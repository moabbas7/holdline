/**
 * `holdline doctor`: check everything holdline depends on and say what to fix. Read-only.
 */
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, type Config } from '../core/config.js';
import { getRepo, gitMaybe, gitPath, headSha, type RepoInfo } from '../core/git.js';
import { lockIsLive, readLock } from '../core/lock.js';
import { readSession } from '../core/session.js';
import { storePaths } from '../core/store.js';
import { hookSettings, hooksDisabled } from '../hooks/settings.js';
import { readState } from '../hooks/state.js';
import type { Io } from '../io.js';
import { apiSettings } from '../probes/api/types.js';
import { settingsFrom } from '../probes/database/capture.js';
import { agentVarsIn, databaseSafety } from '../probes/devServer.js';
import { visualSettingsFrom } from '../probes/visual/index.js';
import { relativeTime } from './common.js';
import { HOOK_EVENT_NAMES, isHoldlineHandler, onPath, readSettings, settingsPath, type CommandHandler } from './hooks.js';
import { posix } from '../core/paths.js';

export type Level = 'ok' | 'warn' | 'error' | 'info';
export interface DoctorItem {
  section: string;
  level: Level;
  text: string;
  fix?: string;
}
export interface DoctorResult {
  items: DoctorItem[];
  exitCode: 0 | 2;
}

export interface DoctorOptions {
  env?: NodeJS.ProcessEnv;
}

export async function doctorCommand(cwd: string, opts: DoctorOptions, io: Io): Promise<DoctorResult> {
  const env = opts.env ?? process.env;
  const items: DoctorItem[] = [];
  const add = (section: string, level: Level, text: string, fix?: string) => items.push({ section, level, text, ...(fix ? { fix } : {}) });

  // --- Git -------------------------------------------------------------------------------
  let repo: RepoInfo | null = null;
  try {
    repo = await getRepo(cwd);
  } catch (e) {
    add('Git', 'error', `not a git repository (${(e as Error).message.split('\n')[0]})`, 'run holdline inside a git repository (git init)');
  }
  if (!repo) return finish(items, io);
  const root = repo.root;
  await gitChecks(repo, add);

  // --- Config ----------------------------------------------------------------------------
  let config: Config | null = null;
  try {
    config = await loadConfig(root);
  } catch (e) {
    add('Config', 'error', (e as Error).message, 'run `holdline init`');
  }
  if (config) await configChecks(root, config, add);

  // --- Hooks -----------------------------------------------------------------------------
  await hookChecks(root, config, env, add);

  if (config) {
    await playwrightCheck(root, config, add);
    await databaseChecks(root, config, env, add);
    await nextChecks(root, config, env, add);
  }

  // --- Lock and session --------------------------------------------------------------------
  await lockChecks(root, add);
  return finish(items, io);
}

function finish(items: DoctorItem[], io: Io): DoctorResult {
  const mark = { ok: io.c.green('✓'), warn: io.c.yellow('!'), error: io.c.red('✗'), info: io.c.dim('·') };
  let section = '';
  for (const it of items) {
    if (it.section !== section) {
      section = it.section;
      io.log(io.c.bold(section));
    }
    io.log(`  ${mark[it.level]} ${it.text}`);
    if (it.fix) io.log(io.c.dim(`      fix: ${it.fix}`));
  }
  const errors = items.filter((i) => i.level === 'error').length;
  const warns = items.filter((i) => i.level === 'warn').length;
  io.log();
  io.log(errors ? io.c.red(`${errors} problem${errors === 1 ? '' : 's'} to fix${warns ? `, ${warns} warning${warns === 1 ? '' : 's'}` : ''}.`) : warns ? `No problems; ${warns} warning${warns === 1 ? '' : 's'}.` : io.c.green('Everything looks good.'));
  return { items, exitCode: errors ? 2 : 0 };
}

type Add = (section: string, level: Level, text: string, fix?: string) => void;

