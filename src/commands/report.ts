/** `holdline report`: open the latest HTML report, or list older ones. */
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { HoldlineError } from '../core/errors.js';
import { readJson } from '../core/store.js';
import type { Io } from '../io.js';
import type { ScopedReport } from '../report/model.js';
import { openProject, relativeTime } from './common.js';
import { posix } from '../core/paths.js';
import { plural } from '../plural.js';

export interface ReportOptions {
  list?: boolean;
  /** Which report: a number from --list (1 = newest) or a file name. Default: newest. */
  which?: string;
  /** Don't open a browser, only print the path (also when HOLDLINE_NO_OPEN is set or there is no TTY). */
  noOpen?: boolean;
}

export interface ReportEntry {
  n: number;
  file: string;
  createdAt: string | null;
  task: string | null;
  regressions: number | null;
  outside: number | null;
  broken: number;
}

export interface ReportResult {
  reports: ReportEntry[];
  opened: string | null;
}

/** Stamp → ISO time (20261122T214300123Z → 2026-11-22T21:43:00.123Z). */
function stampTime(name: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z/.exec(name);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z` : null;
}

export async function listReports(root: string): Promise<ReportEntry[]> {
  const dir = path.join(root, '.holdline', 'reports');
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const html = names.filter((n) => n.endsWith('.html')).sort().reverse();
  const out: ReportEntry[] = [];
  for (const [i, name] of html.entries()) {
    const side = await readJson<ScopedReport>(path.join(dir, name.replace(/\.html$/, '.json'))).catch(() => null);
    out.push({
      n: i + 1,
      file: path.join(dir, name),
      createdAt: side?.createdAt ?? stampTime(name),
      task: side?.task ?? null,
      regressions: side?.counts?.regressions ?? null,
      outside: side?.counts?.['outside-scope'] ?? null,
      broken: side?.counts?.['broken-by-task'] ?? 0,
    });
  }
  return out;
}

function opener(): [string, string[]] {
  if (process.platform === 'darwin') return ['open', []];
  if (process.platform === 'win32') return ['cmd', ['/c', 'start', '""']];
  return ['xdg-open', []];
}

export async function reportCommand(cwd: string, opts: ReportOptions, io: Io): Promise<ReportResult> {
  const { root } = await openProject(cwd);
  const reports = await listReports(root);
  const rel = (f: string) => posix(path.relative(cwd, f)) || f;
  if (opts.list) {
    if (!reports.length) io.log('No reports yet. `holdline after` writes one.');
    for (const r of reports) {
      const when = r.createdAt ? relativeTime(r.createdAt) : '';
      const counts = r.regressions === null ? '' : `${plural(r.regressions, 'regression')}, ${r.outside} outside the task${r.broken ? `, ${r.broken} broken by the task's changes` : ''}`;
      io.log(`${String(r.n).padStart(3)}  ${rel(r.file)}  ${io.c.dim(when)}  ${r.task ? `"${r.task}"` : ''}  ${io.c.dim(counts)}`);
    }
    return { reports, opened: null };
  }
  if (!reports.length) throw new HoldlineError('No reports yet. Run `holdline after` first.');
  let pick = reports[0]!;
  if (opts.which) {
    const n = Number(opts.which);
    const found = Number.isInteger(n) ? reports.find((r) => r.n === n) : reports.find((r) => path.basename(r.file) === path.basename(opts.which!) || path.basename(r.file) === `${opts.which}.html`);
    if (!found) throw new HoldlineError(`No report "${opts.which}". See \`holdline report --list\`.`);
    pick = found;
  }
  io.log(rel(pick.file));
  const noOpen = opts.noOpen || Boolean(process.env.HOLDLINE_NO_OPEN) || !io.interactive;
  if (!noOpen) {
    const [cmd, args] = opener();
    try {
      const child = spawn(cmd, [...args, pick.file], { stdio: 'ignore', detached: true, windowsHide: true });
      child.on('error', () => io.warn(`Could not open a browser; open ${rel(pick.file)} yourself.`));
      child.unref();
    } catch {
      io.warn(`Could not open a browser; open ${rel(pick.file)} yourself.`);
    }
  }
  return { reports, opened: pick.file };
}
