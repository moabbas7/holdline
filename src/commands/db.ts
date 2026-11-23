import { loadConfig, type Config } from '../core/config.js';
import type { Io } from '../io.js';
import { captureSchema, settingsFrom } from '../probes/database/capture.js';
import { schemaDrift, type DriftItem } from '../probes/database/diff.js';
import { describeTarget } from '../probes/database/live/target.js';
import { displayName, type DbSchema, type FilesCapture, type LiveCapture, type Table } from '../probes/database/types.js';
import { openProject } from './common.js';
import { plural } from '../plural.js';

export interface DbOptions {
  json?: boolean;
}

export interface DbResult {
  /** Which schema is shown: the live database when it could be read, else the schema files. */
  source: 'live' | 'files' | 'none';
  live: Omit<LiveCapture, 'schema'>;
  files: Omit<FilesCapture, 'schema'>;
  warnings: string[];
  schema: DbSchema | null;
  /** Schema according to the files, when the live schema is shown. */
  filesSchema: DbSchema | null;
  drift: DriftItem[];
}

export async function dbCommand(cwd: string, opts: DbOptions, io: Io): Promise<DbResult> {
  const { root } = await openProject(cwd);
  let config: Config | null = null;
  try {
    config = await loadConfig(root);
  } catch {
    /* works without `holdline init` */
  }
  const capture = await captureSchema(root, settingsFrom(config));
  const { schema: liveSchema, ...live } = capture.live;
  const { schema: filesSchema, ...files } = capture.files;
  const warnings: string[] = [];
  if (live.message && live.status !== 'ok') warnings.push(live.message);
  warnings.push(...files.warnings.map((w) => `Schema files: ${w}`));
  const result: DbResult = {
    source: liveSchema ? 'live' : filesSchema ? 'files' : 'none',
    live,
    files,
    warnings,
    schema: liveSchema ?? filesSchema,
    filesSchema: liveSchema ? filesSchema : null,
    drift: liveSchema && filesSchema ? schemaDrift(liveSchema, filesSchema) : [],
  };
  if (!opts.json) printDb(result, io);
  else for (const w of warnings) io.warn(w);
  return result;
}

const MAX_TABLES = 200;

function printDb(r: DbResult, io: Io): void {
  const { c } = io;
  for (const w of r.warnings) io.warn(w);
  if (r.source === 'live' && r.live.target) {
    io.log(`${c.bold('Source:')} live database, ${describeTarget(r.live.target)} ${c.dim(`(from ${r.live.target.envVar} in ${r.live.target.envFile}, read-only)`)}`);
    if (r.files.sources.length) io.log(`${c.bold('Schema files:')} ${r.files.sources.map((s) => s.label).join(', ')}`);
  } else if (r.source === 'files') {
    io.log(`${c.bold('Source:')} schema files: ${r.files.sources.map((s) => s.label).join(', ')}`);
    if (r.live.status === 'none') io.log(c.dim('No DATABASE_URL, POSTGRES_URL or DIRECT_URL in .env files; set probes.database.envVar to use another variable.'));
  } else {
    io.log('No schema files (Supabase/SQL migrations, schema.prisma, Drizzle tables) or local database connection found.');
    return;
  }
  const s = r.schema!;
  const keys = Object.keys(s.tables).sort();
  io.log(
    c.dim(
      `${plural(keys.length, 'table')}, ${plural(Object.keys(s.views).length, 'view')}, ` +
        `${plural(Object.keys(s.enums).length, 'enum')} (${s.dialect})`,
    ),
  );
  for (const k of keys.slice(0, MAX_TABLES)) printTable(k, s.tables[k]!, io);
  if (keys.length > MAX_TABLES) io.log(c.dim(`\n…and ${plural(keys.length - MAX_TABLES, 'more table')} (use --json for all)`));
  if (Object.keys(s.enums).length) {
    io.log();
    io.log(c.bold('Enums'));
    for (const [k, v] of Object.entries(s.enums).sort()) io.log(`  ${displayName(k)}: ${v.join(', ')}`);
  }
  if (Object.keys(s.views).length) {
    io.log();
    io.log(c.bold('Views'));
    for (const [k, v] of Object.entries(s.views).sort()) io.log(`  ${displayName(k)}${v.materialized ? c.dim(' (materialized)') : ''}`);
  }
  if (r.source === 'live' && r.filesSchema) {
    io.log();
    if (r.drift.length === 0) io.log(c.green('The live database matches the schema files.'));
    else {
      io.log(c.bold(c.yellow(`The live database and the schema files disagree (${r.drift.length}):`)));
      for (const d of r.drift.slice(0, 50)) io.log(`  ${d.text}`);
      if (r.drift.length > 50) io.log(c.dim(`  …and ${r.drift.length - 50} more`));
    }
  }
}

function printTable(key: string, t: Table, io: Io): void {
  const { c } = io;
  io.log();
  const pol = Object.keys(t.policies).length;
  const rls = t.rls === null ? '' : t.rls ? c.green(` RLS on${pol ? `, ${plural(pol, 'policy', 'policies')}` : ', no policies'}`) : c.yellow(' RLS off');
  io.log(`${c.bold(displayName(key))}${rls}${t.definedIn ? c.dim(`  ${t.definedIn}`) : ''}`);
  const cols = Object.values(t.columns);
  const w = Math.min(28, Math.max(4, ...cols.map((x) => x.name.length)));
  const tw = Math.min(30, Math.max(4, ...cols.map((x) => x.type.length)));
  for (const col of cols) {
    const flags: string[] = [];
    if (t.primaryKey.includes(col.name)) flags.push('PK');
    if (!col.nullable) flags.push('not null');
    if (col.identity) flags.push('identity');
    if (col.generated) flags.push('generated');
    if (col.default) flags.push(`default ${col.default.length > 40 ? col.default.slice(0, 37) + '…' : col.default}`);
    if (t.uniques.some((u) => u.columns.length === 1 && u.columns[0] === col.name)) flags.push('unique');
    const fk = t.foreignKeys.find((f) => f.columns.length === 1 && f.columns[0] === col.name);
    if (fk) flags.push(`→ ${displayName(fk.refTable)}${fk.refColumns.length ? `.${fk.refColumns.join(',')}` : ''}${fk.onDelete ? ` (on delete ${fk.onDelete})` : ''}`);
    io.log(`  ${col.name.padEnd(w)}  ${c.cyan(col.type.padEnd(tw))}  ${c.dim(flags.join(', '))}`);
  }
  if (t.primaryKey.length > 1) io.log(c.dim(`  primary key (${t.primaryKey.join(', ')})`));
  for (const u of t.uniques.filter((x) => x.columns.length > 1)) io.log(c.dim(`  unique (${u.columns.join(', ')})`));
  for (const f of t.foreignKeys.filter((x) => x.columns.length > 1)) io.log(c.dim(`  (${f.columns.join(', ')}) → ${displayName(f.refTable)}(${f.refColumns.join(', ')})`));
  for (const i of t.indexes) io.log(c.dim(`  ${i.unique ? 'unique index' : 'index'} ${i.name} (${i.columns.join(', ')})${i.where ? ` where ${i.where}` : ''}`));
  for (const p of Object.values(t.policies)) {
    io.log(c.dim(`  policy "${p.name}" ${p.command} to ${p.roles.join(', ')}${p.using ? ` using (${p.using})` : ''}${p.check ? ` with check (${p.check})` : ''}`));
  }
}
