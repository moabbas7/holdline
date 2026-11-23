import path from 'node:path';
import { configHash, matchCandidate, saveCandidate, type BaselineCandidate } from '../core/baseline.js';
import { loadConfig, type Config } from '../core/config.js';
import { CancelledError, HoldlineError } from '../core/errors.js';
import { DEFAULT_KEEP, pruneHistory } from '../core/prune.js';
import { readSession, writeSession, type Session } from '../core/session.js';
import { createSnapshot, refName, type SnapshotInfo } from '../core/snapshot.js';
import { ensureGitignore, stamp } from '../core/store.js';
import type { Io } from '../io.js';
import { DevServerPool } from '../probes/devServer.js';
import { enabledProbes } from '../probes/registry.js';
import type { BaselineTag, ProbeContext } from '../probes/types.js';
import { changesSince, gitignoreSuggestion, topLevelNames, worktreeTree, type OwnOutputs } from '../core/ownOutputs.js';
import { recallGraph } from '../probes/dependencies/graph.js';
import { readGraph } from '../probes/dependencies/store.js';
import type { DepGraph, DepGraphRef } from '../probes/dependencies/types.js';
import { matchTask, snapshotFiles, type TaskScope } from '../scope/taskScope.js';
import { locked, preflightLargeFiles, short, type Project } from './common.js';

/** One line: what the task text and globs matched. */
export function describeScope(scope: TaskScope): string {
  const hits = scope.terms.filter((t) => !t.dropped && (t.files.length || t.routes.length || t.tables.length));
  const parts = hits.slice(0, 6).map((t) => `"${t.text}" → ${t.files.length} file${t.files.length === 1 ? '' : 's'}`);
  if (hits.length > 6) parts.push(`…${hits.length - 6} more`);
  for (const g of scope.globs) parts.push(`--scope ${g}`);
  const dropped = scope.terms.filter((t) => t.dropped).map((t) => `"${t.text}"`);
  let line = parts.length ? parts.join(', ') : "nothing in the task text matched the project; the files the agent edits will be taken as the task area (add --scope '<glob>' to be explicit)";
  if (dropped.length) line += ` (too common to use: ${dropped.slice(0, 4).join(', ')})`;
  return line;
}

export interface BeforeOptions {
  task: string;
  /** Replace an existing session without asking. */
  force?: boolean;
  /** Non-interactive: replace an existing session and continue past warnings. */
  yes?: boolean;
  /** Globs that are part of the task (repeatable --scope). */
  scope?: string[];
  /**
   * Reuse the probe results of the last `after` (or the background run at session start)
   * when the working tree is exactly the state they checked, instead of re-running them.
   */
  reuseBaseline?: boolean;
}

export interface CapturedBaseline {
  snap: SnapshotInfo;
  runDir: string;
  results: Record<string, unknown>;
  /** Files the checks of this run wrote that git doesn't ignore. */
  ownOutputs: OwnOutputs;
  /** Probe ids whose results came from a reused baseline, and where it came from. */
  reused: { source: BaselineCandidate['source']; probes: string[] } | null;
}

/**
 * Snapshot the working tree and capture every enabled probe: the shared core of `before`
 * and the background baseline run. With `reuse`, probes whose results were recorded for
 * exactly this working tree are restored instead of run.
 */
