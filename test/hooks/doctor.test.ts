import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { doctorCommand } from '../../src/commands/doctor.js';
import { installHooksCommand } from '../../src/commands/hooks.js';
import { sentinel } from '../helpers/secrets.js';
import { cleanupAll, fakeIo, makeRepo, tmpDir, writeConfig, type TestRepo } from '../helpers/tmpRepo.js';

let xdg: string | undefined;
beforeEach(() => {
  xdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tmpDir();
});
afterEach(() => {
  if (xdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = xdg;
  cleanupAll();
});

/** A directory with an executable `holdline`, for PATH. */
function fakeBin(): string {
  const bin = tmpDir();
  writeFileSync(path.join(bin, 'holdline'), '#!/bin/sh\n', { mode: 0o755 });
  return bin;
}

async function healthy(): Promise<{ t: TestRepo; env: NodeJS.ProcessEnv }> {
  const t = makeRepo();
  t.write('package.json', JSON.stringify({ scripts: { build: 'tsc' } }));
  t.write('.gitignore', '.holdline/\n');
  t.commitAll('setup');
  await writeConfig(t.dir, { build: 'npm run build' });
  await installHooksCommand(t.dir, { command: 'holdline' }, fakeIo());
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${fakeBin()}${path.delimiter}${process.env.PATH}` };
  delete env.HOLDLINE_HOOKS;
  return { t, env };
}

const doctor = async (t: TestRepo, env: NodeJS.ProcessEnv = process.env) => {
  const io = fakeIo();
  const r = await doctorCommand(t.dir, { env }, io);
  return { ...r, out: io.logs.join('\n') };
};

describe('holdline doctor', { timeout: 60_000 }, () => {
  it('a healthy project: exit 0, every section checked', async () => {
    const { t, env } = await healthy();
    const r = await doctor(t, env);
    expect(r.items.filter((i) => i.level === 'error')).toEqual([]);
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain('✓ .holdline/config.json: node, npm; checks: build');
    expect(r.out).toContain('✓ .claude/settings.local.json: SessionStart, UserPromptSubmit, Stop, SessionEnd');
    expect(r.out).toContain('✓ no lock held');
    expect(r.out).toContain(`✓ Node.js ${process.versions.node}`);
    for (const s of ['Node.js', 'Git', 'Config', 'Claude Code hooks', 'Visual check', 'Database safety', 'Lock and session']) expect(r.out).toContain(s);
  });

  it('a Node.js older than package.json "engines" allows is an error', async () => {
    const { t, env } = await healthy();
    const io = fakeIo();
    const r = await doctorCommand(t.dir, { env, nodeVersion: '22.12.0' }, io);
    expect(r.exitCode).toBe(2);
    expect(io.logs.join('\n')).toContain('✗ Node.js 22.12.0 is too old: holdline needs 22.13 or later');
    expect((await doctorCommand(t.dir, { env, nodeVersion: 'v22.13.0' }, fakeIo())).items).toContainEqual(expect.objectContaining({ section: 'Node.js', level: 'ok' }));
  });

  it('missing config', async () => {
    const t = makeRepo();
    const r = await doctor(t);
    expect(r.exitCode).toBe(2);
    expect(r.items).toContainEqual(expect.objectContaining({ section: 'Config', level: 'error', fix: 'run `holdline init`' }));
    expect(r.items).toContainEqual(expect.objectContaining({ section: 'Claude Code hooks', level: 'warn', fix: expect.stringContaining('holdline install-hooks') }));
  });

  it('a hook command that does not exist', async () => {
    const { t, env } = await healthy();
    await installHooksCommand(t.dir, { command: '"/nonexistent/node" "/nope/holdline/dist/cli.js"' }, fakeIo());
    const r = await doctor(t, env);
    expect(r.exitCode).toBe(2);
    expect(r.out).toMatch(/✗ Stop runs `"\/nonexistent\/node" "\/nope\/holdline\/dist\/cli\.js" hook stop`, but \/nonexistent\/node does not exist/);
  });

  it('a check pointing at a missing script, and timeouts shorter than the budgets', async () => {
    const { t, env } = await healthy();
    await writeConfig(t.dir, { build: 'npm run compile' }, { hooks: { stopBudgetSec: 900 } });
    const r = await doctor(t, env);
    expect(r.out).toContain('✗ checks.build runs `npm run compile`, but package.json has no "compile" script');
    expect(r.out).toMatch(/! Stop timeout is 570s, but holdline may use 900s/);
  });

  it('a stale lock and a live one', async () => {
    const { t, env } = await healthy();
    mkdirSync(t.p('.holdline'), { recursive: true });
    const lock = (pid: number) => t.write('.holdline/lock', JSON.stringify({ pid, hostname: os.hostname(), command: 'after', startedAt: new Date().toISOString(), token: 'x' }));
    lock(2 ** 22 + 12345);
    expect((await doctor(t, env)).out).toMatch(/! stale lock from `holdline after` \(pid \d+ is gone\); it will be cleared automatically\n\s+fix: or run `holdline unlock`/);
    lock(process.ppid);
    expect((await doctor(t, env)).out).toMatch(/! `holdline after` is running \(pid \d+/);
  });

  it('database safety: a non-local URL is named by host only, and allow-lists are flagged', async () => {
    const { t, env } = await healthy();
    const [user, password] = [sentinel('user'), sentinel('password')];
    t.write('.env', `DATABASE_URL=postgres://${user}:${password}@db.prod.example.com:5432/app\n`);
    await writeConfig(t.dir, { build: 'npm run build' }, { probes: { database: { allowHosts: ['db.staging.internal'] }, api: { live: { enabled: true, requests: [{ path: '/api/x' }] } } } });
    const r = await doctor(t, env);
    expect(r.out).toContain("the dev server checks won't start: DATABASE_URL in .env points at db.prod.example.com");
    expect(r.out).toContain('! probes.database.allowHosts lets holdline connect to: db.staging.internal');
    expect(r.out).not.toContain(user);
    expect(r.out).not.toContain(password);
  });

  it('HOLDLINE_HOOKS=off and hooks in both files are warnings', async () => {
    const { t, env } = await healthy();
    await installHooksCommand(t.dir, { shared: true, command: 'holdline' }, fakeIo());
    const r = await doctor(t, { ...env, HOLDLINE_HOOKS: 'off' });
    expect(r.out).toContain('HOLDLINE_HOOKS is set to off');
    expect(r.out).toMatch(/installed in both \.claude\/settings\.local\.json and \.claude\/settings\.json/);
  });

  it('Next.js with experimental.agentUpgrade and a dev-server check is flagged', async () => {
    const { t, env } = await healthy();
    t.write('next.config.ts', "export default { experimental: { agentUpgrade: 'security' } };\n");
    await writeConfig(t.dir, { build: 'npm run build' }, { projectType: 'nextjs', probes: { api: { live: { enabled: true, requests: [{ path: '/api/x' }] } } } });
    const r = await doctor(t, env);
    expect(r.out).toMatch(/! experimental\.agentUpgrade is set: `next dev` stops itself when it sees an AI agent/);
  });
});
