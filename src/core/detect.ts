import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  CHECK_NAMES,
  DEFAULT_LARGE_UNTRACKED_MB,
  DEFAULT_TIMEOUTS,
  type CheckName,
  type Config,
  type PackageManager,
  type ProjectType,
} from './config.js';

interface PackageJson {
  packageManager?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

/** npm's `npm init` placeholder, which always fails. */
const NPM_TEST_PLACEHOLDER = /no test specified/;

const SCRIPT_CANDIDATES: Record<CheckName, string[]> = {
  build: ['build'],
  typecheck: ['typecheck', 'type-check', 'check-types', 'types:check', 'tsc'],
  lint: ['lint'],
  test: ['test'],
};

const ESLINT_CONFIGS = [
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  '.eslintrc.yml',
  '.eslintrc.yaml',
];

export async function detectPackageManager(root: string, pkg: PackageJson | null): Promise<PackageManager> {
  const declared = pkg?.packageManager?.split('@')[0];
  if (declared === 'pnpm' || declared === 'yarn' || declared === 'npm' || declared === 'bun') {
    return declared;
  }
  const lockfiles: [string, PackageManager][] = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lock', 'bun'],
    ['bun.lockb', 'bun'],
    ['package-lock.json', 'npm'],
    ['npm-shrinkwrap.json', 'npm'],
  ];
  for (const [file, pm] of lockfiles) if (await exists(path.join(root, file))) return pm;
  return 'npm';
}

export function detectProjectType(pkg: PackageJson | null): ProjectType {
  if (!pkg) return 'unknown';
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if ('next' in deps) return 'nextjs';
  if ('vite' in deps) return 'vite-react';
  return 'node';
}

const runScript = (pm: PackageManager, script: string) => `${pm} run ${script}`;

const execBin = (pm: PackageManager, bin: string): string =>
  ({ npm: `npx --no-install ${bin}`, pnpm: `pnpm exec ${bin}`, yarn: `yarn ${bin}`, bun: `bunx ${bin}` })[pm];

export interface Detection {
  config: Config;
  /** Human-readable notes about how each command was chosen. */
  notes: string[];
}

export async function detectProject(root: string): Promise<Detection> {
  let pkg: PackageJson | null = null;
  try {
    pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as PackageJson;
  } catch {
    pkg = null;
  }
  const notes: string[] = [];
  const projectType = detectProjectType(pkg);
  const packageManager = await detectPackageManager(root, pkg);
  const scripts = pkg?.scripts ?? {};
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  if (!pkg) notes.push('No package.json found; set the check commands by hand.');

  const checks = {} as Config['checks'];
  for (const name of CHECK_NAMES) {
    checks[name] = null;
    const script = SCRIPT_CANDIDATES[name].find((s) => {
      const body = scripts[s];
      return body !== undefined && !(name === 'test' && NPM_TEST_PLACEHOLDER.test(body));
    });
    if (script) {
      checks[name] = { command: runScript(packageManager, script), timeoutSec: DEFAULT_TIMEOUTS[name] };
      continue;
    }
    if (name === 'typecheck' && pkg && (await exists(path.join(root, 'tsconfig.json')))) {
      checks[name] = {
        command: `${execBin(packageManager, 'tsc')} --noEmit`,
        timeoutSec: DEFAULT_TIMEOUTS[name],
      };
      notes.push('typecheck: no script found, using tsc --noEmit because tsconfig.json exists.');
      continue;
    }
    if (name === 'lint' && 'eslint' in deps) {
      for (const f of ESLINT_CONFIGS) {
        if (await exists(path.join(root, f))) {
          checks[name] = { command: `${execBin(packageManager, 'eslint')} .`, timeoutSec: DEFAULT_TIMEOUTS[name] };
          notes.push(`lint: no script found, using eslint because ${f} exists.`);
          break;
        }
      }
    }
    if (!checks[name] && pkg) notes.push(`${name}: no script found; disabled.`);
  }

  return {
    config: {
      version: 1,
      projectType,
      packageManager,
      largeUntrackedWarnMB: DEFAULT_LARGE_UNTRACKED_MB,
      checks,
      probes: { dependencies: { enabled: true }, database: { enabled: true } },
    },
    notes,
  };
}

export const PROJECT_TYPE_LABELS: Record<ProjectType, string> = {
  nextjs: 'Next.js',
  'vite-react': 'Vite/React',
  node: 'Node (API / library)',
  unknown: 'Unknown',
};
