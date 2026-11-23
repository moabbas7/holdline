import { randomBytes } from 'node:crypto';
import { copyFile, lstat, mkdir, rename, rm, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  currentBranch,
  git,
  GitError,
  gitMaybe,
  gitPath,
  headSha,
  splitNul,
  type RepoInfo,
} from './git.js';
import { HOLDLINE_DIR, stamp, storePaths } from './store.js';
import { posix } from './paths.js';

/**
 * Snapshots are ordinary git commits that are reachable only from refs under
 * refs/holdline/<worktree-id>/. Each snapshot commit has:
 *   - tree:     the full working tree (tracked + untracked, minus ignored files and .holdline/)
 *   - parent 1: a commit whose tree is the user's staged index at snapshot time
 *   - parent 2: HEAD at snapshot time (absent in a repo with no commits)
 * Nothing here touches HEAD, branches, the user's index file or the stash list.
 */

const IDENTITY = {
  GIT_AUTHOR_NAME: 'holdline',
  GIT_AUTHOR_EMAIL: 'holdline@localhost',
  GIT_COMMITTER_NAME: 'holdline',
  GIT_COMMITTER_EMAIL: 'holdline@localhost',
};

export const GITLINK_MODE = '160000';

export function refName(repo: RepoInfo, label: string): string {
  return `refs/holdline/${repo.worktreeId}/${label}`;
}

export function historyPrefix(repo: RepoInfo): string {
  return `refs/holdline/${repo.worktreeId}/history/`;
}

export type TempIndexEnv = {
  GIT_INDEX_FILE: string;
};

/**
 * Run `fn` with GIT_INDEX_FILE pointing at a fresh, uniquely named index inside this
 * worktree's git dir. The file (and any .lock left by a crashed git) is always removed.
 * With `seedFromRealIndex`, the user's index is copied first (fast: keeps stat info).
 * Returns whether seeding happened via the second callback argument.
 */