export async function captureBaseline(
  project: Project,
  config: Config,
  io: Io,
  opts: { label: 'before' | 'warm'; reuse?: boolean },
): Promise<CapturedBaseline> {
  const { repo, root, paths } = project;
  const tag: BaselineTag = opts.label;
  const snap = await createSnapshot(repo, opts.label, { setRef: opts.label === 'before' });
  if (opts.label === 'before') {
    io.log(`Snapshot ${io.c.bold(short(snap.sha))} saved as ${refName(repo, 'before')}`);
    if (snap.indexConflicted) {
      io.warn('The index has unresolved merge conflicts, so the staged state was not recorded.');
    }
  }

  const candidate = opts.reuse ? await matchCandidate(root, { tree: snap.tree, indexTree: snap.indexTree }, await configHash(root, config)) : null;
  const runDir = path.join(paths.runs, `${stamp()}-${opts.label}`);
  const probes = enabledProbes(config);
  const results: Record<string, unknown> = {};
  const reused: string[] = [];
  let ran = false;
  const devServers = new DevServerPool();
  try {
    for (const probe of probes) {
      const ctx: ProbeContext = { repo, root, config, snapshotSha: snap.sha, phase: 'before', tag, runDir, io, devServers };
      if (candidate && probe.restoreBaseline && candidate.probes[probe.id] !== undefined) {
        const restored = await probe.restoreBaseline(candidate.probes[probe.id], ctx).catch(() => null);
        if (restored !== null && restored !== undefined) {
          results[probe.id] = restored;
          reused.push(probe.id);
          continue;
        }
      }
      if (!ran && probe.id === 'checks') io.log('Running checks:');
      ran = true;
      results[probe.id] = await probe.snapshot(ctx);
    }
  } finally {
    await devServers.dispose();
  }
  if (candidate && reused.length) {
    const rerun = probes.filter((p) => !reused.includes(p.id)).map((p) => p.id);
    io.log(
      io.c.dim(
        `Working tree unchanged since the ${candidate.source === 'after' ? 'last `holdline after`' : 'baseline run at session start'}: reused its results` +
          (rerun.length ? ` (ran again: ${rerun.join(', ')})` : ''),
      ),
    );
  }
  // Files written by the checks themselves (build output that isn't git-ignored).
  const ownOutputs = ran ? await changesSince(repo, snap.sha) : {};
  return { snap, runDir, results, ownOutputs, reused: candidate && reused.length ? { source: candidate.source, probes: reused } : null };
}

/**
 * Record a capture as a reusable baseline. `trees`: the working-tree states it is valid for.
 * Never throws: a baseline is only an optimisation.
 */
export async function keepBaseline(
  project: Project,
  config: Config,
  io: Io,
  source: BaselineCandidate['source'],
  snap: { sha: string; tree: string; indexTree: string },
  data: Record<string, unknown>,
  phase: 'before' | 'after',
  tag: BaselineTag,
): Promise<void> {
  const { repo, root } = project;
  try {
    const kept: Record<string, unknown> = {};
    for (const probe of enabledProbes(config)) {
      if (!probe.saveBaseline || data[probe.id] === undefined) continue;
      const ctx: ProbeContext = { repo, root, config, snapshotSha: snap.sha, phase, tag, runDir: '', io };
      const k = await probe.saveBaseline(data[probe.id], ctx);
      if (k !== null && k !== undefined) kept[probe.id] = k;
    }
    const trees = [{ tree: snap.tree, indexTree: snap.indexTree }];
    // The run's own checks may have written files git doesn't ignore: the tree is then valid too.
    const now = await worktreeTree(repo);
    if (now !== snap.tree) trees.push({ tree: now, indexTree: snap.indexTree });
    await saveCandidate(root, { source, configHash: await configHash(root, config), trees, snapshotSha: snap.sha, probes: kept });
  } catch (e) {
    io.warn(`Could not record a reusable baseline: ${(e as Error).message}`);
  }
}

