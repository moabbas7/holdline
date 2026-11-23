import type { Config } from '../core/config.js';

/** At most this many automatic fix rounds per task (not configurable). */
export const MAX_FIX_ROUNDS = 2;

export interface HookSettings {
  /** Time the prompt hook may spend starting a session (snapshot + checks). */
  promptBudgetSec: number;
  /** Time the stop hook may spend on `after`. */
  stopBudgetSec: number;
  /** A turn of another Claude session this old is abandoned and can be taken over. */
  staleTurnHours: number;
}

export const DEFAULT_HOOK_SETTINGS: HookSettings = { promptBudgetSec: 180, stopBudgetSec: 540, staleTurnHours: 2 };

const pos = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d);

export function hookSettings(config: Pick<Config, 'hooks'> | null | undefined): HookSettings {
  const h = (config?.hooks ?? {}) as Record<string, unknown>;
  return {
    promptBudgetSec: pos(h.promptBudgetSec, DEFAULT_HOOK_SETTINGS.promptBudgetSec),
    stopBudgetSec: pos(h.stopBudgetSec, DEFAULT_HOOK_SETTINGS.stopBudgetSec),
    staleTurnHours: pos(h.staleTurnHours, DEFAULT_HOOK_SETTINGS.staleTurnHours),
  };
}

/** Claude Code's `timeout` for each hook (seconds): the budget plus room to report and exit. */
export function hookTimeouts(s: HookSettings) {
  return {
    SessionStart: 10,
    UserPromptSubmit: Math.ceil(s.promptBudgetSec) + 15,
    Stop: Math.ceil(s.stopBudgetSec) + 30,
    SessionEnd: 5,
  };
}

/** HOLDLINE_HOOKS=off (or 0/false) turns every hook handler into a no-op. */
export const hooksDisabled = (env: NodeJS.ProcessEnv = process.env) => /^(off|0|false|no)$/i.test(env.HOLDLINE_HOOKS ?? '');
