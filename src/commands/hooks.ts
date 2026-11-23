/**
 * `holdline install-hooks` / `holdline uninstall-hooks`: add holdline's Claude Code hooks to
 * .claude/settings.local.json (personal, default) or .claude/settings.json (--shared, the
 * whole team), merged with whatever is there. Other settings and other tools' hooks are never
 * touched; installing twice changes nothing; uninstalling removes only holdline's handlers.
 */
import { accessSync, constants, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitMaybe } from '../core/git.js';
import { HoldlineError } from '../core/errors.js';
import { readJson, writeJson } from '../core/store.js';
import { hookSettings, hookTimeouts, MAX_FIX_ROUNDS } from '../hooks/settings.js';
import type { Io } from '../io.js';
import { openProject } from './common.js';
import { initCommand } from './init.js';
import { loadConfig } from '../core/config.js';
import { posix } from '../core/paths.js';

export const HOOK_EVENT_NAMES = ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd'] as const;
export type ClaudeHookEvent = (typeof HOOK_EVENT_NAMES)[number];
const SUBCOMMAND: Record<ClaudeHookEvent, string> = {
  SessionStart: 'session-start',
  UserPromptSubmit: 'prompt',
  Stop: 'stop',
  SessionEnd: 'session-end',
};

/** A handler holdline installed: `… holdline hook prompt`, `"node" "…/cli.js" hook stop`. */
export const HOLDLINE_COMMAND = /(?:holdline(?:\.js|\.cmd)?|[\\/]cli\.js)["']?\s+hook\s+(session-start|prompt|stop|session-end)\s*$/;

export interface CommandHandler {
  type: string;
  command?: string;
  timeout?: number;
  statusMessage?: string;
  [k: string]: unknown;
}
interface HookGroup {
  matcher?: string;
  hooks?: CommandHandler[];
  [k: string]: unknown;
}
type Settings = Record<string, unknown> & { hooks?: Record<string, HookGroup[]> };

export const isHoldlineHandler = (h: unknown): h is CommandHandler =>
  !!h && typeof h === 'object' && typeof (h as CommandHandler).command === 'string' && HOLDLINE_COMMAND.test((h as CommandHandler).command!);

export function settingsPath(root: string, shared: boolean): string {
  return path.join(root, '.claude', shared ? 'settings.json' : 'settings.local.json');
}

/** Read a settings file: {} when missing; an error (and no changes) when it isn't a JSON object. */
export async function readSettings(file: string): Promise<{ settings: Settings; text: string | null }> {
  let text: string | null = null;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  if (text === null || !text.trim()) return { settings: {}, text };
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new HoldlineError(`${file} is not valid JSON, so holdline won't change it. Fix it and try again.`);
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HoldlineError(`${file} is not a JSON object, so holdline won't change it.`);
  const s = v as Settings;
  if (s.hooks !== undefined && (typeof s.hooks !== 'object' || s.hooks === null || Array.isArray(s.hooks))) {
    throw new HoldlineError(`${file}: "hooks" is not an object, so holdline won't change it.`);
  }
  for (const [event, groups] of Object.entries(s.hooks ?? {})) {
    if (!Array.isArray(groups)) throw new HoldlineError(`${file}: hooks.${event} is not an array, so holdline won't change it.`);
  }
  return { settings: s, text };
}

const isExecutable = (p: string) => {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** First `name` on PATH. */
export function onPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', ''] : [''];
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      if (existsSync(p) && isExecutable(p)) return p;
    }
  }
  return null;
}

const quote = (p: string) => (/^[\w./@+-]+$/.test(p) ? p : `"${p.replace(/"/g, '\\"')}"`);

/**
 * How the hooks call holdline, in order of preference:
 *   1. the project's own install, "$CLAUDE_PROJECT_DIR"/node_modules/.bin/holdline (works for everyone);
 *   2. `holdline` on PATH;
 *   3. (personal install only) this holdline, by absolute path.
 */
