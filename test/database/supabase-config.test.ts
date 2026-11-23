import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbCommand } from '../../src/commands/db.js';
import { supabaseDbPort } from '../../src/probes/database/live/env.js';
import { captureLive, connectors } from '../../src/probes/database/live/index.js';
import { dbSettings } from '../../src/probes/database/types.js';
import { FIXTURES, fixtureRepo } from '../helpers/fixtures.js';
import { startPg, type TestPg } from '../helpers/pglite.js';
import { cleanupAll, fakeIo, writeConfig } from '../helpers/tmpRepo.js';

let pg: TestPg;
beforeAll(async () => {
  pg = await startPg();
}, 60_000);
afterAll(async () => {
  await pg?.stop();
});
beforeEach(async () => {
  await pg.reset();
  await pg.migrate(path.join(FIXTURES, 'supabase-db/supabase/migrations'));
});
afterEach(() => {
  cleanupAll();
  vi.restoreAllMocks();
});

const settings = dbSettings({});

describe('supabase/config.toml: [db] port', () => {
  it('reads the port from the [db] section only', () => {
    const toml = [
      'project_id = "myapp"',
      '',
      '[api]',
      'port = 54321',
      '',
      '[db]',
      '# The local database',
      'port = 54999 # custom',
      'major_version = 15',
      '',
      '[studio]',
      'port = 54323',
    ].join('\n');
    expect(supabaseDbPort(toml)).toBe(54999);
    expect(supabaseDbPort('[db]\nmajor_version = 15\n')).toBe(54322);
    expect(supabaseDbPort('[api]\nport = 1\n')).toBeNull();
    expect(supabaseDbPort('[db]\nport = "abc"\n')).toBe(54322);
  });
});

describe('local Supabase auto-discovery', () => {
  function project(toml: string) {
    const t = fixtureRepo('supabase-db');
    t.write('.gitignore', '.holdline/\nnode_modules/\n.env*\n');
    t.write('supabase/config.toml', toml);
    t.commitAll('supabase config');
    return t;
  }

  it('without a URL in .env, connects to the local Supabase database from config.toml (read-only)', async () => {
    const t = project(`[db]\nport = ${pg.port}\n`);
    const live = await captureLive(t.dir, settings);
    expect(live.status).toBe('ok');
    expect(live.target).toMatchObject({ dialect: 'postgres', host: '127.0.0.1', port: pg.port, local: true, envFile: 'supabase/config.toml' });
    expect(Object.keys(live.schema!.tables)).toEqual(expect.arrayContaining(['public.profiles']));

    await writeConfig(t.dir, {}, { projectType: 'nextjs', probes: { dependencies: { enabled: false } } });
    const io = fakeIo();
    await dbCommand(t.dir, {}, io);
    const out = io.logs.join('\n');
    expect(out).toMatch(new RegExp(`Source: live database, Postgres at 127\\.0\\.0\\.1:${pg.port} \\(from local Supabase \\(\\[db\\] port\\) in supabase/config\\.toml, read-only\\)`));
    expect(out).not.toContain('postgres:postgres');
  });

  it('a DATABASE_URL in .env still wins, and a non-local one is still refused without connecting', async () => {
    const t = project(`[db]\nport = ${pg.port}\n`);
    t.write('.env.local', 'DATABASE_URL=postgresql://u:p@db.example.com:5432/postgres\n');
    const spy = vi.spyOn(connectors, 'postgres');
    const live = await captureLive(t.dir, settings);
    expect(live.status).toBe('refused');
    expect(live.target?.envVar).toBe('DATABASE_URL');
    expect(spy).not.toHaveBeenCalled();
  });

  it('respects connect: false', async () => {
    const t = project(`[db]\nport = ${pg.port}\n`);
    const spy = vi.spyOn(connectors, 'postgres');
    const live = await captureLive(t.dir, dbSettings({ connect: false }));
    expect(live.status).toBe('disabled');
    expect(spy).not.toHaveBeenCalled();
  });

  it('falls back to schema files with a warning when the local Supabase is not running', async () => {
    const t = project('[db]\nport = 1\n');
    const live = await captureLive(t.dir, settings);
    expect(live.status).toBe('failed');
    expect(live.message).toMatch(/could not read the live database \(Postgres at 127\.0\.0\.1:1, from local Supabase \(\[db\] port\) in supabase\/config\.toml\)/);
    expect(live.message).not.toContain('postgres:postgres');
  });

  it('projects without supabase/config.toml are unchanged', async () => {
    const t = fixtureRepo('supabase-db');
    expect((await captureLive(t.dir, settings)).status).toBe('none');
  });
});
