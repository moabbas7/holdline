import { diffSnapshots } from '../core/snapshot.js';
import type { Probe } from './types.js';

export interface FilesSnapshot {
  sha: string;
}

const STATUS_WORDS: Record<string, string> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  T: 'type changed',
  C: 'copied',
};

export const filesProbe: Probe<FilesSnapshot> = {
  id: 'files',
  title: 'Files changed since the snapshot',

  enabled() {
    return true;
  },

  async snapshot(ctx) {
    return { sha: ctx.snapshotSha };
  },

  async compare(before, after, ctx) {
    const changes = await diffSnapshots(ctx.repo, before.sha, after.sha);
    return {
      probeId: 'files',
      title: this.title,
      status: changes.length > 0 ? 'changed' : 'ok',
      summary:
        changes.length === 0
          ? 'no files changed'
          : `${changes.length} file${changes.length > 1 ? 's' : ''} changed`,
      findings: changes.map((c) => ({
        kind: 'change' as const,
        title: c.oldPath ? `${c.status} ${c.oldPath} → ${c.path}` : `${c.status} ${c.path}`,
        detail: STATUS_WORDS[c.status] ?? c.status,
        path: c.path,
      })),
    };
  },
};
