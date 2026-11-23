/**
 * pg and libpg-query are loaded only for projects that have SQL schema files or a database
 * connection configured. vi.mock records every import of them (static or dynamic) made by
 * holdline's modules; module state carries across the tests in this file, so the project
 * without a database runs first.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { afterCommand } from '../../src/commands/after.js';
import { beforeCommand } from '../../src/commands/before.js';
import { dbCommand } from '../../src/commands/db.js';
import { fixtureRepo } from '../helpers/fixtures.js';
import { cleanupAll, fakeIo, makeRepo, writeConfig } from '../helpers/tmpRepo.js';

const loaded = vi.hoisted(() => new Set<string>());

vi.mock('pg', async (importOriginal) => {
  loaded.add('pg');
  return importOriginal();
});
vi.mock('libpg-query', async (importOriginal) => {
  loaded.add('libpg-query');
  return importOriginal();
});

afterEach(cleanupAll);

describe('lazy loading of database modules', () => {
  it('a project without a database never loads pg or libpg-query', async () => {
    const t = makeRepo();
    t.write('.gitignore', '.holdline/\n');
    t.write('src/app.ts', "export const query = 'select * from nowhere';\n");
    t.commitAll('app');
    await writeConfig(t.dir);
    await beforeCommand(t.dir, { task: 'x', yes: true }, fakeIo());
    t.write('src/more.ts', 'export const y = 2;\n');
    const report = await afterCommand(t.dir, {}, fakeIo());
    await dbCommand(t.dir, { json: true }, fakeIo());
    expect(report.reports.find((r) => r.probeId === 'database')!.status).toBe('skipped');
    expect([...loaded]).toEqual([]);
  });

  it('SQL migrations load libpg-query, but not pg when no connection is configured', async () => {
    const t = fixtureRepo('supabase-db');
    await dbCommand(t.dir, { json: true }, fakeIo());
    expect([...loaded]).toEqual(['libpg-query']);
  });

  it('a configured local connection loads pg', async () => {
    const t = fixtureRepo('supabase-db');
    t.write('.env', 'DATABASE_URL=postgres://u:p@127.0.0.1:1/db\n');
    await dbCommand(t.dir, { json: true }, fakeIo());
    expect([...loaded].sort()).toEqual(['libpg-query', 'pg']);
  });
});
