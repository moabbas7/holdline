/**
 * The scoped `holdline after` report: findings classified against the task's scope,
 * grouped and ranked, plus a short plain-English summary. This object is also the
 * documented, versioned JSON output (docs/report-schema.md, schema/after-report.v1.json).
 */
import { createHash } from 'node:crypto';
import type { ProbeReport } from '../probes/types.js';
import { SCOPE_RANK, SEVERITY_RANK, type Classification, type ClassifiedFinding, type ScopeArea, type ScopeClass, type Severity } from '../scope/classify.js';

export const REPORT_SCHEMA = 'holdline.after-report';
export const REPORT_SCHEMA_VERSION = 1;
export const ROLLBACK_COMMAND = 'holdline rollback';

export interface ReportFinding {
  /** Stable within a report; derived from probe, title and subject files. */
  id: string;
  probe: string;
  kind: ClassifiedFinding['kind'];
  severity: Severity;
  scope: ScopeClass;
  reason: string;
  title: string;
  detail?: string;
  /** Files the finding is about (subjects). */
  files: string[];
  /** Source locations: callers, lines still reading a removed field or column, errors in check output. */
  lines: { file: string; line: number; text?: string }[];
  /** Extra human-readable lines (dependents, callers, image paths). */
  notes: string[];
  pages?: string[];
  routes?: string[];
  tables?: string[];
  viewports?: string[];
  affects?: string[];
  images?: { before?: string; after?: string; diff?: string };
}

export interface ScopedReport {
  schema: typeof REPORT_SCHEMA;
  schemaVersion: typeof REPORT_SCHEMA_VERSION;
  task: string;
  createdAt: string;
  sessionCreatedAt: string;
  snapshots: { before: string; after: string };
  headMoved: { from: string | null; to: string | null } | null;
  scope: ScopeArea & { globsGiven: string[] };
  regressed: boolean;
  exitCode: 0 | 1;
  counts: Record<ScopeClass, number> & { regressions: number; footer: number };
  summary: string[];
  rollbackCommand: string;
  htmlReport: string | null;
  findings: ReportFinding[];
  probes: { id: string; title: string; status: ProbeReport['status']; summary: string }[];
  ownOutputs: { excluded: string[]; agentEdited: string[]; gitignoreSuggestion: string[] };
}

export interface BuildReportInput {
  task: string;
  sessionCreatedAt: string;
  beforeSha: string;
  afterSha: string;
  headMoved: ScopedReport['headMoved'];
  globs: string[];
  classification: Classification;
  reports: ProbeReport[];
  ownOutputs: ScopedReport['ownOutputs'];
  now?: Date;
}

/** Fixed, still-failing and info findings go to the footer, not the scope groups. */
export const isFooter = (f: { severity: Severity }) => f.severity === 'info';

const PROBE_ORDER = ['checks', 'dependencies', 'database', 'api', 'visual', 'files'];

