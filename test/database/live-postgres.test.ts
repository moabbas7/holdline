import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { afterCommand } from '../../src/commands/after.js';
import { beforeCommand } from '../../src/commands/before.js';
import { dbCommand } from '../../src/commands/db.js';
import { rollbackCommand } from '../../src/commands/rollback.js';
import { captureLive, connectors } from '../../src/probes/database/live/index.js';
import { introspectPostgres, withReadOnlyPostgres } from '../../src/probes/database/live/postgres.js';
import { parseConnectionString, type PgTarget } from '../../src/probes/database/live/target.js';
import { dbSettings, emptySchema } from '../../src/probes/database/types.js';
import { FIXTURES, fixtureRepo } from '../helpers/fixtures.js';
import { startPg, type TestPg } from '../helpers/pglite.js';
import { cleanupAll, fakeIo, writeConfig, type FakeIo, type TestRepo } from '../helpers/tmpRepo.js';
import { sentinel } from '../helpers/secrets.js';

let pg: TestPg;
beforeAll(async () => {
  pg = await startPg();
}, 60_000);
afterAll(async () => {
  await pg?.stop();
});
beforeEach(async () => {
  await pg.reset();
});
afterEach(() => {
  cleanupAll();
  vi.restoreAllMocks();
});

const MIGRATIONS = path.join(FIXTURES, 'supabase-db/supabase/migrations');
const SECRET = sentinel('password');
/** For tests about the live connection itself: the dependency graph only adds run time. */
const NO_GRAPH = { dependencies: { enabled: false } };
const settings = dbSettings({});

/** The Supabase fixture as a git repo with a git-ignored .env.local pointing at `url`. */
async function project(url: string, probes: Record<string, { enabled?: boolean; [key: string]: unknown }> = {}): Promise<TestRepo> {
  const t = fixtureRepo('supabase-db');
  t.write('.gitignore', '.holdline/\nnode_modules/\n.next/\ndist/\n.env*\n');
  t.commitAll('ignore env');
  t.write('.env.local', `# local dev\nNEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321\nDATABASE_URL="${url}"\n`);
  await writeConfig(t.dir, {}, { projectType: 'nextjs', probes });
  return t;
}

function target(): PgTarget {
  const r = parseConnectionString(pg.url(), { root: '/' });
  if (!r.ok) throw new Error(r.reason);
  return r.target as PgTarget;
}

/** Everything holdline printed or stored, for secret checks. */
function allOutput(t: TestRepo, ios: FakeIo[], extra: unknown[] = []): string {
  const parts: string[] = [];
  for (const io of ios) parts.push(...io.logs, ...io.warnings, ...io.prompts);
  for (const x of extra) parts.push(JSON.stringify(x));
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else parts.push(readFileSync(p, 'utf8'));
    }
  };
  walk(t.p('.holdline'));
  return parts.join('\n');
}

