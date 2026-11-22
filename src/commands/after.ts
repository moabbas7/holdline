import path from 'node:path';
import { loadConfig } from '../core/config.js';
import { HoldlineError } from '../core/errors.js';
import { headSha, objectExists } from '../core/git.js';
import { readSession, type Session } from '../core/session.js';
import { createSnapshot } from '../core/snapshot.js';
import { stamp, writeJson } from '../core/store.js';
import type { Io } from '../io.js';
import { enabledProbes } from '../probes/registry.js';
import type { Finding, ProbeContext, ProbeReport } from '../probes/types.js';
import { locked, preflightLargeFiles, relativeTime, short } from './common.js';

export interface AfterOptions {
  json?: boolean;
}

export interface AfterReport {
  task: string;
  beforeSnapshot: string;
  afterSnapshot: string;
  sessionCreatedAt: string;
  headMoved: { from: string | null; to: string | null } | null;
  regressed: boolean;
  reports: ProbeReport[];
}

export async function afterCommand(cwd: string, opts: AfterOptions, io: Io): Promise<AfterReport> {
  return locked(cwd, 'after', io, async (project) => {
    const { repo, root, paths } = project;
    const config = await loadConfig(root);
    const session = await requireSession(root);
    if (!(await objectExists(repo, session.snapshot.sha))) {
      throw new HoldlineError(`The "before" snapshot ${short(session.snapshot.sha)} is missing from git.`);
    }

    await preflightLargeFiles(project, config.largeUntrackedWarnMB, io, { canCancel: false });
    const snap = await createSnapshot(repo, 'after');

    const runDir = path.join(paths.runs, `${stamp()}-after`);
    const reports: ProbeReport[] = [];
    if (config.checks && Object.values(config.checks).some(Boolean)) io.log('Running checks:');
    for (const probe of enabledProbes(config)) {
      const ctx: ProbeContext = { repo, root, config, snapshotSha: snap.sha, phase: 'after', runDir, io };
      const afterData = await probe.snapshot(ctx);
      if (!(probe.id in session.probes)) {
        reports.push({
          probeId: probe.id,
          title: probe.title,
          status: 'skipped',
          summary: 'not captured by `holdline before`; run before again to include it',
          findings: [],
        });
        continue;
      }
      reports.push(await probe.compare(session.probes[probe.id], afterData, ctx));
    }

    const head = await headSha(repo);
    const report: AfterReport = {
      task: session.task,
      beforeSnapshot: session.snapshot.sha,
      afterSnapshot: snap.sha,
      sessionCreatedAt: session.createdAt,
      headMoved: head !== session.snapshot.head ? { from: session.snapshot.head, to: head } : null,
      regressed: reports.some((r) => r.status === 'regressed'),
      reports,
    };
    await writeJson(path.join(runDir, 'report.json'), report);
    await writeJson(paths.lastReport, report);
    printReport(report, io);
    return report;
  });
}

export async function requireSession(root: string): Promise<Session> {
  const session = await readSession(root);
  if (!session) {
    throw new HoldlineError('No snapshot yet. Run `holdline before --task "<description>"` first.');
  }
  return session;
}

const MARK: Record<Finding['kind'], string> = {
  regression: '✗',
  fixed: '✓',
  'still-failing': '•',
  change: '',
  info: 'i',
};

function indent(text: string, maxLines: number): string {
  const lines = text.split('\n');
  const shown = lines.length > maxLines ? ['…', ...lines.slice(-maxLines)] : lines;
  return shown.map((l) => `      ${l}`).join('\n');
}

export function printReport(r: AfterReport, io: Io): void {
  io.log();
  io.log(`${io.c.bold('Task:')} "${r.task}"  ${io.c.dim(`(snapshot ${short(r.beforeSnapshot)}, ${relativeTime(r.sessionCreatedAt)})`)}`);
  if (r.headMoved) {
    io.log(
      io.c.yellow(
        `HEAD moved during the task: ${short(r.headMoved.from)} → ${short(r.headMoved.to)} (the agent may have committed or switched branches).`,
      ),
    );
  }
  for (const rep of r.reports) {
    io.log();
    const head =
      rep.status === 'regressed' ? io.c.red(rep.summary) : rep.status === 'skipped' ? io.c.dim(rep.summary) : rep.summary;
    io.log(`${io.c.bold(rep.title)}: ${head}`);
    for (const f of rep.findings) {
      const paint =
        f.kind === 'regression' ? io.c.red : f.kind === 'fixed' ? io.c.green : f.kind === 'change' ? (s: string) => s : io.c.dim;
      io.log(`  ${paint(f.kind === 'change' ? f.title : `${MARK[f.kind]} ${f.title}`)}`);
      if (f.kind === 'regression' && f.detail) io.log(io.c.dim(indent(f.detail, 15)));
    }
  }
  io.log();
  if (r.regressed) {
    const n = r.reports.flatMap((x) => x.findings).filter((f) => f.kind === 'regression').length;
    io.log(io.c.red(io.c.bold(`${n} regression${n > 1 ? "s" : ""} since the snapshot.`)) + ` Undo all changes with ${io.c.bold('holdline rollback')}.`);
  } else {
    io.log(io.c.green('Nothing went from passing to failing.'));
  }
}