export function resolveHookCommand(root: string, shared: boolean, env: NodeJS.ProcessEnv = process.env): { base: string; how: string } {
  if (existsSync(path.join(root, 'node_modules', '.bin', 'holdline'))) {
    return { base: '"$CLAUDE_PROJECT_DIR"/node_modules/.bin/holdline', how: "the project's own holdline (node_modules/.bin)" };
  }
  if (onPath('holdline', env)) return { base: 'holdline', how: '`holdline` on your PATH' };
  if (shared) {
    throw new HoldlineError(
      'holdline is neither installed in this project (node_modules/.bin/holdline) nor on PATH, so teammates could not run the shared hooks. ' +
        'Install it as a dev dependency (npm install -D holdline), or install the hooks just for you (without --shared).',
    );
  }
  const cli = fileURLToPath(new URL('../cli.js', import.meta.url));
  return { base: `${quote(process.execPath)} ${quote(cli)}`, how: `this holdline (${cli})` };
}

export function holdlineGroups(base: string, timeouts: ReturnType<typeof hookTimeouts>): Record<ClaudeHookEvent, HookGroup> {
  const handler = (event: ClaudeHookEvent, extra: Partial<CommandHandler> = {}): CommandHandler => ({
    type: 'command',
    command: `${base} hook ${SUBCOMMAND[event]}`,
    timeout: timeouts[event],
    ...extra,
  });
  return {
    SessionStart: { matcher: 'startup|resume|clear', hooks: [handler('SessionStart')] },
    UserPromptSubmit: { hooks: [handler('UserPromptSubmit', { statusMessage: 'holdline: recording the baseline…' })] },
    Stop: { hooks: [handler('Stop', { statusMessage: 'holdline: checking what changed…' })] },
    SessionEnd: { hooks: [handler('SessionEnd')] },
  };
}

/** Remove holdline's handlers; groups that held only holdline handlers go, everything else stays. */
export function removeHoldline(settings: Settings): { settings: Settings; removed: number } {
  if (!settings.hooks) return { settings, removed: 0 };
  let removed = 0;
  const hooks: Record<string, HookGroup[]> = {};
  for (const [event, groups] of Object.entries(settings.hooks)) {
    const kept: HookGroup[] = [];
    for (const g of groups) {
      if (!g || typeof g !== 'object' || !Array.isArray(g.hooks)) {
        kept.push(g);
        continue;
      }
      const rest = g.hooks.filter((h) => !isHoldlineHandler(h));
      removed += g.hooks.length - rest.length;
      if (rest.length === g.hooks.length) kept.push(g);
      else if (rest.length) kept.push({ ...g, hooks: rest });
    }
    if (kept.length) hooks[event] = kept;
  }
  const next: Settings = { ...settings };
  if (Object.keys(hooks).length) next.hooks = hooks;
  else delete next.hooks;
  return { settings: next, removed };
}

export function addHoldline(settings: Settings, groups: Record<ClaudeHookEvent, HookGroup>): Settings {
  const { settings: clean } = removeHoldline(settings);
  const hooks: Record<string, HookGroup[]> = { ...(clean.hooks ?? {}) };
  for (const event of HOOK_EVENT_NAMES) hooks[event] = [...(hooks[event] ?? []), groups[event]];
  return { ...clean, hooks };
}

const serialise = (s: Settings) => JSON.stringify(s, null, 2) + '\n';

