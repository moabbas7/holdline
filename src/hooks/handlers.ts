/**
 * The Claude Code hook handlers. Each returns what to print; src/hooks/run.ts adds the time
 * budget, error handling and logging, and always exits 0 (fail open).
 *
 *   SessionStart      start a background baseline run (`hook warm`) so the first prompt can reuse it
 *   UserPromptSubmit  start a holdline session with the prompt as the task (or add a follow-up to it)
 *   Stop              run `after`; feed regressions outside the task back to Claude (≤ 2 rounds)
 *   SessionEnd        mark this session's turn as ended so another session can take over
 */
import { afterCommand, type AfterReport } from '../commands/after.js';
import { amendTaskCommand, beforeCommand, captureBaseline, keepBaseline, MAX_TASK_TEXT } from '../commands/before.js';
import { locked } from '../commands/common.js';
import { configHash, readCandidate } from '../core/baseline.js';
import { loadConfig, type Config } from '../core/config.js';
import { git, type RepoInfo } from '../core/git.js';
import { LockedError } from '../core/lock.js';
import { worktreeTree } from '../core/ownOutputs.js';
import { readSession, type Session } from '../core/session.js';
import { readJson, storePaths } from '../core/store.js';
import type { Io } from '../io.js';
import type { ScopedReport } from '../report/model.js';
import { buildFeedback, unresolvedOf } from './feedback.js';
import { MAX_FIX_ROUNDS, type HookSettings } from './settings.js';
import { otherActiveTurn, readState, writeState, writeStateSync, type HookState, type Turn } from './state.js';
import { plural } from '../plural.js';

/** The JSON Claude Code sends on stdin (the fields holdline uses). */
export interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  permission_mode?: string;
  /** UserPromptSubmit */
  prompt?: string;
  /** Stop: Claude is already continuing because of a stop hook. */
  stop_hook_active?: boolean;
  last_assistant_message?: string;
  /** SessionStart */
  source?: string;
  /** SessionEnd */
  reason?: string;
}

export interface HookResult {
  /** Printed as JSON on stdout (Stop's decision, …). */
  json?: Record<string, unknown>;
  /** One line shown to the user (systemMessage). */
  warning?: string;
  /** For the hook log. */
  outcome: string;
  detail?: string;
}

export interface HookContext {
  repo: RepoInfo;
  root: string;
  config: Config | null;
  settings: HookSettings;
  io: Io;
  now: () => number;
  /** True once the time budget ran out: don't write state any more. */
  cancelled: () => boolean;
  /** Registered by a handler: runs synchronously when the budget runs out. */
  onCancel: (fn: () => void) => void;
  /** Start `holdline hook warm` in the background. */
  spawnWarm: (root: string, sessionId: string) => void;
}

export const NOT_CONFIGURED = 'holdline: not set up in this project (run `holdline install-hooks` or `holdline init`); not checking.';
const otherSessionMessage = (t: Turn) =>
  `holdline: already tracking another Claude session in this project (since ${t.startedAt.slice(11, 16)} UTC); this session isn't checked.`;

const sessionId = (input: HookInput) => (typeof input.session_id === 'string' && input.session_id ? input.session_id : 'unknown');
const shortText = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run `fn`; while the background baseline run holds the lock, wait for it (within the budget). */
async function waitingForWarm<T>(ctx: HookContext, fn: () => Promise<T>): Promise<T> {
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof LockedError && e.holder.command === 'hook-warm' && !ctx.cancelled()) {
        await sleep(300);
        continue;
      }
      throw e;
    }
  }
}

/** One line for an error that stopped a hook from doing its job. */
export function describeFailure(e: unknown): string {
  if (e instanceof LockedError) return `another holdline command is running here (\`holdline ${e.holder.command}\`, pid ${e.holder.pid})`;
  const msg = e instanceof Error ? e.message : String(e);
  return msg.split('\n')[0]!.replace(/\s+/g, ' ').slice(0, 200);
}

// --- SessionStart / warm / SessionEnd ---------------------------------------------------------

export async function sessionStartHook(input: HookInput, ctx: HookContext): Promise<HookResult> {
  if (!ctx.config) return { outcome: 'not-configured' };
  ctx.spawnWarm(ctx.root, sessionId(input));
  return { outcome: 'warm-started' };
}

