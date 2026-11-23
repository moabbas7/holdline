/** before/after with schema files only (no database connection). */
import { afterEach, describe, expect, it } from 'vitest';
import { afterCommand } from '../../src/commands/after.js';
import { beforeCommand } from '../../src/commands/before.js';
import { dbCommand } from '../../src/commands/db.js';
import { initCommand } from '../../src/commands/init.js';
import { loadConfig } from '../../src/core/config.js';
import { fixtureProject, fixtureRepo } from '../helpers/fixtures.js';
import { cleanupAll, fakeIo } from '../helpers/tmpRepo.js';

afterEach(cleanupAll);

const dbReport = (r: Awaited<ReturnType<typeof afterCommand>>) => r.reports.find((x) => x.probeId === 'database')!;

describe('schema files only', () => {
  it('Supabase: a breaking migration is a regression, with the code that uses the table', async () => {
    const t = await fixtureProject('supabase-db', 'nextjs');
    const io = fakeIo();
    await beforeCommand(t.dir, { task: 'cleanup', yes: true }, io);
    expect(io.logs.join('\n')).toMatch(/Database schema: 3 tables from supabase\/migrations \(2 files\)/);
    t.write(
      'supabase/migrations/20240301000000_cleanup.sql',
      `alter table public.profiles drop column email;
       alter table public.profiles disable row level security;
       drop policy "Published posts are public" on public.posts;
       alter table public.posts alter column title type varchar(80);
       alter table public.posts add column tenant_id uuid not null;
       alter table public.orgs add column logo text;`,
    );
    const report = await afterCommand(t.dir, {}, fakeIo());
    expect(report.regressed).toBe(true);
    const r = dbReport(report);
    expect(r.summary).toBe('5 breaking schema changes, 1 other schema change (schema files)');
    expect(r.findings.filter((f) => f.kind === 'regression').map((f) => f.title)).toEqual([
      'Column profiles.email dropped',
      'Row-level security turned OFF on profiles (every row is now visible to anyone who can query the table)',
      "Column posts.tenant_id added as NOT NULL without a default (inserts that don't set it will fail)",
      'Column posts.title type changed: text → character varying(80)',
      'Policy "Published posts are public" on posts removed (select to public)',
    ]);
    const email = r.findings[0]!.lines!.join('\n');
    expect(email).toMatch(/still references email/);
    expect(email).toMatch(/route GET\|POST \/api\/profiles/);
    const rls = r.findings[1]!.lines!.join('\n');
    expect(rls).toMatch(/used by .* \(listed above\)/);
    // posts is used by app/api/posts.ts
    expect(r.findings[2]!.lines!.join('\n')).toMatch(/app\/api\/posts\.ts/);
    expect(r.findings.some((f) => /restores files only/.test(f.title))).toBe(false);
  });

  it('Supabase: additive changes are changes, not regressions', async () => {
    const t = await fixtureProject('supabase-db', 'nextjs');
    await beforeCommand(t.dir, { task: 'add', yes: true }, fakeIo());
    t.write(
      'supabase/migrations/20240301000000_add.sql',
      `create table public.comments (id bigint primary key, body text);
       alter table public.posts add column slug text;
       drop index public.profiles_org_id_idx;
       alter table public.profiles drop constraint profiles_org_id_fkey;`,
    );
    const report = await afterCommand(t.dir, {}, fakeIo());
    const r = dbReport(report);
    expect(report.regressed).toBe(false);
    expect(r.status).toBe('changed');
    expect(r.findings.map((f) => f.title)).toEqual(
      expect.arrayContaining([
        'Table comments added',
        'Column posts.slug added (text)',
        'Index profiles_org_id_idx on profiles(org_id) removed',
        'Foreign key profiles(org_id) → orgs(id) removed',
      ]),
    );
  });

  it('editing an old migration in place is compared on the resulting schema', async () => {
    const t = await fixtureProject('supabase-db', 'nextjs');
    await beforeCommand(t.dir, { task: 'x', yes: true }, fakeIo());
    const f = 'supabase/migrations/20240101000000_init.sql';
    t.write(f, t.read(f).replace('  display_name text,\n', ''));
    const r = dbReport(await afterCommand(t.dir, {}, fakeIo()));
    expect(r.findings.filter((x) => x.kind === 'regression').map((x) => x.title)).toEqual(['Column profiles.display_name dropped']);
  });

  it('Prisma: a removed field is found in prisma.<model> calls by its field name', async () => {
    const t = await fixtureProject('prisma-db', 'node');
    await beforeCommand(t.dir, { task: 'x', yes: true }, fakeIo());
    t.write('prisma/schema.prisma', t.read('prisma/schema.prisma').replace('  name      String?  @map("full_name")\n', ''));
    const r = dbReport(await afterCommand(t.dir, {}, fakeIo()));
    const f = r.findings.find((x) => x.title === 'Column users.full_name dropped')!;
    expect(f.kind).toBe('regression');
    expect(f.lines!.join('\n')).toMatch(/✗ src\/routes\/users\.ts:7 still references full_name \(Prisma findMany\(\) uses field name\)/);
  });

  it('Prisma: a renamed model keeps its table when @@map is unchanged', async () => {
    const t = await fixtureProject('prisma-db', 'node');
    await beforeCommand(t.dir, { task: 'x', yes: true }, fakeIo());
    t.write('prisma/schema.prisma', t.read('prisma/schema.prisma').replace(/model User \{/, 'model Account {').replace(/User(\s+@relation)/, 'Account$1'));
    const r = dbReport(await afterCommand(t.dir, {}, fakeIo()));
    expect(r.status).toBe('ok');
  });

  it('Drizzle: a dropped column is found where code uses table.column', async () => {
    const t = await fixtureProject('drizzle-db', 'node');
    await beforeCommand(t.dir, { task: 'x', yes: true }, fakeIo());
    t.write('src/db/schema.ts', t.read('src/db/schema.ts').replace("    displayName: text('display_name'),\n", ''));
    const r = dbReport(await afterCommand(t.dir, {}, fakeIo()));
    const f = r.findings.find((x) => x.title === 'Column users.display_name dropped')!;
    expect(f.kind).toBe('regression');
    expect(f.lines!.join('\n')).toMatch(/✗ src\/api\/users\.ts:9 still references display_name \(users\.displayName\)/);
  });

  it('Drizzle: removing a policy and nullability changes', async () => {
    const t = await fixtureProject('drizzle-db', 'node');
    await beforeCommand(t.dir, { task: 'x', yes: true }, fakeIo());
    t.write(
      'src/db/schema.ts',
      t
        .read('src/db/schema.ts')
        .replace("    pgPolicy('authors can read', { for: 'select', to: 'authenticated', using: sql`true` }),\n", '')
        .replace("title: text('title').notNull()", "title: text('title')")
        .replace("pinned: boolean('pinned').default(false)", "pinned: boolean('pinned').default(false).notNull()"),
    );
    const r = dbReport(await afterCommand(t.dir, {}, fakeIo()));
    expect(r.findings.map((f) => `${f.kind}: ${f.title}`)).toEqual(
      expect.arrayContaining([
        'regression: Policy "authors can read" on posts removed (select to authenticated)',
        'change: Column posts.title is now nullable (code may receive nulls)',
        'change: Column posts.pinned is now NOT NULL (has a default)',
      ]),
    );
  });

  it('`holdline db` prints the schema from files and where it came from', async () => {
    const t = fixtureRepo('supabase-db');
    const io = fakeIo();
    const r = await dbCommand(t.dir, {}, io);
    expect(r.source).toBe('files');
    const out = io.logs.join('\n');
    expect(out).toMatch(/^Source: schema files: supabase\/migrations \(2 files\)/m);
    expect(out).toMatch(/No DATABASE_URL, POSTGRES_URL or DIRECT_URL/);
    expect(out).toMatch(/^profiles RLS on, 2 policies {2}supabase\/migrations\/20240101000000_init\.sql$/m);
    expect(out).toMatch(/ {2}email +character varying\(255\) +not null, unique/);
    expect(out).toMatch(/org_id +uuid +→ orgs\.id \(on delete cascade\)/);
    expect(out).toMatch(/member_role: owner, member/);
    const json = await dbCommand(t.dir, { json: true }, fakeIo());
    expect(JSON.parse(JSON.stringify(json))).toMatchObject({ source: 'files', live: { status: 'none' }, schema: { dialect: 'postgres' } });
  });

  it('can be turned off, and init enables it', async () => {
    const t = await fixtureProject('supabase-db', 'nextjs', { probes: { database: { enabled: false } } });
    const session = await beforeCommand(t.dir, { task: 'x', yes: true }, fakeIo());
    expect(session.probes.database).toBeUndefined();
    const u = fixtureRepo('supabase-db');
    await initCommand(u.dir, { yes: true }, fakeIo());
    expect((await loadConfig(u.dir)).probes?.database).toEqual({ enabled: true });
  });
});