export function buildReport(i: BuildReportInput): ScopedReport {
  const probeIdx = (p: string) => {
    const n = PROBE_ORDER.indexOf(p);
    return n < 0 ? PROBE_ORDER.length : n;
  };
  const ids = new Map<string, number>();
  const findings: ReportFinding[] = i.classification.findings.map((c, n) => {
    const base = createHash('sha1').update(`${c.probe}\0${c.title}\0${c.files.join('\0')}`).digest('hex').slice(0, 10);
    const seen = ids.get(base) ?? 0;
    ids.set(base, seen + 1);
    const m = c.meta;
    const f: ReportFinding & { _n: number } = {
      _n: n,
      id: seen ? `${c.probe}-${base}-${seen}` : `${c.probe}-${base}`,
      probe: c.probe,
      kind: c.kind,
      severity: c.severity,
      scope: c.scope,
      reason: c.reason,
      title: c.title,
      ...(c.detail ? { detail: c.detail } : {}),
      files: c.files,
      lines: c.locations,
      notes: c.lines ?? [],
      ...(m.pages?.length ? { pages: m.pages } : {}),
      ...(m.routes?.length ? { routes: m.routes } : {}),
      ...(m.tables?.length ? { tables: m.tables } : {}),
      ...(m.viewports?.length ? { viewports: m.viewports } : {}),
      ...(m.affects?.length ? { affects: m.affects } : {}),
      ...(m.images ? { images: m.images } : {}),
    };
    return f;
  });
  findings.sort((a, b) => {
    const fa = isFooter(a) ? 1 : 0;
    const fb = isFooter(b) ? 1 : 0;
    return (
      fa - fb ||
      (fa ? 0 : SCOPE_RANK[b.scope] - SCOPE_RANK[a.scope]) ||
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      probeIdx(a.probe) - probeIdx(b.probe) ||
      (a as unknown as { _n: number })._n - (b as unknown as { _n: number })._n
    );
  });
  for (const f of findings) delete (f as Partial<{ _n: number }>)._n;

  const main = findings.filter((f) => !isFooter(f));
  const regressions = findings.filter((f) => f.kind === 'regression');
  const counts = {
    'outside-scope': main.filter((f) => f.scope === 'outside-scope').length,
    'expected-ripple': main.filter((f) => f.scope === 'expected-ripple').length,
    'in-scope': main.filter((f) => f.scope === 'in-scope').length,
    regressions: regressions.length,
    footer: findings.length - main.length,
  };
  const regressed = regressions.length > 0;
  const report: ScopedReport = {
    schema: REPORT_SCHEMA,
    schemaVersion: REPORT_SCHEMA_VERSION,
    task: i.task,
    createdAt: (i.now ?? new Date()).toISOString(),
    sessionCreatedAt: i.sessionCreatedAt,
    snapshots: { before: i.beforeSha, after: i.afterSha },
    headMoved: i.headMoved,
    scope: { ...i.classification.area, globsGiven: i.globs },
    regressed,
    exitCode: regressed ? 1 : 0,
    counts,
    summary: [],
    rollbackCommand: ROLLBACK_COMMAND,
    htmlReport: null,
    findings,
    probes: i.reports.map((r) => ({ id: r.probeId, title: r.title, status: r.status, summary: r.summary })),
    ownOutputs: i.ownOutputs,
  };
  report.summary = summarize(report);
  return report;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Cut at a word boundary. */
function clip(t: string, max = 60): string {
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.5 ? cut.slice(0, sp) : cut).replace(/[\s,;:(]+$/, '')}…`;
}

/** A short name for a finding in a sentence. */
export function shortTitle(f: ReportFinding): string {
  const t = f.title.replace(/ \[(?:live database|schema files)[^\]]*\]$/, '');
  if (f.probe === 'checks') {
    const m = /^(\w+):/.exec(t);
    if (m) return `the ${m[1]}`;
  }
  if (f.probe === 'dependencies' && f.kind === 'regression' && f.files[0]) return `a broken import in ${f.files[0]}`;
  if ((f.probe === 'api' || f.probe === 'visual') && t.includes(': ')) return clip(t.slice(0, t.indexOf(': ')));
  return clip(t);
}

function listOf(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/** 1–3 plain-English lines. */
export function summarize(r: ScopedReport): string[] {
  const main = r.findings.filter((f) => !isFooter(f));
  const outside = main.filter((f) => f.scope === 'outside-scope');
  const outReg = outside.filter((f) => f.kind === 'regression');
  const outChanges = outside.filter((f) => f.kind !== 'regression');
  const inReg = main.filter((f) => f.scope === 'in-scope' && f.kind === 'regression');
  const rippleReg = main.filter((f) => f.scope === 'expected-ripple' && f.kind === 'regression');
  const edited = r.scope.edited.inScope + r.scope.edited.ripple + r.scope.edited.outside;
  const lines: string[] = [];

  if (outReg.length) {
    const names = outReg.slice(0, 2).map(shortTitle);
    const more = outReg.length > 2 ? ` and ${outReg.length - 2} more` : '';
    lines.push(`The agent broke ${plural(outReg.length, 'thing')} outside the task: ${names.join('; ')}${more}.`);
  } else if (outChanges.length) {
    const editedOutside = r.scope.edited.outside;
    lines.push(
      editedOutside
        ? `Nothing broke, but the agent edited ${plural(editedOutside, 'file')} outside the task area (${plural(outChanges.length, 'change')} to review below).`
        : `Nothing broke, but ${plural(outChanges.length, 'change')} landed outside the task area; review them below.`,
    );
  } else if (edited === 0) {
    lines.push('The agent changed no files, and nothing went from passing to failing.');
  } else {
    lines.push(`Everything the agent changed stays within the task area${inReg.length || rippleReg.length ? '' : ', and nothing went from passing to failing'}.`);
  }
  const fixLines: string[] = [];
  if (inReg.length) fixLines.push(`${plural(inReg.length, 'regression')} inside the task area (${listOf(inReg.slice(0, 2).map(shortTitle))}${inReg.length > 2 ? ', …' : ''})`);
  if (rippleReg.length) fixLines.push(`${plural(rippleReg.length, 'regression')} in code that uses what the task changed (${listOf(rippleReg.slice(0, 2).map(shortTitle))}${rippleReg.length > 2 ? ', …' : ''})`);
  if (fixLines.length) lines.push(`To fix: ${fixLines.join('; ')}.`);
  if (edited > 0) {
    const parts = [`${plural(r.scope.edited.inScope, 'file')} in the task area`];
    if (r.scope.edited.ripple) parts.push(`${r.scope.edited.ripple} next to it (expected ripple)`);
    if (r.scope.edited.outside) parts.push(`${r.scope.edited.outside} outside it`);
    lines.push(`Edited: ${parts.join(', ')}.`);
  }
  return lines.slice(0, 3);
}
