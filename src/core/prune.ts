import { git, type RepoInfo } from './git.js';
import { readRollback, readSession } from './session.js';
import { historyPrefix, resolveNamedRef } from './snapshot.js';

export const DEFAULT_KEEP = 20;

/** Named refs whose snapshots must never be pruned from history. */
export const PROTECTED_LABELS = ['before', 'after', 'pre-rollback', 'pre-undo'] as const;

export interface HistoryEntry {
  ref: string;
  sha: string;
}

/** History refs for this worktree, oldest first. */
export async function listHistory(repo: RepoInfo): Promise<HistoryEntry[]> {
  // Ref names cannot contain spaces, so a space-separated format is unambiguous.
  const out = await git(['for-each-ref', '--format=%(objectname) %(refname)', historyPrefix(repo)], {
    cwd: repo.root,
  });
  const entries: HistoryEntry[] = [];
  for (const line of out.split('\n')) {
    const space = line.indexOf(' ');
    if (space > 0) entries.push({ sha: line.slice(0, space), ref: line.slice(space + 1) });
  }
  // Names are <15-digit ms>-<label>, so lexical order is chronological.
  return entries.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
}

export async function protectedShas(repo: RepoInfo): Promise<Set<string>> {
  const shas = new Set<string>();
  for (const label of PROTECTED_LABELS) {
    const sha = await resolveNamedRef(repo, label);
    if (sha) shas.add(sha);
  }
  const session = await readSession(repo.root);
  if (session?.snapshot?.sha) shas.add(session.snapshot.sha);
  const rb = await readRollback(repo.root);
  for (const sha of [rb?.preRollback, rb?.rolledBackTo, rb?.preUndo]) if (sha) shas.add(sha);
  return shas;
}

export interface PruneResult {
  deleted: HistoryEntry[];
  kept: HistoryEntry[];
  /** Entries outside the keep window that survived because they are protected. */
  protectedKept: HistoryEntry[];
}

/**
 * Delete all but the newest `keep` history refs of this worktree. Entries pointing at
 * a protected snapshot (current session, after, pre-rollback, pre-undo) always survive.
 */
export async function pruneHistory(
  repo: RepoInfo,
  keep: number,
  opts: { dryRun?: boolean } = {},
): Promise<PruneResult> {
  if (!Number.isInteger(keep) || keep < 0) throw new Error(`invalid keep count: ${keep}`);
  const history = await listHistory(repo);
  const prot = await protectedShas(repo);
  const cutoff = Math.max(0, history.length - keep);
  const result: PruneResult = { deleted: [], kept: history.slice(cutoff), protectedKept: [] };
  for (const entry of history.slice(0, cutoff)) {
    if (prot.has(entry.sha)) result.protectedKept.push(entry);
    else result.deleted.push(entry);
  }
  if (!opts.dryRun && result.deleted.length > 0) {
    const input = result.deleted.map((e) => `delete ${e.ref}\n`).join('');
    await git(['update-ref', '--stdin'], { cwd: repo.root, input });
  }
  return result;
}
