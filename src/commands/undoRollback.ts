import { loadConfig } from '../core/config.js';
import { CancelledError, HoldlineError } from '../core/errors.js';
import { restoreWithSafety, type SafeRestoreOutcome } from '../core/rollback.js';
import { readRollback, writeRollback } from '../core/session.js';
import { planIsEmpty } from '../core/snapshot.js';
import type { Io } from '../io.js';
import { describePlan, locked, preflightLargeFiles, requireConfirmation, short } from './common.js';
import { reportOutcome } from './rollback.js';

export interface UndoRollbackOptions {
  yes?: boolean;
}

export async function undoRollbackCommand(
  cwd: string,
  opts: UndoRollbackOptions,
  io: Io,
): Promise<SafeRestoreOutcome | null> {
  return locked(cwd, 'undo-rollback', io, async (project) => {
    const { repo, root } = project;
    const config = await loadConfig(root);
    const record = await readRollback(root);
    if (!record) throw new HoldlineError('There is no rollback to undo.');
    await preflightLargeFiles(project, config.largeUntrackedWarnMB, io, { yes: opts.yes, canCancel: true });

    let nothingToDo = false;
    const outcome = await restoreWithSafety(repo, record.preRollback, 'pre-undo', {
      confirm: async (plan) => {
        if (planIsEmpty(plan)) {
          nothingToDo = true;
          return false;
        }
        io.log(`Restore the state saved before the rollback (${short(record.preRollback)}, ${record.rolledBackAt}):`);
        for (const line of describePlan(plan, io)) io.log(`  ${line}`);
        return requireConfirmation(io, 'Undo the rollback now?', { yes: opts.yes });
      },
      onSafetyRecorded: async (safety) => {
        await writeRollback(root, { ...record, preUndo: safety.sha, undoneAt: new Date().toISOString() });
      },
    });

    if (nothingToDo) {
      io.log('The working tree already matches the state from before the rollback. Nothing to undo.');
      return null;
    }
    if (!outcome) throw new CancelledError();
    reportOutcome(outcome, io);
    io.log(io.c.dim(`The state just before this undo is saved as ${short(outcome.safety.sha)} (refs/holdline/${repo.worktreeId}/pre-undo).`));
    return outcome;
  });
}
