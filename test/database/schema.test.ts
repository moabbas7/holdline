import { afterEach, describe, expect, it } from 'vitest';
import { canonPg, prismaType } from '../../src/probes/database/canon.js';
import { schemaDrift, diffSchemas, type ChangeKind } from '../../src/probes/database/diff.js';
import { applyDrizzle } from '../../src/probes/database/files/drizzle.js';
import { captureFiles } from '../../src/probes/database/files/index.js';
import { applyPrisma } from '../../src/probes/database/files/prisma.js';
import { replaySqlFiles, splitStatements } from '../../src/probes/database/files/sql.js';
import { emptySchema, type DbSchema } from '../../src/probes/database/types.js';
import { fixtureRepo } from '../helpers/fixtures.js';
import { cleanupAll, makeRepo } from '../helpers/tmpRepo.js';

afterEach(cleanupAll);

async function sql(...files: string[]): Promise<DbSchema> {
  const s = emptySchema();
  const r = await replaySqlFiles(s, files.map((text, i) => ({ path: `m${i}.sql`, text })));
  expect(r.warnings).toEqual([]);
  return s;
}

describe('type canonicalisation', () => {
  it('maps aliases to format_type() spelling', () => {
    expect(canonPg('int4')).toBe('integer');
    expect(canonPg('serial')).toBe('integer');
    expect(canonPg('bigserial')).toBe('bigint');
    expect(canonPg('varchar', [10])).toBe('character varying(10)');
    expect(canonPg('character varying(10)')).toBe('character varying(10)');
    expect(canonPg('timestamptz')).toBe('timestamp with time zone');
    expect(canonPg('timestamptz', [3])).toBe('timestamp(3) with time zone');
    expect(canonPg('timestamp(3) without time zone')).toBe('timestamp(3) without time zone');
    expect(canonPg('numeric', [10, 2])).toBe('numeric(10,2)');
    expect(canonPg('numeric(10, 2)')).toBe('numeric(10,2)');
    expect(canonPg('_int4')).toBe('integer[]');
    expect(canonPg('text[]')).toBe('text[]');
    expect(canonPg('public.member_role')).toBe('member_role');
    expect(canonPg('"Role"')).toBe('role');
    expect(canonPg('bool')).toBe('boolean');
    expect(canonPg('float8')).toBe('double precision');
  });

  it('maps Prisma types, including native @db types', () => {
    expect(prismaType('DateTime', null, 'postgresql', false)).toBe('timestamp(3) without time zone');
    expect(prismaType('DateTime', '@db.Timestamptz(6)', 'postgresql', false)).toBe('timestamp(6) with time zone');
    expect(prismaType('String', '@db.VarChar(200)', 'postgresql', false)).toBe('character varying(200)');
    expect(prismaType('String', '@db.Uuid', 'postgresql', false)).toBe('uuid');
    expect(prismaType('String', null, 'postgresql', true)).toBe('text[]');
    expect(prismaType('Int', null, 'sqlite', false)).toBe('integer');
  });
});

