import { readJson, storePaths, writeJson } from './store.js';

export interface Session {
  version: 1;
  task: string;
  createdAt: string;
  worktreeId: string;
  snapshot: {
    sha: string;
    tree: string;
    indexTree: string;
    head: string | null;
    branch: string | null;
    ref: string;
    historyRef: string;
  };
  runDir: string;
  /** Each probe's snapshot() result, keyed by probe id. */
  probes: Record<string, unknown>;
}

export interface RollbackRecord {
  version: 1;
  /** Snapshot taken right before the rollback; undo-rollback restores it. */
  preRollback: string;
  rolledBackTo: string;
  rolledBackAt: string;
  task: string | null;
  /** Snapshot taken right before the most recent undo-rollback. */
  preUndo?: string;
  undoneAt?: string;
}

export const readSession = (root: string) => readJson<Session>(storePaths(root).session);
export const writeSession = (root: string, s: Session) => writeJson(storePaths(root).session, s);
export const readRollback = (root: string) => readJson<RollbackRecord>(storePaths(root).rollback);
export const writeRollback = (root: string, r: RollbackRecord) =>
  writeJson(storePaths(root).rollback, r);
