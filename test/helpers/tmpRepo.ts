import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeColors, type Io } from '../../src/io.js';
import { saveConfig, type Config } from '../../src/core/config.js';

const cleanups: (() => void)[] = [];

export function cleanupAll(): void {
  while (cleanups.length) cleanups.pop()!();
}

export function tmpDir(prefix = 'holdline-test-'): string {
  // .native expands Windows 8.3 short names (C:\Users\RUNNER~1), like holdline's own realpath.
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), prefix)));
  // Windows refuses to delete files a just-killed process still holds for a moment: retry.
  cleanups.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

export class TestRepo {
  constructor(public readonly dir: string) {}

  git(...args: string[]): string {
    return execFileSync('git', args, { cwd: this.dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  }
  p(rel: string): string {
    return path.join(this.dir, rel);
  }
  write(rel: string, content: string | Buffer): this {
    mkdirSync(path.dirname(this.p(rel)), { recursive: true });
    writeFileSync(this.p(rel), content);
    return this;
  }
  read(rel: string): string {
    return readFileSync(this.p(rel), 'utf8');
  }
  exists(rel: string): boolean {
    try {
      lstatSync(this.p(rel));
      return true;
    } catch {
      return false;
    }
  }
  rm(rel: string): this {
    rmSync(this.p(rel), { recursive: true, force: true });
    return this;
  }
  symlink(target: string, rel: string): this {
    mkdirSync(path.dirname(this.p(rel)), { recursive: true });
    symlinkSync(target, this.p(rel));
    return this;
  }
  chmod(rel: string, mode: number): this {
    chmodSync(this.p(rel), mode);
    return this;
  }
  commitAll(message = 'commit'): string {
    this.git('add', '-A');
    this.git('commit', '-q', '--no-gpg-sign', '--allow-empty', '-m', message);
    return this.git('rev-parse', 'HEAD').trim();
  }
  /** Staged content of a path (`git show :path`). */
  staged(rel: string): string {
    return this.git('show', `:${rel}`);
  }
  status(): string {
    return this.git('--no-optional-locks', 'status', '--porcelain=v1', '-uall');
  }
  refs(prefix = 'refs/holdline/'): string[] {
    return this.git('for-each-ref', '--format=%(refname)', prefix).split('\n').filter(Boolean);
  }
  gitDir(): string {
    return this.git('rev-parse', '--absolute-git-dir').trim();
  }
  indexBytes(): Buffer | null {
    const p = path.resolve(this.dir, this.git('rev-parse', '--git-path', 'index').trim());
    return existsSync(p) ? readFileSync(p) : null;
  }

  /**
   * Fingerprint of every file and symlink in the working tree (including ignored
   * files), excluding .git and .holdline. Maps path → "<type>:<mode>:<hash>".
   */
  fingerprint(opts: { includeDirs?: boolean } = {}): Record<string, string> {
    const result: Record<string, string> = {};
    const walk = (rel: string) => {
      const abs = rel ? this.p(rel) : this.dir;
      for (const name of readdirSync(abs).sort()) {
        if (!rel && (name === '.git' || name === '.holdline')) continue;
        const childRel = rel ? `${rel}/${name}` : name;
        const st = lstatSync(this.p(childRel));
        if (st.isSymbolicLink()) {
          result[childRel] = `link:${readlinkSync(this.p(childRel))}`;
        } else if (st.isDirectory()) {
          if (opts.includeDirs) result[childRel + '/'] = 'dir';
          walk(childRel);
        } else {
          const hash = createHash('sha256').update(readFileSync(this.p(childRel))).digest('hex');
          result[childRel] = `file:${(st.mode & 0o111) !== 0 ? 'x' : '-'}:${hash.slice(0, 16)}`;
        }
      }
    };
    walk('');
    return result;
  }
}

export function makeRepo(opts: { commit?: boolean } = {}): TestRepo {
  const repo = new TestRepo(tmpDir());
  repo.git('init', '-q', '-b', 'main');
  if (opts.commit !== false) {
    repo.write('README.md', '# test\n').write('src/index.js', 'console.log(1);\n');
    repo.commitAll('initial');
  }
  return repo;
}

export interface FakeIo extends Io {
  logs: string[];
  warnings: string[];
  prompts: string[];
}

/** Headless IO. `answers` feeds confirm() in order; when empty, confirm returns its default. */
export function fakeIo(opts: { interactive?: boolean; answers?: boolean[]; inputs?: string[] } = {}): FakeIo {
  const answers = [...(opts.answers ?? [])];
  const inputs = [...(opts.inputs ?? [])];
  const io: FakeIo = {
    interactive: opts.interactive ?? false,
    c: makeColors(false),
    logs: [],
    warnings: [],
    prompts: [],
    log: (m = '') => void io.logs.push(m),
    warn: (m) => void io.warnings.push(m),
    progress: () => {},
    progressDone: (m) => void io.logs.push(m),
    confirm: async (m, d) => {
      io.prompts.push(m);
      return answers.length ? answers.shift()! : d;
    },
    input: async (m, prefill) => {
      io.prompts.push(m);
      return inputs.length ? inputs.shift()! : prefill;
    },
  };
  return io;
}

/** Write a config with the given check commands (others disabled). */
export async function writeConfig(
  root: string,
  checks: Partial<Record<keyof Config['checks'], string>> = {},
  extra: Partial<Config> = {},
): Promise<void> {
  await saveConfig(root, {
    version: 1,
    projectType: 'node',
    packageManager: 'npm',
    largeUntrackedWarnMB: 100,
    checks: {
      build: checks.build ? { command: checks.build, timeoutSec: 30 } : null,
      typecheck: checks.typecheck ? { command: checks.typecheck, timeoutSec: 30 } : null,
      lint: checks.lint ? { command: checks.lint, timeoutSec: 30 } : null,
      test: checks.test ? { command: checks.test, timeoutSec: 30 } : null,
    },
    ...extra,
  });
}