describe('SQL migrations', () => {
  it('splits statements around quotes, dollar quoting, comments and psql meta-commands', () => {
    const parts = splitStatements("select ';'; -- a; b\ncreate function f() returns int as $x$ select 1; $x$ language sql;\n\\set ON_ERROR_STOP 1\n/* ; */ select 2");
    expect(parts).toEqual([
      "select ';'",
      '-- a; b\ncreate function f() returns int as $x$ select 1; $x$ language sql',
      '\\set ON_ERROR_STOP 1',
      '/* ; */ select 2',
    ]);
  });

  it('replays create/alter/rename/drop for tables, columns, constraints, indexes, enums, views and RLS', async () => {
    const s = await sql(
      `create type status as enum ('a', 'b');
       create table users (id serial primary key, email text not null, nick varchar(20), s status, org int);
       create table orgs (id int primary key);
       alter table users add constraint users_org_fk foreign key (org) references orgs (id) on delete set null;
       alter table users add constraint users_email_key unique (email);
       create unique index users_nick_idx on users (lower(nick));
       alter table users enable row level security;
       create policy p1 on users for select to authenticated using (true);
       create view v as select * from users;`,
      `alter table users alter column nick type text, alter column nick set not null, alter column nick set default 'x';
       alter table users rename column s to state;
       alter table users drop constraint users_org_fk;
       alter type status add value 'c' after 'a';
       alter policy p1 on users using (id > 0);
       drop view v;
       alter table orgs rename to organisations;`,
    );
    const u = s.tables['public.users']!;
    expect(Object.keys(u.columns)).toEqual(['id', 'email', 'nick', 'state', 'org']);
    expect(u.columns.id).toMatchObject({ type: 'integer', nullable: false });
    expect(u.columns.nick).toMatchObject({ type: 'text', nullable: false, default: "'x'" });
    expect(u.columns.state!.type).toBe('status');
    expect(u.foreignKeys).toEqual([]);
    expect(u.uniques).toEqual([{ name: 'users_email_key', columns: ['email'] }]);
    expect(u.indexes).toEqual([{ name: 'users_nick_idx', columns: ['lower(nick)'], unique: true }]);
    expect(u.rls).toBe(true);
    expect(u.policies.p1).toMatchObject({ command: 'select', roles: ['authenticated'], using: 'id > 0' });
    expect(s.enums['public.status']).toEqual(['a', 'c', 'b']);
    expect(s.views).toEqual({});
    expect(s.tables['public.orgs']).toBeUndefined();
    expect(s.tables['public.organisations']).toBeDefined();
    expect(s.renames.map((r) => `${r.kind}:${r.from}->${r.to}`)).toEqual(['column:s->state', 'table:orgs->organisations']);
  });

  it('handles Supabase db-diff style primary keys (unique index + constraint using index)', async () => {
    const s = await sql(
      `create table "public"."todos" ("id" bigint not null, "task" text);
       CREATE UNIQUE INDEX todos_pkey ON public.todos USING btree (id);
       alter table "public"."todos" add constraint "todos_pkey" PRIMARY KEY using index "todos_pkey";`,
    );
    const t = s.tables['public.todos']!;
    expect(t.primaryKey).toEqual(['id']);
    expect(t.indexes).toEqual([]);
  });

  it('skips only the statements it cannot parse', async () => {
    const s = emptySchema();
    const r = await replaySqlFiles(s, [{ path: 'x.sql', text: 'create table a (id int);\n\\connect other\ncreate table b (id int);' }]);
    expect(Object.keys(s.tables).sort()).toEqual(['public.a', 'public.b']);
    expect(r.warnings[0]).toMatch(/x\.sql: skipped 1 statement/);
  });

  it('reads enums created inside idempotent DO blocks, and nothing else from them', async () => {
    const s = await sql(`
      do $$ begin
        if not exists (select 1 from pg_type where typname = 'role') then
          create type basejump.role as enum ('owner', 'member');
        end if;
        raise notice 'create table not_a_table (id int)';
      end $$;
      do $$ begin alter type basejump.role add value 'guest'; exception when others then null; end $$;`);
    expect(s.enums).toEqual({ 'basejump.role': ['owner', 'member', 'guest'] });
    expect(s.tables).toEqual({});
  });

  it('resolves `references t` without columns to the primary key of t', async () => {
    const s = await sql('create table a (code text primary key); create table b (a_code text references a);');
    expect(s.tables['public.b']!.foreignKeys[0]).toMatchObject({ refTable: 'public.a', refColumns: ['code'] });
  });

  it('uses a root schema.sql only when there are no migrations (it is usually a copy of them)', async () => {
    const t = fixtureRepo('supabase-db');
    t.write('schema.sql', 'create table public.from_dump (id int);\n').commitAll('dump');
    expect(Object.keys((await captureFiles(t.dir)).schema!.tables)).not.toContain('public.from_dump');
    t.rm('supabase').commitAll('no migrations');
    const c = await captureFiles(t.dir);
    expect(c.sources.map((x) => x.label)).toEqual(['schema.sql (1 file)']);
    expect(Object.keys(c.schema!.tables)).toEqual(['public.from_dump']);
  });

  it('reads the Supabase fixture, ignoring functions, DO blocks, grants and data', async () => {
    const t = fixtureRepo('supabase-db');
    const c = await captureFiles(t.dir);
    expect(c.warnings).toEqual([]);
    expect(c.sources.map((s) => s.label)).toEqual(['supabase/migrations (2 files)']);
    const s = c.schema!;
    expect(Object.keys(s.tables).sort()).toEqual(['public.orgs', 'public.posts', 'public.profiles']);
    const p = s.tables['public.profiles']!;
    expect(p.columns.email).toMatchObject({ type: 'character varying(255)', nullable: false });
    expect(p.columns.role).toMatchObject({ type: 'member_role', default: "'member'" });
    expect(p.foreignKeys[0]).toMatchObject({ columns: ['org_id'], refTable: 'public.orgs', onDelete: 'cascade' });
    expect(Object.keys(p.policies)).toHaveLength(2);
    expect(s.tables['public.posts']!.columns.id).toMatchObject({ type: 'bigint', identity: true, nullable: false });
    expect(s.views['public.published_posts']).toBeDefined();
  });
});

