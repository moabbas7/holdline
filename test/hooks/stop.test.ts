import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { DATA_NOTICE } from '../../src/hooks/feedback.js';
import { cleanupAll } from '../helpers/tmpRepo.js';
import { breakBilling, fixBilling, hook, hookRepo, input, out, prompt, session, state, stop } from './helpers.js';

afterEach(() => cleanupAll());

const instructionsOf = (reason: string) => reason.slice(0, reason.indexOf(DATA_NOTICE));

describe('Stop hook', { timeout: 120_000 }, () => {
  it('feeds a break outside the task back to Claude: what broke, where and why', async () => {
    const t = await hookRepo();
    await prompt(t, 'add pagination to the users list');
    breakBilling(t);
    const r = await stop(t);
    const o = out(r);
    expect(o.decision).toBe('block');
    const reason = String(o.reason);
    const ins = instructionsOf(reason);
    expect(ins).toContain('1 thing that worked before this task is broken now');
    expect(ins).toContain('1. Outside the task: the build check went from passing to failing in app/billing/page.tsx:');
    expect(ins).toContain('Automatic fix round 1 of 2. Full report: .holdline/reports/');
    expect(reason).toContain("[1] why: the error is in app/billing/page.tsx, which was edited by the agent, but the task doesn't name it");
    expect(reason).toContain("Cannot find name 'BROKEN'");
    expect(reason).not.toMatch(/rollback/i);
    expect(state(t).turn).toMatchObject({ fixRounds: 1, status: 'ready' });
    expect(r.result.outcome).toBe('fix-round-1');
  });

  it("feeds back regressions broken by the task's changes", async () => {
    const t = await hookRepo();
    await prompt(t, 'show full names on the users page');
    t.write('lib/format.ts', t.read('lib/format.ts').replace('export function formatMoney', 'export function formatMoneyCents'));
    const o = out(await stop(t));
    expect(o.decision).toBe('block');
    expect(instructionsOf(String(o.reason))).toMatch(/Broken by the task's changes: an import that worked is now broken in app\/billing\/page\.tsx:\d+/);
  });

  it('never starts a fix round for regressions inside the task area or for plain changes', async () => {
    const t = await hookRepo();
    await prompt(t, 'add pagination to the users list');
    t.write('app/users/page.tsx', t.read('app/users/page.tsx').replace('export default', 'const y = BROKEN;\nexport default'));
    t.write('components/Footer.tsx', 'export const Footer = () => null;\n'); // an outside change, not a break
    const r = await stop(t);
    const o = out(r);
    expect(o.decision).toBeUndefined();
    expect(String(o.systemMessage)).toMatch(/^holdline: nothing broken outside the task; 1 regression inside the task area; 1 change outside the task to review · report: /);
    expect(state(t).turn!.fixRounds).toBe(0);
  });

  it('stops after 2 fix rounds and shows the user the report and the rollback command instead', async () => {
    const t = await hookRepo();
    await prompt(t, 'add pagination to the users list');
    breakBilling(t);
    expect(out(await stop(t)).decision).toBe('block');
    // Claude "tries" (changes something) but the break stays.
    t.write('app/users/page.tsx', t.read('app/users/page.tsx') + '\n// try 1\n');
    const r2 = out(await stop(t, { stop_hook_active: true }));
    expect(r2.decision).toBe('block');
    expect(String(r2.reason)).toContain('Automatic fix round 2 of 2');
    t.write('app/users/page.tsx', t.read('app/users/page.tsx') + '\n// try 2\n');
    const r3 = await stop(t, { stop_hook_active: true });
    const o3 = out(r3);
    expect(o3.decision).toBeUndefined();
    expect(r3.result.outcome).toBe('gave-up-round-limit');
    expect(String(o3.systemMessage)).toMatch(/^holdline: 1 problem outside the task still unresolved after 2 automatic fix rounds\. Report: \.holdline\/reports\/\S+\.html · to undo everything since the task started: holdline rollback$/);
    expect(state(t).turn!.fixRounds).toBe(2);
  });

  it('uses stop_hook_active: no second round when Claude changed nothing in the first', async () => {
    const t = await hookRepo();
    await prompt(t, 'add pagination to the users list');
    breakBilling(t);
    expect(out(await stop(t)).decision).toBe('block');
    const r = await stop(t, { stop_hook_active: true });
    expect(out(r).decision).toBeUndefined();
    expect(r.result.outcome).toBe('gave-up-no-progress');
    expect(String(out(r).systemMessage)).toContain('Claude changed nothing in the last fix round');
  });

  it('a continuation caused by another tool (stop_hook_active, no holdline round yet) is still checked', async () => {
    const t = await hookRepo();
    await prompt(t, 'add pagination to the users list');
    breakBilling(t);
    expect(out(await stop(t, { stop_hook_active: true })).decision).toBe('block');
  });

  it('reports a fix, and the round count starts again with the next prompt', async () => {
    const t = await hookRepo();
    await prompt(t, 'add pagination to the users list');
    breakBilling(t);
    await stop(t);
    fixBilling(t);
    const fixed = out(await stop(t, { stop_hook_active: true }));
    expect(fixed.decision).toBeUndefined();
    expect(String(fixed.systemMessage)).toMatch(/^holdline: the regressions it found are fixed \(1 automatic fix round\)/);

    await prompt(t, 'show full names on the users page');
    expect(state(t).turn!.fixRounds).toBe(0);
    breakBilling(t);
    expect(String(out(await stop(t)).reason)).toContain('Automatic fix round 1 of 2');
  });

  it('does nothing when the prompt hook did not start a session for this turn', async () => {
    const t = await hookRepo();
    const r = await stop(t);
    expect(r.stdout).toBe('');
    expect(r.result.outcome).toBe('no-turn');
    expect(existsSync(t.p('.holdline/last-report.json'))).toBe(false);
  });
});

describe('concurrent Claude sessions', { timeout: 120_000 }, () => {
  it("a second session's prompt and stop hooks leave the tracked session alone", async () => {
    const t = await hookRepo();
    await prompt(t, 'add pagination to the users list', { session_id: 'session-one' });
    const first = session(t);
    breakBilling(t);

    const p2 = await prompt(t, 'refactor the billing page', { session_id: 'session-two' });
    expect(p2.result.outcome).toBe('other-session');
    expect(String(out(p2).systemMessage)).toMatch(/^holdline: already tracking another Claude session in this project \(since \d\d:\d\d UTC\); this session isn't checked\.$/);
    expect(session(t)).toEqual(first); // no snapshot, no amend
    expect(state(t).turn!.claudeSessionId).toBe('session-one');

    const s2 = await stop(t, { session_id: 'session-two' });
    expect(s2.result.outcome).toBe('other-session');
    expect(out(s2).decision).toBeUndefined();
    expect(existsSync(t.p('.holdline/last-report.json'))).toBe(false); // `after` did not run
    expect(t.builds()).toBe(1);

    // The tracked session is still checked normally.
    expect(out(await stop(t, { session_id: 'session-one' })).decision).toBe('block');
  });

  it('a stale turn (older than hooks.staleTurnHours) can be taken over', async () => {
    const t = await hookRepo();
    await prompt(t, 'add pagination to the users list', { session_id: 'session-one' });
    const s = state(t);
    s.turn!.updatedAt = new Date(Date.now() - 3 * 3600_000).toISOString();
    t.write('.holdline/hooks/state.json', JSON.stringify(s));
    const r = await prompt(t, 'show full names on the users page', { session_id: 'session-two' });
    expect(r.result.outcome).not.toBe('other-session');
    expect(state(t).turn).toMatchObject({ claudeSessionId: 'session-two', status: 'ready' });
    expect(session(t).task).toBe('show full names on the users page');
  });

  it('the stale limit is configurable', async () => {
    const t = await hookRepo({ hooks: { staleTurnHours: 0.0001 } });
    await prompt(t, 'add pagination to the users list', { session_id: 'session-one' });
    await new Promise((r) => setTimeout(r, 600));
    const r = await prompt(t, 'show full names on the users page', { session_id: 'session-two' });
    expect(r.result.outcome).not.toBe('other-session');
  });

  it('a turn whose session ended can be taken over', async () => {
    const t = await hookRepo();
    await prompt(t, 'add pagination to the users list', { session_id: 'session-one' });
    const end = await hook('session-end', input(t, 'SessionEnd', { session_id: 'session-one' }));
    expect(end.result.outcome).toBe('ended');
    expect(state(t).turn!.status).toBe('ended');
    const r = await prompt(t, 'show full names on the users page', { session_id: 'session-two' });
    expect(r.result.outcome).not.toBe('other-session');
    expect(state(t).turn!.claudeSessionId).toBe('session-two');
  });
});
