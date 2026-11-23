import { diffSnapshots } from '../core/snapshot.js';
import type { Probe } from './types.js';
import { plural } from '../plural.js';

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

  async saveBaseline() {
    return {};
  },

  // The file list is the snapshot itself: point at the new "before" snapshot.
  async restoreBaseline(_kept, ctx) {
    return { sha: ctx.snapshotSha };
  },

  async compare(before, after, ctx) {
    const own = ctx.ownOutputs;
    // Files written only by holdline's own build in `before` are not the agent's changes.
    const changes = (await diffSnapshots(ctx.repo, before.sha, after.sha)).filter((c) => !own?.excluded.has(c.path));
    return {
      probeId: 'files',
      title: this.title,
      status: changes.length > 0 ? 'changed' : 'ok',
      summary:
        changes.length === 0
          ? 'no files changed'
          : `${plural(changes.length, 'file')} changed`,
      findings: changes.map((c) => ({
        kind: 'change' as const,
        title: c.oldPath ? `${c.status} ${c.oldPath} → ${c.path}` : `${c.status} ${c.path}`,
        detail: STATUS_WORDS[c.status] ?? c.status,
        path: c.path,
        meta: {
          files: c.oldPath ? [c.path, c.oldPath] : [c.path],
          ...(own?.edited.has(c.path) ? { ownOutputEdited: true } : {}),
        },
      })),
    };
  },
};
