import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { CHECK_NAMES, DEFAULT_TIMEOUTS, saveConfig, type Config } from '../core/config.js';
import { detectProject, PROJECT_TYPE_LABELS } from '../core/detect.js';
import { CancelledError, HoldlineError } from '../core/errors.js';
import { ensureGitignore, readJson } from '../core/store.js';
import type { Io } from '../io.js';
import { buildGraph } from '../probes/dependencies/graph.js';
import { nextPagePattern, nextPageTemplate } from '../probes/dependencies/routes.js';
import { isPageTemplate, templateParams } from '../probes/visual/types.js';
import { installCommands, loadPlaywright } from '../probes/visual/playwright.js';
import { locked } from './common.js';

const MAX_SUGGESTED_PAGES = 8;
const LOCALE_PARAMS = /^(?:locale|lang|language|lng|langcode|lang_code|languagecode)$/i;

export interface PageSuggestions {
  /** Page paths (templates such as "/[locale]/pricing" when their values are known). */
  pages: string[];
  /** Sample values guessed for dynamic segments. */
  params: Record<string, string>;
  /** Pages under dynamic segments holdline can't guess a value for. */
  needValues: { template: string; missing: string[] }[];
}

/** The default locale from next.config / i18n config files, if one is set. */
async function defaultLocale(root: string): Promise<string | null> {
  const candidates = ['next.config.js', 'next.config.mjs', 'next.config.ts', 'next.config.cjs', 'i18n.ts', 'i18n.js', 'src/i18n.ts', 'i18n/routing.ts', 'src/i18n/routing.ts', 'i18n/config.ts', 'src/i18n/config.ts', 'next-i18next.config.js'];
  for (const c of candidates) {
    try {
      const text = await readFile(path.join(root, c), 'utf8');
      const m = /defaultLocale\s*[:=]\s*['"`]([\w-]+)['"`]/.exec(text);
      if (m) return m[1]!;
    } catch {
      /* missing */
    }
  }
  return null;
}

/**
 * Pages from the dependency graph (Next.js app/pages routers), shallowest first. Pages
 * under dynamic segments are included when a sample value is known (probes.visual.params,
 * or a guess: locale → the default locale or "en"; an optional catch-all can stay empty).
 */
export async function suggestPages(root: string, projectType: Config['projectType'], known: Record<string, string> = {}): Promise<PageSuggestions> {
  const found = new Set<string>(['/']);
  const params: Record<string, string> = {};
  const needValues = new Map<string, string[]>();
  let locale: string | null | undefined;
  try {
    const graph = await buildGraph(root, { projectType });
    for (const [file, info] of Object.entries(graph.files)) {
      if (info.role !== 'page') continue;
      const pattern = nextPagePattern(file);
      if (!pattern) continue;
      if (!/[:*]/.test(pattern)) {
        found.add(pattern);
        continue;
      }
      const template = nextPageTemplate(file);
      if (!template) continue;
      const missing: string[] = [];
      for (const p of templateParams(template)) {
        if (known[p.name] !== undefined || params[p.name] !== undefined || p.optional) continue;
        if (LOCALE_PARAMS.test(p.name)) {
          locale ??= await defaultLocale(root);
          params[p.name] = locale ?? 'en';
          continue;
        }
        missing.push(p.name);
      }
      if (missing.length) needValues.set(template, missing);
      else found.add(template);
    }
  } catch {
    /* no graph: suggest / only */
  }
  const depth = (p: string) => (p === '/' ? 0 : p.split('/').length - 1);
  const order = (a: string, b: string) => depth(a) - depth(b) || Number(isPageTemplate(a)) - Number(isPageTemplate(b)) || a.localeCompare(b);
  return {
    pages: [...found].sort(order).slice(0, MAX_SUGGESTED_PAGES),
    params,
    needValues: [...needValues].sort(([a], [b]) => order(a, b)).slice(0, MAX_SUGGESTED_PAGES).map(([template, missing]) => ({ template, missing })),
  };
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
    const suggested = await suggestPages(root, config.projectType);
    config.probes = {
      ...config.probes,
      visual: { enabled: false, pages: suggested.pages, ...(Object.keys(suggested.params).length ? { params: suggested.params } : {}) },
    };
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

    const visual = config.probes!.visual as { enabled: boolean; pages: string[]; params?: Record<string, string> };
    if (!opts.yes && io.interactive && visual.pages.length > 0) {
      const enable = await io.confirm(
        `Enable the visual check (screenshots, console errors, failed requests) for ${visual.pages.join(', ')}? It starts your dev server and needs Playwright.`,
        false,
      );
      if (enable) {
        visual.enabled = true;
        // Pages under dynamic segments: ask for a sample value holdline can't guess.
        const params = { ...(visual.params ?? {}) };
        const asked = new Set<string>();
        for (const need of suggested.needValues) {
          for (const name of need.missing) {
            if (asked.has(name) || params[name] !== undefined) continue;
            asked.add(name);
            const v = (await io.input(`Sample value for [${name}] (used in ${need.template}); leave empty to skip these pages:`, '')).trim();
            if (v) params[name] = v;
          }
          if (need.missing.every((m) => params[m] !== undefined)) visual.pages.push(need.template);
        }
        if (Object.keys(params).length) visual.params = params;
        const pw = loadPlaywright(root, config.packageManager);
        if (!pw.ok) {
          io.log(io.c.yellow('Playwright is not installed. Install it and Chromium with:'));
          for (const cmd of installCommands(config.packageManager)) io.log(`  ${io.c.bold(cmd)}`);
        }
      }
    }
    const skipped = suggested.needValues.filter((n) => !visual.pages.includes(n.template));
    if (skipped.length) {
      io.log(
        io.c.dim(
          `Not suggested (need a sample value): ${skipped.map((n) => n.template).join(', ')}. Add them to probes.visual.pages with values in probes.visual.params, e.g. { ${skipped[0]!.missing.map((m) => `"${m}": "…"`).join(', ')} }.`,
        ),
      );
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
