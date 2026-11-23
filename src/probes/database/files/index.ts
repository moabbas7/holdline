/** Finds schema files in the project and builds the schema they describe. */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { decodeText, listFiles, MAX_FILE_BYTES, SOURCE_EXTS } from '../../dependencies/files.js';
import { emptySchema, type DbSchema, type FilesCapture } from '../types.js';
import { applyDrizzle, looksLikeDrizzle } from './drizzle.js';
import { applyPrisma } from './prisma.js';
import { replaySqlFiles } from './sql.js';

interface SqlGroup {
  label: string;
  re: RegExp;
  /** Skipped when the project has Prisma / Drizzle schemas (it's their generated output). */
  generated?: 'prisma' | 'drizzle';
  exclude?: RegExp;
  onlyAlone?: boolean;
}

/** SQL schema locations, in the order they're applied. */
const SQL_GROUPS: SqlGroup[] = [
  { label: 'supabase/migrations', re: /(^|\/)supabase\/migrations\/[^/]+\.sql$/ },
  { label: 'supabase/schemas', re: /(^|\/)supabase\/schemas\/.+\.sql$/ },
  { label: 'migrations', re: /(^|\/)(db\/|database\/|sql\/)?migrations?\/.+\.sql$/, exclude: /(^|\/)prisma\/migrations\// },
  { label: 'drizzle', re: /(^|\/)drizzle\/[^/]+\.sql$/, generated: 'drizzle' },
  { label: 'prisma/migrations', re: /(^|\/)prisma\/migrations\/[^/]+\/migration\.sql$/, generated: 'prisma' },
  // A schema dump next to migrations is usually a copy of them: replaying it after the
  // migrations would hide changes made to the migrations, so it's only used on its own.
  { label: 'schema.sql', re: /(^|\/)(db\/|database\/|sql\/)?schema\.sql$/, onlyAlone: true },
];

const DOWN_MIGRATION = /(^|[._/-])down\.sql$/i;

export interface SchemaFileSet {
  sql: { group: string; files: string[] }[];
  prisma: string[];
  /** Source files that may define Drizzle tables (by content), filled in by readSchemaFiles. */
  drizzleCandidates: string[];
}

/** Which schema files exist. Cheap: lists files with git and reads only small TS/JS files' text when needed. */
export async function findSchemaFiles(root: string): Promise<SchemaFileSet> {
  const listing = await listFiles(root);
  const paths = [...listing.all].sort();
  const prisma = paths.filter((p) => p.endsWith('.prisma') && !p.includes('/node_modules/'));
  const sqlFiles = paths.filter((p) => p.endsWith('.sql') && !DOWN_MIGRATION.test(p) && !/(^|\/)seed[^/]*\.sql$/.test(p));

  // Drizzle: only files whose text mentions a table builder (a regex, no parsing).
  const drizzleCandidates: string[] = [];
  for (const p of paths) {
    const ext = path.extname(p);
    if (!SOURCE_EXTS.includes(ext) || p.endsWith('.d.ts') || /\.(test|spec)\.[cm]?[jt]sx?$/.test(p)) continue;
    const text = await readSmall(root, p);
    if (text && looksLikeDrizzle(text)) drizzleCandidates.push(p);
  }

  const taken = new Set<string>();
  const sql: SchemaFileSet['sql'] = [];
  for (const g of SQL_GROUPS) {
    if (g.generated === 'prisma' && prisma.length > 0) continue;
    if (g.generated === 'drizzle' && drizzleCandidates.length > 0) continue;
    if (g.onlyAlone && sql.length > 0) continue;
    const files = sqlFiles.filter((p) => !taken.has(p) && g.re.test(p) && !g.exclude?.test(p));
    for (const f of files) taken.add(f);
    if (files.length) sql.push({ group: g.label, files: sortMigrations(files) });
  }
  return { sql, prisma, drizzleCandidates };
}

/** Migration files sort by name within their folder; nested `<n>/up.sql` folders by folder name. */
function sortMigrations(files: string[]): string[] {
  return [...files].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

async function readSmall(root: string, rel: string): Promise<string | null> {
  try {
    const buf = await readFile(path.join(root, rel));
    return buf.length > MAX_FILE_BYTES ? null : decodeText(buf);
  } catch {
    return null;
  }
}

export const hasSchemaFiles = (s: SchemaFileSet) => s.sql.length > 0 || s.prisma.length > 0 || s.drizzleCandidates.length > 0;

/**
 * Build the schema described by the project's files. Sources are merged by table: SQL
 * migrations first, then Prisma, then Drizzle; a table already defined by an earlier
 * source keeps that definition.
 */
export async function captureFiles(root: string, found?: SchemaFileSet): Promise<FilesCapture> {
  const started = Date.now();
  const set = found ?? (await findSchemaFiles(root));
  const warnings: string[] = [];
  const sources: FilesCapture['sources'] = [];
  if (!hasSchemaFiles(set)) return { schema: null, sources, warnings, ms: Date.now() - started };

  const read = async (files: string[]) =>
    (await Promise.all(files.map(async (p) => ({ path: p, text: await readSmall(root, p) })))).filter(
      (f): f is { path: string; text: string } => f.text !== null,
    );

  const parts: DbSchema[] = [];
  if (set.sql.length) {
    const s = emptySchema('postgres');
    for (const g of set.sql) {
      const r = await replaySqlFiles(s, await read(g.files));
      warnings.push(...r.warnings);
      sources.push({ kind: 'sql', label: `${g.group} (${g.files.length} file${g.files.length > 1 ? 's' : ''})`, files: g.files });
    }
    parts.push(s);
  }
  if (set.prisma.length) {
    const s = emptySchema('postgres');
    const { provider } = applyPrisma(s, await read(set.prisma));
    if (provider === 'sqlite') s.dialect = 'sqlite';
    else if (provider === 'mysql') s.dialect = 'mysql';
    if (Object.keys(s.tables).length) {
      sources.push({ kind: 'prisma', label: set.prisma.join(', '), files: set.prisma });
      parts.push(s);
    }
  }
  if (set.drizzleCandidates.length) {
    const s = emptySchema('postgres');
    const { dialect } = await applyDrizzle(s, await read(set.drizzleCandidates));
    if (dialect) s.dialect = dialect;
    const defining = [...new Set(Object.values(s.tables).map((t) => t.definedIn!))].sort();
    if (defining.length) {
      sources.push({ kind: 'drizzle', label: `Drizzle (${defining.join(', ')})`, files: defining });
      parts.push(s);
    }
  }
  if (parts.length === 0) return { schema: null, sources, warnings, ms: Date.now() - started };

  const merged = emptySchema(parts[0]!.dialect);
  for (const p of parts) {
    for (const [k, t] of Object.entries(p.tables)) {
      const existing = merged.tables[k];
      if (!existing) merged.tables[k] = t;
      else {
        if (t.codeNames) existing.codeNames = [...new Set([...(existing.codeNames ?? []), ...t.codeNames])];
        existing.prismaAccessor ??= t.prismaAccessor;
      }
      // Prisma field names / Drizzle keys help find code references even when SQL defines the table.
      if (existing) for (const [c, col] of Object.entries(t.columns)) if (col.field && existing.columns[c] && !existing.columns[c].field) existing.columns[c].field = col.field;
    }
    for (const [k, v] of Object.entries(p.enums)) merged.enums[k] ??= v;
    for (const [k, v] of Object.entries(p.views)) merged.views[k] ??= v;
    merged.renames.push(...p.renames);
  }
  return { schema: merged, sources, warnings, ms: Date.now() - started };
}
