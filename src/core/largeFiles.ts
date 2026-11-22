import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { git, splitNul, type RepoInfo } from './git.js';
import { HOLDLINE_DIR } from './store.js';

export interface UntrackedScan {
  totalBytes: number;
  /** Largest first. */
  files: { path: string; bytes: number }[];
}

/** Sizes of untracked, non-ignored files (exactly what a snapshot would add). */
export async function scanUntracked(repo: RepoInfo): Promise<UntrackedScan> {
  const out = await git(['ls-files', '--others', '--exclude-standard', '-z'], { cwd: repo.root });
  const files: { path: string; bytes: number }[] = [];
  let totalBytes = 0;
  for (const rel of splitNul(out)) {
    if (rel === HOLDLINE_DIR || rel.startsWith(`${HOLDLINE_DIR}/`)) continue;
    try {
      const st = await lstat(path.join(repo.root, rel));
      if (!st.isFile()) continue;
      files.push({ path: rel, bytes: st.size });
      totalBytes += st.size;
    } catch {
      /* vanished between listing and stat */
    }
  }
  files.sort((a, b) => b.bytes - a.bytes);
  return { totalBytes, files };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

/** Returns a warning to show, or null if untracked files are under the threshold. */
export function largeUntrackedWarning(scan: UntrackedScan, thresholdMB: number): string | null {
  if (scan.totalBytes <= thresholdMB * 1024 * 1024) return null;
  const top = scan.files.slice(0, 10);
  const width = Math.max(...top.map((f) => formatBytes(f.bytes).length));
  const lines = [
    `Untracked files that are not ignored add up to ${formatBytes(scan.totalBytes)} ` +
      `(warning threshold: ${thresholdMB} MB). They will be copied into the snapshot.`,
    'Largest:',
    ...top.map((f) => `  ${formatBytes(f.bytes).padStart(width)}  ${f.path}`),
  ];
  if (scan.files.length > top.length) lines.push(`  …and ${scan.files.length - top.length} more`);
  lines.push(
    'If these are build output, caches or data, add them to .gitignore so snapshots stay small.',
  );
  return lines.join('\n');
}
