import { CancelledError, HoldlineError } from '../core/errors.js';
import { getRepo, type RepoInfo } from '../core/git.js';
import { largeUntrackedWarning, scanUntracked } from '../core/largeFiles.js';
import { withLock } from '../core/lock.js';
import type { RestorePlan } from '../core/snapshot.js';
import { storePaths } from '../core/store.js';
import type { Io } from '../io.js';

export interface Project {
  repo: RepoInfo;
  root: string;
  paths: ReturnType<typeof storePaths>;
}

export async function openProject(cwd: string): Promise<Project> {
  const repo = await getRepo(cwd);
  return { repo, root: repo.root, paths: storePaths(repo.root) };
}

/** Open the project and run `fn` while holding its .holdline/lock. */
export async function locked<T>(
  cwd: string,
  command: string,
  io: Io,
  fn: (project: Project) => Promise<T>,
): Promise<T> {
  const project = await openProject(cwd);
  return withLock(project.paths.dir, command, () => fn(project), (m) => io.warn(m));
}

/**
 * Warn when untracked, non-ignored files are large. When `canCancel`, an interactive
 * user may stop here (throws CancelledError); --yes or no TTY continues.
 */
export async function preflightLargeFiles(
  project: Project,
  thresholdMB: number,
  io: Io,
  opts: { yes?: boolean; canCancel: boolean },
): Promise<void> {
  const warning = largeUntrackedWarning(await scanUntracked(project.repo), thresholdMB);
  if (!warning) return;
  io.warn(warning);
  if (!opts.canCancel || opts.yes || !io.interactive) return;
  if (!(await io.confirm('Continue and include them in the snapshot?', true))) {
    throw new CancelledError();
  }
}

/** Ask a yes/no question that guards a destructive step. --yes skips; no TTY requires --yes. */
export async function requireConfirmation(
  io: Io,
  message: string,
  opts: { yes?: boolean; flagHint?: string },
): Promise<boolean> {
  if (opts.yes) return true;
  if (!io.interactive) {
    throw new HoldlineError(`${message} Not running in a terminal; pass ${opts.flagHint ?? '--yes'} to confirm.`);
  }
  return io.confirm(message, false);
}

const LIST_LIMIT = 15;

export function describePlan(plan: RestorePlan, io: Io): string[] {
  const lines: string[] = [];
  const section = (title: string, items: string[], paint: (s: string) => string) => {
    if (items.length === 0) return;
    lines.push(`${title} (${items.length}):`);
    for (const p of items.slice(0, LIST_LIMIT)) lines.push(`  ${paint(p)}`);
    if (items.length > LIST_LIMIT) lines.push(io.c.dim(`  …and ${items.length - LIST_LIMIT} more`));
  };
  section('Restore to the snapshot version', plan.restore, io.c.yellow);
  section('Recreate (missing now)', plan.recreate, io.c.green);
  section('Delete (not in the snapshot)', plan.remove, io.c.red);
  if (plan.indexDiffers) lines.push('Reset the staging area (git index) to what was staged at the snapshot.');
  if (plan.skippedGitlinks.length > 0) {
    lines.push(io.c.dim(`Not touched (nested repositories / submodules): ${plan.skippedGitlinks.join(', ')}`));
  }
  return lines;
}

export function relativeTime(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 10) : '(none)');
