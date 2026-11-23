import { afterEach, describe, expect, it } from 'vitest';
import { afterCommand } from '../../src/commands/after.js';
import { beforeCommand } from '../../src/commands/before.js';
import { cleanupAll, fakeIo } from '../helpers/tmpRepo.js';
import { edit, group, runTask, scopeRepo } from './helpers.js';

afterEach(() => cleanupAll());

const PAGINATE = (t: Parameters<typeof edit>[0]) => edit(t, 'app/users/page.tsx', 'export default async function UsersPage() {', 'export default async function UsersPage() {\n  const page = 1;');

describe('task scope: classification of findings', { timeout: 120_000 }, () => {
  it('an agent that stays in scope produces no outside-scope findings', async () => {
    const t = await scopeRepo();
    const { report, out } = await runTask(t, 'add pagination to the users list', (t) => {
      PAGINATE(t);
      edit(t, 'components/UserCard.tsx', '{name}', '{name} ({1})');
      t.write('app/users/pagination.tsx', "export function Pagination() {\n  return <nav>1</nav>;\n}\n");
    });
    expect(group(report, 'outside-scope')).toEqual([]);
    expect(report.regressed).toBe(false);
    expect(report.scoped.exitCode).toBe(0);
    expect(report.scoped.scope.edited).toEqual({ inScope: 3, ripple: 0, outside: 0 });
    expect(out).not.toContain('Outside the task');
    expect(out).toContain('Everything the agent changed stays within the task area');
    expect(out).toContain('Undo everything: holdline rollback');
    // In-scope changes are collapsed to a count by default…
    expect(out).toMatch(/In the task area: \d+ changes? \(holdline after --all to list them\)/);
    expect(out).not.toContain('A app/users/pagination.tsx');
  });

  it('--all expands the in-scope changes', async () => {
    const t = await scopeRepo();
    const { out } = await runTask(t, 'add pagination to the users list', PAGINATE, { all: true });
    expect(out).toContain('M app/users/page.tsx');
    expect(out).toContain('why: app/users/page.tsx matches "users" in the task');
  });

  it('breaking something unrelated lands outside scope, ranked first: regression before changes', async () => {
    const t = await scopeRepo();
    const { report, out } = await runTask(t, 'add pagination to the users list', (t) => {
      PAGINATE(t);
      edit(t, 'app/billing/page.tsx', '  return <InvoiceTable', '  const x = BROKEN;\n  return <InvoiceTable');
    });
    const outside = group(report, 'outside-scope');
    expect(outside.map((f) => [f.probe, f.kind, f.severity])).toEqual([
      ['checks', 'regression', 'critical'],
      ['files', 'change', 'low'],
    ]);
    expect(outside[0]!.title).toBe('build: passed before, fails now');
    expect(outside[0]!.files).toEqual(['app/billing/page.tsx']);
    expect(outside[0]!.lines).toEqual([{ file: 'app/billing/page.tsx', line: 7 }]);
    expect(report.scoped.findings[0]!.id).toBe(outside[0]!.id); // first in the whole report
    expect(report.scoped.exitCode).toBe(1);
    // Terminal: outside group comes before everything else.
    expect(out.indexOf('Outside the task (2)')).toBeGreaterThan(-1);
    expect(out.indexOf('Outside the task')).toBeLessThan(out.indexOf('In the task area'));
    expect(out).toContain('The agent broke 1 thing outside the task: the build.');
  });

  it('a regression inside the task area is shown, not collapsed, and does not count as outside', async () => {
    const t = await scopeRepo();
    const { report, out } = await runTask(t, 'add pagination to the users list', (t) => {
      edit(t, 'app/users/page.tsx', '  return (', '  const p = BROKEN;\n  return (');
    });
    expect(group(report, 'outside-scope')).toEqual([]);
    const inScope = group(report, 'in-scope');
    expect(inScope.find((f) => f.kind === 'regression')?.title).toBe('build: passed before, fails now');
    expect(out).toContain('In the task area: 1 regression');
    expect(out).toContain('To fix: 1 regression inside the task area (the build).');
    expect(report.scoped.exitCode).toBe(1);
  });

  it('changing a shared file shows its direct dependents as expected ripple', async () => {
    const t = await scopeRepo();
    const { report, out } = await runTask(t, 'show full names on the users page', (t) => {
      edit(t, 'lib/format.ts', '`${first} ${last}`.trim()', '`${first} ${last}`.trim().toUpperCase()');
    });
    expect(group(report, 'outside-scope')).toEqual([]);
    const ripple = group(report, 'expected-ripple');
    const dep = ripple.find((f) => f.probe === 'dependencies');
    expect(dep?.title).toMatch(/^lib\/format\.ts \(modified\) → /);
    expect(dep?.reason).toBe('3 files use lib/format.ts (5 depend on it in all), which the agent changed for the task');
    expect(dep?.affects?.sort()).toEqual(['app/billing/page.tsx', 'app/page.tsx', 'app/settings/page.tsx', 'app/users/page.tsx', 'lib/index.ts']);
    // The edit itself is in scope: the users page (named by the task) imports it.
    const edit_ = report.scoped.findings.find((f) => f.probe === 'files' && f.files.includes('lib/format.ts'));
    expect(edit_?.scope).toBe('in-scope');
    expect(edit_?.reason).toBe('lib/format.ts is imported by app/users/page.tsx, which matches "users" in the task');
    expect(out).toContain('Expected ripple (1)');
  });

  it('a regression in a direct dependent of a shared file changed for the task is broken by the task', async () => {
    const t = await scopeRepo();
    const { report, out } = await runTask(t, 'show full names on the users page', (t) => {
      edit(t, 'lib/format.ts', 'export function formatMoney', 'export function formatMoneyCents');
    });
    const broken = report.scoped.findings.find((f) => f.probe === 'dependencies' && f.kind === 'regression');
    expect(broken?.title).toMatch(/app\/billing\/page\.tsx/);
    expect(broken?.scope).toBe('broken-by-task');
    expect(broken?.reason).toBe('app/billing/page.tsx imports formatMoney from lib/format.ts, which the agent changed for the task');
    expect(broken?.severity).toBe('critical');
    // Expected ripple only holds changes that didn't break anything.
    expect(group(report, 'expected-ripple').filter((f) => f.kind === 'regression')).toEqual([]);
    expect(report.scoped.counts['broken-by-task']).toBeGreaterThanOrEqual(1);
    // Shown right after "Outside the task", before expected ripple.
    expect(out).toMatch(/Broken by the task's changes \(\d+\)/);
    const iBroken = out.indexOf("Broken by the task's changes");
    const iRipple = out.indexOf('Expected ripple');
    if (iRipple > -1) expect(iBroken).toBeLessThan(iRipple);
    const iOutside = out.indexOf('Outside the task');
    if (iOutside > -1) expect(iOutside).toBeLessThan(iBroken);
    expect(report.scoped.summary.join(' ')).toMatch(/The task's changes broke 1 thing that uses them: a broken import in app\/billing\/page\.tsx/);
  });

  it('a file that uses a task file, edited by the agent and left broken, is broken by the task (not inside the task area)', async () => {
    const t = await scopeRepo();
    const { report, out } = await runTask(t, 'add a formatBytes helper to lib/format.ts', (t) => {
      edit(t, 'lib/format.ts', 'export function formatMoney', 'export function formatBytes(n: number): string {\n  return `${n} B`;\n}\n\nexport function formatMoney');
      edit(t, 'app/billing/page.tsx', "from '@/lib/format';", "from '@/lib/formatting';");
    });
    const broken = report.scoped.findings.find((f) => f.probe === 'dependencies' && f.kind === 'regression')!;
    expect(broken.files).toEqual(['app/billing/page.tsx']);
    expect(broken.scope).toBe('broken-by-task');
    expect(broken.reason).toBe('app/billing/page.tsx uses lib/format.ts, which the task covers; it was edited during the task and is broken now');
    expect(group(report, 'in-scope').filter((f) => f.kind === 'regression')).toEqual([]);
    expect(out).toContain("Broken by the task's changes (1)");
  });

  it('ripple follows re-exports (barrel files) by name: users of the changed helper only', async () => {
    const t = await scopeRepo();
    const { report } = await runTask(t, 'show full names on the users page', (t) => {
      edit(t, 'lib/format.ts', '`${first} ${last}`.trim()', '`${last}, ${first}`.trim()');
      // Break both pages that import through lib/index.ts: only one uses the changed helper.
      edit(t, 'app/settings/page.tsx', '  return (', '  const a = BROKEN;\n  return (');
      edit(t, 'app/page.tsx', '  return <h1>', '  const b = BROKEN;\n  return <h1>');
    });
    const check = report.scoped.findings.find((f) => f.probe === 'checks')!;
    // app/page.tsx only imports `db` through the barrel: not a user of format.ts, so the check is outside.
    expect(check.scope).toBe('outside-scope');
    expect(check.reason).toMatch(/^errors are in 2 files, including app\/page\.tsx, which was edited by the agent/);
    const settingsEdit = report.scoped.findings.find((f) => f.probe === 'files' && f.files.includes('app/settings/page.tsx'))!;
    expect(settingsEdit.scope).toBe('expected-ripple');
    expect(settingsEdit.reason).toBe('app/settings/page.tsx uses formatName from lib/format.ts (through lib/index.ts), which the agent changed for the task');
    const homeEdit = report.scoped.findings.find((f) => f.probe === 'files' && f.files.includes('app/page.tsx'))!;
    expect(homeEdit.scope).toBe('outside-scope');
  });

  it('an edit to an unrelated component in the same large folder is outside scope', async () => {
    const t = await scopeRepo();
    const { report } = await runTask(t, 'make UserCard bold', (t) => {
      edit(t, 'components/UserCard.tsx', 'className="user-card"', 'className="user-card bold"');
      edit(t, 'components/Tabs.tsx', 'className="tabs"', 'className="tabs tabs-wide"');
    });
    const byFile = (p: string) => report.scoped.findings.find((f) => f.probe === 'files' && f.files.includes(p))!;
    expect(byFile('components/UserCard.tsx').scope).toBe('in-scope');
    expect(byFile('components/UserCard.tsx').reason).toBe('components/UserCard.tsx matches "UserCard" in the task');
    expect(byFile('components/Tabs.tsx').scope).toBe('outside-scope');
    expect(byFile('components/Tabs.tsx').reason).toBe(
      "components/Tabs.tsx was edited by the agent, but the task doesn't name it and it isn't next to or imported by a file the task covers",
    );
  });

  it('a new file next to a task file in a small folder is in scope', async () => {
    const t = await scopeRepo();
    const { report } = await runTask(t, 'trim whitespace in format helpers', (t) => {
      t.write('lib/strings.ts', 'export const squish = (s: string) => s.replace(/\\s+/g, " ");\n');
    });
    const f = report.scoped.findings.find((x) => x.probe === 'files' && x.files.includes('lib/strings.ts'))!;
    expect(f.scope).toBe('in-scope');
    expect(f.reason).toBe('lib/strings.ts sits next to lib/format.ts (part of the task) in lib/, a small folder');
  });

  it('--scope globs define the task area when the text names nothing', async () => {
    const t = await scopeRepo();
    const { report, out } = await runTask(
      t,
      'tidy this up',
      (t) => {
        edit(t, 'app/settings/page.tsx', '<SettingsForm />', '<SettingsForm compact />');
        edit(t, 'components/InvoiceTable.tsx', '<table>', '<table className="t">');
      },
      { scope: ['app/settings/**'] },
    );
    const byFile = (p: string) => report.scoped.findings.find((f) => f.probe === 'files' && f.files.includes(p))!;
    expect(byFile('app/settings/page.tsx').scope).toBe('in-scope');
    expect(byFile('app/settings/page.tsx').reason).toBe('app/settings/page.tsx matches --scope "app/settings/**"');
    expect(byFile('components/InvoiceTable.tsx').scope).toBe('outside-scope');
    expect(report.scoped.scope.globs).toEqual([{ glob: 'app/settings/**', files: 1 }]);
    expect(out).toContain('--scope app/settings/** (1 file)');
  });

  it('a folder given to --scope without wildcards covers everything below it', async () => {
    const t = await scopeRepo();
    const { report } = await runTask(t, 'tidy this up', (t) => edit(t, 'lib/db.ts', "'anon'", "'anon-key'"), { scope: ['lib'] });
    expect(report.scoped.findings.find((f) => f.probe === 'files')?.scope).toBe('in-scope');
  });

  it("with no match in the task text and no --scope, the agent's edits are the task area", async () => {
    const t = await scopeRepo();
    const { report, out } = await runTask(t, 'tidy this up', (t) => edit(t, 'components/Tabs.tsx', 'className="tabs"', 'className="tabs x"'));
    const f = report.scoped.findings.find((x) => x.probe === 'files')!;
    expect(f.scope).toBe('in-scope');
    expect(f.reason).toBe(
      'components/Tabs.tsx was edited by the agent (the task text matched nothing in the project, so the edited files are taken as the task area)',
    );
    expect(report.scoped.scope.fallback).toBe(true);
    expect(out).toContain("Scope: the task text matched nothing in the project; the agent's edits are taken as the task area");
  });

  it('a schema change to a task table that breaks a direct user of the table is broken by the task', async () => {
    const t = await scopeRepo();
    const { report } = await runTask(t, 'add a bio column to users', (t) => {
      t.write('supabase/migrations/0002_users_bio.sql', 'alter table users add column bio text;\nalter table users drop column email;\n');
    });
    const dropped = report.scoped.findings.find((f) => f.probe === 'database' && f.kind === 'regression')!;
    expect(dropped.title).toMatch(/email/);
    expect(dropped.tables).toEqual(['users']);
    expect(dropped.lines).toEqual([{ file: 'app/api/invoices/route.ts', line: 6, text: expect.any(String) }]);
    expect(dropped.scope).toBe('broken-by-task');
    expect(dropped.reason).toBe(
      'table users matches "users" in the task; app/api/invoices/route.ts uses table users, which supabase/migrations/0002_users_bio.sql changes for the task',
    );
    expect(dropped.severity).toBe('high');
    const added = report.scoped.findings.find((f) => f.probe === 'database' && f.kind === 'change')!;
    expect(added.scope).toBe('in-scope');
    const migration = report.scoped.findings.find((f) => f.probe === 'files')!;
    expect(migration.reason).toBe('supabase/migrations/0002_users_bio.sql matches "bio" in the task');
  });

  it('ranks outside-scope findings: checks/imports, then database/API, then visual, then changes', async () => {
    const t = await scopeRepo();
    const { report } = await runTask(t, 'add pagination to the users list', (t) => {
      PAGINATE(t);
      t.write('supabase/migrations/0002_invoices.sql', 'alter table invoices drop column total;\n');
      t.rm('components/Button.tsx');
    });
    const outside = group(report, 'outside-scope');
    const sev = outside.map((f) => f.severity);
    expect(sev).toEqual([...sev].sort((a, b) => ['critical', 'high', 'medium', 'low'].indexOf(a) - ['critical', 'high', 'medium', 'low'].indexOf(b)));
    expect(outside[0]!.probe).toBe('dependencies'); // broken import of the deleted Button
    expect(outside[0]!.kind).toBe('regression');
    expect(outside.find((f) => f.probe === 'database')?.severity).toBe('high');
  });

  it('prints the task scope at `before`', async () => {
    const t = await scopeRepo();
    const io = fakeIo();
    await beforeCommand(t.dir, { task: 'add pagination to the users list', yes: true }, io);
    expect(io.logs.join('\n')).toContain('Task scope: "users" → 4 files');
  });

  it('sessions without a stored scope still classify (computed in after)', async () => {
    const t = await scopeRepo();
    await beforeCommand(t.dir, { task: 'add pagination to the users list', yes: true }, fakeIo());
    const sessionFile = '.holdline/session.json';
    const s = JSON.parse(t.read(sessionFile));
    delete s.scope;
    t.write(sessionFile, JSON.stringify(s));
    PAGINATE(t);
    const report = await afterCommand(t.dir, {}, fakeIo());
    expect(report.scoped.findings.find((f) => f.probe === 'files')?.scope).toBe('in-scope');
  });
});
