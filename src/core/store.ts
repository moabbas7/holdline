import { randomBytes } from 'node:crypto';
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
  await rename(tmp, file);
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