describe('live Postgres (PGlite over a socket)', () => {
  it('reads the schema read-only and it matches the schema files exactly (no drift)', async () => {
    await pg.migrate(MIGRATIONS);
    const t = await project(pg.url());
    const io = fakeIo();
    const r = await dbCommand(t.dir, { json: true }, io);
    expect(r.source).toBe('live');
    expect(r.live).toMatchObject({ status: 'ok', target: { dialect: 'postgres', host: '127.0.0.1', local: true, envVar: 'DATABASE_URL', envFile: '.env.local' } });
    const s = r.schema!;
    expect(Object.keys(s.tables).sort()).toEqual(['public.orgs', 'public.posts', 'public.profiles']);
    const p = s.tables['public.profiles']!;
    expect(p.rls).toBe(true);
    expect(p.columns.email).toMatchObject({ type: 'character varying(255)', nullable: false });
    expect(p.uniques).toEqual([{ name: 'profiles_email_key', columns: ['email'] }]);
    expect(p.foreignKeys[0]).toMatchObject({ refTable: 'public.orgs', onDelete: 'cascade' });
    expect(p.indexes).toEqual([{ name: 'profiles_org_id_idx', columns: ['org_id'], unique: false }]);
    expect(Object.keys(p.policies).sort()).toEqual(['Owners update their profile', 'Profiles are visible to their owner']);
    expect(p.policies['Owners update their profile']).toMatchObject({ command: 'update', roles: ['authenticated'] });
    expect(s.enums['public.member_role']).toEqual(['owner', 'member']);
    expect(s.views['public.published_posts']).toBeDefined();
    expect(s.tables['public.posts']!.indexes[0]).toMatchObject({ name: 'posts_published_idx', where: 'published' });
    // Supabase's own schemas (auth here) are left out.
    expect(Object.keys(s.tables).some((k) => k.startsWith('auth.'))).toBe(false);
    expect(r.drift).toEqual([]);

    const text = fakeIo();
    await dbCommand(t.dir, {}, text);
    const out = text.logs.join('\n');
    expect(out).toMatch(/Source: live database, Postgres at 127\.0\.0\.1:\d+ \(from DATABASE_URL in \.env\.local, read-only\)/);
    expect(out).toMatch(/The live database matches the schema files/);
  });

  it('every query runs in a read-only transaction: writes fail and change nothing', async () => {
    await pg.migrate(MIGRATIONS);
    const opts = { statementTimeoutMs: 5000, connectTimeoutMs: 3000 };
    await withReadOnlyPostgres(target(), opts, async (q) => {
      expect((await q<{ transaction_read_only: string }>('show transaction_read_only'))[0]!.transaction_read_only).toBe('on');
      expect(Number((await q<{ statement_timeout: string }>('show statement_timeout'))[0]!.statement_timeout.replace(/\D/g, ''))).toBeGreaterThan(0);
    });
    for (const write of [
      "insert into public.orgs (name) values ('evil')",
      'create table public.evil (id int)',
      'drop table public.posts cascade',
      'alter table public.profiles disable row level security',
    ]) {
      await expect(withReadOnlyPostgres(target(), opts, (q) => q(write))).rejects.toThrow(/read-only transaction/);
    }
    const orgs = await pg.db.query<{ n: number }>('select count(*)::int as n from public.orgs');
    expect(orgs.rows[0]!.n).toBe(1);
    const after = await withReadOnlyPostgres(target(), opts, (q) => introspectPostgres(q));
    expect(Object.keys(after.tables).sort()).toEqual(['public.orgs', 'public.posts', 'public.profiles']);
    expect(after.tables['public.profiles']!.rls).toBe(true);
  });

  it('`after` reports live schema changes as regressions, with the code that still uses them', async () => {
    await pg.migrate(MIGRATIONS);
    const t = await project(pg.url());
    await beforeCommand(t.dir, { task: 'refactor profiles', yes: true }, fakeIo());
    // The "agent" changes the local database directly.
    await pg.db.exec(`
      alter table public.profiles drop column email;
      alter table public.profiles alter column display_name type varchar(50);
      alter table public.posts disable row level security;
      drop policy "Owners update their profile" on public.profiles;
      drop index public.profiles_org_id_idx;
      alter table public.posts add column slug text;
    `);
    const io = fakeIo();
    const report = await afterCommand(t.dir, {}, io);
    expect(report.regressed).toBe(true);
    const db = report.reports.find((r) => r.probeId === 'database')!;
    expect(db.status).toBe('regressed');
    const titles = db.findings.map((f) => `${f.kind}: ${f.title}`);
    expect(titles).toEqual(
      expect.arrayContaining([
        'regression: Column profiles.email dropped [live database]',
        'regression: Column profiles.display_name type changed: text → character varying(50) [live database]',
        'regression: Row-level security turned OFF on posts (every row is now visible to anyone who can query the table) [live database]',
        'regression: Policy "Owners update their profile" on profiles removed (update to authenticated) [live database]',
        'change: Index profiles_org_id_idx on profiles(org_id) removed [live database]',
        'change: Column posts.slug added (text) [live database]',
      ]),
    );
    const email = db.findings.find((f) => f.title.startsWith('Column profiles.email dropped'))!;
    const lines = email.lines!.join('\n');
    // Code that still names the column in a query…
    expect(lines).toMatch(/✗ app\/api\/profiles\/route\.ts:5 still references email \(\.select\(\) uses column email\)/);
    expect(lines).toMatch(/✗ app\/api\/profiles\/route\.ts:12 still references email \(\.insert\(\) sets column email\)/);
    expect(lines).toMatch(/✗ lib\/db\.ts:6 still references email \(SQL query mentions email\)/);
    // …and the routes, pages and files that use the table.
    expect(lines).toMatch(/route GET\|POST \/api\/profiles/);
    expect(lines).toMatch(/page app\/profiles\/page\.tsx/);
    // The comment on line 11 mentions "email" but isn't a query.
    expect(lines).not.toMatch(/route\.ts:11/);
    // Drift from the files, and the note that rollback won't undo the database.
    expect(titles).toEqual(expect.arrayContaining(['change: Drift: Column profiles.email is in the schema files but not in the database']));
    const note = db.findings.find((f) => f.kind === 'info' && /restores files only/.test(f.title))!;
    expect(note.title).toMatch(/the database is NOT rolled back/);
    expect(note.lines).toEqual(expect.arrayContaining(['Column profiles.email dropped']));
    expect(io.logs.join('\n')).toMatch(/Database schema: \d+ breaking schema changes/);
  });

  it('marks a change seen in both the database and a new migration as [live database + schema files]', async () => {
    await pg.migrate(MIGRATIONS);
    const t = await project(pg.url());
    await beforeCommand(t.dir, { task: 'drop bodies', yes: true }, fakeIo());
    const migration = 'alter table public.posts drop column body;\n';
    t.write('supabase/migrations/20240301000000_drop_body.sql', migration);
    await pg.db.exec(migration);
    const report = await afterCommand(t.dir, {}, fakeIo());
    const db = report.reports.find((r) => r.probeId === 'database')!;
    expect(db.findings.filter((f) => f.kind === 'regression').map((f) => f.title)).toEqual(['Column posts.body dropped [live database + schema files]']);
    expect(db.findings.some((f) => f.title.startsWith('Drift'))).toBe(false);
  });

  it('rollback warns that the database is not rolled back, lists the live changes, and never writes to it', async () => {
    await pg.migrate(MIGRATIONS);
    const t = await project(pg.url(), NO_GRAPH);
    await beforeCommand(t.dir, { task: 'x', yes: true }, fakeIo());
    t.write('app/new.ts', 'export const x = 1;\n');
    await pg.db.exec('alter table public.profiles drop column email; alter table public.posts disable row level security;');
    const opts = { statementTimeoutMs: 5000, connectTimeoutMs: 3000 };
    const liveBefore = await withReadOnlyPostgres(target(), opts, (q) => introspectPostgres(q));

    const io = fakeIo();
    await rollbackCommand(t.dir, { yes: true }, io);
    const warned = io.warnings.join('\n');
    expect(warned).toMatch(/Files will be restored, but the database is NOT rolled back/);
    expect(warned).toMatch(/- Column profiles\.email dropped/);
    expect(warned).toMatch(/- Row-level security turned OFF on posts/);
    expect(warned).toMatch(/Re-run your migrations or restore the database yourself/);
    expect(t.exists('app/new.ts')).toBe(false);
    // The warning comes before the files are restored.
    const warnAt = io.warnings.findIndex((w) => /NOT rolled back/.test(w));
    expect(warnAt).toBeGreaterThanOrEqual(0);
    expect(io.logs.some((l) => /^Restored/.test(l))).toBe(true);
    // The database is exactly as the agent left it.
    expect(await withReadOnlyPostgres(target(), opts, (q) => introspectPostgres(q))).toEqual(liveBefore);
  });

  it('rollback shows no database warning when the live schema did not change', async () => {
    await pg.migrate(MIGRATIONS);
    const t = await project(pg.url(), NO_GRAPH);
    await beforeCommand(t.dir, { task: 'x', yes: true }, fakeIo());
    t.write('app/new.ts', 'export const x = 1;\n');
    const io = fakeIo();
    await rollbackCommand(t.dir, { yes: true }, io);
    expect(io.warnings.join('\n')).not.toMatch(/database/i);
  });

  it('rollback falls back to what `after` saw when the database is unreachable', async () => {
    await pg.migrate(MIGRATIONS);
    const t = await project(pg.url(), NO_GRAPH);
    await beforeCommand(t.dir, { task: 'x', yes: true }, fakeIo());
    await pg.db.exec('alter table public.profiles drop column display_name;');
    await afterCommand(t.dir, {}, fakeIo());
    vi.spyOn(connectors, 'postgres').mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    t.write('app/new.ts', 'export const x = 1;\n');
    const io = fakeIo();
    await rollbackCommand(t.dir, { yes: true }, io);
    expect(io.warnings.join('\n')).toMatch(/NOT rolled back[\s\S]*Column profiles\.display_name dropped/);
  });

  it('falls back to schema files with a warning when the local database is down', async () => {
    const t = await project('postgres://postgres:postgres@127.0.0.1:1/postgres', NO_GRAPH);
    const io = fakeIo();
    const session = await beforeCommand(t.dir, { task: 'x', yes: true }, io);
    expect(session.probes.database).toMatchObject({ live: 'failed', tables: 3 });
    expect(io.warnings.join('\n')).toMatch(/could not read the live database \(Postgres at 127\.0\.0\.1:1, from DATABASE_URL in \.env\.local\): connection refused.*Using schema files only/);
    t.write('supabase/migrations/20240301000000_x.sql', 'alter table public.profiles drop column display_name;');
    const report = await afterCommand(t.dir, {}, fakeIo());
    const db = report.reports.find((r) => r.probeId === 'database')!;
    expect(db.summary).toMatch(/\(schema files\)$/);
    expect(db.findings.map((f) => f.title)).toContain('Column profiles.display_name dropped');
  });
});

