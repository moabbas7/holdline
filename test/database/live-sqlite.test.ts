import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { afterCommand } from '../../src/commands/after.js';
import { beforeCommand } from '../../src/commands/before.js';
import { dbCommand } from '../../src/commands/db.js';
import { introspectSqlite, openSqliteReadOnly } from '../../src/probes/database/live/sqlite.js';
import { cleanupAll, fakeIo, makeRepo, writeConfig } from '../helpers/tmpRepo.js';

afterEach(cleanupAll);

const SCHEMA = `
  create table users (id integer primary key autoincrement, email text not null unique, name text, created_at datetime default current_timestamp);
  create table posts (id integer primary key, user_id integer not null references users(id) on delete cascade, title text not null);
  create index posts_user_idx on posts (user_id);
  create view titles as select title from posts;
  insert into users (email) values ('a@example.com');
`;

async function sqliteProject() {
  const t = makeRepo();
  t.write('.gitignore', '.holdline/\n.env\n*.db\n');
  t.write('prisma/schema.prisma', 'datasource db {\n  provider = "sqlite"\n  url = env("DATABASE_URL")\n}\n');
  t.commitAll('setup');
  const db = new DatabaseSync(t.p('prisma/dev.db'));
  db.exec(SCHEMA);
  db.close();
  t.write('.env', 'DATABASE_URL="file:./dev.db"\n');
  await writeConfig(t.dir, {}, { probes: { dependencies: { enabled: false } } });
  return t;
}

describe('live SQLite (node:sqlite, read-only)', () => {
  it('reads tables, keys, indexes and views from a Prisma-style file: URL', async () => {
    const t = await sqliteProject();
    const r = await dbCommand(t.dir, { json: true }, fakeIo());
    expect(r.source).toBe('live');
    expect(r.live.target).toMatchObject({ dialect: 'sqlite', host: 'prisma/dev.db', local: true });
    const s = r.schema!;
    expect(Object.keys(s.tables).sort()).toEqual(['main.posts', 'main.users']);
    expect(s.tables['main.users']!.columns.email).toMatchObject({ type: 'text', nullable: false });
    expect(s.tables['main.users']!.uniques[0]!.columns).toEqual(['email']);
    expect(s.tables['main.posts']!.foreignKeys[0]).toMatchObject({ columns: ['user_id'], refTable: 'main.users', refColumns: ['id'], onDelete: 'cascade' });
    expect(s.tables['main.posts']!.indexes).toEqual([{ name: 'posts_user_idx', columns: ['user_id'], unique: false }]);
    expect(s.views['main.titles']).toBeDefined();
  });

  it('opens the file read-only: writes fail and change nothing', async () => {
    const t = await sqliteProject();
    const h = await openSqliteReadOnly(t.p('prisma/dev.db'));
    try {
      expect(() => h.exec("insert into users (email) values ('evil@example.com')")).toThrow(/readonly|read-only|query_only/i);
      expect(() => h.exec('drop table posts')).toThrow();
      expect(() => h.exec('create table evil (id int)')).toThrow();
      expect(Object.keys(introspectSqlite(h).tables)).toHaveLength(2);
    } finally {
      h.close();
    }
    const db = new DatabaseSync(t.p('prisma/dev.db'));
    expect(db.prepare('select count(*) as n from users').get()).toEqual({ n: 1 });
    db.close();
  });

  it('never creates a missing database file', async () => {
    const t = await sqliteProject();
    t.write('.env', 'DATABASE_URL="file:./missing.db"\n');
    const io = fakeIo();
    const r = await dbCommand(t.dir, {}, io);
    expect(r.live.status).toBe('failed');
    expect(io.warnings.join('\n')).toMatch(/could not read the live database \(SQLite prisma\/missing\.db/);
    expect(t.exists('prisma/missing.db')).toBe(false);
  });

  it('`after` reports a dropped column in the live SQLite database', async () => {
    const t = await sqliteProject();
    await beforeCommand(t.dir, { task: 'x', yes: true }, fakeIo());
    const db = new DatabaseSync(t.p('prisma/dev.db'));
    db.exec('alter table users drop column name; drop index posts_user_idx;');
    db.close();
    const report = await afterCommand(t.dir, {}, fakeIo());
    const r = report.reports.find((x) => x.probeId === 'database')!;
    expect(report.regressed).toBe(true);
    expect(r.findings.map((f) => `${f.kind}: ${f.title}`)).toEqual(
      expect.arrayContaining(['regression: Column users.name dropped', 'change: Index posts_user_idx on posts(user_id) removed']),
    );
  });
});