/** The background baseline run: capture everything now, while nobody is editing, for the first prompt to reuse. */
export async function warmHook(input: HookInput, ctx: HookContext): Promise<HookResult> {
  if (!ctx.config) return { outcome: 'not-configured' };
  const state = await readState(ctx.root);
  // Never run the checks while another Claude session is working on this project.
  if (otherActiveTurn(state, sessionId(input), ctx.settings.staleTurnHours, ctx.now()) || state.turn?.status === 'starting') {
    return { outcome: 'skipped', detail: 'another Claude session is tracked here' };
  }
  const config = ctx.config;
  const hash = await configHash(ctx.root, config);
  const cand = await readCandidate(ctx.root);
  if (cand && cand.configHash === hash) {
    const tree = await worktreeTree(ctx.repo);
    if (cand.trees.some((t) => t.tree === tree)) return { outcome: 'up-to-date' };
  }
  return locked(ctx.root, 'hook-warm', ctx.io, async (project) => {
    const cap = await captureBaseline(project, config, ctx.io, { label: 'warm' });
    await keepBaseline(project, config, ctx.io, 'warm', cap.snap, cap.results, 'before', 'warm');
    return { outcome: 'baseline-recorded' };
  });
}

export async function sessionEndHook(input: HookInput, ctx: HookContext): Promise<HookResult> {
  const state = await readState(ctx.root);
  if (!state.turn || state.turn.claudeSessionId !== sessionId(input)) return { outcome: 'not-tracked' };
  state.turn = { ...state.turn, status: 'ended', updatedAt: new Date(ctx.now()).toISOString() };
  await writeState(ctx.root, state);
  return { outcome: 'ended' };
}

// --- UserPromptSubmit ------------------------------------------------------------------------

async function lastReport(root: string): Promise<ScopedReport | null> {
  try {
    return await readJson<ScopedReport>(storePaths(root).lastReport);
  } catch {
    return null;
  }
}

/**
 * Add the prompt to the open session instead of taking a new snapshot (which would hide what
 * broke earlier) when the last `after` of that session left problems unresolved, or when the
 * hooks opened it and no `after` ran since (the turn was interrupted) and files changed.
 */
async function isFollowUp(ctx: HookContext, session: Session | null, prev: Turn | null): Promise<boolean> {
  if (!session) return false;
  const report = await lastReport(ctx.root);
  if (report && report.sessionCreatedAt === session.createdAt) return unresolvedOf(report).length > 0;
  if (prev && prev.status === 'ready' && prev.sessionCreatedAt === session.createdAt) {
    return (await worktreeTree(ctx.repo)) !== session.snapshot.tree;
  }
  return false;
}

export async function promptHook(input: HookInput, ctx: HookContext): Promise<HookResult> {
  if (!ctx.config) return { outcome: 'not-configured', warning: NOT_CONFIGURED };
  const sid = sessionId(input);
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  const state = await readState(ctx.root);
  const other = otherActiveTurn(state, sid, ctx.settings.staleTurnHours, ctx.now());
  if (other) return { outcome: 'other-session', warning: otherSessionMessage(other) };
  if (!prompt) return { outcome: 'empty-prompt' };

  const session = await readSession(ctx.root).catch(() => null);
  const prev = state.turn?.claudeSessionId === sid ? state.turn : null;
  const followUp = await isFollowUp(ctx, session, prev);

  const nowIso = new Date(ctx.now()).toISOString();
  const turn: Turn = {
    claudeSessionId: sid,
    prompt: shortText(prompt),
    startedAt: nowIso,
    updatedAt: nowIso,
    status: 'starting',
    sessionCreatedAt: null,
    fixRounds: 0,
    lastAfterTree: null,
    ...(followUp ? { followUp: true } : {}),
  };
  const save = (t: Turn) => writeState(ctx.root, { version: 1, turn: t } satisfies HookState);
  await save(turn);
  // Out of time: this turn is not checked (never pair it with an older session).
  ctx.onCancel(() => writeStateSync(ctx.root, { version: 1, turn: { ...turn, status: 'skipped' } }));

  try {
    const s = followUp
      ? await waitingForWarm(ctx, () => amendTaskCommand(ctx.root, prompt, ctx.io))
      : await waitingForWarm(ctx, () => beforeCommand(ctx.root, { task: prompt.slice(0, MAX_TASK_TEXT), yes: true, reuseBaseline: true }, ctx.io));
    if (ctx.cancelled()) return { outcome: 'cancelled' };
    await save({ ...turn, status: 'ready', sessionCreatedAt: s.createdAt, updatedAt: new Date(ctx.now()).toISOString() });
    const reused = (ctx.io as { logs?: string[] }).logs?.some((l) => l.includes('Working tree unchanged since')) ?? false;
    return { outcome: followUp ? 'amended' : reused ? 'session-reused-baseline' : 'session' };
  } catch (e) {
    if (ctx.cancelled()) return { outcome: 'cancelled' };
    await save({ ...turn, status: 'skipped', updatedAt: new Date(ctx.now()).toISOString() });
    return { outcome: 'failed', warning: `holdline: couldn't start checking this task: ${describeFailure(e)}. It won't be checked.`, detail: describeFailure(e) };
  }
}