async function gitChecks(repo: RepoInfo, add: Add): Promise<void> {
  const head = await headSha(repo);
  if (!head) add('Git', 'warn', 'no commits yet', 'commit once so snapshots have a base (git commit)');
  else add('Git', 'ok', `repository at ${repo.root}${repo.worktreeId !== 'main' ? ' (linked worktree)' : ''}`);
  for (const [name, what] of [
    ['MERGE_HEAD', 'a merge'],
    ['rebase-merge', 'a rebase'],
    ['rebase-apply', 'a rebase or git am'],
    ['CHERRY_PICK_HEAD', 'a cherry-pick'],
    ['REVERT_HEAD', 'a revert'],
  ] as const) {
    if (existsSync(await gitPath(repo, name))) add('Git', 'warn', `${what} is in progress`, `finish or abort ${what} before starting an agent task`);
  }
  const ignored = await gitMaybe(['check-ignore', '-q', '--no-index', '.holdline/config.json'], { cwd: repo.root });
  if (ignored === null) add('Git', 'warn', '.holdline/ is not git-ignored', 'add `.holdline/` to .gitignore (holdline before does this)');
}

const SCRIPT = /^(?:npm|pnpm|yarn|bun)(?:\s+run)?\s+([\w:.-]+)\s*$/;