export async function beforeCommand(cwd: string, opts: BeforeOptions, io: Io): Promise<Session> {
  const task = opts.task?.trim();
  if (!task) throw new HoldlineError('Describe the task: holdline before --task "<description>"');

  return locked(cwd, 'before', io, async (project) => {
    const { repo, root } = project;
    const config = await loadConfig(root);

    const existing = await readSession(root);
    if (existing && !opts.force && !opts.yes) {
      if (!io.interactive) {
        throw new HoldlineError(
          `A session already exists (task: "${existing.task}"). Pass --force to replace it.`,
        );
      }
      const replace = await io.confirm(
        `A session already exists (task: "${existing.task}", ${existing.createdAt}). Replace it?`,
        false,
      );
      if (!replace) throw new CancelledError();
    }

    if (await ensureGitignore(root)) io.log('Added .holdline/ to .gitignore');
    await preflightLargeFiles(project, config.largeUntrackedWarnMB, io, {
      yes: opts.yes,
      canCancel: true,
    });

    const { snap, runDir, results, ownOutputs } = await captureBaseline(project, config, io, { label: 'before', reuse: opts.reuseBaseline });
    const ownCount = Object.keys(ownOutputs).length;
    if (ownCount > 0) {
      const tops = await topLevelNames(repo, snap.sha);
      io.warn(
        `Your checks wrote ${ownCount} file${ownCount === 1 ? '' : 's'} that git doesn't ignore (build output?). ` +
          `They won't be counted as the agent's changes unless the agent edits them. Consider adding to .gitignore: ${gitignoreSuggestion(Object.keys(ownOutputs), tops).join(' ')}`,
      );
    }

    // The task's scope: what the task text and --scope globs name in the project.
    const globs = (opts.scope ?? []).map((g) => g.trim()).filter(Boolean);
    const scope = matchTask(task, globs, {
      files: await snapshotFiles(repo, snap.sha),
      graph: await graphFor(root, snap.sha, results.dependencies as DepGraphRef | undefined),
    });

    const session: Session = {
      version: 1,
      task,
      createdAt: snap.createdAt,
      worktreeId: repo.worktreeId,
      snapshot: {
        sha: snap.sha,
        tree: snap.tree,
        indexTree: snap.indexTree,
        head: snap.head,
        branch: snap.branch,
        ref: refName(repo, 'before'),
        historyRef: snap.historyRef,
      },
      runDir: path.relative(root, runDir),
      probes: results,
      scope,
      ...(ownCount > 0 ? { ownOutputs } : {}),
    };
    await writeSession(root, session);

    const pruned = await pruneHistory(repo, DEFAULT_KEEP);
    if (pruned.deleted.length > 0) {
      io.log(io.c.dim(`Pruned ${pruned.deleted.length} old snapshot(s); keeping the newest ${DEFAULT_KEEP}.`));
    }

    io.log();
    io.log(`Recorded task: ${io.c.bold(`"${task}"`)}`);
    io.log(io.c.dim(`Task scope: ${describeScope(scope)}`));
    io.log(
      io.c.dim(
        'Covered: tracked, modified and untracked files. Not covered: git-ignored files (node_modules, ignored .env, build output).',
      ),
    );
    io.log(`When the agent is done: ${io.c.bold('holdline after')}`);
    return session;
  });
}

/** The dependency graph of a snapshot: built in this process, or read from its stored file. */
export async function graphFor(root: string, sha: string, ref: DepGraphRef | undefined): Promise<DepGraph | null> {
  const known = recallGraph(root, sha);
  if (known) return known;
  if (!ref) return null;
  const g = await readGraph(root, ref);
  return 'graph' in g ? g.graph : null;
}

/** The longest task text kept from one prompt (long pasted prompts would match everything). */
export const MAX_TASK_TEXT = 4000;

/**
 * Add a follow-up instruction to the open session's task: the text is appended and the scope
 * recomputed against the same "before" snapshot. No new snapshot is taken, so problems found
 * since `before` stay visible.
 */
export async function amendTaskCommand(cwd: string, extra: string, io: Io): Promise<Session> {
  const text = extra.trim().slice(0, MAX_TASK_TEXT);
  if (!text) throw new HoldlineError('Nothing to add to the task.');
  return locked(cwd, 'amend', io, async ({ repo, root }) => {
    const session = await readSession(root);
    if (!session) throw new HoldlineError('No session to add to. Run `holdline before --task "<description>"` first.');
    const task = `${session.task}\n${text}`;
    const scope = matchTask(task, session.scope?.globs ?? [], {
      files: await snapshotFiles(repo, session.snapshot.sha),
      graph: await graphFor(root, session.snapshot.sha, session.probes.dependencies as DepGraphRef | undefined),
    });
    const next: Session = { ...session, task, scope };
    await writeSession(root, next);
    io.log(`Added to the task: ${io.c.bold(`"${text.length > 80 ? `${text.slice(0, 79)}…` : text}"`)}`);
    io.log(io.c.dim(`Task scope: ${describeScope(scope)}`));
    return next;
  });
}
