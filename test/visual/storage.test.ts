/**
 * Pages behind login: the storage-state file is used in place. It is never copied into
 * .holdline/, and the cookies in it never appear in anything holdline stores or prints.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { afterCommand } from '../../src/commands/after.js';
import { beforeCommand } from '../../src/commands/before.js';
import { visualCommand } from '../../src/commands/visual.js';
import { PLAYWRIGHT } from '../helpers/playwright.js';
import { cleanupAll, fakeIo, tmpDir } from '../helpers/tmpRepo.js';
import { starts, visualRepo } from './helpers.js';
import { sentinel } from '../helpers/secrets.js';

afterEach(cleanupAll);

const SECRET = sentinel('cookie');

function stateFile(dir: string, name = 'auth.json'): string {
  const file = path.join(dir, name);
  writeFileSync(
    file,
    JSON.stringify({
      cookies: [{ name: 'session', value: SECRET, domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }],
      origins: [{ origin: 'http://127.0.0.1', localStorage: [{ name: 'token', value: SECRET }] }],
    }),
  );
  return file;
}

function allFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) out.push(...allFiles(p));
    else out.push(p);
  }
  return out;
}

describe.skipIf(!PLAYWRIGHT)('storage state', () => {
  it('logs in with the file, never copies it and never stores or prints its values', { timeout: 180_000 }, async () => {
    const outside = tmpDir('holdline-auth-');
    const file = stateFile(outside);
    const t = await visualRepo({ pages: ['/account'], storageState: file });
    const io = fakeIo();
    await beforeCommand(t.dir, { task: 'x', yes: true }, io);
    const io2 = fakeIo();
    const report = await afterCommand(t.dir, { json: true }, io2);
    const io3 = fakeIo();
    const result = await visualCommand(t.dir, { json: true }, io3);

    // The page saw the cookie (it logs "not logged in" otherwise).
    expect(result.status).toBe('ok');
    for (const r of result.results) expect(r.consoleErrors).toEqual([]);
    expect(report.reports.find((r) => r.probeId === 'visual')!.findings).toEqual([]);

    const original = readFileSync(file, 'utf8');
    for (const f of allFiles(t.p('.holdline'))) {
      const content = readFileSync(f);
      expect(content.includes(SECRET), f).toBe(false);
      expect(content.equals(Buffer.from(original)), f).toBe(false);
      expect(path.basename(f)).not.toBe('auth.json');
    }
    const printed = [io, io2, io3].flatMap((x) => [...x.logs, ...x.warnings]).join('\n') + JSON.stringify(report) + JSON.stringify(result);
    expect(printed).not.toContain(SECRET);
    expect(t.git('for-each-ref', 'refs/holdline').length).toBeGreaterThan(0);
    expect(t.git('log', '--all', '-p', '--format=%H')).not.toContain(SECRET);
  });

  it('refuses a state file inside the project that git does not ignore', { timeout: 60_000 }, async () => {
    const t = await visualRepo({ pages: ['/account'], storageState: 'auth.json' });
    stateFile(t.dir);
    const io = fakeIo();
    await beforeCommand(t.dir, { task: 'x', yes: true }, io);
    const w = io.warnings.join('\n');
    expect(w).toContain('the storage-state file auth.json is inside the project and not git-ignored');
    expect(w).not.toContain(SECRET);
    expect(starts(t)).toBe(0);
  });

  it('accepts a git-ignored state file inside the project', { timeout: 120_000 }, async () => {
    const t = await visualRepo({ pages: ['/account'], storageState: 'auth.json' });
    t.write('.gitignore', '.holdline/\npids.json\nstarts.log\nauth.json\n');
    stateFile(t.dir);
    const result = await visualCommand(t.dir, {}, fakeIo());
    expect(result.status).toBe('ok');
    for (const r of result.results) expect(r.consoleErrors).toEqual([]);
  });

  it('reports a missing state file by path only', async () => {
    const t = await visualRepo({ pages: ['/account'], storageState: '../nope/auth.json' });
    const io = fakeIo();
    const result = await visualCommand(t.dir, {}, io);
    expect(result.status).toBe('refused');
    expect(result.message).toContain('the storage-state file ../nope/auth.json (probes.visual.storageState) does not exist');
  });
});
