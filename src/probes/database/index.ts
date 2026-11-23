import { readFile } from 'node:fs/promises';
import type { Finding, FindingMeta, Probe, ProbeReport } from '../types.js';
import { captureSchema, dbCaptureFile, describeCapture, readCapture, settingsFrom, writeCapture } from './capture.js';
import { changeKey, diffSchemas, schemaDrift, type SchemaChange } from './diff.js';
import { captureLive } from './live/index.js';
import { describeTarget } from './live/target.js';
import { bareName, emptySchema, type DbCapture, type DbRef, type DbSchema } from './types.js';
import { UsageIndex } from './usage.js';

const MAX_LIST = 15;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const NOT_ROLLED_BACK =
  'Files will be restored, but the database is NOT rolled back. Re-run your migrations or restore the database yourself.';

export const databaseProbe: Probe<DbRef> = {
  id: 'database',
  title: 'Database schema',

  enabled(config) {
    return config.probes?.database?.enabled !== false;
  },

  async snapshot(ctx) {
    ctx.io.progress('  database schema …');
    const started = Date.now();
    const capture = await captureSchema(ctx.root, settingsFrom(ctx.config));
    const ref = await writeCapture(ctx.root, ctx.phase, capture);
    ctx.io.progressDone(ctx.io.c.dim(`Database schema: ${describeCapture(capture)} (${((Date.now() - started) / 1000).toFixed(1)}s)`));
    if (capture.live.message && (capture.live.status === 'refused' || capture.live.status === 'failed')) ctx.io.warn(capture.live.message);
    for (const w of capture.files.warnings.slice(0, 5)) ctx.io.warn(`Schema files: ${w}`);
    return ref;
  },

  async compare(beforeRef, afterRef, ctx) {
    const skipped = (why: string): ProbeReport => ({ probeId: 'database', title: this.title, status: 'skipped', summary: why, findings: [] });
    const b = await readCapture(ctx.root, beforeRef);
    if ('error' in b) return skipped(`schema from \`holdline before\` unavailable (${b.error}); run before again`);
    const a = await readCapture(ctx.root, afterRef);
    if ('error' in a) return skipped(`schema from \`holdline after\` unavailable (${a.error})`);
    return compareCaptures(b.capture, a.capture, {
      title: this.title,
      usage: () => UsageIndex.build(ctx.root, ctx.config.projectType),
    });
  },

  async rollbackWarnings(beforeRef, ctx) {
    const b = await readCapture(ctx.root, beforeRef);
    if ('error' in b || !b.capture.live.schema) return [];
    const before = b.capture.live.schema;
    let now: DbSchema | undefined;
    const fresh = await captureLive(ctx.root, settingsFrom(ctx.config));
    if (fresh.status === 'ok') now = fresh.schema;
    else {
      // Can't reach the database now: fall back to what `holdline after` saw.
      try {
        const after = JSON.parse(await readFile(dbCaptureFile(ctx.root, 'after'), 'utf8')) as DbCapture;
        now = after.live.schema;
      } catch {
        /* no after capture */
      }
    }
    if (!now) return [];
    const changes = diffSchemas(before, now);
    if (changes.length === 0) return [];
    const list = changes.slice(0, MAX_LIST).map((c) => `  - ${c.text}`);
    if (changes.length > MAX_LIST) list.push(`  …and ${changes.length - MAX_LIST} more`);
    return [
      `Files will be restored, but the database is NOT rolled back. holdline saw ${plural(changes.length, 'change')} in the live database since \`holdline before\`:`,
      ...list,
      'Re-run your migrations or restore the database yourself. (holdline never writes to the database.)',
    ];
  },
};

type Origin = 'live' | 'files';

export interface CompareOptions {
  title?: string;
  /** Builds the dependency graph lookup; only called when there are changes. */
  usage?: () => Promise<UsageIndex>;
}

