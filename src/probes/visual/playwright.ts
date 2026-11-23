/**
 * Playwright is optional: it is loaded only when the visual check runs, from the project
 * first and then from holdline's own install. When it (or Chromium) is missing, callers get
 * a message with the exact install commands and skip the check instead of failing.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Browser, BrowserType } from 'playwright';
import { assertStarting } from '../../core/stop.js';
import type { PackageManager } from '../../core/config.js';

export const PLAYWRIGHT_MODULES = ['playwright', '@playwright/test', 'playwright-core'];

export function installCommands(pm: PackageManager): string[] {
  switch (pm) {
    case 'pnpm':
      return ['pnpm add -D playwright', 'pnpm exec playwright install chromium'];
    case 'yarn':
      return ['yarn add -D playwright', 'yarn playwright install chromium'];
    case 'bun':
      return ['bun add -d playwright', 'bunx playwright install chromium'];
    default:
      return ['npm install -D playwright', 'npx playwright install chromium'];
  }
}

function notInstalled(what: string, pm: PackageManager, commands = installCommands(pm)): string {
  return `${what}, so the visual check was skipped. Install it in the project with:\n    ${commands.join('\n    ')}`;
}

export type LoadResult = { ok: true; chromium: BrowserType; from: string } | { ok: false; message: string };

export interface LoadOptions {
  /** Module names to try (tests). */
  modules?: string[];
  /** Require functions to resolve with, in order (tests). Default: the project's, then holdline's. */
  requires?: { from: string; require: NodeJS.Require }[];
}

/** Find Playwright without starting anything. */
export function loadPlaywright(root: string, pm: PackageManager, opts: LoadOptions = {}): LoadResult {
  const modules = opts.modules ?? PLAYWRIGHT_MODULES;
  const requires = opts.requires ?? [
    { from: 'the project', require: createRequire(path.join(root, 'package.json')) },
    { from: 'holdline', require: createRequire(import.meta.url) },
  ];
  for (const r of requires) {
    for (const m of modules) {
      let mod: { chromium?: BrowserType };
      try {
        mod = r.require(m) as { chromium?: BrowserType };
      } catch {
        continue;
      }
      if (mod?.chromium && typeof mod.chromium.launch === 'function') return { ok: true, chromium: mod.chromium, from: `${m} (${r.from})` };
    }
  }
  return { ok: false, message: notInstalled('Playwright is not installed', pm) };
}

export type LaunchResult = { ok: true; browser: Browser } | { ok: false; message: string };

/** Launch headless Chromium; a missing browser download becomes the install message. */
export async function launchChromium(chromium: BrowserType, pm: PackageManager): Promise<LaunchResult> {
  assertStarting('Chromium');
  try {
    return { ok: true, browser: await chromium.launch({ headless: true }) };
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    if (/Executable doesn't exist|playwright install|browserType\.launch: .*not found/i.test(msg)) {
      return { ok: false, message: notInstalled("Playwright's Chromium is not installed", pm, [installCommands(pm)[1]!]) };
    }
    return { ok: false, message: `Chromium could not be started: ${msg.split('\n')[0]}` };
  }
}
