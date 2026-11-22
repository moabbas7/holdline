import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initCommand } from '../src/commands/init.js';
import { loadConfig } from '../src/core/config.js';
import { detectProject } from '../src/core/detect.js';
import { cleanupAll, fakeIo, makeRepo, tmpDir } from './helpers/tmpRepo.js';

afterEach(cleanupAll);

function project(pkg: object, files: string[] = []): string {
  const dir = tmpDir();
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
  for (const f of files) writeFileSync(path.join(dir, f), '');
  return dir;
}

describe('detectProject', () => {
  it('detects Next.js with pnpm', async () => {
    const dir = project(
      {
        dependencies: { next: '15', react: '19' },
        scripts: { build: 'next build', lint: 'next lint', typecheck: 'tsc --noEmit', test: 'vitest run' },
      },
      ['pnpm-lock.yaml'],
    );
    const { config } = await detectProject(dir);
    expect(config.projectType).toBe('nextjs');
    expect(config.packageManager).toBe('pnpm');
    expect(config.checks.build?.command).toBe('pnpm run build');
    expect(config.checks.typecheck?.command).toBe('pnpm run typecheck');
    expect(config.checks.lint?.command).toBe('pnpm run lint');
    expect(config.checks.test?.command).toBe('pnpm run test');
  });

  it('detects Vite/React with yarn and a type-check script variant', async () => {
    const dir = project(
      { devDependencies: { vite: '6', react: '19' }, scripts: { build: 'vite build', 'type-check': 'tsc -b' } },
      ['yarn.lock'],
    );
    const { config } = await detectProject(dir);
    expect(config.projectType).toBe('vite-react');
    expect(config.packageManager).toBe('yarn');
    expect(config.checks.typecheck?.command).toBe('yarn run type-check');
    expect(config.checks.lint).toBeNull();
    expect(config.checks.test).toBeNull();
  });

  it('detects a plain Node API with npm, tsc fallback and eslint fallback', async () => {
    const dir = project(
      {
        dependencies: { express: '5' },
        devDependencies: { eslint: '9', typescript: '5' },
        scripts: { test: 'node --test' },
      },
      ['package-lock.json', 'tsconfig.json', 'eslint.config.js'],
    );
    const { config, notes } = await detectProject(dir);
    expect(config.projectType).toBe('node');
    expect(config.packageManager).toBe('npm');
    expect(config.checks.build).toBeNull();
    expect(config.checks.typecheck?.command).toBe('npx --no-install tsc --noEmit');
    expect(config.checks.lint?.command).toBe('npx --no-install eslint .');
    expect(config.checks.test?.command).toBe('npm run test');
    expect(notes.join('\n')).toMatch(/tsconfig\.json/);
  });

  it('ignores npm\'s placeholder test script', async () => {
    const dir = project({ scripts: { test: 'echo "Error: no test specified" && exit 1' } });
    expect((await detectProject(dir)).config.checks.test).toBeNull();
  });

  it('prefers the packageManager field over lockfiles', async () => {
    const dir = project({ packageManager: 'bun@1.2.0', scripts: { build: 'x' } }, ['package-lock.json']);
    const { config } = await detectProject(dir);
    expect(config.packageManager).toBe('bun');
    expect(config.checks.build?.command).toBe('bun run build');
  });

  it('handles a project without package.json', async () => {
    const { config } = await detectProject(tmpDir());
    expect(config.projectType).toBe('unknown');
    expect(Object.values(config.checks).every((c) => c === null)).toBe(true);
  });
});

describe('holdline init', () => {
  it('writes the detected config with --yes and ignores .holdline/', async () => {
    const t = makeRepo();
    t.write('package.json', JSON.stringify({ dependencies: { next: '15' }, scripts: { build: 'next build' } }));
    await initCommand(t.dir, { yes: true }, fakeIo());
    const config = await loadConfig(t.dir);
    expect(config.projectType).toBe('nextjs');
    expect(config.checks.build?.command).toBe('npm run build');
    expect(t.read('.gitignore')).toContain('.holdline/');
  });

  it('lets the user edit and disable commands', async () => {
    const t = makeRepo();
    t.write('package.json', JSON.stringify({ scripts: { build: 'tsc', test: 'jest' } }));
    // "Use these commands?" → no; then build, typecheck, lint, test inputs.
    const io = fakeIo({ interactive: true, answers: [false], inputs: ['npm run build:prod', '', 'npx eslint src', ''] });
    await initCommand(t.dir, {}, io);
    const config = await loadConfig(t.dir);
    expect(config.checks.build?.command).toBe('npm run build:prod');
    expect(config.checks.typecheck).toBeNull();
    expect(config.checks.lint?.command).toBe('npx eslint src');
    expect(config.checks.test).toBeNull();
  });

  it('asks before overwriting an existing config', async () => {
    const t = makeRepo();
    await initCommand(t.dir, { yes: true }, fakeIo());
    await expect(initCommand(t.dir, {}, fakeIo({ interactive: true, answers: [false] }))).rejects.toThrow(/Kept the existing/);
    await expect(initCommand(t.dir, {}, fakeIo())).rejects.toThrow(/--yes/);
  });

  it('fails clearly outside a git repository', async () => {
    await expect(initCommand(tmpDir(), { yes: true }, fakeIo())).rejects.toThrow(/git init/);
  });
});
