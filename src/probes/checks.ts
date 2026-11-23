import path from 'node:path';
import { CHECK_NAMES, type CheckName } from '../core/config.js';
import { runCommand } from '../core/runner.js';
import type { Finding, Probe, ProbeReport } from './types.js';
import { posix } from '../core/paths.js';
import { plural } from '../plural.js';

export interface CheckResult {
  command: string;
  passed: boolean;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  outputTail: string;
  logFile: string;
}

export interface ChecksSnapshot {
  results: Partial<Record<CheckName, CheckResult>>;
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

export const checksProbe: Probe<ChecksSnapshot> = {
  id: 'checks',
  title: 'Build, typecheck, lint and tests',

  enabled(config) {
    return CHECK_NAMES.some((n) => config.checks[n] !== null);
  },

  async saveBaseline(data) {
    return data;
  },

  async restoreBaseline(kept) {
    const k = kept as ChecksSnapshot | null;
    return k && typeof k === 'object' && k.results && typeof k.results === 'object' ? k : null;
  },

  async snapshot(ctx) {
    const results: ChecksSnapshot['results'] = {};
    for (const name of CHECK_NAMES) {
      const check = ctx.config.checks[name];
      if (!check) continue;
      ctx.io.progress(`  ${name.padEnd(9)} ${check.command} …`);
      const logFile = path.join(ctx.runDir, `${name}.log`);
      const r = await runCommand(check.command, {
        cwd: ctx.root,
        timeoutMs: check.timeoutSec * 1000,
        logFile,
      });
      const passed = r.exitCode === 0 && !r.timedOut;
      results[name] = {
        command: check.command,
        passed,
        exitCode: r.exitCode,
        signal: r.signal,
        timedOut: r.timedOut,
        durationMs: r.durationMs,
        outputTail: r.outputTail,
        logFile: posix(path.relative(ctx.root, logFile)),
      };
      const status = passed ? ctx.io.c.green('pass') : ctx.io.c.red(r.timedOut ? 'timeout' : 'fail');
      ctx.io.progressDone(`  ${name.padEnd(9)} ${status} ${ctx.io.c.dim(`(${secs(r.durationMs)})`)}`);
    }
    return { results };
  },

  async compare(before, after) {
    const findings: Finding[] = [];
    const names = CHECK_NAMES.filter((n) => before.results[n] || after.results[n]);
    for (const name of names) {
      const b = before.results[name];
      const a = after.results[name];
      if (!b || !a) {
        findings.push({
          kind: 'info',
          title: `${name}: ${b ? 'not run after' : 'not run before'} (config changed?)`,
        });
        continue;
      }
      const detail = `${a.command}\n${a.outputTail.trim()}\n(full log: ${a.logFile})`;
      if (b.passed && !a.passed) {
        findings.push({
          kind: 'regression',
          title: `${name}: passed before, ${a.timedOut ? 'times out' : 'fails'} now`,
          detail,
        });
      } else if (!b.passed && a.passed) {
        findings.push({ kind: 'fixed', title: `${name}: failed before, passes now` });
      } else if (!b.passed && !a.passed) {
        findings.push({ kind: 'still-failing', title: `${name}: was already failing before the task`, detail });
      }
      if (b.command !== a.command) {
        findings.push({ kind: 'info', title: `${name}: command changed from \`${b.command}\` to \`${a.command}\`` });
      }
    }
    const regressions = findings.filter((f) => f.kind === 'regression').length;
    const report: ProbeReport = {
      probeId: 'checks',
      title: this.title,
      status: regressions > 0 ? 'regressed' : 'ok',
      summary:
        regressions > 0
          ? `${plural(regressions, 'check')} went from passing to failing`
          : names.length === 0
            ? 'no checks configured'
            : 'no check went from passing to failing',
      findings,
    };
    return report;
  },
};