describe('Prisma', () => {
  it('reads models with @map/@@map, enums, relations, ids, uniques and indexes', () => {
    const t = fixtureRepo('prisma-db');
    const s = emptySchema();
    const text = t.read('prisma/schema.prisma');
    applyPrisma(s, [{ path: 'prisma/schema.prisma', text }]);
    expect(Object.keys(s.tables).sort()).toEqual(['public.posts', 'public.users']);
    const u = s.tables['public.users']!;
    expect(u.prismaAccessor).toBe('user');
    expect(u.columns.full_name).toMatchObject({ type: 'text', nullable: true, field: 'name' });
    expect(u.columns.created_at).toMatchObject({ type: 'timestamp(3) without time zone', nullable: false });
    expect(u.columns.role!.type).toBe('role');
    expect(u.uniques).toEqual([{ name: 'users_email_key', columns: ['email'] }]);
    const p = s.tables['public.posts']!;
    expect(p.columns.title!.type).toBe('character varying(200)');
    expect(p.foreignKeys).toEqual([
      { name: 'posts_author_id_fkey', columns: ['author_id'], refTable: 'public.users', refColumns: ['id'], onDelete: 'cascade' },
    ]);
    expect(p.uniques[0]!.columns).toEqual(['author_id', 'title']);
    expect(p.indexes[0]).toMatchObject({ name: 'posts_title_idx', columns: ['title'] });
    expect(s.enums['public.Role']).toEqual(['ADMIN', 'USER']);
  });
});

describe('Drizzle', () => {
  it('reads tables, columns, enums, references, indexes and policies', async () => {
    const t = fixtureRepo('drizzle-db');
    const s = emptySchema();
    const r = await applyDrizzle(s, [{ path: 'src/db/schema.ts', text: t.read('src/db/schema.ts') }]);
    expect(r.dialect).toBe('postgres');
    const u = s.tables['public.users']!;
    expect(u.codeNames).toEqual(['users']);
    expect(u.columns.email).toMatchObject({ type: 'character varying(320)', nullable: false });
    expect(u.columns.display_name).toMatchObject({ field: 'displayName', nullable: true });
    expect(u.columns.created_at).toMatchObject({ type: 'timestamp with time zone', nullable: false, default: 'now()' });
    expect(u.indexes[0]).toMatchObject({ name: 'users_email_lower_idx', unique: true, columns: ['email'] });
    const p = s.tables['public.posts']!;
    expect(p.columns.status!.type).toBe('status');
    expect(p.foreignKeys[0]).toMatchObject({ columns: ['author_id'], refTable: 'public.users', refColumns: ['id'], onDelete: 'cascade' });
    expect(p.rls).toBe(true);
    expect(p.policies['authors can read']).toMatchObject({ command: 'select', roles: ['authenticated'] });
    expect(s.enums['public.status']).toEqual(['draft', 'published']);
  });

  it('skips files that only mention table builders in passing', async () => {
    const t = makeRepo();
    t.write('src/notes.ts', 'export const doc = "we use mysql";\n').commitAll();
    const c = await captureFiles(t.dir);
    expect(c.schema).toBeNull();
  });
});

