import { headSha, objectExists, type RepoInfo } from './git.js';
import { HoldlineError } from './errors.js';
import {
  createSnapshot,
  planRestore,
  readSnapshot,
  restoreTree,
  setNamedRef,
  type RestorePlan,
  type RestoreResult,
  type SnapshotInfo,
} from './snapshot.js';

export interface SafeRestoreOutcome {
  /** Snapshot of the state just before the restore: what undo goes back to. */
  safety: SnapshotInfo;
  plan: RestorePlan;
  result: RestoreResult;
  /** Set when HEAD now differs from HEAD at the target snapshot. Refs are never moved. */
  headMoved: { snapshotHead: string | null; currentHead: string | null } | null;
}

export interface SafeRestoreOptions {
  /** Return false to cancel. Called after the safety snapshot, before anything is changed. */
  confirm?: (plan: RestorePlan) => Promise<boolean>;
  /** Called after the safety snapshot is recorded under its named ref, before files change. */
  onSafetyRecorded?: (safety: SnapshotInfo) => Promise<void>;
}

/**
 * Restore the working tree and index to `targetSha`. Before anything changes, the
 * current state is snapshotted and recorded as refs/holdline/<wt>/<safetyLabel>,
 * so the restore itself can always be undone. Returns null if `confirm` declined.
 */
export async function restoreWithSafety(
  repo: RepoInfo,
  targetSha: string,
  safetyLabel: string,
  opts: SafeRestoreOptions = {},
): Promise<SafeRestoreOutcome | null> {
  if (!(await objectExists(repo, targetSha))) {
    throw new HoldlineError(
      `Snapshot ${targetSha.slice(0, 12)} no longer exists in this repository. Nothing was changed.`,
    );
  }
  const target = await readSnapshot(repo, targetSha);

  // Taken without moving the named ref, so a cancelled restore leaves the previous
  // safety point intact. The history ref keeps this snapshot reachable regardless.
  const safety = await createSnapshot(repo, safetyLabel, { setRef: false });
  const current = await readSnapshot(repo, safety.sha);
  const plan = await planRestore(repo, current, target);

  if (opts.confirm && !(await opts.confirm(plan))) return null;

  await setNamedRef(repo, safetyLabel, safety.sha);
  await opts.onSafetyRecorded?.(safety);

  const result = await restoreTree(repo, current, target, {
    plan,
    restoreIndex: !safety.indexConflicted,
  });

  const currentHead = await headSha(repo);
  const headMoved =
    currentHead !== target.head ? { snapshotHead: target.head, currentHead } : null;

  return { safety, plan, result, headMoved };
}
