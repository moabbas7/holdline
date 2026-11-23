import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { reportCommand } from '../../src/commands/report.js';
import { buildReport } from '../../src/report/model.js';
import { renderHtml } from '../../src/report/html.js';
import { cleanupAll, fakeIo, tmpDir } from '../helpers/tmpRepo.js';
import { edit, runTask, scopeRepo } from '../scope/helpers.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCHEMA = JSON.parse(readFileSync(path.join(REPO, 'schema/after-report.v1.json'), 'utf8'));
const ajv = new (Ajv2020 as unknown as typeof Ajv2020.default)({ strict: true, allErrors: true, validateFormats: false });
const validate = ajv.compile(SCHEMA);

afterEach(() => cleanupAll());

const BREAK_BILLING = (t: Parameters<typeof edit>[0]) => {
  edit(t, 'app/users/page.tsx', 'export default async function UsersPage() {', 'export default async function UsersPage() {\n  const page = 1;');
  edit(t, 'app/billing/page.tsx', '  return <InvoiceTable', '  const x = BROKEN;\n  return <InvoiceTable');
};

/** A 1×1 PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

describe('HTML report', { timeout: 120_000 }, () => {
  it('is one offline file, grouped like the terminal report, with in-scope changes collapsed', async () => {
    const t = await scopeRepo();
    const { report, out } = await runTask(t, 'add pagination to the users list', BREAK_BILLING);
    expect(report.scoped.htmlReport).toMatch(/^\.holdline\/reports\/\d{8}T\d{9}Z\.html$/);
    expect(out).toContain(`Report: ${report.scoped.htmlReport}`);
    const html = t.read(report.scoped.htmlReport!);
    // Offline: no external resources at all.
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/src="(?!data:)/);
    // Grouping and order.
    const iOut = html.indexOf('Outside the task');
    const iRipple = html.indexOf('Expected ripple');
    const iIn = html.indexOf('In the task area');
    expect(iOut).toBeGreaterThan(-1);
    expect(iOut).toBeLessThan(iRipple);
    expect(iRipple).toBeLessThan(iIn);
    expect(html.indexOf('build: passed before, fails now')).toBeLessThan(iRipple);
    expect(html).toMatch(/<details><summary>\d+ changes? in the task area<\/summary>/);
    expect(html).toContain('why: the error is in app/billing/page.tsx, which was edited by the agent, but the task doesn&#39;t name it');
    expect(html).toContain('holdline rollback');
    // Only the HTML and its sidecar JSON in the reports folder.
    expect(readdirSync(t.p('.holdline/reports')).sort()).toEqual([path.basename(report.scoped.htmlReport!), path.basename(report.scoped.htmlReport!).replace('.html', '.json')]);
  });

  it('embeds screenshots and diff images as data: URIs and escapes text', async () => {
    const root = tmpDir();
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(path.join(root, '.holdline/visual/diff'), { recursive: true });
    for (const f of ['b.png', 'a.png', 'diff/d.png']) writeFileSync(path.join(root, '.holdline/visual', f), PNG);
    const scoped = buildReport({
      task: 'restyle <the> "account" page',
      sessionCreatedAt: new Date().toISOString(),
      beforeSha: 'a'.repeat(40),
      afterSha: 'b'.repeat(40),
      headMoved: null,
      globs: [],
      classification: {
        area: { terms: [], dropped: [], unmatched: [], globs: [], fallback: false, files: [], routes: [], tables: [], edited: { inScope: 1, ripple: 0, outside: 0 } },
        findings: [
          {
            probe: 'visual',
            probeTitle: 'Visual',
            kind: 'change',
            severity: 'low',
            scope: 'outside-scope',
            reason: 'page / isn\'t named by the task',
            title: '/ (desktop): unexpected visual change (3.1% of pixels changed) <img src=x>',
            files: [],
            locations: [],
            meta: { pages: ['/'], visualDiff: true, images: { before: '.holdline/visual/b.png', after: '.holdline/visual/a.png', diff: '.holdline/visual/diff/d.png' } },
          },
        ],
      },
      reports: [],
      ownOutputs: { excluded: [], agentEdited: [], gitignoreSuggestion: [] },
    });
    const html = await renderHtml(scoped, root);
    expect(html.match(/src="data:image\/png;base64,/g)?.length).toBe(3);
    expect(html).toContain(PNG.toString('base64'));
    expect(html).toContain('&lt;img src=x&gt;');
    expect(html).not.toContain('<img src=x>');
    expect(html).toContain('restyle &lt;the&gt; &quot;account&quot; page');
  });
});

describe('JSON report', { timeout: 180_000 }, () => {
  it('matches the documented schema (version 1), in every shape the fixtures produce', async () => {
    const cases: [string, (t: Parameters<typeof edit>[0]) => void][] = [
      ['add pagination to the users list', BREAK_BILLING],
      ['show full names on the users page', (t) => edit(t, 'lib/format.ts', '.trim()', '.trim().toUpperCase()')],
      ['add a bio column to users', (t) => t.write('supabase/migrations/0002_bio.sql', 'alter table users drop column email;\n')],
    ];
    for (const [task, agent] of cases) {
      const t = await scopeRepo();
      const { report } = await runTask(t, task, agent);
      const doc = JSON.parse(JSON.stringify(report.scoped));
      const ok = validate(doc);
      expect(validate.errors ?? [], task).toEqual([]);
      expect(ok).toBe(true);
      expect(doc.exitCode).toBe(doc.regressed ? 1 : 0);
      for (const f of doc.findings) expect(f.reason.length).toBeGreaterThan(0);
      // last-report.json holds the same document.
      expect(JSON.parse(t.read('.holdline/last-report.json')).findings).toEqual(doc.findings);
    }
  });

  it('the schema rejects documents that drift from it', () => {
    expect(validate({ schema: 'holdline.after-report', schemaVersion: 2 })).toBe(false);
  });
});

describe('the CLI: after --json, exit codes and holdline report', () => {
  let cli: string;
  let out: string;
  beforeAll(() => {
    // Not a tmpDir(): those are removed after each test, and the build is shared.
    out = mkdtempSync(path.join(realpathSync(tmpdir()), 'holdline-cli-'));
    execFileSync(process.execPath, [path.join(REPO, 'node_modules/typescript/bin/tsc'), '-p', path.join(REPO, 'tsconfig.json'), '--outDir', path.join(out, 'dist')], { stdio: 'pipe' });
    cpSync(path.join(REPO, 'package.json'), path.join(out, 'package.json'));
    symlinkSync(path.join(REPO, 'node_modules'), path.join(out, 'node_modules'));
    cli = path.join(out, 'dist/cli.js');
  }, 120_000);
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  const run = (cwd: string, ...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', env: { ...process.env, HOLDLINE_NO_OPEN: '1', NO_COLOR: '1' } });

  it('exit 1 with regressions, 0 without; stdout is only the JSON document', async () => {
    const t = await scopeRepo();
    expect(run(t.dir, 'before', '-y', '--task', 'add pagination to the users list', '--scope', 'app/users/**').status).toBe(0);
    BREAK_BILLING(t);
    const bad = run(t.dir, 'after', '--json');
    expect(bad.status).toBe(1);
    const doc = JSON.parse(bad.stdout);
    expect(validate(doc)).toBe(true);
    expect(doc.scope.globsGiven).toEqual(['app/users/**']);
    expect(doc.findings[0].scope).toBe('outside-scope');
    expect(bad.stderr).toContain('Outside the task');

    edit(t, 'app/billing/page.tsx', '  const x = BROKEN;\n', '');
    const good = run(t.dir, 'after', '--json');
    expect(good.status).toBe(0);
    expect(JSON.parse(good.stdout).exitCode).toBe(0);

    const list = run(t.dir, 'report', '--list');
    expect(list.status).toBe(0);
    const lines = list.stdout.split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^ {2}1 {2}\.holdline\/reports\/\S+\.html .*"add pagination to the users list" +0 regressions, 0 outside the task$/);
    expect(lines[1]).toMatch(/^ {2}2 .*1 regression, \d+ outside the task$/);

    const latest = run(t.dir, 'report');
    expect(latest.status).toBe(0);
    expect(latest.stdout.trim()).toBe(lines[0]!.trim().split(/\s+/)[1]);
    const second = run(t.dir, 'report', '2');
    expect(second.stdout.trim()).toBe(lines[1]!.trim().split(/\s+/)[1]);
    expect(run(t.dir, 'report', '9').status).toBe(2);
  }, 120_000);

  it('holdline report without any report says so', async () => {
    const t = await scopeRepo();
    const r = run(t.dir, 'report');
    expect(r.stderr).toContain('No reports yet');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('No reports yet');
    const io = fakeIo();
    const res = await reportCommand(t.dir, { list: true }, io);
    expect(res.reports).toEqual([]);
    expect(io.logs.join('\n')).toContain('No reports yet');
  });
});