/** Make sure git ignores the personal settings file (Claude Code does this when it creates it). */
async function ignoreLocalSettings(root: string, io: Io): Promise<void> {
  const rel = '.claude/settings.local.json';
  const ignored = await gitMaybe(['check-ignore', '-q', '--no-index', rel], { cwd: root });
  if (ignored !== null) return;
  const file = path.join(root, '.gitignore');
  let text = '';
  try {
    text = await readFile(file, 'utf8');
  } catch {
    /* none yet */
  }
  const { writeFile } = await import('node:fs/promises');
  await writeFile(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${rel}\n`);
  io.log(io.c.dim(`Added ${rel} to .gitignore`));
}

export interface InstallOptions {
  shared?: boolean;
  /** Use this command instead of resolving one (tests, unusual setups). */
  command?: string;
}

export interface InstallResult {
  file: string;
  changed: boolean;
  command: string;
  ranInit: boolean;
}

export async function installHooksCommand(cwd: string, opts: InstallOptions, io: Io): Promise<InstallResult> {
  const { root, paths } = await openProject(cwd);
  let ranInit = false;
  if ((await readJson(paths.config).catch(() => null)) === null) {
    io.log('No holdline config yet: running `holdline init --yes` first.');
    await initCommand(root, { yes: true }, io);
    ranInit = true;
  }
  const config = await loadConfig(root);
  const file = settingsPath(root, !!opts.shared);
  const { settings, text } = await readSettings(file);
  const resolved = opts.command ? { base: opts.command, how: 'the given command' } : resolveHookCommand(root, !!opts.shared);
  const next = addHoldline(settings, holdlineGroups(resolved.base, hookTimeouts(hookSettings(config))));
  const out = serialise(next);
  const rel = posix(path.relative(root, file));
  const changed = out !== text;
  if (changed) await writeJson(file, next);
  if (!opts.shared) await ignoreLocalSettings(root, io);

  const s = hookSettings(config);
  io.log(changed ? `Installed holdline's Claude Code hooks in ${io.c.bold(rel)}` : `holdline's hooks are already installed in ${io.c.bold(rel)} (nothing changed).`);
  io.log(io.c.dim(`  calls ${resolved.how}`));
  io.log('  • When a session starts: records a baseline in the background.');
  io.log(`  • When you send a prompt: starts a holdline session with the prompt as the task (up to ${s.promptBudgetSec}s; reuses the last results when nothing changed).`);
  io.log(`  • When Claude finishes: runs \`holdline after\`. Breaks outside the task go back to Claude to fix (at most ${MAX_FIX_ROUNDS} rounds); then you get the report and the rollback command.`);
  io.log(io.c.dim('  If anything goes wrong, the hooks let Claude carry on and print at most one line. Turn them off for a shell with HOLDLINE_HOOKS=off.'));
  io.log(io.c.dim('  Claude Code picks up the change automatically; check with /hooks. Check the setup with `holdline doctor`.'));
  const other = settingsPath(root, !opts.shared);
  if (existsSync(other)) {
    const o = await readSettings(other).catch(() => null);
    if (o && removeHoldline(o.settings).removed > 0) {
      io.warn(`holdline's hooks are also in ${posix(path.relative(root, other))}; Claude Code would run both. Remove one with \`holdline uninstall-hooks${opts.shared ? '' : ' --shared'}\`.`);
    }
  }
  return { file, changed, command: resolved.base, ranInit };
}

export async function uninstallHooksCommand(cwd: string, opts: { shared?: boolean }, io: Io): Promise<{ file: string; removed: number }> {
  const { root } = await openProject(cwd);
  const file = settingsPath(root, !!opts.shared);
  const rel = posix(path.relative(root, file));
  if (!existsSync(file)) {
    io.log(`No ${rel}: nothing to remove.`);
    return { file, removed: 0 };
  }
  const { settings } = await readSettings(file);
  const { settings: next, removed } = removeHoldline(settings);
  if (removed) {
    await writeJson(file, next);
    io.log(`Removed ${removed} holdline hook${removed === 1 ? '' : 's'} from ${io.c.bold(rel)}. Other settings and hooks were left as they were.`);
  } else {
    io.log(`No holdline hooks in ${rel}.`);
  }
  const other = settingsPath(root, !opts.shared);
  if (existsSync(other)) {
    const o = await readSettings(other).catch(() => null);
    if (o && removeHoldline(o.settings).removed > 0) io.log(io.c.dim(`holdline's hooks are still in ${posix(path.relative(root, other))} (remove them with \`holdline uninstall-hooks${opts.shared ? '' : ' --shared'}\`).`));
  }
  return { file, removed };
}
