import { afterCommand, type AfterReport } from '../../src/commands/after.js';
import { beforeCommand } from '../../src/commands/before.js';
import type { ReportFinding } from '../../src/report/model.js';
import { fixtureRepo } from '../helpers/fixtures.js';
import { fakeIo, writeConfig, type FakeIo, type TestRepo } from '../helpers/tmpRepo.js';

/** The scope-app fixture with its fake type checker as the build check. */
export async function scopeRepo(probes: Record<string, { enabled?: boolean; [k: string]: unknown }> = {}, build?: string): Promise<TestRepo> {
  const t = fixtureRepo('scope-app');
  await writeConfig(t.dir, { build: build ?? `"${process.execPath}" scripts/check.mjs` }, { projectType: 'nextjs', probes: { api: { enabled: false }, ...probes } });
  return t;
}

/** before → agent edits → after. */
export async function runTask(
  t: TestRepo,
  task: string,
  agent: (t: TestRepo) => void,
  opts: { scope?: string[]; all?: boolean } = {},
): Promise<{ report: AfterReport; io: FakeIo; out: string }> {
  await beforeCommand(t.dir, { task, yes: true, ...(opts.scope ? { scope: opts.scope } : {}) }, fakeIo());
  agent(t);
  const io = fakeIo();
  const report = await afterCommand(t.dir, { all: opts.all }, io);
  return { report, io, out: io.logs.join('\n') };
}

export const group = (r: AfterReport, scope: ReportFinding['scope']) => r.scoped.findings.filter((f) => f.severity !== 'info' && f.scope === scope);

/** Insert `text` after the first line matching `after`. */
export function edit(t: TestRepo, file: string, find: string, replace: string): void {
  const s = t.read(file);
  if (!s.includes(find)) throw new Error(`${file} has no ${JSON.stringify(find)}`);
  t.write(file, s.replace(find, replace));
}
