/**
 * What the hooks remember between events: the turn currently being tracked (one per
 * project), which Claude session it belongs to, and how many fix rounds it used.
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readJson, storePaths, writeJson } from '../core/store.js';

export type TurnStatus = 'starting' | 'ready' | 'skipped' | 'ended';

export interface Turn {
  claudeSessionId: string;
  /** The prompt, shortened (for messages and the log). */
  prompt: string;
  startedAt: string;
  updatedAt: string;
  status: TurnStatus;
  /** createdAt of the holdline session this turn is checked against. */
  sessionCreatedAt: string | null;
  fixRounds: number;
  /** Tree of the last `after` that asked Claude to fix something. */
  lastAfterTree: string | null;
  /** The prompt was added to the open session (follow-up) instead of starting a new one. */
  followUp?: boolean;
}

export interface HookState {
  version: 1;
  turn: Turn | null;
}

export const hooksDir = (root: string) => path.join(storePaths(root).dir, 'hooks');
const stateFile = (root: string) => path.join(hooksDir(root), 'state.json');

export async function readState(root: string): Promise<HookState> {
  try {
    const s = await readJson<HookState>(stateFile(root));
    if (s && s.version === 1) return s;
  } catch {
    /* corrupt: start over */
  }
  return { version: 1, turn: null };
}

export const writeState = (root: string, s: HookState) => writeJson(stateFile(root), s);

/** Synchronous variant for the out-of-time path, right before the process exits. */
export function writeStateSync(root: string, s: HookState): void {
  const file = stateFile(root);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.sync.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n');
  renameSync(tmp, file);
}

/**
 * The turn of a *different* Claude session that is still being tracked, if any. A turn that
 * ended, was skipped, or hasn't been touched for `staleHours` can be taken over.
 */
export function otherActiveTurn(state: HookState, sessionId: string, staleHours: number, now = Date.now()): Turn | null {
  const t = state.turn;
  if (!t || t.claudeSessionId === sessionId) return null;
  if (t.status !== 'starting' && t.status !== 'ready') return null;
  const age = now - Date.parse(t.updatedAt);
  if (!Number.isFinite(age) || age > staleHours * 3600_000) return null;
  return t;
}
