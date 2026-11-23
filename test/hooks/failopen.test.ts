import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { NOT_CONFIGURED } from '../../src/hooks/handlers.js';
import { buildCli } from '../helpers/cli.js';
import { cleanupAll, makeRepo, tmpDir } from '../helpers/tmpRepo.js';
import { breakBilling, hook, hookRepo, input, out, prompt, state, stop } from './helpers.js';
import { alive } from '../helpers/platform.js';

afterEach(() => cleanupAll());

/** One line or nothing, and never anything but JSON on stdout. */
function expectAtMostOneLine(stdout: string): void {
  if (!stdout) return;
  const lines = stdout.trim().split('\n');
  expect(lines).toHaveLength(1);
  const o = JSON.parse(lines[0]!) as Record<string, unknown>;
  expect(o.decision).toBeUndefined();
  if (o.systemMessage !== undefined) expect(String(o.systemMessage)).not.toContain('\n');
}

/** A lock file held by another live process (this test's parent). */
function holdLock(dir: string, command = 'after'): void {
  mkdirSync(`${dir}/.holdline`, { recursive: true });
  writeFileSync(
    `${dir}/.holdline/lock`,
    JSON.stringify({ pid: process.ppid, hostname: os.hostname(), command, startedAt: new Date().toISOString(), token: 'other' }),
  );
}

describe('fail open', { timeout: 120_000 }, () => {
  it('a lock held by another holdline command: the prompt goes ahead, one line, the turn is not checked', async () => {
    const t = await hookRepo();
    holdLock(t.dir);
    const r = await prompt(t, 'add pagination to the users list');
    expectAtMostOneLine(r.stdout);
    expect(String(out(r).systemMessage)).toMatch(/^holdline: couldn't start checking this task: another holdline command is running here \(`holdline after`, pid \d+\)\. It won't be checked\.$/);
    expect(state(t).turn!.status).toBe('skipped');
    expect(existsSync(t.p('.holdline/session.json'))).toBe(false);
    // …and the stop hook then does nothing.
    const s = await stop(t);
    expect(s.stdout).toBe('');
    expect(s.result.outcome).toBe('turn-skipped');
  });

  it('a lock held while Claude finishes: no fix round, one line', async () => {
    const t = await hookRepo();
    await prompt(t, 'add pagination to the users list');
    breakBilling(t);
    holdLock(t.dir);
    const r = await stop(t);
    expectAtMostOneLine(r.stdout);
    expect(String(out(r).systemMessage)).toMatch(/^holdline: couldn't check Claude's changes: another holdline command is running here/);
  });

  it('not configured: the prompt hook says so in one line; the others are silent', async () => {
    const t = makeRepo();
    const p = await hook('prompt', input(t, 'UserPromptSubmit', { prompt: 'x' }));
    expect(out(p)).toEqual({ systemMessage: NOT_CONFIGURED });
    expect((await hook('stop', input(t, 'Stop'))).stdout).toBe('');
    expect((await hook('session-start', input(t, 'SessionStart'))).stdout).toBe('');
  });

  it('not a git repository: silent', async () => {
    const dir = tmpDir();
    const r = await hook('prompt', { cwd: dir, prompt: 'x', session_id: 's' });
    expect(r.stdout).toBe('');
    expect(r.result.outcome).toBe('not-a-repo');
  });

  it('a crash inside a handler becomes one line', async () => {
    const t = await hookRepo();
    const r = await hook('stop', input(t, 'Stop'), {
      handler: async () => {
        throw new TypeError("Cannot read properties of undefined (reading 'x')");
      },
    });
    expectAtMostOneLine(r.stdout);
    expect(String(out(r).systemMessage)).toBe("holdline: hook error (Cannot read properties of undefined (reading 'x')); continuing without it.");
  });

  it('out of time: the checks are stopped, the prompt goes ahead with one line, and the turn is not checked', async () => {
    // A portable `sleep 30` that records its pid, so the test can check it was killed.
    const sleeper = `"${process.execPath}" -e "require('fs').writeFileSync('sleeper.pid', String(process.pid)); setTimeout(() => {}, 30000)"`;
    const t = await hookRepo({ checks: { build: { command: sleeper, timeoutSec: 60 }, typecheck: null, lint: null, test: null } });
    const started = Date.now();
    const r = await prompt(t, 'add pagination to the users list', {}, { budgetMs: 1500 });
    expect(Date.now() - started).toBeLessThan(6000);
    expectAtMostOneLine(r.stdout);
    expect(String(out(r).systemMessage)).toMatch(/^holdline: recording the baseline took longer than 2s, so this task isn't checked \(raise hooks\.promptBudgetSec/);
    expect(state(t).turn!.status).toBe('skipped');
    // The sleeper (if it got as far as starting) was killed.
    if (existsSync(t.p('sleeper.pid'))) {
      const pid = Number(readFileSync(t.p('sleeper.pid'), 'utf8'));
      for (let i = 0; i < 40 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50));
      expect(alive(pid)).toBe(false);
    }
  });

  it('HOLDLINE_HOOKS=off turns every hook into a no-op', async () => {
    const t = await hookRepo();
    const r = await prompt(t, 'add pagination to the users list', {}, { env: { ...process.env, HOLDLINE_HOOKS: 'off' } });
    expect(r.stdout).toBe('');
    expect(r.result.outcome).toBe('disabled');
    expect(existsSync(t.p('.holdline/hooks'))).toBe(false);
  });
});

