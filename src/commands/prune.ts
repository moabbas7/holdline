import { DEFAULT_KEEP, pruneHistory, type PruneResult } from '../core/prune.js';
import { HoldlineError } from '../core/errors.js';
import type { Io } from '../io.js';
import { locked } from './common.js';
import { plural } from '../plural.js';

export interface PruneOptions {
  keep?: number;
  dryRun?: boolean;
}

export async function pruneCommand(cwd: string, opts: PruneOptions, io: Io): Promise<PruneResult> {
  const keep = opts.keep ?? DEFAULT_KEEP;
  if (!Number.isInteger(keep) || keep < 0) throw new HoldlineError('--keep must be a whole number ≥ 0.');
  return locked(cwd, 'prune', io, async ({ repo }) => {
    const r = await pruneHistory(repo, keep, { dryRun: opts.dryRun });
    const verb = opts.dryRun ? 'Would delete' : 'Deleted';
    io.log(`${verb} ${plural(r.deleted.length, 'snapshot ref')}; ${r.kept.length + r.protectedKept.length} kept.`);
    for (const e of r.deleted) io.log(io.c.dim(`  ${e.ref}`));
    if (r.protectedKept.length > 0) {
      io.log(io.c.dim(`Kept ${plural(r.protectedKept.length, 'older snapshot')} still used by the session, after, or rollback/undo.`));
    }
    if (!opts.dryRun && r.deleted.length > 0) {
      io.log(io.c.dim('git reclaims the space at its next gc.'));
    }
    return r;
  });
}
