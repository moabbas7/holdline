import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireLock } from '../../src/core/lock.js';
import { readCandidate } from '../../src/core/baseline.js';
import { cleanupAll } from '../helpers/tmpRepo.js';
import { breakBilling, hook, hookRepo, input, out, prompt, session, state, stop } from './helpers.js';

afterEach(() => cleanupAll());

describe('UserPromptSubmit hook', { timeout: 120_000 }, () => {
  it('starts a holdline session with the prompt as the task, and prints nothing for Claude', async () => {
    const t = await hookRepo();
    const r = await prompt(t, 'add pagination to the users list');
    expect(r.stdout).toBe(''); // UserPromptSubmit stdout would be added to Claude's context
    expect(r.result.outcome).toBe('session');
    expect(session(t).task).toBe('add pagination to the users list');
    const turn = state(t).turn!;
    expect(turn).toMatchObject({ claudeSessionId: 'sess-aaaa-1111', status: 'ready', fixRounds: 0, sessionCreatedAt: session(t).createdAt });
    expect(t.builds()).toBe(1);
    // Logged with its timing.
    expect(t.read('.holdline/hooks/log.jsonl')).toMatch(/"event":"prompt".*"ms":\d+.*"outcome":"session"/);
  });

  it('a follow-up prompt while problems are unresolved joins the open session: no new snapshot, task and scope include both prompts', async () => {
    const t = await hookRepo();
    await prompt(t, 'add pagination to the users list');
    const first = session(t);
    breakBilling(t);
    const s = await stop(t);
    expect(out(s).decision).toBe('block');

    const refsBefore = t.refs();
    const r = await prompt(t, 'also show the invoice totals on the billing page');
    expect(r.stdout).toBe('');
    expect(r.result.outcome).toBe('amended');
    const second = session(t);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.snapshot.sha).toBe(first.snapshot.sha);
    expect(t.refs()).toEqual(refsBefore); // no snapshot taken
    expect(second.task).toBe('add pagination to the users list\nalso show the invoice totals on the billing page');
    expect(second.scope!.task).toBe(second.task);
    expect(state(t).turn).toMatchObject({ status: 'ready', followUp: true, fixRounds: 0 });
  });

  it('after a clean `after`, the next prompt starts a new session, reusing the results when nothing changed', async () => {
    const t = await hookRepo();
    await prompt(t, 'add pagination to the users list');
    const first = session(t);
    t.write('app/users/page.tsx', t.read('app/users/page.tsx') + '\nexport const pageSize = 20;\n');
    const s = await stop(t);
    expect(out(s).decision).toBeUndefined();
    expect(String(out(s).systemMessage)).toMatch(/^holdline: nothing broken outside the task · report: \.holdline\/reports\//);
    expect(t.builds()).toBe(2); // before + after
    expect((await readCandidate(t.dir))?.source).toBe('after');

    const r = await prompt(t, 'show full names on the users page');
    expect(r.result.outcome).toBe('session-reused-baseline');
    const second = session(t);
    expect(second.createdAt).not.toBe(first.createdAt);
    expect(second.task).toBe('show full names on the users page');
    expect(t.builds()).toBe(2); // the checks were not run again
    expect(existsSync(t.p('.holdline/deps/graph-before.json'))).toBe(true);
  });

  it('runs the checks again when the working tree changed since the last `after`', async () => {
    const t = await hookRepo();
    await prompt(t, 'add pagination to the users list');
    await stop(t);
    expect(t.builds()).toBe(2);
    t.write('README.md', 'edited by hand\n');
    const r = await prompt(t, 'show full names on the users page');
    expect(r.result.outcome).toBe('session');
    expect(t.builds()).toBe(3);
  });

  it('waits for the background baseline run (lock held by `hook warm`) and then continues', async () => {
    const t = await hookRepo();
    const lock = await acquireLock(t.p('.holdline'), 'hook-warm');
    setTimeout(() => void lock.release(), 800);
    const started = Date.now();
    const r = await prompt(t, 'add pagination to the users list');
    expect(Date.now() - started).toBeGreaterThanOrEqual(700);
    expect(r.result.outcome).toBe('session');
    expect(state(t).turn!.status).toBe('ready');
  });

  it('the SessionStart hook starts the background run and returns at once', async () => {
    const t = await hookRepo();
    const spawned: string[] = [];
    const r = await hook('session-start', input(t, 'SessionStart'), { spawnWarm: (root, sid) => void spawned.push(`${root}|${sid}`) });
    expect(r.stdout).toBe('');
    expect(r.result.outcome).toBe('warm-started');
    expect(spawned).toEqual([`${t.dir}|sess-aaaa-1111`]);
    expect(r.ms).toBeLessThan(2000);
  });

  it('the background run records a baseline without touching the session, and the first prompt reuses it', async () => {
    const t = await hookRepo();
    const w = await hook('warm', { cwd: t.dir, session_id: 'sess-aaaa-1111' });
    expect(w.result.outcome).toBe('baseline-recorded');
    expect(existsSync(t.p('.holdline/session.json'))).toBe(false);
    expect(existsSync(t.p('.holdline/deps/graph-warm.json'))).toBe(true);
    expect((await readCandidate(t.dir))?.source).toBe('warm');
    expect(t.builds()).toBe(1);
    // Already up to date: a second run does nothing.
    expect((await hook('warm', { cwd: t.dir, session_id: 'sess-aaaa-1111' })).result.outcome).toBe('up-to-date');

    const r = await prompt(t, 'add pagination to the users list');
    expect(r.result.outcome).toBe('session-reused-baseline');
    expect(t.builds()).toBe(1);
    expect(session(t).task).toBe('add pagination to the users list');
  });

  it('a config change invalidates the reusable results', async () => {
    const t = await hookRepo();
    await hook('warm', { cwd: t.dir, session_id: 'x' });
    const cfg = JSON.parse(t.read('.holdline/config.json'));
    cfg.largeUntrackedWarnMB = 200;
    t.write('.holdline/config.json', JSON.stringify(cfg));
    const r = await prompt(t, 'add pagination to the users list');
    expect(r.result.outcome).toBe('session');
    expect(t.builds()).toBe(2);
  });
});
