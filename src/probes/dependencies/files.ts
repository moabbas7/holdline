import { git, splitNul } from '../../core/git.js';

export const SOURCE_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/** Directories never scanned, even when they are not git-ignored. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.next',
  'dist',
  'build',
  'out',
  '.output',
  '.vercel',
  '.netlify',
  'coverage',
  '.turbo',
  '.svelte-kit',
  '.nuxt',
  '.cache',
  '.holdline',
  '.git',
]);

export const MAX_FILE_BYTES = 1024 * 1024;

/**
 * Decode source text, honouring a byte-order mark: some generated files (e.g. Supabase
 * types written by PowerShell redirection) are UTF-16, and reading them as UTF-8 loses
 * every export.
 */
export function decodeText(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  return buf.toString('utf8');
}

export type FileKind = 'source' | 'sql' | 'prisma';

export function fileKind(p: string): FileKind | null {
  if (p.endsWith('.d.ts') || p.endsWith('.d.mts') || p.endsWith('.d.cts')) return null;
  if (p.endsWith('.prisma')) return 'prisma';
  if (p.endsWith('.sql')) return 'sql';
  const dot = p.lastIndexOf('.');
  if (dot >= 0 && SOURCE_EXTS.includes(p.slice(dot))) return 'source';
  return null;
}

function inSkippedDir(p: string): boolean {
  const parts = p.split('/');
  for (let i = 0; i < parts.length - 1; i++) if (SKIP_DIRS.has(parts[i]!)) return true;
  return false;
}

export interface FileListing {
  /** Every tracked or untracked, non-ignored file (posix paths relative to root). */
  all: Set<string>;
  /** Files the graph analyses, with their kind. */
  analysed: Map<string, FileKind>;
}

/** List files with git (respects .gitignore), skipping dependency and build directories. */
export async function listFiles(root: string): Promise<FileListing> {
  // -c also lists tracked files deleted from the working tree; subtract those.
  const [out, deletedOut] = await Promise.all([
    git(['ls-files', '-z', '-co', '--exclude-standard'], { cwd: root }),
    git(['ls-files', '-z', '-d'], { cwd: root }),
  ]);
  const deleted = new Set(splitNul(deletedOut));
  const all = new Set<string>();
  const analysed = new Map<string, FileKind>();
  for (const p of splitNul(out)) {
    if (deleted.has(p) || inSkippedDir(p)) continue;
    all.add(p);
    const kind = fileKind(p);
    if (kind) analysed.set(p, kind);
  }
  return { all, analysed };
}