describe('the local-host rule', () => {
  it('never connects to a non-local host by default, and says so', async () => {
    const spy = vi.spyOn(connectors, 'postgres');
    const t = await project(`postgresql://postgres.abcdef:${SECRET}@aws-0-eu-west-1.pooler.supabase.com:6543/postgres`, NO_GRAPH);
    const io = fakeIo();
    const r = await dbCommand(t.dir, {}, io);
    expect(spy).not.toHaveBeenCalled();
    expect(r.source).toBe('files');
    expect(r.live.status).toBe('refused');
    expect(io.warnings.join('\n')).toMatch(
      /DATABASE_URL in \.env\.local points at a non-local host \(aws-0-eu-west-1\.pooler\.supabase\.com\), so holdline did NOT connect to it.*allowHosts/,
    );
    const before = fakeIo();
    await beforeCommand(t.dir, { task: 'x', yes: true }, before);
    await afterCommand(t.dir, {}, fakeIo());
    expect(spy).not.toHaveBeenCalled();
    expect(before.warnings.join('\n')).toMatch(/did NOT connect/);
  });

  it('connects to a non-local host only when config allows it', async () => {
    const spy = vi.spyOn(connectors, 'postgres').mockResolvedValue(emptySchema());
    const t = await project(`postgres://u:${SECRET}@db.internal.example.com:5432/app`, { database: { allowHosts: ['db.internal.example.com'] } });
    const r = await dbCommand(t.dir, { json: true }, fakeIo());
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toMatchObject({ host: 'db.internal.example.com', ssl: { rejectUnauthorized: false } });
    expect(r.live.status).toBe('ok');
  });

  it('does not connect at all with probes.database.connect = false', async () => {
    const spy = vi.spyOn(connectors, 'postgres');
    const r = await captureLive('/nonexistent', dbSettings({ connect: false }));
    expect(r.status).toBe('disabled');
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('secrets', () => {
  const user = sentinel('user');
  const scenarios: [string, () => string][] = [
    ['a working connection (PGlite ignores credentials)', () => pg.url({ user, password: SECRET })],
    ['a refused connection', () => `postgres://${user}:${SECRET}@127.0.0.1:1/postgres`],
    ['a non-local host', () => `postgres://${user}:${SECRET}@prod-db.example.com:5432/app`],
    ['a rejected host= parameter', () => `postgres://${user}:${SECRET}@localhost/app?host=evil.example.com`],
    ['a password in the query string', () => `postgres://${user}:${SECRET}@127.0.0.1:1/app?sslmode=require&password=${SECRET}2`],
  ];

  it.each(scenarios)('never prints or stores the connection string, user or password: %s', async (_name, makeUrl) => {
    await pg.migrate(MIGRATIONS);
    const url = makeUrl();
    const t = await project(url, { dependencies: { enabled: false } });
    const ios = [fakeIo(), fakeIo(), fakeIo(), fakeIo()];
    const session = await beforeCommand(t.dir, { task: 'x', yes: true }, ios[0]!);
    await pg.db.exec('alter table public.posts add column tmp text;');
    t.write('supabase/migrations/20240301000000_x.sql', 'alter table public.posts drop column body;');
    const report = await afterCommand(t.dir, { json: true }, ios[1]!);
    const json = await dbCommand(t.dir, { json: true }, ios[2]!);
    await dbCommand(t.dir, {}, ios[3]!);
    const out = allOutput(t, ios, [session, report, json]);
    expect(out.length).toBeGreaterThan(1000);
    for (const secret of [SECRET, encodeURIComponent(SECRET), user, url]) expect(out, `leaked ${secret}`).not.toContain(secret);
  });
});
