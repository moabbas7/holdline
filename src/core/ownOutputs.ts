/**
 * Files written by holdline's own commands. `holdline before` takes its snapshot first and
 * then runs the checks; a build whose output isn't git-ignored writes files after the
 * snapshot, and without this they would show up as the agent's changes in `after`.
 *
 * At the end of `before`, the working tree is hashed again (through a temporary index, so
 * nothing the user sees changes) and every path that differs from the snapshot is recorded
 * with its blob. In `after`, a path whose blob still matches was written by holdline only.
 */
import path from 'node:path';
import { git, splitNul, type RepoInfo } from './git.js';
import { withTempIndex } from './snapshot.js';
import { HOLDLINE_DIR } from './store.js';

/** path → blob sha after holdline's commands ran (null: they deleted it). */
export type OwnOutputs = Record<string, string | null>;

/** Tree of the current working tree (tracked + untracked, not ignored), .holdline excluded. */
export async function worktreeTree(repo: RepoInfo): Promise<string> {
  const cwd = repo.root;
  return withTempIndex(
    repo,
    async (env, seeded) => {
      if (!seeded) {
        const head = (await git(['rev-parse', '--verify', '-q', 'HEAD'], { cwd }).catch(() => '')).trim();
        await git(head ? ['read-tree', head] : ['read-tree', '--empty'], { cwd, env });
      }
      await git(['add', '-A', '--', '.'], { cwd, env });
      await git(['rm', '-r', '--cached', '-q', '--ignore-unmatch', '--', HOLDLINE_DIR], { cwd, env });
      return (await git(['write-tree'], { cwd, env })).trim();
    },
    { seedFromRealIndex: true },
  );
}

/** Paths that differ between the snapshot and the working tree now, with their blob now. */
export async function changesSince(repo: RepoInfo, snapshotSha: string): Promise<OwnOutputs> {
  const tree = await worktreeTree(repo);
  const out = await git(['diff-tree', '-r', '-z', '--no-renames', `${snapshotSha}^{tree}`, tree], { cwd: repo.root });
  const parts = splitNul(out);
  const result: OwnOutputs = {};
  for (let i = 0; i + 1 < parts.length; i += 2) {
    // ":100644 100644 <src> <dst> M"
    const meta = parts[i]!.slice(1).split(' ');
    const status = meta[4]![0]!;
    result[parts[i + 1]!] = status === 'D' ? null : meta[3]!;
  }
  return result;
}

/** Blob of each path in a snapshot (null: not in it). */
export async function blobsAt(repo: RepoInfo, sha: string, paths: string[]): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>(paths.map((p) => [p, null]));
  if (paths.length === 0) return result;
  // ls-tree takes pathspecs; batch to keep the command line short.
  for (let i = 0; i < paths.length; i += 500) {
    const batch = paths.slice(i, i + 500);
    const out = await git(['ls-tree', '-r', '-z', '--full-tree', sha, '--', ...batch.map((p) => `:(literal)${p}`)], { cwd: repo.root });
    for (const entry of splitNul(out)) {
      const tab = entry.indexOf('\t');
      const [, type, blob] = entry.slice(0, tab).split(' ');
      if (type === 'blob') result.set(entry.slice(tab + 1), blob!);
    }
  }
  return result;
}

export interface OwnOutputSplit {
  /** Written by holdline only (content unchanged since): not agent changes. */
  excluded: string[];
  /** Written by holdline, then changed again (by the agent): kept as agent changes. */
  edited: string[];
}

/** Split recorded own outputs by whether their content in the "after" snapshot still matches. */
export async function splitOwnOutputs(repo: RepoInfo, afterSha: string, own: OwnOutputs | undefined): Promise<OwnOutputSplit> {
  const paths = Object.keys(own ?? {});
  if (!own || paths.length === 0) return { excluded: [], edited: [] };
  const now = await blobsAt(repo, afterSha, paths);
  const excluded: string[] = [];
  const edited: string[] = [];
  for (const p of paths.sort()) (now.get(p) === own[p] ? excluded : edited).push(p);
  return { excluded, edited };
}

/**
 * .gitignore lines for build output: a top-level folder that the build created (it isn't in
 * the snapshot) is ignored as a whole; files elsewhere are listed one by one.
 */
export function gitignoreSuggestion(paths: string[], topLevelInSnapshot: Set<string>): string[] {
  const lines = new Set<string>();
  for (const p of [...paths].sort()) {
    const top = p.includes('/') ? p.slice(0, p.indexOf('/')) : null;
    lines.add(top && !topLevelInSnapshot.has(top) ? `/${top}/` : `/${p}`);
  }
  return [...lines].slice(0, 10);
}

/** Names at the top level of a snapshot. */
export async function topLevelNames(repo: RepoInfo, sha: string): Promise<Set<string>> {
  return new Set(splitNul(await git(['ls-tree', '-z', '--name-only', sha], { cwd: repo.root })));
}

export const posix = (p: string) => p.split(path.sep).join('/');
