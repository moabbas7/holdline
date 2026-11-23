/**
 * Playwright is optional: when it (or Chromium) is missing, before/after print the install
 * commands, skip the visual check and carry on, and the dev server is never started. When
 * the browser fails mid-run, the server's process tree is still killed.
 */
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { afterCommand } from '../../src/commands/after.js';
import { beforeCommand } from '../../src/commands/before.js';
import { installCommands, launchChromium, loadPlaywright } from '../../src/probes/visual/playwright.js';
import { cleanupAll, fakeIo, writeConfig } from '../helpers/tmpRepo.js';
import { expectTreeDead, starts, visualRepo } from './helpers.js';

const mode = vi.hoisted(() => ({ value: 'missing' as 'missing' | 'launch-throws' | 'real' }));
vi.mock('../../src/probes/visual/playwright.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/probes/visual/playwright.js')>();
  return {
    ...orig,
    loadPlaywright: (...args: Parameters<typeof orig.loadPlaywright>) =>
      mode.value === 'missing' ? orig.loadPlaywright(args[0], args[1], { modules: ['holdline-test-no-such-playwright'] }) : orig.loadPlaywright(...args),
    launchChromium: async (...args: Parameters<typeof orig.launchChromium>) => {
      if (mode.value === 'launch-throws') throw new Error('browser crashed');
      return orig.launchChromium(...args);
    },
  };
});

afterEach(cleanupAll);

describe('Playwright not installed', () => {
  it('warns with the install commands, skips the check and the run continues', { timeout: 60_000 }, async () => {
    mode.value = 'missing';
    const t = await visualRepo({ pages: ['/'] });
    await writeConfig(t.dir, { test: 'node -e "process.exit(0)"' }, { probes: { dependencies: { enabled: false }, database: { enabled: false }, api: { enabled: false }, visual: { enabled: true, pages: ['/'] } } });
    const io = fakeIo();
    const session = await beforeCommand(t.dir, { task: 'x', yes: true }, io);
    const w = io.warnings.join('\n');
    expect(w).toContain('Playwright is not installed, so the visual check was skipped');
    expect(w).toContain('npm install -D playwright');
    expect(w).toContain('npx playwright install chromium');
    expect(session.probes.checks).toBeDefined();
    expect(starts(t)).toBe(0);

    const io2 = fakeIo();
    const report = await afterCommand(t.dir, {}, io2);
    expect(report.regressed).toBe(false);
    expect(report.reports.find((r) => r.probeId === 'checks')!.status).not.toBe('skipped');
    const visual = report.reports.find((r) => r.probeId === 'visual')!;
    expect(visual.status).toBe('skipped');
    expect(visual.summary).toContain('npm install -D playwright');
    expect(io2.warnings.join('\n')).toContain('npx playwright install chromium');
    expect(starts(t)).toBe(0);
  });

  it('kills the server tree when the browser fails during the run', { timeout: 60_000 }, async () => {
    mode.value = 'launch-throws';
    const t = await visualRepo({ pages: ['/'] });
    const io = fakeIo();
    await beforeCommand(t.dir, { task: 'x', yes: true }, io);
    expect(starts(t)).toBe(1);
    expectTreeDead(t);
    expect(io.warnings.join('\n')).toContain('Visual check: the visual check failed: browser crashed');
  });
});

describe('loader', () => {
  beforeEach(() => {
    mode.value = 'real';
  });

  it('gives the package manager’s install commands', () => {
    const r = loadPlaywright('/nonexistent', 'pnpm', { modules: ['holdline-test-no-such-playwright'] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('pnpm add -D playwright');
      expect(r.message).toContain('pnpm exec playwright install chromium');
    }
    expect(installCommands('yarn')).toEqual(['yarn add -D playwright', 'yarn playwright install chromium']);
    expect(installCommands('bun')).toEqual(['bun add -d playwright', 'bunx playwright install chromium']);
  });

  it('finds Playwright from the project or holdline', () => {
    const r = loadPlaywright('/nonexistent', 'npm', { requires: [{ from: 'test', require: createRequire(import.meta.url) }] });
    expect(r.ok).toBe(true);
  });

  it('a missing Chromium download becomes the install message', async () => {
    const fake = { launch: async () => { throw new Error("browserType.launch: Executable doesn't exist at /x/chrome\nLooks like Playwright was just installed…"); } };
    const r = await launchChromium(fake as never, 'npm');
    expect(r).toEqual({ ok: false, message: expect.stringContaining('npx playwright install chromium') });
    expect((r as { message: string }).message).toContain("Playwright's Chromium is not installed");
  });
});