async function configChecks(root: string, config: Config, add: Add): Promise<void> {
  const checks = Object.entries(config.checks).filter(([, c]) => c);
  add('Config', 'ok', `.holdline/config.json: ${config.projectType}, ${config.packageManager}; checks: ${checks.map(([n]) => n).join(', ') || 'none'}`);
  if (!checks.length) add('Config', 'warn', 'no build, typecheck, lint or test command is configured, so regressions are only found by the other probes', 'run `holdline init` or add commands to .holdline/config.json');
  let scripts: Record<string, string> = {};
  try {
    scripts = (JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {};
  } catch {
    /* no package.json */
  }
  for (const [name, c] of checks) {
    const m = SCRIPT.exec(c!.command);
    if (m && !['install', 'test', 'exec', 'dlx', 'x'].includes(m[1]!) && !scripts[m[1]!]) {
      add('Config', 'error', `checks.${name} runs \`${c!.command}\`, but package.json has no "${m[1]}" script`, `fix the command in .holdline/config.json or re-run \`holdline init\``);
    }
    if (m && m[1] === 'test' && !scripts.test) add('Config', 'error', `checks.${name} runs \`${c!.command}\`, but package.json has no "test" script`, 'fix the command in .holdline/config.json');
  }
}

/** The executable a hook command starts, and whether it exists. */
function commandProblem(root: string, command: string, env: NodeJS.ProcessEnv): string | null {
  const projectBin = '"$CLAUDE_PROJECT_DIR"/node_modules/.bin/holdline';
  if (command.startsWith(projectBin)) return existsSync(path.join(root, 'node_modules', '.bin', 'holdline')) ? null : 'node_modules/.bin/holdline is missing (run npm install, or install holdline as a dev dependency)';
  if (/^holdline\s/.test(command)) return onPath('holdline', env) ? null : '`holdline` is not on PATH';
  const quoted = [...command.matchAll(/"([^"]+)"/g)].map((m) => m[1]!).filter((p) => path.isAbsolute(p));
  const bare = /^(\/[^\s"]+)/.exec(command)?.[1];
  for (const p of bare ? [bare, ...quoted] : quoted) if (!existsSync(p)) return `${p} does not exist`;
  return null;
}

async function hookChecks(root: string, config: Config | null, env: NodeJS.ProcessEnv, add: Add): Promise<void> {
  const s = hookSettings(config);
  const found: { file: string; events: Map<string, CommandHandler[]> }[] = [];
  for (const shared of [false, true]) {
    const file = settingsPath(root, shared);
    const rel = posix(path.relative(root, file));
    if (!existsSync(file)) continue;
    let settings: Awaited<ReturnType<typeof readSettings>>['settings'];
    try {
      settings = (await readSettings(file)).settings;
    } catch (e) {
      add('Claude Code hooks', 'error', (e as Error).message, `fix ${rel} by hand`);
      continue;
    }
    const events = new Map<string, CommandHandler[]>();
    for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
      for (const g of groups) for (const h of g?.hooks ?? []) if (isHoldlineHandler(h)) events.set(event, [...(events.get(event) ?? []), h]);
    }
    if (events.size) found.push({ file: rel, events });
  }
  if (!found.length) {
    add('Claude Code hooks', 'warn', 'not installed: holdline only runs when you run it', 'run `holdline install-hooks` (or `--shared` for the whole team)');
    return;
  }
  if (found.length > 1) add('Claude Code hooks', 'warn', `installed in both ${found.map((f) => f.file).join(' and ')}; Claude Code would run them twice`, 'remove one: `holdline uninstall-hooks` or `holdline uninstall-hooks --shared`');
  for (const f of found) {
    const missing = HOOK_EVENT_NAMES.filter((e) => !f.events.has(e));
    add('Claude Code hooks', missing.length ? 'error' : 'ok', `${f.file}: ${missing.length ? `missing ${missing.join(', ')}` : HOOK_EVENT_NAMES.join(', ')}`, missing.length ? `run \`holdline install-hooks${f.file.endsWith('settings.json') ? ' --shared' : ''}\` again` : undefined);
    for (const [event, handlers] of f.events) {
      if (handlers.length > 1) add('Claude Code hooks', 'warn', `${f.file}: ${handlers.length} holdline handlers for ${event}`, 'run `holdline install-hooks` again (it replaces them)');
      for (const h of handlers) {
        const problem = commandProblem(root, h.command!, env);
        if (problem) add('Claude Code hooks', 'error', `${event} runs \`${h.command}\`, but ${problem}`, 'run `holdline install-hooks` again, or install holdline');
      }
      const t = handlers[0]?.timeout;
      const need = event === 'UserPromptSubmit' ? s.promptBudgetSec : event === 'Stop' ? s.stopBudgetSec : 0;
      if (need && (typeof t !== 'number' || t < need + 5)) {
        add('Claude Code hooks', 'warn', `${event} timeout is ${typeof t === 'number' ? `${t}s` : 'the default'}, but holdline may use ${need}s; Claude Code would cut it off`, 'run `holdline install-hooks` again (it sets the timeouts from hooks.* in the config)');
      }
    }
  }
  add('Claude Code hooks', 'info', `budgets: prompt ${s.promptBudgetSec}s, stop ${s.stopBudgetSec}s; another session's turn is taken over after ${s.staleTurnHours}h`);
  if (hooksDisabled(env)) add('Claude Code hooks', 'warn', 'HOLDLINE_HOOKS is set to off in this shell: the hooks do nothing', 'unset HOLDLINE_HOOKS');
}

async function playwrightCheck(root: string, config: Config, add: Add): Promise<void> {
  const v = visualSettingsFrom(config);
  if (!v.enabled) {
    add('Visual check', 'info', 'off (probes.visual.enabled is false)');
    return;
  }
  const { loadPlaywright, installCommands } = await import('../probes/visual/playwright.js');
  const pw = loadPlaywright(root, config.packageManager);
  if (!pw.ok) {
    add('Visual check', 'error', 'Playwright is not installed, so the visual check is skipped', installCommands(config.packageManager).join(' && '));
    return;
  }
  let exe = '';
  try {
    exe = pw.chromium.executablePath();
  } catch {
    /* unknown */
  }
  if (!exe || !existsSync(exe)) add('Visual check', 'error', `Playwright found (${pw.from}), but its Chromium is not installed`, installCommands(config.packageManager).at(-1));
  else add('Visual check', 'ok', `Playwright and Chromium found (${pw.from}); ${v.pages.length} page${v.pages.length === 1 ? '' : 's'}`);
}

async function databaseChecks(root: string, config: Config, env: NodeJS.ProcessEnv, add: Add): Promise<void> {
  const db = settingsFrom(config);
  if (!db.enabled) add('Database safety', 'info', 'database probe off');
  else if (!db.connect) add('Database safety', 'ok', 'schema files only (probes.database.connect is false)');
  else add('Database safety', 'ok', 'live database reads are read-only and only to local hosts');
  if (db.allowHosts.length) add('Database safety', 'warn', `probes.database.allowHosts lets holdline connect to: ${db.allowHosts.join(', ')}`, 'make sure none of these is a production database');
  const live = apiSettings(config.probes?.api as Record<string, unknown> | undefined).live;
  const visual = visualSettingsFrom(config);
  for (const [on, allow, key] of [
    [live.enabled, live.allowNonLocalDatabase, 'probes.api.live.allowNonLocalDatabase'],
    [visual.enabled, visual.allowNonLocalDatabase, 'probes.visual.allowNonLocalDatabase'],
  ] as const) {
    if (on && allow) add('Database safety', 'warn', `${key} is true: the dev server may start against a non-local database`, `set ${key} to false unless that is intended`);
  }
  if (live.enabled || visual.enabled) {
    const safety = await databaseSafety(root, db.envVar, env);
    if (!safety.ok) add('Database safety', 'info', `the dev server checks won't start: ${safety.reason}`);
  }
}

async function nextChecks(root: string, config: Config, env: NodeJS.ProcessEnv, add: Add): Promise<void> {
  if (config.projectType !== 'nextjs') return;
  const devServer = visualSettingsFrom(config).enabled || apiSettings(config.probes?.api as Record<string, unknown> | undefined).live.enabled;
  if (!devServer) return;
  let files: string[] = [];
  try {
    files = (await readdir(root)).filter((f) => /^next\.config\.(js|mjs|cjs|ts|mts)$/.test(f));
  } catch {
    /* unreadable */
  }
  let agentUpgrade = !!env.__NEXT_AGENT_UPGRADE;
  for (const f of files) {
    if (/\bagentUpgrade\b/.test(await readFile(path.join(root, f), 'utf8').catch(() => ''))) agentUpgrade = true;
  }
  if (!agentUpgrade) return;
  const vars = agentVarsIn(env);
  add(
    'Next.js',
    'warn',
    `experimental.agentUpgrade is set: \`next dev\` stops itself when it sees an AI agent${vars.length ? ` (here: ${vars.join(', ')})` : ''}, so the visual and live API checks are skipped when holdline runs from the agent's hooks`,
    'upgrade Next.js, remove experimental.agentUpgrade from next.config, or run holdline before/after from a terminal outside the agent',
  );
}

async function lockChecks(root: string, add: Add): Promise<void> {
  const dir = storePaths(root).dir;
  let lock: Awaited<ReturnType<typeof readLock>>;
  try {
    lock = await readLock(dir);
  } catch {
    lock = null;
  }
  if (lock === undefined) add('Lock and session', 'ok', 'no lock held');
  else if (lock === null) add('Lock and session', 'warn', 'the lock file is unreadable; it will be cleared automatically', 'or run `holdline unlock`');
  else if (lockIsLive(lock)) add('Lock and session', 'warn', `\`holdline ${lock.command}\` is running (pid ${lock.pid}, started ${relativeTime(lock.startedAt)})`, 'wait for it; the hooks skip a turn while it runs');
  else add('Lock and session', 'warn', `stale lock from \`holdline ${lock.command}\` (pid ${lock.pid} is gone); it will be cleared automatically`, 'or run `holdline unlock`');
  const session = await readSession(root).catch(() => null);
  if (session) add('Lock and session', 'info', `session: "${session.task.split('\n')[0]!.slice(0, 70)}" (${relativeTime(session.createdAt)})`);
  const state = await readState(root);
  if (state.turn) add('Lock and session', 'info', `hooks: ${state.turn.status} turn of Claude session ${state.turn.claudeSessionId.slice(0, 8)} (${relativeTime(state.turn.updatedAt)}, ${state.turn.fixRounds} fix round${state.turn.fixRounds === 1 ? '' : 's'})`);
}
