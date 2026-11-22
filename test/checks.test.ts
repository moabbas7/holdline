import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { afterCommand } from '../src/commands/after.js';
import { beforeCommand } from '../src/commands/before.js';
import { runCommand } from '../src/core/runner.js';
import { checksProbe, type ChecksSnapshot } from '../src/probes/checks.js';
import { cleanupAll, fakeIo, makeRepo, tmpDir, writeConfig } from './helpers/tmpRepo.js';

afterEach(cleanupAll);

const node = (code: string) => `"${process.execPath}" -e "${code}"`;

describe('runCommand', () => {
  it('captures exit code and output', async () => {
    const dir = tmpDir();
    const r = await runCommand(node("console.log('hello'); console.error('oops'); process.exit(3)"), {
      cwd: dir,
      timeoutMs: 10_000,
      logFile: path.join(dir, 'x.log'),
    });
    expect(r.exitCode).toBe(3);
    expect(r.timedOut).toBe(false);
    expect(r.outputTail).toContain('hello');
    expect(r.outputTail).toContain('oops');
  });

  it('kills commands that exceed their timeout', async () => {
    const dir = tmpDir();
    const started = Date.now();
    const r = await runCommand(node('setTimeout(() => {}, 30000)'), {
      cwd: dir,
      timeoutMs: 300,
      logFile: path.join(dir, 'x.log'),
    });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe('checks probe compare', () => {
  const result = (passed: boolean) => ({
    command: 'x',
    passed,
    exitCode: passed ? 0 : 1,
    signal: null,
    timedOut: false,
    durationMs: 1,
    outputTail: passed ? '' : 'Error: boom',
    logFile: 'x.log',
  });
  const snap = (r: Partial<Record<string, boolean>>): ChecksSnapshot => ({
    results: Object.fromEntries(Object.entries(r).map(([k, v]) => [k, result(v!)])),
  });

  it('classifies regressions, fixes and pre-existing failures', async () => {
    const report = await checksProbe.compare(
      snap({ build: true, typecheck: false, lint: false, test: true }),
      snap({ build: true, typecheck: true, lint: false, test: false }),
      {} as never,
    );
    expect(report.status).toBe('regressed');
    const byKind = (k: string) => report.findings.filter((f) => f.kind === k).map((f) => f.title);
    expect(byKind('regression')).toEqual(['test: passed before, fails now']);
    expect(byKind('fixed')).toEqual(['typecheck: failed before, passes now']);
    expect(byKind('still-failing')).toEqual(['lint: was already failing before the task']);
  });

  it('is ok when nothing regressed', async () => {
    const report = await checksProbe.compare(snap({ build: false }), snap({ build: false }), {} as never);
    expect(report.status).toBe('ok');
  });
});

describe('before → after end to end', () => {
  it('reports checks that went from passing to failing, and changed files', async () => {
    const t = makeRepo();
    t.write('.gitignore', '.holdline/\n');
    // "Tests" pass while src/math.js is correct; "lint" was already failing.
    t.write('src/math.js', 'module.exports = (a, b) => a + b;\n');
    t.write(
      'check.js',
      "const add = require('./src/math.js'); process.exit(add(2, 2) === 4 ? 0 : 1);\n",
    );
    t.commitAll('app');
    await writeConfig(t.dir, {
      build: node('process.exit(0)'),
      lint: node("console.log('lint error in legacy.js'); process.exit(1)"),
      test: `"${process.execPath}" check.js`,
    });

    const session = await beforeCommand(t.dir, { task: 'add a subtract function', yes: true }, fakeIo());
    const results = (session.probes.checks as ChecksSnapshot).results;
    expect(results.build?.passed).toBe(true);
    expect(results.test?.passed).toBe(true);
    expect(results.lint?.passed).toBe(false);

    // The agent "adds subtract" but breaks add, and leaves a stray file.
    t.write('src/math.js', 'module.exports = (a, b) => a - b;\n').write('src/subtract.js', 'x');
    t.rm('README.md');

    const io = fakeIo();
    const report = await afterCommand(t.dir, {}, io);
    expect(report.regressed).toBe(true);
    const checks = report.reports.find((r) => r.probeId === 'checks')!;
    expect(checks.findings.filter((f) => f.kind === 'regression').map((f) => f.title)).toEqual([
      'test: passed before, fails now',
    ]);
    const files = report.reports.find((r) => r.probeId === 'files')!;
    expect(files.findings.map((f) => f.title).sort()).toEqual([
      'A src/subtract.js',
      'D README.md',
      'M src/math.js',
    ]);
    const out = io.logs.join('\n');
    expect(out).toContain('test: passed before, fails now');
    expect(out).toContain('lint: was already failing before the task');
    expect(out).toContain('holdline rollback');
  });

  it('reports no regressions when the agent only touched its task', async () => {
    const t = makeRepo();
    t.write('.gitignore', '.holdline/\n');
    await writeConfig(t.dir, { test: node('process.exit(0)') });
    await beforeCommand(t.dir, { task: 'docs', yes: true }, fakeIo());
    t.write('docs/new.md', 'hello\n');
    const report = await afterCommand(t.dir, {}, fakeIo());
    expect(report.regressed).toBe(false);
    expect(report.headMoved).toBeNull();
  });

  it('requires a session', async () => {
    const t = makeRepo();
    await writeConfig(t.dir);
    await expect(afterCommand(t.dir, {}, fakeIo())).rejects.toThrow(/holdline before/);
  });
});
