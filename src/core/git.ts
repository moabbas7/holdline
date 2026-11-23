import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { HoldlineError } from './errors.js';
import { assertStarting } from './stop.js';

export class GitError extends Error {
  constructor(
    public readonly args: string[],
    public readonly code: number | null,
    public readonly stderr: string,
  ) {
    super(`git ${args.join(' ')} failed (exit ${code}): ${stderr.trim()}`);
    this.name = 'GitError';
  }
}

export interface GitOptions {
  cwd: string;
  /** Extra environment variables (merged over the scrubbed process env). */
  env?: Record<string, string | undefined>;
  /** Data written to git's stdin. */
  input?: string | Buffer;
}

/**
 * Inherited variables that would redirect git away from the repo/index we mean.
 * GIT_DIR / GIT_WORK_TREE are kept so holdline still works when invoked from a hook.
 */
const SCRUBBED_ENV = ['GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_NAMESPACE'];

export function gitEnv(extra?: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of SCRUBBED_ENV) delete env[key];
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_OPTIONAL_LOCKS = '0';
  env.LC_ALL = 'C';
  for (const [k, v] of Object.entries(extra ?? {})) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

/** Run git and return stdout. Throws GitError on non-zero exit. */
export function git(args: string[], opts: GitOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    assertStarting('git');
    const child = spawn('git', args, {
      cwd: opts.cwd,
      env: gitEnv(opts.env),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.on('error', (e) => reject(new HoldlineError(`could not run git: ${e.message}`)));
    child.on('close', (code) => {
      const stdout = Buffer.concat(out).toString('utf8');
      if (code === 0) resolve(stdout);
      else reject(new GitError(args, code, Buffer.concat(err).toString('utf8')));
    });
    child.stdin.on('error', () => {
      /* git may exit before reading all input; the close handler reports it */
    });
    child.stdin.end(opts.input ?? '');
  });
}

/** Like git(), but returns null instead of throwing on non-zero exit. */
export async function gitMaybe(args: string[], opts: GitOptions): Promise<string | null> {
  try {
    return await git(args, opts);
  } catch (e) {
    if (e instanceof GitError) return null;
    throw e;
  }
}

/** Split NUL-terminated git output. */
export function splitNul(s: string): string[] {
  const parts = s.split('\0');
  if (parts.at(-1) === '') parts.pop();
  return parts;
}

export interface RepoInfo {
  /** Top of the working tree (realpath). */
  root: string;
  /** This worktree's private git dir (for a linked worktree: <common>/worktrees/<name>). */
  gitDir: string;
  /** The shared git dir. */
  commonDir: string;
  isLinkedWorktree: boolean;
  /** Namespace for refs under refs/holdline/: "main" or "wt-<hash>". */
  worktreeId: string;
}

export async function getRepo(cwd: string): Promise<RepoInfo> {
  const out = await gitMaybe(
    ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'],
    { cwd },
  );
  if (out === null) {
    throw new HoldlineError(
      `${cwd} is not inside a git repository. holdline uses git to snapshot your files; run \`git init\` first.`,
    );
  }
  const [top, gitDirRaw, commonRaw] = out.split('\n');
  if (!top || !gitDirRaw || !commonRaw) {
    throw new HoldlineError(
      'holdline must be run inside a git working tree (not a bare repository).',
    );
  }
  const root = await realpath(top);
  const gitDir = await realpath(gitDirRaw);
  const commonDir = await realpath(path.resolve(cwd, commonRaw));
  const isLinkedWorktree = gitDir !== commonDir;
  const worktreeId = isLinkedWorktree
    ? 'wt-' + createHash('sha1').update(root).digest('hex').slice(0, 12)
    : 'main';
  return { root, gitDir, commonDir, isLinkedWorktree, worktreeId };
}

/** Resolve a path inside the git dir the way git does (worktree-aware). */
export async function gitPath(repo: RepoInfo, name: string): Promise<string> {
  const out = await git(['rev-parse', '--git-path', name], { cwd: repo.root });
  return path.resolve(repo.root, out.trim());
}

export async function headSha(repo: RepoInfo): Promise<string | null> {
  const out = await gitMaybe(['rev-parse', '--verify', '-q', 'HEAD^{commit}'], {
    cwd: repo.root,
  });
  return out ? out.trim() : null;
}

export async function currentBranch(repo: RepoInfo): Promise<string | null> {
  const out = await gitMaybe(['symbolic-ref', '-q', '--short', 'HEAD'], { cwd: repo.root });
  return out ? out.trim() : null;
}

export async function objectExists(repo: RepoInfo, sha: string): Promise<boolean> {
  return (await gitMaybe(['cat-file', '-e', `${sha}^{commit}`], { cwd: repo.root })) !== null;
}
