import { HoldlineError } from './errors.js';
import { readJson, storePaths, writeJson } from './store.js';

export const CHECK_NAMES = ['build', 'typecheck', 'lint', 'test'] as const;
export type CheckName = (typeof CHECK_NAMES)[number];

export type ProjectType = 'nextjs' | 'vite-react' | 'node' | 'unknown';
export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export interface CheckConfig {
  command: string;
  timeoutSec: number;
}

export interface Config {
  version: 1;
  projectType: ProjectType;
  packageManager: PackageManager;
  /** Warn before snapshotting when untracked, non-ignored files exceed this size. */
  largeUntrackedWarnMB: number;
  checks: Record<CheckName, CheckConfig | null>;
  /** Per-probe settings, keyed by probe id. `{ enabled: false }` turns a probe off. */
  probes?: Record<string, { enabled?: boolean; [key: string]: unknown }>;
  /** Claude Code hook settings (see src/hooks/settings.ts). */
  hooks?: Record<string, unknown>;
}

export const DEFAULT_TIMEOUTS: Record<CheckName, number> = {
  build: 600,
  typecheck: 300,
  lint: 300,
  test: 900,
};

export const DEFAULT_LARGE_UNTRACKED_MB = 100;

export async function loadConfig(root: string): Promise<Config> {
  const file = storePaths(root).config;
  const raw = await readJson<Partial<Config>>(file);
  if (!raw) throw new HoldlineError('No .holdline/config.json found. Run `holdline init` first.');
  if (!raw.checks || typeof raw.checks !== 'object') {
    throw new HoldlineError(`${file} has no "checks" section. Re-run \`holdline init\`.`);
  }
  const checks = {} as Record<CheckName, CheckConfig | null>;
  for (const name of CHECK_NAMES) {
    const c = (raw.checks as Record<string, unknown>)[name];
    if (c === null || c === undefined) {
      checks[name] = null;
    } else if (typeof c === 'string') {
      checks[name] = { command: c, timeoutSec: DEFAULT_TIMEOUTS[name] };
    } else if (typeof c === 'object' && typeof (c as CheckConfig).command === 'string') {
      const cc = c as Partial<CheckConfig>;
      checks[name] = {
        command: cc.command!,
        timeoutSec: typeof cc.timeoutSec === 'number' ? cc.timeoutSec : DEFAULT_TIMEOUTS[name],
      };
    } else {
      throw new HoldlineError(`${file}: checks.${name} must be null or { "command": "..." }.`);
    }
  }
  return {
    version: 1,
    projectType: raw.projectType ?? 'unknown',
    packageManager: raw.packageManager ?? 'npm',
    largeUntrackedWarnMB:
      typeof raw.largeUntrackedWarnMB === 'number'
        ? raw.largeUntrackedWarnMB
        : DEFAULT_LARGE_UNTRACKED_MB,
    checks,
    ...(raw.probes ? { probes: raw.probes } : {}),
    ...(raw.hooks && typeof raw.hooks === 'object' ? { hooks: raw.hooks } : {}),
  };
}

export async function saveConfig(root: string, config: Config): Promise<void> {
  await writeJson(storePaths(root).config, config);
}
