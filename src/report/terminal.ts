/** Prints the scoped `holdline after` report. */
import { relativeTime, short } from '../commands/common.js';
import type { Io } from '../io.js';
import type { ScopeClass } from '../scope/classify.js';
import { isFooter, type ReportFinding, type ScopedReport } from './model.js';

export interface PrintOptions {
  /** Expand the in-scope group and show notes in the footer. */
  all?: boolean;
}

const MAX_NOTES = 10;
const MAX_FOOTER = 10;

function indent(text: string, maxLines: number): string[] {
  const lines = text.split('\n');
  const shown = lines.length > maxLines ? ['…', ...lines.slice(-maxLines)] : lines;
  return shown.map((l) => `      ${l}`);
}

export function scopeLine(r: ScopedReport): string {
  const s = r.scope;
  const parts: string[] = [];
  for (const t of s.terms.slice(0, 6)) {
    const bits: string[] = [];
    if (t.files) bits.push(`${t.files} file${t.files === 1 ? '' : 's'}`);
    if (t.routes.length) bits.push(t.routes.join(', '));
    if (t.tables.length) bits.push(`table ${t.tables.join(', ')}`);
    parts.push(`"${t.text}" (${bits.join(', ')})`);
  }
  if (s.terms.length > 6) parts.push(`…${s.terms.length - 6} more`);
  for (const g of s.globs) parts.push(`--scope ${g.glob} (${g.files} file${g.files === 1 ? '' : 's'})`);
  if (s.fallback) return "the task text matched nothing in the project; the agent's edits are taken as the task area";
  return parts.join(', ');
}

function printFinding(f: ReportFinding, io: Io): void {
  const mark = f.kind === 'regression' ? '✗ ' : f.kind === 'fixed' ? '✓ ' : f.kind === 'still-failing' ? '• ' : f.kind === 'info' ? 'i ' : '~ ';
  const paint = f.kind === 'regression' ? io.c.red : f.kind === 'fixed' ? io.c.green : f.kind === 'change' ? (s: string) => s : io.c.dim;
  io.log(`  ${paint(`${mark}${f.title}`)}`);
  io.log(io.c.dim(`      why: ${f.reason}`));
  if (f.kind === 'regression' && f.detail) for (const l of indent(f.detail, 15)) io.log(io.c.dim(l));
  const notes = f.notes;
  for (const line of notes.slice(0, MAX_NOTES)) io.log(io.c.dim(`      ${line}`));
  if (notes.length > MAX_NOTES) io.log(io.c.dim(`      …and ${notes.length - MAX_NOTES} more lines (see the HTML report)`));
}

const HEADINGS: Record<ScopeClass, string> = {
  'outside-scope': 'Outside the task',
  'broken-by-task': "Broken by the task's changes",
  'expected-ripple': 'Expected ripple',
  'in-scope': 'In the task area',
};

export function printScopedReport(r: ScopedReport, io: Io, opts: PrintOptions = {}): void {
  io.log();
  io.log(`${io.c.bold('Task:')} "${r.task}"  ${io.c.dim(`(snapshot ${short(r.snapshots.before)}, ${relativeTime(r.sessionCreatedAt)})`)}`);
  io.log(`${io.c.bold('Scope:')} ${scopeLine(r)}`);
  if (r.scope.dropped.length) {
    io.log(io.c.dim(`       ignored as too common: ${r.scope.dropped.slice(0, 5).map((d) => `"${d.text}" (${d.why.replace(/,.*$/, '')})`).join(', ')}`));
  }
  if (r.headMoved) {
    io.log(
      io.c.yellow(
        `HEAD moved during the task: ${short(r.headMoved.from)} → ${short(r.headMoved.to)} (the agent may have committed or switched branches).`,
      ),
    );
  }

  io.log();
  io.log(io.c.dim('Checked:'));
  for (const p of r.probes) {
    const s = p.status === 'regressed' ? io.c.red(p.summary) : p.summary;
    io.log(io.c.dim(`  ${p.title}: `) + (p.status === 'skipped' ? io.c.dim(p.summary) : s));
  }

  const main = r.findings.filter((f) => !isFooter(f));
  for (const scope of ['outside-scope', 'broken-by-task', 'expected-ripple', 'in-scope'] as const) {
    const group = main.filter((f) => f.scope === scope);
    if (scope === 'in-scope') {
      const regs = group.filter((f) => f.kind === 'regression');
      const rest = group.filter((f) => f.kind !== 'regression');
      if (!group.length) continue;
      io.log();
      if (opts.all) {
        io.log(io.c.bold(`${HEADINGS[scope]} (${group.length})`));
        for (const f of group) printFinding(f, io);
      } else {
        if (regs.length) {
          io.log(io.c.bold(`${HEADINGS[scope]}: ${regs.length} regression${regs.length === 1 ? '' : 's'}`));
          for (const f of regs) printFinding(f, io);
        }
        if (rest.length) {
          io.log(`${io.c.bold(regs.length ? '  and' : HEADINGS[scope] + ':')} ${rest.length} change${rest.length === 1 ? '' : 's'} ${io.c.dim('(holdline after --all to list them)')}`);
        }
      }
      continue;
    }
    if (!group.length) continue;
    io.log();
    const title = `${HEADINGS[scope]} (${group.length})`;
    io.log((scope === 'outside-scope' || scope === 'broken-by-task') && group.some((f) => f.kind === 'regression') ? io.c.red(io.c.bold(title)) : io.c.bold(title));
    for (const f of group) printFinding(f, io);
  }

  const footer = r.findings.filter(isFooter);
  const shown = footer.filter((f) => opts.all || f.kind === 'fixed' || f.kind === 'still-failing');
  if (shown.length) {
    io.log();
    io.log(io.c.bold('Also'));
    for (const f of shown.slice(0, opts.all ? shown.length : MAX_FOOTER)) {
      const mark = f.kind === 'fixed' ? io.c.green('✓') : f.kind === 'still-failing' ? '•' : 'i';
      io.log(`  ${mark} ${io.c.dim(f.title)}`);
      if (opts.all) for (const line of f.notes.slice(0, MAX_NOTES)) io.log(io.c.dim(`      ${line}`));
    }
    if (!opts.all && shown.length > MAX_FOOTER) io.log(io.c.dim(`  …and ${shown.length - MAX_FOOTER} more`));
  }
  const notes = footer.length - shown.length;
  if (notes > 0) io.log(io.c.dim(`  ${notes} note${notes === 1 ? '' : 's'} (holdline after --all, or the HTML report)`));

  if (r.ownOutputs.excluded.length) {
    io.log();
    const n = r.ownOutputs.excluded.length;
    io.log(
      io.c.yellow(
        `${n} file${n === 1 ? ' was' : 's were'} written by your own checks during \`holdline before\` (build output that isn't git-ignored), so ${n === 1 ? 'it was' : 'they were'} not counted as agent changes.`,
      ),
    );
    io.log(`  Add to .gitignore: ${r.ownOutputs.gitignoreSuggestion.map((l) => io.c.bold(l)).join('  ')}`);
  }

  io.log();
  for (const line of r.summary) io.log(r.regressed && line === r.summary[0] ? io.c.red(io.c.bold(line)) : io.c.bold(line));
  io.log(`Undo everything: ${io.c.bold(r.rollbackCommand)}`);
  if (r.htmlReport) io.log(io.c.dim(`Report: ${r.htmlReport}  (holdline report to open it)`));
}
