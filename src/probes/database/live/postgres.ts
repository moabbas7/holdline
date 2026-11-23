/**
 * Reads a Postgres schema from the system catalogs. Every query runs inside one
 * READ ONLY transaction with short statement and lock timeouts, which is always rolled
 * back; holdline never writes, migrates or locks user tables. `pg` is loaded lazily.
 */
import type { Client } from 'pg';
import { canonPg, normaliseExpr } from '../canon.js';
import { emptySchema, emptyTable, type DbSchema } from '../types.js';
import type { PgTarget } from './target.js';

export type ReadOnlyQuery = <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<R[]>;

export interface PgOptions {
  statementTimeoutMs: number;
  connectTimeoutMs: number;
}

/** Schemas that belong to Postgres or Supabase itself, not to the project. */
export const INTERNAL_SCHEMAS = [
  'pg_catalog',
  'information_schema',
  'pg_toast',
  'auth',
  'storage',
  'realtime',
  'extensions',
  'graphql',
  'graphql_public',
  'vault',
  'pgsodium',
  'pgsodium_masks',
  'supabase_functions',
  'supabase_migrations',
  '_realtime',
  '_analytics',
  'net',
  'cron',
  'pgbouncer',
  'pgtle',
  '_supavisor',
];

/**
 * Connect, open a READ ONLY transaction, run `fn` with a query function bound to it, then
 * roll back and disconnect. The query function is the only way to reach the connection.
 */
export async function withReadOnlyPostgres<T>(target: PgTarget, opts: PgOptions, fn: (q: ReadOnlyQuery) => Promise<T>): Promise<T> {
  const { default: pg } = await import('pg');
  const client: Client = new pg.Client({
    host: target.host,
    port: target.port,
    user: target.user,
    password: target.password,
    database: target.database,
    ssl: target.ssl,
    connectionTimeoutMillis: opts.connectTimeoutMs,
    query_timeout: opts.statementTimeoutMs + 2000,
    application_name: 'holdline (read-only schema check)',
    // Server-side default as a second guard (honoured by real Postgres servers).
    options: '-c default_transaction_read_only=on',
  });
  // An idle client can emit 'error' (e.g. the server goes away); never crash on it.
  client.on('error', () => {});
  await client.connect();
  try {
    const timeout = Math.max(100, Math.floor(opts.statementTimeoutMs));
    await client.query('BEGIN TRANSACTION READ ONLY');
    await client.query(`SET LOCAL statement_timeout = ${timeout}`);
    await client.query(`SET LOCAL lock_timeout = ${Math.min(timeout, 1000)}`);
    await client.query(`SET LOCAL idle_in_transaction_session_timeout = ${timeout * 4}`);
    const q: ReadOnlyQuery = async (sql, params) => (await client.query(sql, params as unknown[])).rows as never;
    try {
      return await fn(q);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
    }
  } finally {
    await client.end().catch(() => {});
  }
}

const pgArray = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') {
    const inner = v.replace(/^\{|\}$/g, '');
    return inner ? inner.split(',').map((s) => s.replace(/^"|"$/g, '')) : [];
  }
  return [];
};

const FK_ACTION: Record<string, string> = { r: 'restrict', c: 'cascade', n: 'set null', d: 'set default', a: 'no action' };

