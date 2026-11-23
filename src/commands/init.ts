import { CHECK_NAMES, DEFAULT_TIMEOUTS, saveConfig, type Config } from '../core/config.js';
import { detectProject, PROJECT_TYPE_LABELS } from '../core/detect.js';
import { CancelledError, HoldlineError } from '../core/errors.js';
import { ensureGitignore, readJson } from '../core/store.js';
import type { Io } from '../io.js';
import { buildGraph } from '../probes/dependencies/graph.js';
import { nextPagePattern } from '../probes/dependencies/routes.js';
import { installCommands, loadPlaywright } from '../probes/visual/playwright.js';
import { locked } from './common.js';

const MAX_SUGGESTED_PAGES = 8;

/** Static page URLs from the dependency graph (Next.js app/pages routers), shallowest first. */
export async function suggestPages(root: string, projectType: Config['projectType']): Promise<string[]> {
  const found = new Set<string>(['/']);
  try {
    const graph = await buildGraph(root, { projectType });
    for (const [file, info] of Object.entries(graph.files)) {
      if (info.role !== 'page') continue;
      const pattern = nextPagePattern(file);
      if (pattern && !/[:*]/.test(pattern)) found.add(pattern);
    }
  } catch {
    /* no graph: suggest / only */
  }
  const depth = (p: string) => (p === '/' ? 0 : p.split('/').length - 1);
  return [...found].sort((a, b) => depth(a) - depth(b) || a.localeCompare(b)).slice(0, MAX_SUGGESTED_PAGES);
}

export interface InitOptions {
  yes?: boolean;
}

function showConfig(config: Config, io: Io): void {
  io.log(`  Project type:     ${io.c.bold(PROJECT_TYPE_LABELS[config.projectType])}`);
  io.log(`  Package manager:  ${io.c.bold(config.packageManager)}`);
  for (const name of CHECK_NAMES) {
    const c = config.checks[name];
    io.log(`  ${(name + ':').padEnd(17)} ${c ? io.c.cyan(c.command) : io.c.dim('(disabled)')}`);
  }
  const deps = config.probes?.dependencies?.enabled !== false;
  io.log(`  Dependency map:   ${deps ? io.c.bold('enabled') : io.c.dim('(disabled)')}`);
  const db = config.probes?.database?.enabled !== false;
  io.log(`  Database schema:  ${db ? io.c.bold('enabled') : io.c.dim('(disabled)')}`);
  const api = config.probes?.api?.enabled !== false;
  const live = (config.probes?.api as { live?: { enabled?: boolean } } | undefined)?.live?.enabled === true;
  io.log(`  API shapes:       ${api ? io.c.bold('enabled') + (live ? ' (static + live)' : ' (static)') : io.c.dim('(disabled)')}`);
  const visual = config.probes?.visual as { enabled?: boolean; pages?: string[] } | undefined;
  const pages = visual?.pages ?? [];
  if (visual?.enabled === true) io.log(`  Visual check:     ${io.c.bold('enabled')} (${pages.join(', ')})`);
  else io.log(`  Visual check:     ${io.c.dim(`off${pages.length ? ` (suggested pages: ${pages.join(', ')})` : ''}`)}`);
}

export async function initCommand(cwd: string, opts: InitOptions, io: Io): Promise<Config> {
  return locked(cwd, 'init', io, async ({ root, paths }) => {
    if ((await readJson(paths.config)) !== null && !opts.yes) {
      if (!io.interactive) {
        throw new HoldlineError(`${paths.config} already exists. Pass --yes to overwrite it.`);
      }
      if (!(await io.confirm('.holdline/config.json already exists. Overwrite it?', false))) {
        throw new CancelledError('Kept the existing config.');
      }
    }

    const { config, notes } = await detectProject(root);
    // The visual check is opt-in: pages are suggested, but only enabled when the user confirms.
    config.probes = { ...config.probes, visual: { enabled: false, pages: await suggestPages(root, config.projectType) } };
    io.log('Detected:');
    showConfig(config, io);
    for (const n of notes) io.log(io.c.dim(`  · ${n}`));
    io.log();

    if (!opts.yes) {
      if (!io.interactive) {
        throw new HoldlineError('Not running in a terminal; pass --yes to accept the detected settings.');
      }
      if (!(await io.confirm('Use these commands?', true))) {
        io.log(io.c.dim('Edit each command. Clear the line to disable that check.'));
        for (const name of CHECK_NAMES) {
          const answer = (await io.input(`${name} command:`, config.checks[name]?.command ?? '')).trim();
          config.checks[name] = answer
            ? { command: answer, timeoutSec: config.checks[name]?.timeoutSec ?? DEFAULT_TIMEOUTS[name] }
            : null;
        }
        io.log();
        showConfig(config, io);
      }
    }

    const visual = config.probes!.visual as { enabled: boolean; pages: string[] };
    if (!opts.yes && io.interactive && visual.pages.length > 0) {
      const enable = await io.confirm(
        `Enable the visual check (screenshots, console errors, failed requests) for ${visual.pages.join(', ')}? It starts your dev server and needs Playwright.`,
        false,
      );
      if (enable) {
        visual.enabled = true;
        const pw = loadPlaywright(root, config.packageManager);
        if (!pw.ok) {
          io.log(io.c.yellow('Playwright is not installed. Install it and Chromium with:'));
          for (const cmd of installCommands(config.packageManager)) io.log(`  ${io.c.bold(cmd)}`);
        }
      }
    }
    if (!visual.enabled) {
      io.log(io.c.dim('Visual check: off. To turn it on, set probes.visual.enabled to true in .holdline/config.json (edit probes.visual.pages as needed).'));
    }

    await saveConfig(root, config);
    const added = await ensureGitignore(root);
    io.log(io.c.green(`Wrote ${paths.config}`));
    if (added) io.log('Added .holdline/ to .gitignore');
    io.log(`Next: ${io.c.bold('holdline before --task "<what the agent is about to do>"')}`);
    return config;
  });
}
