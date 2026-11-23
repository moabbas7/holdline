import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installHooksCommand, resolveHookCommand, uninstallHooksCommand } from '../../src/commands/hooks.js';
import { HoldlineError } from '../../src/core/errors.js';
import { cleanupAll, fakeIo, makeRepo, tmpDir, writeConfig } from '../helpers/tmpRepo.js';

// The user's global git excludes (Claude Code adds settings.local.json there) must not decide these tests.
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

const LOCAL = '.claude/settings.local.json';
const SHARED = '.claude/settings.json';

async function configured() {
  const t = makeRepo();
  await writeConfig(t.dir, { build: 'true' });
  return t;
}

const OTHER_TOOL = { type: 'command', command: '/usr/local/bin/other-tool notify', timeout: 5 };

describe('holdline install-hooks', () => {
  it('installs into .claude/settings.local.json by default, with all four events', async () => {
    const t = await configured();
    const io = fakeIo();
    const r = await installHooksCommand(t.dir, { command: 'holdline' }, io);
    expect(r.changed).toBe(true);
    const s = JSON.parse(t.read(LOCAL));
    expect(Object.keys(s.hooks)).toEqual(['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd']);
    expect(s.hooks.SessionStart).toEqual([{ matcher: 'startup|resume|clear', hooks: [{ type: 'command', command: 'holdline hook session-start', timeout: 10 }] }]);
    expect(s.hooks.UserPromptSubmit[0].hooks[0]).toEqual({ type: 'command', command: 'holdline hook prompt', timeout: 195, statusMessage: 'holdline: recording the baseline…' });
    expect(s.hooks.Stop[0].hooks[0]).toMatchObject({ command: 'holdline hook stop', timeout: 570 });
    expect(s.hooks.SessionEnd[0].hooks[0]).toMatchObject({ command: 'holdline hook session-end', timeout: 5 });
    expect(existsSync(t.p(SHARED))).toBe(false);
    // The personal file is git-ignored.
    expect(t.read('.gitignore')).toContain('.claude/settings.local.json');
    expect(t.git('check-ignore', LOCAL).trim()).toBe(LOCAL);
  });

  it('--shared installs into .claude/settings.json and leaves .gitignore alone', async () => {
    const t = await configured();
    await installHooksCommand(t.dir, { shared: true, command: 'holdline' }, fakeIo());
    expect(JSON.parse(t.read(SHARED)).hooks.Stop).toHaveLength(1);
    expect(existsSync(t.p(LOCAL))).toBe(false);
    expect(existsSync(t.p('.gitignore')) ? t.read('.gitignore') : '').not.toContain('settings');
  });

  it('merges with existing settings and other tools’ hooks, and replaces an older holdline entry', async () => {
    const t = await configured();
    const existing = {
      permissions: { allow: ['Bash(npm test:*)'] },
      env: { FOO: '1' },
      hooks: {
        Stop: [{ hooks: [OTHER_TOOL] }],
        UserPromptSubmit: [{ hooks: [OTHER_TOOL, { type: 'command', command: 'holdline hook prompt', timeout: 30 }] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh' }] }],
      },
    };
    t.write(LOCAL, JSON.stringify(existing, null, 2));
    await installHooksCommand(t.dir, { command: 'holdline' }, fakeIo());
    const s = JSON.parse(t.read(LOCAL));
    expect(s.permissions).toEqual(existing.permissions);
    expect(s.env).toEqual(existing.env);
    expect(s.hooks.PreToolUse).toEqual(existing.hooks.PreToolUse);
    expect(s.hooks.Stop).toEqual([{ hooks: [OTHER_TOOL] }, { hooks: [expect.objectContaining({ command: 'holdline hook stop' })] }]);
    // The old holdline handler is gone from the mixed group; the other tool's handler stays.
    expect(s.hooks.UserPromptSubmit).toEqual([{ hooks: [OTHER_TOOL] }, { hooks: [expect.objectContaining({ command: 'holdline hook prompt', timeout: 195 })] }]);
    const commands = JSON.stringify(s).match(/holdline hook \w[\w-]*/g);
    expect(commands?.sort()).toEqual(['holdline hook prompt', 'holdline hook session-end', 'holdline hook session-start', 'holdline hook stop']);
  });

  it('is idempotent: a second install changes nothing', async () => {
    const t = await configured();
    t.write(LOCAL, JSON.stringify({ hooks: { Stop: [{ hooks: [OTHER_TOOL] }] } }));
    await installHooksCommand(t.dir, { command: 'holdline' }, fakeIo());
    const first = t.read(LOCAL);
    const io = fakeIo();
    const r = await installHooksCommand(t.dir, { command: 'holdline' }, io);
    expect(r.changed).toBe(false);
    expect(t.read(LOCAL)).toBe(first);
    expect(io.logs.join('\n')).toContain('already installed');
    expect(t.read('.gitignore').match(/settings\.local\.json/g)).toHaveLength(1);
  });

  it('refuses to change a settings file that is not valid JSON', async () => {
    const t = await configured();
    t.write(LOCAL, '{ "hooks": { oops ');
    await expect(installHooksCommand(t.dir, { command: 'holdline' }, fakeIo())).rejects.toThrow(/not valid JSON, so holdline won't change it/);
    expect(t.read(LOCAL)).toBe('{ "hooks": { oops ');
  });

  it('runs `holdline init --yes` first when there is no config', async () => {
    const t = makeRepo();
    t.write('package.json', JSON.stringify({ scripts: { build: 'tsc' } }));
    const r = await installHooksCommand(t.dir, { command: 'holdline' }, fakeIo());
    expect(r.ranInit).toBe(true);
    expect(JSON.parse(t.read('.holdline/config.json')).checks.build.command).toBe('npm run build');
  });

  it('warns when the hooks are in both files', async () => {
    const t = await configured();
    await installHooksCommand(t.dir, { shared: true, command: 'holdline' }, fakeIo());
    const io = fakeIo();
    await installHooksCommand(t.dir, { command: 'holdline' }, io);
    expect(io.warnings.join('\n')).toMatch(/also in \.claude\/settings\.json; Claude Code would run both/);
  });
});

describe('the hook command', () => {
  it("prefers the project's own holdline, then PATH; --shared refuses an absolute path", () => {
    const t = makeRepo();
    expect(() => resolveHookCommand(t.dir, true, { PATH: '' })).toThrow(HoldlineError);
    const local = resolveHookCommand(t.dir, false, { PATH: '' });
    expect(local.base).toMatch(/cli\.(js|ts)"?$/);
    const bin = path.join(t.dir, 'bin');
    mkdirSync(bin);
    writeFileSync(path.join(bin, 'holdline'), '#!/bin/sh\n', { mode: 0o755 });
    expect(resolveHookCommand(t.dir, true, { PATH: bin }).base).toBe('holdline');
    t.write('node_modules/.bin/holdline', '#!/bin/sh\n');
    expect(resolveHookCommand(t.dir, true, { PATH: bin }).base).toBe('"$CLAUDE_PROJECT_DIR"/node_modules/.bin/holdline');
  });
});

describe('holdline uninstall-hooks', () => {
  it("removes only holdline's handlers", async () => {
    const t = await configured();
    const existing = {
      model: 'opus',
      hooks: {
        Stop: [{ hooks: [OTHER_TOOL] }],
        UserPromptSubmit: [{ hooks: [OTHER_TOOL] }],
      },
    };
    t.write(LOCAL, JSON.stringify(existing, null, 2));
    await installHooksCommand(t.dir, { command: '"/usr/bin/node" "/opt/holdline/dist/cli.js"' }, fakeIo());
    const r = await uninstallHooksCommand(t.dir, {}, fakeIo());
    expect(r.removed).toBe(4);
    expect(JSON.parse(t.read(LOCAL))).toEqual(existing);
  });

  it('drops the hooks key when only holdline was there, keeps the file and other keys', async () => {
    const t = await configured();
    t.write(LOCAL, JSON.stringify({ theme: 'dark' }));
    await installHooksCommand(t.dir, { command: 'holdline' }, fakeIo());
    await uninstallHooksCommand(t.dir, {}, fakeIo());
    expect(JSON.parse(t.read(LOCAL))).toEqual({ theme: 'dark' });
  });

  it('leaves the shared file alone unless --shared', async () => {
    const t = await configured();
    await installHooksCommand(t.dir, { shared: true, command: 'holdline' }, fakeIo());
    const before = t.read(SHARED);
    const io = fakeIo();
    expect((await uninstallHooksCommand(t.dir, {}, io)).removed).toBe(0);
    expect(t.read(SHARED)).toBe(before);
    expect((await uninstallHooksCommand(t.dir, { shared: true }, fakeIo())).removed).toBe(4);
    expect(JSON.parse(t.read(SHARED))).toEqual({});
  });
});
