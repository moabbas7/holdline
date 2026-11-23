import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { HookInput } from '../../src/hooks/handlers.js';
import { runHook, type HookEvent, type RunHookOptions, type RunHookResult } from '../../src/hooks/run.js';
import type { HookState } from '../../src/hooks/state.js';
import { fixtureRepo } from '../helpers/fixtures.js';
import { tmpDir, writeConfig, type TestRepo } from '../helpers/tmpRepo.js';

export interface HookRepo extends TestRepo {
  /** How many times the build check ran. */
  builds(): number;
}

/** The scope-app fixture; its build check counts its runs in a file outside the repo. */
export async function hookRepo(extra: Record<string, unknown> = {}): Promise<HookRepo> {
  const t = fixtureRepo('scope-app') as HookRepo;
  const counter = path.join(tmpDir(), 'builds.txt');
  writeFileSync(counter, '');
  const node = JSON.stringify(process.execPath);
  const build = `${node} -e "require('fs').appendFileSync(${JSON.stringify(JSON.stringify(counter)).slice(1, -1)}, 'x')" && ${node} scripts/check.mjs`;
  await writeConfig(t.dir, { build }, { projectType: 'nextjs', probes: { api: { enabled: false } }, ...extra });
  t.builds = () => readFileSync(counter, 'utf8').length;
  return t;
}

let n = 0;
/** Real-shaped hook input, as Claude Code sends it. */
export function input(t: TestRepo, event: 'UserPromptSubmit' | 'Stop' | 'SessionStart' | 'SessionEnd', fields: Partial<HookInput> = {}): HookInput {
  return {
    session_id: 'sess-aaaa-1111',
    transcript_path: path.join(t.dir, '..', `transcript-${++n}.jsonl`),
    cwd: t.dir,
    hook_event_name: event,
    permission_mode: 'default',
    ...(event === 'Stop' ? { stop_hook_active: false, last_assistant_message: 'Done.' } : {}),
    ...(event === 'SessionStart' ? { source: 'startup' } : {}),
    ...(event === 'SessionEnd' ? { reason: 'prompt_input_exit' } : {}),
    ...fields,
  };
}

const noWarm = () => {};

export const hook = (event: HookEvent, i: HookInput, opts: RunHookOptions = {}): Promise<RunHookResult> => runHook(event, i, { spawnWarm: noWarm, ...opts });
export const prompt = (t: TestRepo, text: string, fields: Partial<HookInput> = {}, opts: RunHookOptions = {}) => hook('prompt', input(t, 'UserPromptSubmit', { prompt: text, ...fields }), opts);
export const stop = (t: TestRepo, fields: Partial<HookInput> = {}, opts: RunHookOptions = {}) => hook('stop', input(t, 'Stop', fields), opts);

export const out = (r: RunHookResult): Record<string, unknown> => (r.stdout ? (JSON.parse(r.stdout) as Record<string, unknown>) : {});

export function state(t: TestRepo): HookState {
  const f = t.p('.holdline/hooks/state.json');
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as HookState) : { version: 1, turn: null };
}

export function session(t: TestRepo): { task: string; createdAt: string; snapshot: { sha: string }; scope?: { task: string } } {
  return JSON.parse(t.read('.holdline/session.json'));
}

/** Break the build in a file outside the "users" task. */
export function breakBilling(t: TestRepo): void {
  const f = 'app/billing/page.tsx';
  t.write(f, t.read(f).replace('  return <InvoiceTable', '  const x = BROKEN;\n  return <InvoiceTable'));
}

export function fixBilling(t: TestRepo): void {
  const f = 'app/billing/page.tsx';
  t.write(f, t.read(f).replace('  const x = BROKEN;\n', ''));
}
