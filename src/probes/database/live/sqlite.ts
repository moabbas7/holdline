/**
 * Reads a SQLite schema with Node's built-in node:sqlite, opened read-only (and with
 * query_only on). A missing file is never created. Loaded lazily.
 */
import { existsSync } from 'node:fs';
import { canonSqlite } from '../canon.js';
import { emptySchema, emptyTable, type DbSchema } from '../types.js';

export interface SqliteHandle {
  /** Run a read query. Writes fail: the file is opened read-only. */
  all(sql: string): Record<string, unknown>[];
  exec(sql: string): void;
  close(): void;
}

export async function openSqliteReadOnly(file: string): Promise<SqliteHandle> {
  if (!existsSync(file)) {
    throw Object.assign(new Error('the SQLite file could not be opened (it does not exist)'), { code: 'SQLITE_CANTOPEN' });
  }
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  db.exec('PRAGMA query_only = ON');
  return {
    all: (sql) => db.prepare(sql).all() as Record<string, unknown>[],
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
  };
}

const quoteIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;
const quoteStr = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function introspectSqlite(h: SqliteHandle): DbSchema {
  const s = emptySchema('sqlite');
  const objects = h.all("SELECT type, name, tbl_name AS tbl FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name") as {
    type: string;
    name: string;
    tbl: string;
  }[];
  for (const o of objects) {
    if (o.type === 'view') s.views[`main.${o.name}`] = { materialized: false };
    if (o.type !== 'table' || o.name.startsWith('_prisma_migrations') || o.name === '__drizzle_migrations') continue;
    const t = emptyTable('main', o.name);
    const pk: { name: string; seq: number }[] = [];
    for (const c of h.all(`PRAGMA table_xinfo(${quoteStr(o.name)})`) as {
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
      hidden: number;
    }[]) {
      if (c.hidden === 1) continue;
      t.columns[c.name] = {
        name: c.name,
        type: canonSqlite(c.type || 'blob'),
        nullable: !c.notnull && !c.pk,
        default: c.dflt_value,
        ...(c.dflt_value ? { defaultKey: c.dflt_value.toLowerCase() } : {}),
        ...(c.hidden === 2 || c.hidden === 3 ? { generated: true } : {}),
      };
      if (c.pk) pk.push({ name: c.name, seq: c.pk });
    }
    t.primaryKey = pk.sort((a, b) => a.seq - b.seq).map((p) => p.name);
    const fks = new Map<number, { table: string; from: string[]; to: string[]; onDelete: string }>();
    for (const f of h.all(`PRAGMA foreign_key_list(${quoteStr(o.name)})`) as {
      id: number;
      table: string;
      from: string;
      to: string | null;
      on_delete: string;
    }[]) {
      const fk = fks.get(f.id) ?? { table: f.table, from: [], to: [], onDelete: f.on_delete };
      fk.from.push(f.from);
      if (f.to) fk.to.push(f.to);
      fks.set(f.id, fk);
    }
    for (const fk of fks.values()) {
      t.foreignKeys.push({
        name: `${o.name}_${fk.from.join('_')}_fkey`,
        columns: fk.from,
        refTable: `main.${fk.table}`,
        refColumns: fk.to,
        ...(fk.onDelete && fk.onDelete !== 'NO ACTION' ? { onDelete: fk.onDelete.toLowerCase() } : {}),
      });
    }
    for (const i of h.all(`PRAGMA index_list(${quoteStr(o.name)})`) as { name: string; unique: number; origin: string; partial: number }[]) {
      if (i.origin === 'pk') continue;
      const cols = (h.all(`PRAGMA index_info(${quoteIdent(i.name)})`) as { seqno: number; name: string | null }[])
        .sort((a, b) => a.seqno - b.seqno)
        .map((c) => c.name ?? '<expr>');
      if (i.origin === 'u') t.uniques.push({ name: i.name, columns: cols });
      else t.indexes.push({ name: i.name, columns: cols, unique: Boolean(i.unique) });
    }
    s.tables[`main.${o.name}`] = t;
  }
  return s;
}