/** Compare two captures: live ↔ live and files ↔ files, merged, plus drift and code usage. */
export async function compareCaptures(b: DbCapture, a: DbCapture, opts: CompareOptions = {}): Promise<ProbeReport> {
  const title = opts.title ?? 'Database schema';
  const notes: Finding[] = [];
  const bl = b.live.schema;
  const al = a.live.schema;
  const liveCompared = Boolean(bl && al);
  const filesCompared = Boolean(b.files.schema || a.files.schema);

  if (!liveCompared && !filesCompared) {
    return { probeId: 'database', title, status: 'skipped', summary: 'no schema files or database connection found', findings: [] };
  }
  if (Boolean(bl) !== Boolean(al)) {
    const why = (al ? b : a).live.message ?? 'the database was not reachable';
    notes.push({ kind: 'info', title: `The live database was read only during \`holdline ${bl ? 'before' : 'after'}\`, so only schema files were compared (${why})` });
  } else if (!bl && a.live.message && (a.live.status === 'refused' || a.live.status === 'failed')) {
    notes.push({ kind: 'info', title: a.live.message });
  }
  for (const w of a.files.warnings) notes.push({ kind: 'info', title: `Schema files: ${w}` });

  const liveChanges = liveCompared ? diffSchemas(bl!, al!) : [];
  const fileChanges = filesCompared ? diffSchemas(b.files.schema ?? emptySchema(), a.files.schema ?? emptySchema()) : [];

  const merged = new Map<string, { change: SchemaChange; origins: Set<Origin> }>();
  for (const [list, origin] of [
    [liveChanges, 'live'],
    [fileChanges, 'files'],
  ] as const) {
    for (const c of list) {
      const k = changeKey(c);
      const m = merged.get(k);
      if (m) {
        m.origins.add(origin);
        if (c.severity === 'regression') m.change.severity = 'regression';
      } else merged.set(k, { change: { ...c }, origins: new Set([origin]) });
    }
  }
  const items = [...merged.values()].sort((x, y) => (x.change.severity === y.change.severity ? 0 : x.change.severity === 'regression' ? -1 : 1));

  // Code that uses changed tables.
  const usageKinds = new Set<SchemaChange['kind']>([
    'table-dropped', 'table-renamed', 'column-dropped', 'column-renamed', 'type-changed', 'nullability-changed', 'column-added',
    'rls-disabled', 'policy-removed', 'policy-changed', 'foreign-key-removed', 'unique-removed', 'primary-key-changed', 'view-dropped',
  ]);
  const needsUsage = items.some((i) => i.change.table && usageKinds.has(i.change.kind) && (i.change.kind !== 'column-added' || i.change.severity === 'regression'));
  let usage: UsageIndex | null = null;
  if (needsUsage && opts.usage) {
    try {
      usage = await opts.usage();
    } catch {
      usage = null;
    }
  }
  const beforeSchema = b.files.schema ?? bl ?? null;
  const describedTables = new Set<string>();
  const findings: Finding[] = [];
  let regressions = 0;
  for (const { change: c, origins } of items) {
    const label = liveCompared && filesCompared ? ` [${[...origins].map((o) => (o === 'live' ? 'live database' : 'schema files')).join(' + ')}]` : '';
    const lines: string[] = [];
    const meta: FindingMeta = c.table ? { tables: [bareName(c.table)] } : {};
    // An added column only matters to existing code when inserts that omit it will fail.
    const wantsUsage = usageKinds.has(c.kind) && (c.kind !== 'column-added' || c.severity === 'regression');
    if (usage && c.table && wantsUsage) {
      const u = usage.tableUsage(c.table);
      if (u) {
        meta.affects = u.directFiles;
        if (c.kind === 'column-dropped' || c.kind === 'column-renamed') {
          const refs = await usage.columnRefs(u.directFiles, beforeSchema, c.table, c.column!);
          meta.locations = refs.map((r) => ({ file: r.file, line: r.line, text: r.text }));
          for (const r of refs.slice(0, 10)) lines.push(`✗ ${r.file}:${r.line} still references ${c.column} (${r.text})`);
          if (refs.length > 10) lines.push(`…and ${refs.length - 10} more references`);
        }
        if (describedTables.has(c.table)) lines.push(`used by ${u.summary} (listed above)`);
        else {
          describedTables.add(c.table);
          lines.push(`still used by ${u.summary}:`, ...u.lines.map((l) => `  ${l}`));
        }
      }
    }
    if (c.severity === 'regression') regressions++;
    findings.push({ kind: c.severity, title: c.text + label, ...(lines.length ? { lines } : {}), ...(Object.keys(meta).length ? { meta } : {}) });
  }

  // The live database changed: rollback won't undo that.
  if (liveChanges.length > 0) {
    const list = liveChanges.slice(0, MAX_LIST).map((c) => c.text);
    if (liveChanges.length > MAX_LIST) list.push(`…and ${liveChanges.length - MAX_LIST} more`);
    notes.push({
      kind: 'info',
      title: `The live database schema changed during the task. \`holdline rollback\` restores files only: ${NOT_ROLLED_BACK.replace('Files will be restored, but the', 'the')}`,
      lines: list,
    });
  }

  // Drift between the database and the schema files.
  if (al && a.files.schema) {
    const driftAfter = schemaDrift(al, a.files.schema);
    const before = new Set(bl && b.files.schema ? schemaDrift(bl, b.files.schema).map((d) => d.key) : []);
    const fresh = driftAfter.filter((d) => !before.has(d.key));
    const old = driftAfter.filter((d) => before.has(d.key));
    for (const d of fresh.slice(0, MAX_LIST)) {
      const table = /^[^:]+:([^.]+\.[^.]+)/.exec(d.key)?.[1];
      findings.push({ kind: 'change', title: `Drift: ${d.text}`, ...(table ? { meta: { tables: [bareName(table)] } } : {}) });
    }
    if (fresh.length > MAX_LIST) findings.push({ kind: 'info', title: `…and ${fresh.length - MAX_LIST} more differences between the database and the schema files` });
    if (old.length) {
      notes.push({
        kind: 'info',
        title: `${plural(old.length, 'difference')} between the live database and the schema files already existed before the task (run \`holdline db\` to see them)`,
      });
    }
  }

  const changes = findings.filter((f) => f.kind === 'change').length;
  const source = liveCompared ? (filesCompared ? 'live database + schema files' : 'live database') : 'schema files';
  let summary: string;
  if (regressions === 0 && changes === 0) summary = `no schema changes (${source})`;
  else {
    const parts: string[] = [];
    if (regressions) parts.push(plural(regressions, 'breaking schema change'));
    if (changes) parts.push(plural(changes, 'other schema change'));
    summary = `${parts.join(', ')} (${source})`;
  }
  return {
    probeId: 'database',
    title,
    status: regressions > 0 ? 'regressed' : changes > 0 ? 'changed' : 'ok',
    summary,
    findings: [...findings, ...notes],
  };
}

export { describeTarget };