describe('diff', () => {
  const base = `
    create type role as enum ('a', 'b');
    create table orgs (id int primary key, name text);
    create table users (
      id int primary key,
      org_id int references orgs (id),
      email text not null unique,
      nick text,
      age int,
      bio text,
      note text default 'x'
    );
    create index users_nick_idx on users (nick);
    alter table users enable row level security;
    create policy "read own" on users for select using (id = 1);
    create policy "write own" on users for update using (id = 1);
    create view v as select 1;`;

  const cases: [string, string, ChangeKind, 'regression' | 'change'][] = [
    ['drop table', 'drop table orgs cascade;', 'table-dropped', 'regression'],
    ['rename table', 'alter table orgs rename to organisations;', 'table-renamed', 'regression'],
    ['drop column', 'alter table users drop column bio;', 'column-dropped', 'regression'],
    ['rename column', 'alter table users rename column nick to handle;', 'column-renamed', 'regression'],
    ['type change', 'alter table users alter column age type bigint;', 'type-changed', 'regression'],
    ['set not null without default', 'alter table users alter column bio set not null;', 'nullability-changed', 'regression'],
    ['add not null column without default', 'alter table users add column tenant int not null;', 'column-added', 'regression'],
    ['rls off', 'alter table users disable row level security;', 'rls-disabled', 'regression'],
    ['policy removed', 'drop policy "read own" on users;', 'policy-removed', 'regression'],
    ['policy changed', 'alter policy "write own" on users using (true);', 'policy-changed', 'regression'],
    ['enum value removed', "drop type role; create type role as enum ('a');", 'enum-value-removed', 'regression'],
    ['view dropped', 'drop view v;', 'view-dropped', 'regression'],
    ['set not null with default', 'alter table users alter column note set not null;', 'nullability-changed', 'change'],
    ['drop not null', 'alter table users alter column email drop not null;', 'nullability-changed', 'change'],
    ['add nullable column', 'alter table users add column avatar text;', 'column-added', 'change'],
    ['index removed', 'drop index users_nick_idx;', 'index-removed', 'change'],
    ['foreign key removed', 'alter table users drop constraint users_org_id_fkey;', 'foreign-key-removed', 'change'],
    ['unique removed', 'alter table users drop constraint users_email_key;', 'unique-removed', 'change'],
    ['default changed', "alter table users alter column note set default 'y';", 'default-changed', 'change'],
    ['table added', 'create table logs (id int);', 'table-added', 'change'],
    ['policy added', 'create policy "new" on users for insert with check (true);', 'policy-added', 'change'],
    ['enum value added', "alter type role add value 'c';", 'enum-value-added', 'change'],
  ];

  it.each(cases)('%s → %s (%s)', async (_name, change, kind, severity) => {
    const before = await sql(base);
    const after = await sql(base, change);
    const diff = diffSchemas(before, after);
    const hit = diff.find((d) => d.kind === kind);
    expect(hit, JSON.stringify(diff)).toBeDefined();
    expect(hit!.severity).toBe(severity);
    // Nothing else is reported as a regression.
    if (severity === 'change') expect(diff.filter((d) => d.severity === 'regression')).toEqual([]);
  });

  it('reports nothing for an unchanged schema, and renames as renames, not drop + add', async () => {
    const before = await sql(base);
    expect(diffSchemas(before, await sql(base))).toEqual([]);
    const diff = diffSchemas(before, await sql(base, 'alter table users rename column nick to handle;'));
    expect(diff.map((d) => d.kind)).toEqual(['column-renamed']);
    expect(diff[0]).toMatchObject({ column: 'nick', to: 'handle', inferred: false });
  });

  it('infers a column rename from drop + add of the same type (live databases have no rename history)', async () => {
    const before = await sql(base);
    const after = await sql(base, 'alter table users drop column bio; alter table users add column about text;');
    after.renames = [];
    const diff = diffSchemas(before, after);
    expect(diff.map((d) => d.kind)).toEqual(['column-renamed']);
    expect(diff[0]).toMatchObject({ inferred: true, to: 'about' });
  });

  it('does not report a foreign key or index twice when its column was dropped', async () => {
    const diff = diffSchemas(await sql(base), await sql(base, 'alter table users drop column org_id; alter table users drop column nick;'));
    expect(diff.map((d) => d.kind).sort()).toEqual(['column-dropped', 'column-dropped']);
  });

  it('finds drift between a live schema and schema files', async () => {
    const files = await sql(base);
    const live = await sql(base, 'alter table users add column extra int; alter table users alter column age type bigint; drop table orgs cascade;');
    const drift = schemaDrift(live, files).map((d) => d.text);
    expect(drift).toEqual(
      expect.arrayContaining([
        'Table orgs is in the schema files but not in the database (migration not applied?)',
        'Column users.age: database type bigint, schema files say integer',
        'Column users.extra is in the database but not in the schema files',
      ]),
    );
  });
});
