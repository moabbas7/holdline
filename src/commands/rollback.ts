import { CancelledError } from '../core/errors.js';
import { restoreWithSafety, type SafeRestoreOutcome } from '../core/rollback.js';
import { writeRollback } from '../core/session.js';
import { planIsEmpty } from '../core/snapshot.js';
import { loadConfig } from '../core/config.js';
import type { Io } from '../io.js';
import { describePlan, locked, preflightLargeFiles, requireConfirmation, short } from './common.js';
import { requireSession } from './after.js';

export interface RollbackOptions {
  yes?: boolean;
}

export function reportOutcome(outcome: SafeRestoreOutcome, io: Io): void {
  const { result, headMoved } = outcome;
  io.log(
    io.c.green(
      `Restored ${result.written.length} file(s), deleted ${result.deleted.length}` +
        (result.indexRestored ? ', reset the staging area' : '') +
        '.',
    ),
  );
  for (const d of result.displaced) {
    io.warn(`Moved ${d.from} out of the way (it is git-ignored or untracked): now at ${d.to}`);
  }
  if (result.skippedGitlinks.length > 0) {
    io.warn(`Left nested repositories/submodules untouched: ${result.skippedGitlinks.join(', ')}`);
  }
  if (headMoved) {
    io.warn(
      `HEAD is ${short(headMoved.currentHead)}, but was ${short(headMoved.snapshotHead)} at the snapshot. ` +
        'Branches and commits were not changed; only files and the staging area were restored.' +
        (headMoved.snapshotHead ? ` To move the branch back too: git reset --soft ${headMoved.snapshotHead}` : ''),
    );
  }
}

export async function rollbackCommand(cwd: string, opts: RollbackOptions, io: Io): Promise<SafeRestoreOutcome | null> {
  return locked(cwd, 'rollback', io, async (project) => {
    const { repo, root } = project;
    const config = await loadConfig(root);
    const session = await requireSession(root);
    await preflightLargeFiles(project, config.largeUntrackedWarnMB, io, { yes: opts.yes, canCancel: true });

    let nothingToDo = false;
    const outcome = await restoreWithSafety(repo, session.snapshot.sha, 'pre-rollback', {
      confirm: async (plan) => {
        if (planIsEmpty(plan)) {
          nothingToDo = true;
          return false;
        }
        io.log(`Roll back to the snapshot taken before "${session.task}" (${short(session.snapshot.sha)}):`);
        for (const line of describePlan(plan, io)) io.log(`  ${line}`);
        io.log(io.c.dim('  The current state is saved first; `holdline undo-rollback` brings it back.'));
        return requireConfirmation(io, 'Roll back now?', { yes: opts.yes });
      },
      onSafetyRecorded: async (safety) => {
        await writeRollback(root, {
          version: 1,
          preRollback: safety.sha,
          rolledBackTo: session.snapshot.sha,
          rolledBackAt: new Date().toISOString(),
          task: session.task,
        });
      },
    });

    if (nothingToDo) {
      io.log('The working tree already matches the "before" snapshot. Nothing to roll back.');
      return null;
    }
    if (!outcome) throw new CancelledError();
    reportOutcome(outcome, io);
    io.log(`Saved the previous state as ${short(outcome.safety.sha)}. Undo with ${io.c.bold('holdline undo-rollback')}.`);
    return outcome;
  });
}
