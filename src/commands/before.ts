import path from 'node:path';
import { loadConfig } from '../core/config.js';
import { CancelledError, HoldlineError } from '../core/errors.js';
import { DEFAULT_KEEP, pruneHistory } from '../core/prune.js';
import { readSession, writeSession, type Session } from '../core/session.js';
import { createSnapshot, refName } from '../core/snapshot.js';
import { ensureGitignore, stamp } from '../core/store.js';
import type { Io } from '../io.js';
import { enabledProbes } from '../probes/registry.js';
import type { ProbeContext } from '../probes/types.js';
import { locked, preflightLargeFiles, short } from './common.js';

export interface BeforeOptions {
  task: string;
  /** Replace an existing session without asking. */
  force?: boolean;
  /** Non-interactive: replace an existing session and continue past warnings. */
  yes?: boolean;
}

export async function beforeCommand(cwd: string, opts: BeforeOptions, io: Io): Promise<Session> {
  const task = opts.task?.trim();
  if (!task) throw new HoldlineError('Describe the task: holdline before --task "<description>"');

  return locked(cwd, 'before', io, async (project) => {
    const { repo, root, paths } = project;
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

    const snap = await createSnapshot(repo, 'before');
    io.log(`Snapshot ${io.c.bold(short(snap.sha))} saved as ${refName(repo, 'before')}`);
    if (snap.indexConflicted) {
      io.warn('The index has unresolved merge conflicts, so the staged state was not recorded.');
    }

    const runDir = path.join(paths.runs, `${stamp()}-before`);
    const probes = enabledProbes(config);
    const results: Record<string, unknown> = {};
    if (probes.some((p) => p.id === 'checks')) io.log('Running checks:');
    for (const probe of probes) {
      const ctx: ProbeContext = { repo, root, config, snapshotSha: snap.sha, phase: 'before', runDir, io };
      results[probe.id] = await probe.snapshot(ctx);
    }

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
    };
    await writeSession(root, session);

    const pruned = await pruneHistory(repo, DEFAULT_KEEP);
    if (pruned.deleted.length > 0) {
      io.log(io.c.dim(`Pruned ${pruned.deleted.length} old snapshot(s); keeping the newest ${DEFAULT_KEEP}.`));
    }

    io.log();
    io.log(`Recorded task: ${io.c.bold(`"${task}"`)}`);
    io.log(
      io.c.dim(
        'Covered: tracked, modified and untracked files. Not covered: git-ignored files (node_modules, ignored .env, build output).',
      ),
    );
    io.log(`When the agent is done: ${io.c.bold('holdline after')}`);
    return session;
  });
}
