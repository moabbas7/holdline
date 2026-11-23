import { afterEach, describe, expect, it } from 'vitest';
import { beforeCommand } from '../../src/commands/before.js';
import { cleanupAll, fakeIo } from '../helpers/tmpRepo.js';
import { edit, runTask, scopeRepo } from './helpers.js';

afterEach(() => cleanupAll());

/** A build that writes output git doesn't ignore: out/app.js (new folder) and lib/version.ts (tracked). */
const BUILD = `"${process.execPath}" -e "const fs=require('fs');fs.mkdirSync('out',{recursive:true});fs.writeFileSync('out/app.js','built\\n');fs.writeFileSync('lib/version.ts','export const BUILT = true;\\n')"`;

describe('files written by holdline’s own checks', { timeout: 120_000 }, () => {
  it('are not counted as agent changes, and .gitignore lines are suggested', async () => {
    const t = await scopeRepo({}, BUILD);
    t.write('lib/version.ts', 'export const BUILT = false;\n');
    t.commitAll('version');
    const beforeIo = fakeIo();
    await beforeCommand(t.dir, { task: 'add pagination to the users list', yes: true }, beforeIo);
    expect(beforeIo.warnings.join('\n')).toMatch(/Your checks wrote 2 files that git doesn't ignore/);

    edit(t, 'app/users/page.tsx', 'export default async function UsersPage() {', 'export default async function UsersPage() {\n  const page = 1;');
    const { afterCommand } = await import('../../src/commands/after.js');
    const io = fakeIo();
    const report = await afterCommand(t.dir, {}, io);
    const changed = report.reports.find((r) => r.probeId === 'files')!.findings.map((f) => f.path);
    expect(changed).toEqual(['app/users/page.tsx']);
    expect(report.scoped.ownOutputs).toEqual({ excluded: ['lib/version.ts', 'out/app.js'], agentEdited: [], gitignoreSuggestion: ['/lib/version.ts', '/out/'] });
    const deps = report.reports.find((r) => r.probeId === 'dependencies')!;
    expect(deps.summary).toMatch(/^1 changed file/);
    const out = io.logs.join('\n');
    expect(out).toContain('2 files were written by your own checks during `holdline before`');
    expect(out).toContain('Add to .gitignore: /lib/version.ts  /out/');
    expect(report.scoped.scope.edited).toEqual({ inScope: 1, ripple: 0, outside: 0 });
  });

  it('a generated file the agent also edits stays an agent change, and the reason says so', async () => {
    const t = await scopeRepo({}, BUILD);
    const { report } = await runTask(t, 'add pagination to the users list', (t) => {
      t.write('out/app.js', 'hand-edited by the agent\n');
    });
    const f = report.scoped.findings.find((x) => x.probe === 'files' && x.files.includes('out/app.js'))!;
    expect(f).toBeDefined();
    expect(f.scope).toBe('outside-scope');
    expect(f.reason).toContain('your build also wrote this file in `before`, but the agent changed it since, so it counts as an agent change');
    expect(report.scoped.ownOutputs.excluded).toEqual(['lib/version.ts']);
    expect(report.scoped.ownOutputs.agentEdited).toEqual(['out/app.js']);
  });

  it('nothing is recorded when the build output is git-ignored', async () => {
    const t = await scopeRepo({}, BUILD);
    t.write('.gitignore', `${t.read('.gitignore')}out/\nlib/version.ts\n`);
    t.commitAll('ignore build output');
    const io = fakeIo();
    const session = await beforeCommand(t.dir, { task: 'x', yes: true }, io);
    expect(session.ownOutputs).toBeUndefined();
    expect(io.warnings.join('\n')).not.toMatch(/Your checks wrote/);
  });
});