describe('fail open through the real CLI (exit code 0)', { timeout: 120_000 }, () => {
  let cli: string;
  let cleanup: () => void;
  beforeAll(() => ({ cli, cleanup } = buildCli()), 120_000);
  afterAll(() => cleanup?.());

  const runCli = (cwd: string, args: string[], stdin: string) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [cli, ...args], { cwd, env: { ...process.env, NO_COLOR: '1' } });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('exit', (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(stdin);
    });

  it('invalid stdin', async () => {
    const t = await hookRepo();
    const r = await runCli(t.dir, ['hook', 'prompt'], 'this is not json');
    expect(r.code).toBe(0);
    expectAtMostOneLine(r.stdout);
    expect(JSON.parse(r.stdout).systemMessage).toBe("holdline: couldn't read the hook input; not checking this time.");
  });

  it('an unexpected crash (holdline cannot write its state) still exits 0 with one line', async () => {
    const t = await hookRepo();
    rmSync(t.p('.holdline/hooks'), { recursive: true, force: true });
    writeFileSync(t.p('.holdline/hooks'), 'not a directory');
    const r = await runCli(t.dir, ['hook', 'prompt'], JSON.stringify(input(t, 'UserPromptSubmit', { prompt: 'add pagination to the users list' })));
    expect(r.code).toBe(0);
    expectAtMostOneLine(r.stdout);
    expect(JSON.parse(r.stdout).systemMessage).toMatch(/^holdline: hook error \(/);
  });

  it('a held lock through the CLI', async () => {
    const t = await hookRepo();
    holdLock(t.dir);
    const r = await runCli(t.dir, ['hook', 'prompt'], JSON.stringify(input(t, 'UserPromptSubmit', { prompt: 'add pagination to the users list' })));
    expect(r.code).toBe(0);
    expectAtMostOneLine(r.stdout);
  });

  it('a normal prompt prints nothing and exits 0; an unknown event exits 0 with one line', async () => {
    const t = await hookRepo();
    const r = await runCli(t.dir, ['hook', 'prompt'], JSON.stringify(input(t, 'UserPromptSubmit', { prompt: 'add pagination to the users list' })));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    const u = await runCli(t.dir, ['hook', 'nonsense'], '{}');
    expect(u.code).toBe(0);
    expectAtMostOneLine(u.stdout);
  });
});