/** Read tables, columns, keys, indexes, enums, views, RLS and policies through `q`. */
export async function introspectPostgres(q: ReadOnlyQuery, schemas?: string[]): Promise<DbSchema> {
  const filter = schemas?.length
    ? { sql: 'n.nspname = ANY($1::text[])', params: [schemas] }
    : { sql: "NOT (n.nspname = ANY($1::text[])) AND n.nspname NOT LIKE 'pg\\_%'", params: [INTERNAL_SCHEMAS] };
  const s = emptySchema('postgres');

  const rels = await q<{ schema: string; name: string; kind: string; rls: boolean }>(
    `SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind, c.relrowsecurity AS rls
       FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r','p','v','m') AND NOT c.relispartition AND ${filter.sql}
        AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e')
      ORDER BY 1, 2`,
    filter.params,
  );
  for (const r of rels) {
    const key = `${r.schema}.${r.name}`;
    if (r.kind === 'v' || r.kind === 'm') s.views[key] = { materialized: r.kind === 'm' };
    else {
      const t = emptyTable(r.schema, r.name);
      t.rls = r.rls;
      s.tables[key] = t;
    }
  }

  const cols = await q<{ schema: string; table: string; name: string; type: string; notnull: boolean; def: string | null; identity: string; generated: string }>(
    `SELECT n.nspname AS schema, c.relname AS "table", a.attname AS name,
            pg_catalog.format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS notnull,
            pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS def, a.attidentity AS identity, a.attgenerated AS generated
       FROM pg_catalog.pg_attribute a
       JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r','p') AND ${filter.sql}
      ORDER BY 1, 2, a.attnum`,
    filter.params,
  );
  for (const c of cols) {
    const t = s.tables[`${c.schema}.${c.table}`];
    if (!t) continue;
    const def = c.generated ? null : c.def;
    t.columns[c.name] = {
      name: c.name,
      type: canonPg(c.type),
      nullable: !c.notnull,
      default: def,
      ...(def ? { defaultKey: normaliseExpr(def) } : {}),
      ...(c.identity ? { identity: true } : {}),
      ...(c.generated ? { generated: true } : {}),
    };
  }

  const cons = await q<{ schema: string; table: string; name: string; type: string; cols: string[]; refschema: string | null; reftable: string | null; refcols: string[] | null; ondelete: string }>(
    `SELECT n.nspname AS schema, c.relname AS "table", con.conname AS name, con.contype AS type,
            ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(num, ord)
                    JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.num ORDER BY k.ord) AS cols,
            rn.nspname AS refschema, rc.relname AS reftable,
            ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY k(num, ord)
                    JOIN pg_catalog.pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.num ORDER BY k.ord) AS refcols,
            con.confdeltype AS ondelete
       FROM pg_catalog.pg_constraint con
       JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_catalog.pg_class rc ON rc.oid = con.confrelid
       LEFT JOIN pg_catalog.pg_namespace rn ON rn.oid = rc.relnamespace
      WHERE con.contype IN ('p','u','f') AND ${filter.sql}
      ORDER BY 1, 2, 3`,
    filter.params,
  );
  for (const c of cons) {
    const t = s.tables[`${c.schema}.${c.table}`];
    if (!t) continue;
    const columns = pgArray(c.cols);
    if (c.type === 'p') {
      t.primaryKey = columns;
      t.primaryKeyName = c.name;
    } else if (c.type === 'u') t.uniques.push({ name: c.name, columns });
    else if (c.type === 'f') {
      t.foreignKeys.push({
        name: c.name,
        columns,
        refTable: `${c.refschema}.${c.reftable}`,
        refColumns: pgArray(c.refcols),
        ...(c.ondelete && c.ondelete !== 'a' ? { onDelete: FK_ACTION[c.ondelete] } : {}),
      });
    }
  }

  const idx = await q<{ schema: string; table: string; name: string; unique: boolean; cols: string[]; pred: string | null }>(
    `SELECT n.nspname AS schema, c.relname AS "table", ic.relname AS name, i.indisunique AS unique,
            ARRAY(SELECT pg_catalog.pg_get_indexdef(i.indexrelid, k + 1, true) FROM generate_series(0, i.indnkeyatts - 1) k ORDER BY k) AS cols,
            pg_catalog.pg_get_expr(i.indpred, i.indrelid) AS pred
       FROM pg_catalog.pg_index i
       JOIN pg_catalog.pg_class c ON c.oid = i.indrelid
       JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE ${filter.sql}
        AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint con
                         WHERE con.conindid = i.indexrelid AND con.conrelid = i.indrelid AND con.contype IN ('p','u','x'))
      ORDER BY 1, 2, 3`,
    filter.params,
  );
  for (const i of idx) {
    const t = s.tables[`${i.schema}.${i.table}`];
    if (!t) continue;
    t.indexes.push({ name: i.name, columns: pgArray(i.cols).map((c) => c.replace(/^"|"$/g, '')), unique: i.unique, ...(i.pred ? { where: i.pred } : {}) });
  }

  const enums = await q<{ schema: string; name: string; vals: string[] }>(
    `SELECT n.nspname AS schema, t.typname AS name, ARRAY(SELECT e.enumlabel::text FROM pg_catalog.pg_enum e WHERE e.enumtypid = t.oid ORDER BY e.enumsortorder) AS vals
       FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
      WHERE t.typtype = 'e' AND ${filter.sql}
      ORDER BY 1, 2`,
    filter.params,
  );
  for (const e of enums) s.enums[`${e.schema}.${e.name}`] = pgArray(e.vals);

  const pols = await q<{ schema: string; table: string; name: string; permissive: boolean; roles: string[]; cmd: string; qual: string | null; check: string | null }>(
    `SELECT n.nspname AS schema, c.relname AS "table", p.polname AS name, p.polpermissive AS permissive,
            CASE WHEN p.polroles = '{0}' THEN ARRAY['public']::text[]
                 ELSE ARRAY(SELECT r.rolname::text FROM pg_catalog.pg_roles r WHERE r.oid = ANY (p.polroles) ORDER BY 1) END AS roles,
            p.polcmd AS cmd,
            pg_catalog.pg_get_expr(p.polqual, p.polrelid) AS qual,
            pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) AS "check"
       FROM pg_catalog.pg_policy p
       JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE ${filter.sql}
      ORDER BY 1, 2, 3`,
    filter.params,
  );
  const CMD: Record<string, string> = { '*': 'all', r: 'select', a: 'insert', w: 'update', d: 'delete' };
  for (const p of pols) {
    const t = s.tables[`${p.schema}.${p.table}`];
    if (!t) continue;
    t.policies[p.name] = {
      name: p.name,
      command: CMD[p.cmd] ?? p.cmd,
      roles: pgArray(p.roles).sort(),
      permissive: p.permissive,
      using: p.qual,
      check: p.check,
      usingKey: p.qual ? normaliseExpr(p.qual) : null,
      checkKey: p.check ? normaliseExpr(p.check) : null,
    };
  }
  return s;
}
