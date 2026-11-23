import { randomBytes } from 'node:crypto';
import { renameSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { HoldlineError } from './errors.js';

export const HOLDLINE_DIR = '.holdline';

export function storePaths(root: string) {
  const dir = path.join(root, HOLDLINE_DIR);
  return {
    dir,
    config: path.join(dir, 'config.json'),
    session: path.join(dir, 'session.json'),
    rollback: path.join(dir, 'rollback.json'),
    lastReport: path.join(dir, 'last-report.json'),
    lock: path.join(dir, 'lock'),
    runs: path.join(dir, 'runs'),
    reports: path.join(dir, 'reports'),
    displaced: path.join(dir, 'displaced'),
  };
}

export async function readJson<T>(file: string): Promise<T | null> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HoldlineError(`${file} is not valid JSON. Fix or delete it and try again.`);
  }
}

/** Write JSON atomically (temp file + rename) so a crash never leaves half a file. */
export async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n');
  await renameRetrying(tmp, file);
}

// On Windows, replacing a file fails for a moment while another process (antivirus, the
// search indexer, a holdline process reading it) has it open. Retry those errors briefly.
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_DELAYS_MS = [10, 25, 50, 100, 200, 400];
const retryable = (e: unknown) => process.platform === 'win32' && RENAME_RETRY_CODES.has((e as NodeJS.ErrnoException).code ?? '');

/** `rename`, retried on Windows' transient sharing errors. */
export async function renameRetrying(from: string, to: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      return await rename(from, to);
    } catch (e) {
      if (i >= RENAME_DELAYS_MS.length || !retryable(e)) throw e;
      await new Promise((r) => setTimeout(r, RENAME_DELAYS_MS[i]));
    }
  }
}

/** `renameSync`, retried on Windows' transient sharing errors (busy-waits; only for exit paths). */
export function renameRetryingSync(from: string, to: string): void {
  for (let i = 0; ; i++) {
    try {
      return renameSync(from, to);
    } catch (e) {
      if (i >= RENAME_DELAYS_MS.length || !retryable(e)) throw e;
      const until = Date.now() + RENAME_DELAYS_MS[i]!;
      while (Date.now() < until) {
        /* wait */
      }
    }
  }
}

/** Sortable, filesystem-safe timestamp, e.g. 20261122T214300123Z. */
export function stamp(d = new Date()): string {
  return d.toISOString().replace(/[-:.]/g, '');
}

const IGNORE_LINE = /^\/?\.holdline\/?(\*\*?)?\s*$/;

/** Make sure the project's .gitignore ignores .holdline/. Returns true if it was added. */
export async function ensureGitignore(root: string): Promise<boolean> {
  const file = path.join(root, '.gitignore');
  let text = '';
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  if (text.split(/\r?\n/).some((line) => IGNORE_LINE.test(line))) return false;
  const sep = text.length === 0 || text.endsWith('\n') ? '' : '\n';
  await writeFile(file, `${text}${sep}${HOLDLINE_DIR}/\n`);
  return true;
}