// --- Stop ------------------------------------------------------------------------------------

export async function stopHook(input: HookInput, ctx: HookContext): Promise<HookResult> {
  if (!ctx.config) return { outcome: 'not-configured' };
  const sid = sessionId(input);
  const state = await readState(ctx.root);
  const turn = state.turn;
  if (!turn) return { outcome: 'no-turn' };
  if (turn.claudeSessionId !== sid) {
    const other = otherActiveTurn(state, sid, ctx.settings.staleTurnHours, ctx.now());
    return other ? { outcome: 'other-session', warning: otherSessionMessage(other) } : { outcome: 'not-tracked' };
  }
  if (turn.status !== 'ready') return { outcome: `turn-${turn.status}` };
  const session = await readSession(ctx.root).catch(() => null);
  if (!session || session.createdAt !== turn.sessionCreatedAt) return { outcome: 'session-replaced' };

  let report: AfterReport;
  try {
    report = await waitingForWarm(ctx, () => afterCommand(ctx.root, {}, ctx.io));
  } catch (e) {
    return { outcome: 'failed', warning: `holdline: couldn't check Claude's changes: ${describeFailure(e)}.`, detail: describeFailure(e) };
  }
  if (ctx.cancelled()) return { outcome: 'cancelled' };
  const scoped = report.scoped;
  const afterTree = (await git(['rev-parse', `${report.afterSnapshot}^{tree}`], { cwd: ctx.root })).trim();
  const unresolved = unresolvedOf(scoped);
  const where = scoped.htmlReport ?? '.holdline/last-report.json';
  const next: Turn = { ...turn, updatedAt: new Date(ctx.now()).toISOString() };
  const save = () => writeState(ctx.root, { version: 1, turn: next });

  if (unresolved.length === 0) {
    await save();
    const main = scoped.findings.filter((f) => f.severity !== 'info');
    const inReg = main.filter((f) => f.kind === 'regression').length;
    const outChanges = main.filter((f) => f.scope === 'outside-scope').length;
    let msg = turn.fixRounds > 0 ? `holdline: the regressions it found are fixed (${plural(turn.fixRounds, 'automatic fix round')})` : 'holdline: nothing broken outside the task';
    if (inReg) msg += `; ${plural(inReg, 'regression')} inside the task area`;
    if (outChanges) msg += `; ${plural(outChanges, 'change')} outside the task to review`;
    return { outcome: turn.fixRounds > 0 ? 'fixed' : 'clean', json: { systemMessage: `${msg} · report: ${where}` } };
  }

  const noProgress = input.stop_hook_active === true && turn.fixRounds > 0 && turn.lastAfterTree === afterTree;
  if (turn.fixRounds >= MAX_FIX_ROUNDS || noProgress) {
    await save();
    const why = noProgress
      ? `Claude changed nothing in the last fix round`
      : `after ${plural(turn.fixRounds, 'automatic fix round')}`;
    return {
      outcome: noProgress ? 'gave-up-no-progress' : 'gave-up-round-limit',
      json: {
        systemMessage: `holdline: ${plural(unresolved.length, 'problem')} outside the task still unresolved ${why}. Report: ${where} · to undo everything since the task started: ${scoped.rollbackCommand}`,
      },
    };
  }

  next.fixRounds = turn.fixRounds + 1;
  next.lastAfterTree = afterTree;
  await save();
  const reason = buildFeedback({ report: scoped, round: next.fixRounds });
  return { outcome: `fix-round-${next.fixRounds}`, json: { decision: 'block', reason }, detail: reason };
}

export async function loadConfigOrNull(root: string): Promise<Config | null> {
  try {
    return await loadConfig(root);
  } catch {
    return null;
  }
}