export async function withTempIndex<T>(
  repo: RepoInfo,
  fn: (env: TempIndexEnv, seeded: boolean) => Promise<T>,
  opts: { seedFromRealIndex?: boolean } = {},
): Promise<T> {
  const name = `holdline-index-${process.pid}-${randomBytes(6).toString('hex')}`;
  const indexPath = await gitPath(repo, name);
  try {
    let seeded = false;
    if (opts.seedFromRealIndex) {
      try {
        await copyFile(await gitPath(repo, 'index'), indexPath);
        seeded = true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    }
    return await fn({ GIT_INDEX_FILE: indexPath }, seeded);
  } finally {
    await rm(indexPath, { force: true });
    await rm(`${indexPath}.lock`, { force: true });
  }
}

async function emptyTree(repo: RepoInfo): Promise<string> {
  return (await git(['mktree'], { cwd: repo.root, input: '' })).trim();
}

async function commitTree(
  repo: RepoInfo,
  tree: string,
  parents: string[],
  message: string,
): Promise<string> {
  const args = ['commit-tree', '--no-gpg-sign', tree];
  for (const p of parents) args.push('-p', p);
  args.push('-m', message);
  return (await git(args, { cwd: repo.root, env: IDENTITY })).trim();
}

export interface SnapshotInfo {
  sha: string;
  tree: string;
  /** Tree of the user's staged index when the snapshot was taken. */
  indexTree: string;
  head: string | null;
  branch: string | null;
  label: string;
  createdAt: string;
  historyRef: string;
  /** True when the index had merge conflicts, so the staged state could not be recorded. */
  indexConflicted: boolean;
}

let lastHistoryMs = 0;

async function newHistoryRef(repo: RepoInfo, label: string): Promise<string> {
  let ms = Math.max(Date.now(), lastHistoryMs + 1);
  for (;;) {
    const ref = `${historyPrefix(repo)}${String(ms).padStart(15, '0')}-${label}`;
    const exists = await gitMaybe(['rev-parse', '--verify', '-q', ref], { cwd: repo.root });
    if (!exists) {
      lastHistoryMs = ms;
      return ref;
    }
    ms++;
  }
}

export async function setNamedRef(repo: RepoInfo, label: string, sha: string): Promise<void> {
  await git(['update-ref', '-m', `holdline ${label}`, refName(repo, label), sha], {
    cwd: repo.root,
  });
}

export async function resolveNamedRef(repo: RepoInfo, label: string): Promise<string | null> {
  const out = await gitMaybe(['rev-parse', '--verify', '-q', `${refName(repo, label)}^{commit}`], {
    cwd: repo.root,
  });
  return out ? out.trim() : null;
}

/**
 * Snapshot the whole working tree. Always records a history ref; with `setRef`
 * (default true) also points refs/holdline/<wt>/<label> at it.
 */
export async function createSnapshot(
  repo: RepoInfo,
  label: string,
  opts: { setRef?: boolean } = {},
): Promise<SnapshotInfo> {
  const cwd = repo.root;
  const head = await headSha(repo);
  const branch = await currentBranch(repo);

  // 1. The staged tree. write-tree may rewrite the cache-tree of the index it reads,
  //    so it runs on a copy; the user's index file is never written.
  let indexConflicted = false;
  const indexTree = await withTempIndex(
    repo,
    async (env, seeded) => {
      if (!seeded) {
        return head
          ? (await git(['rev-parse', `${head}^{tree}`], { cwd })).trim()
          : await emptyTree(repo);
      }
      try {
        return (await git(['write-tree'], { cwd, env })).trim();
      } catch (e) {
        if (!(e instanceof GitError)) throw e;
        indexConflicted = true;
        return head
          ? (await git(['rev-parse', `${head}^{tree}`], { cwd })).trim()
          : await emptyTree(repo);
      }
    },
    { seedFromRealIndex: true },
  );

  // 2. The working tree: start from a copy of the index (keeps stat info, so unchanged
  //    files aren't re-hashed), then stage everything that isn't ignored.
  const tree = await withTempIndex(
    repo,
    async (env, seeded) => {
      if (!seeded) {
        await git(head ? ['read-tree', head] : ['read-tree', '--empty'], { cwd, env });
      }
      // An exclude pathspec for .holdline errors out when .holdline is git-ignored,
      // so stage everything first and drop .holdline from the temp index afterwards.
      await git(['add', '-A', '--', '.'], { cwd, env });
      await git(['rm', '-r', '--cached', '-q', '--ignore-unmatch', '--', HOLDLINE_DIR], {
        cwd,
        env,
      });
      return (await git(['write-tree'], { cwd, env })).trim();
    },
    { seedFromRealIndex: true },
  );

  // 3. Commits and refs.
  const createdAt = new Date().toISOString();
  const indexCommit = await commitTree(repo, indexTree, [], `holdline index: ${label}`);
  const message = [
    `holdline snapshot: ${label}`,
    '',
    `worktree: ${repo.root}`,
    `branch: ${branch ?? '(detached)'}`,
    `head: ${head ?? '(none)'}`,
    `created: ${createdAt}`,
  ].join('\n');
  const sha = await commitTree(repo, tree, head ? [indexCommit, head] : [indexCommit], message);

  const historyRef = await newHistoryRef(repo, label);
  await git(['update-ref', '-m', `holdline ${label}`, historyRef, sha], { cwd });
  if (opts.setRef !== false) await setNamedRef(repo, label, sha);

  return { sha, tree, indexTree, head, branch, label, createdAt, historyRef, indexConflicted };
}

export interface SnapshotRefs {
  sha: string;
  tree: string;
  indexTree: string;
  head: string | null;
}

export async function readSnapshot(repo: RepoInfo, sha: string): Promise<SnapshotRefs> {
  const cwd = repo.root;
  const tree = (await git(['rev-parse', `${sha}^{tree}`], { cwd })).trim();
  const indexTree = (await git(['rev-parse', `${sha}^1^{tree}`], { cwd })).trim();
  const head = await gitMaybe(['rev-parse', '--verify', '-q', `${sha}^2`], { cwd });
  return { sha, tree, indexTree, head: head ? head.trim() : null };
}

export interface FileChange {
  /** A added, M modified, D deleted, R renamed, T type changed, C copied. */
  status: string;
  path: string;
  oldPath?: string;
}

/** Files that differ between two snapshots (or any two commits), with rename detection. */
export async function diffSnapshots(
  repo: RepoInfo,
  from: string,
  to: string,
): Promise<FileChange[]> {
  const out = await git(
    ['diff-tree', '-r', '-z', '-M', '--name-status', `${from}^{tree}`, `${to}^{tree}`],
    { cwd: repo.root },
  );
  const parts = splitNul(out);
  const changes: FileChange[] = [];
  for (let i = 0; i < parts.length; ) {
    const status = parts[i++]!;
    const letter = status[0]!;
    if (letter === 'R' || letter === 'C') {
      const oldPath = parts[i++]!;
      const newPath = parts[i++]!;
      changes.push({ status: letter, path: newPath, oldPath });
    } else {
      changes.push({ status: letter, path: parts[i++]! });
    }
  }
  return changes;
}

interface RawEntry {
  srcMode: string;
  dstMode: string;
  status: string;
  path: string;
}

async function rawDiff(repo: RepoInfo, fromTree: string, toTree: string): Promise<RawEntry[]> {
  const out = await git(['diff-tree', '-r', '-z', '--no-renames', fromTree, toTree], {
    cwd: repo.root,
  });
  const parts = splitNul(out);
  const entries: RawEntry[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    // ":100644 100644 <sha> <sha> M"
    const meta = parts[i]!.slice(1).split(' ');
    entries.push({
      srcMode: meta[0]!,
      dstMode: meta[1]!,
      status: meta[4]![0]!,
      path: parts[i + 1]!,
    });
  }
  return entries;
}

export interface RestorePlan {
  /** Exist in both, content/mode differs: will be overwritten. */
  restore: string[];
  /** Missing now (e.g. deleted by the agent): will be recreated. */
  recreate: string[];
  /** Exist now but not in the target (e.g. created by the agent): will be deleted. */
  remove: string[];
  /** Nested repositories / submodules: never touched. */
  skippedGitlinks: string[];
  /** The staged index differs and will be reset to the target's. */
  indexDiffers: boolean;
}

export async function planRestore(
  repo: RepoInfo,
  current: SnapshotRefs,
  target: SnapshotRefs,
): Promise<RestorePlan> {
  const plan: RestorePlan = {
    restore: [],
    recreate: [],
    remove: [],
    skippedGitlinks: [],
    indexDiffers: current.indexTree !== target.indexTree,
  };
  for (const e of await rawDiff(repo, current.tree, target.tree)) {
    if (e.srcMode === GITLINK_MODE || e.dstMode === GITLINK_MODE) {
      plan.skippedGitlinks.push(e.path);
    } else if (e.status === 'D') {
      plan.remove.push(e.path);
    } else if (e.status === 'A') {
      plan.recreate.push(e.path);
    } else {
      plan.restore.push(e.path);
    }
  }
  return plan;
}

export function planIsEmpty(plan: RestorePlan): boolean {
  return (
    plan.restore.length === 0 &&
    plan.recreate.length === 0 &&
    plan.remove.length === 0 &&
    !plan.indexDiffers
  );
}

export interface RestoreResult {
  written: string[];
  deleted: string[];
  /** Untracked/ignored things that were in the way, moved under .holdline/displaced/. */
  displaced: { from: string; to: string }[];
  skippedGitlinks: string[];
  indexRestored: boolean;
}

async function lstatOrNull(p: string) {
  try {
    return await lstat(p);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw e;
  }
}

/**
 * Make the working tree (and optionally the index) match `target`, given that
 * `current` is a snapshot of the working tree taken just now. Only paths that differ
 * are touched. Ignored files are left alone, except when one sits exactly where a
 * restored file must go; then it is moved under .holdline/displaced/, never deleted.
 */
export async function restoreTree(
  repo: RepoInfo,
  current: SnapshotRefs,
  target: SnapshotRefs,
  opts: { restoreIndex?: boolean; plan?: RestorePlan } = {},
): Promise<RestoreResult> {
  const root = repo.root;
  const plan = opts.plan ?? (await planRestore(repo, current, target));
  const result: RestoreResult = {
    written: [],
    deleted: [],
    displaced: [],
    skippedGitlinks: plan.skippedGitlinks,
    indexRestored: false,
  };
  const displaceDir = path.join(storePaths(root).dir, 'displaced', stamp());

  const displace = async (rel: string) => {
    const to = path.join(displaceDir, rel);
    await mkdir(path.dirname(to), { recursive: true });
    await rename(path.join(root, rel), to);
    result.displaced.push({ from: rel, to: posix(path.relative(root, to)) });
  };

  // 1. Delete files that exist now but not in the target.
  const parentDirs = new Set<string>();
  for (const rel of plan.remove) {
    const abs = path.join(root, rel);
    const st = await lstatOrNull(abs);
    if (!st) continue;
    if (st.isDirectory()) {
      await displace(rel);
    } else {
      await unlink(abs);
      result.deleted.push(rel);
    }
    for (let d = path.dirname(rel); d !== '.' && d !== ''; d = path.dirname(d)) parentDirs.add(d);
  }
  // Remove directories left empty, deepest first. rmdir refuses non-empty dirs.
  for (const d of [...parentDirs].sort((a, b) => b.length - a.length)) {
    try {
      await rmdir(path.join(root, d));
    } catch {
      /* not empty (or already gone): keep it */
    }
  }

  // 2. Clear anything still in the way of files we are about to write.
  const toWrite = [...plan.restore, ...plan.recreate];
  for (const rel of plan.recreate) {
    const segments = rel.split('/');
    for (let i = 1; i < segments.length; i++) {
      const ancestor = segments.slice(0, i).join('/');
      const st = await lstatOrNull(path.join(root, ancestor));
      if (!st) break;
      if (!st.isDirectory()) {
        await displace(ancestor);
        break;
      }
    }
    const st = await lstatOrNull(path.join(root, rel));
    if (st?.isDirectory()) await displace(rel);
  }

  // 3. Write the target's version of every differing path.
  if (toWrite.length > 0) {
    await withTempIndex(repo, async (env) => {
      await git(['read-tree', target.tree], { cwd: root, env });
      await git(['checkout-index', '-f', '-z', '--stdin'], {
        cwd: root,
        env,
        input: toWrite.join('\0') + '\0',
      });
    });
    result.written = toWrite;
  }

  // 4. Put the staged index back.
  if (opts.restoreIndex !== false && current.indexTree !== target.indexTree) {
    await git(['read-tree', target.indexTree], { cwd: root });
    await gitMaybe(['update-index', '-q', '--refresh'], { cwd: root });
    result.indexRestored = true;
  }

  return result;
}
