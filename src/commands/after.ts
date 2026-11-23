import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, type Config } from '../core/config.js';
import { HoldlineError } from '../core/errors.js';
import { headSha, objectExists, type RepoInfo } from '../core/git.js';
import { gitignoreSuggestion, splitOwnOutputs, topLevelNames } from '../core/ownOutputs.js';
import { readSession, type Session } from '../core/session.js';
import { createSnapshot, diffSnapshots } from '../core/snapshot.js';
import { stamp, storePaths, writeJson } from '../core/store.js';
import type { Io } from '../io.js';
import { recallGraph } from '../probes/dependencies/graph.js';
import { readGraph } from '../probes/dependencies/store.js';
import type { DepGraph, DepGraphRef } from '../probes/dependencies/types.js';
import { DevServerPool } from '../probes/devServer.js';
import { enabledProbes } from '../probes/registry.js';
import type { ProbeContext, ProbeReport } from '../probes/types.js';
import { renderHtml } from '../report/html.js';
import { buildReport, type ScopedReport } from '../report/model.js';
import { printScopedReport } from '../report/terminal.js';
import { classify } from '../scope/classify.js';
import { matchTask, snapshotFiles } from '../scope/taskScope.js';
import { locked, preflightLargeFiles, short } from './common.js';

export interface AfterOptions {
  json?: boolean;
  /** Expand the in-scope group (and notes) in the terminal report. */
  all?: boolean;
  /** Don't write the HTML report (tests). */
  noHtml?: boolean;
}

export interface AfterReport {
  task: string;
  beforeSnapshot: string;
  afterSnapshot: string;
  sessionCreatedAt: string;
  headMoved: { from: string | null; to: string | null } | null;
  regressed: boolean;
  /** Each probe's own report, unclassified. */
  reports: ProbeReport[];
  /** The classified report (also what --json prints). */
  scoped: ScopedReport;
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
    const own = await splitOwnOutputs(repo, snap.sha, session.ownOutputs);
    const ownOutputs = { excluded: new Set(own.excluded), edited: new Set(own.edited) };

    const runStamp = stamp();
    const runDir = path.join(paths.runs, `${runStamp}-after`);
    const reports: ProbeReport[] = [];
    if (config.checks && Object.values(config.checks).some(Boolean)) io.log('Running checks:');
    const devServers = new DevServerPool();
    try {
      for (const probe of enabledProbes(config)) {
        const ctx: ProbeContext = { repo, root, config, snapshotSha: snap.sha, phase: 'after', runDir, io, devServers, ownOutputs };
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
    } finally {
      await devServers.dispose();
    }

    const head = await headSha(repo);
    const headMoved = head !== session.snapshot.head ? { from: session.snapshot.head, to: head } : null;
    const scoped = await scopeReport({ repo, root, config, session, afterSha: snap.sha, reports, headMoved, own });

    if (!opts.noHtml) {
      const file = await writeHtmlReport(root, runStamp, scoped);
      scoped.htmlReport = path.relative(root, file).split(path.sep).join('/');
    }
    const report: AfterReport = {
      task: session.task,
      beforeSnapshot: session.snapshot.sha,
      afterSnapshot: snap.sha,
      sessionCreatedAt: session.createdAt,
      headMoved,
      regressed: scoped.regressed,
      reports,
      scoped,
    };
    await writeJson(path.join(runDir, 'report.json'), scoped);
    await writeJson(paths.lastReport, scoped);
    if (scoped.htmlReport) await writeJson(path.join(paths.reports, `${runStamp}.json`), scoped);
    printScopedReport(scoped, io, { all: opts.all });
    return report;
  });
}

interface ScopeReportInput {
  repo: RepoInfo;
  root: string;
  config: Config;
  session: Session;
  afterSha: string;
  reports: ProbeReport[];
  headMoved: AfterReport['headMoved'];
  own: { excluded: string[]; edited: string[] };
}

/** Classify every finding against the task's scope and build the report. */
async function scopeReport(i: ScopeReportInput): Promise<ScopedReport> {
  const { repo, root, session } = i;
  const beforeFiles = await snapshotFiles(repo, session.snapshot.sha);
  const afterFiles = await snapshotFiles(repo, i.afterSha);
  const depsRef = session.probes.dependencies as DepGraphRef | undefined;
  let beforeGraph: DepGraph | null = null;
  if (depsRef) {
    const g = await readGraph(root, depsRef);
    if ('graph' in g) beforeGraph = g.graph;
  }
  const afterGraph = recallGraph(root, i.afterSha);
  // Sessions from older versions have no scope: compute it now from the "before" state.
  const scope = session.scope ?? matchTask(session.task, [], { files: beforeFiles, graph: beforeGraph });
  const excluded = new Set(i.own.excluded);
  const edited = (await diffSnapshots(repo, session.snapshot.sha, i.afterSha)).filter((c) => !excluded.has(c.path));
  const visual = i.config.probes?.visual as { failOnUnexpectedChange?: unknown } | undefined;
  const classification = classify({
    scope,
    beforeFiles,
    afterFiles,
    beforeGraph,
    afterGraph,
    edited: edited.map((c) => ({ path: c.path, status: c.status, ...(c.oldPath ? { oldPath: c.oldPath } : {}) })),
    ownEdited: new Set(i.own.edited),
    reports: i.reports,
    failOnUnexpectedVisual: visual?.failOnUnexpectedChange === true,
    root,
  });
  const tops = i.own.excluded.length ? await topLevelNames(repo, session.snapshot.sha) : new Set<string>();
  return buildReport({
    task: session.task,
    sessionCreatedAt: session.createdAt,
    beforeSha: session.snapshot.sha,
    afterSha: i.afterSha,
    headMoved: i.headMoved,
    globs: scope.globs,
    classification,
    reports: i.reports,
    ownOutputs: {
      excluded: i.own.excluded,
      agentEdited: i.own.edited,
      gitignoreSuggestion: i.own.excluded.length ? gitignoreSuggestion(i.own.excluded, tops) : [],
    },
  });
}

/** Write .holdline/reports/<stamp>.html. */
export async function writeHtmlReport(root: string, runStamp: string, scoped: ScopedReport): Promise<string> {
  const dir = storePaths(root).reports;
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${runStamp}.html`);
  scoped.htmlReport = path.relative(root, file).split(path.sep).join('/');
  await writeFile(file, await renderHtml(scoped, root));
  return file;
}

export async function requireSession(root: string): Promise<Session> {
  const session = await readSession(root);
  if (!session) {
    throw new HoldlineError('No snapshot yet. Run `holdline before --task "<description>"` first.');
  }
  return session;
}

