import { cpSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProjectType } from '../../src/core/config.js';
import { TestRepo, tmpDir, writeConfig } from './tmpRepo.js';

export const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');

/**
 * Copy a fixture into a fresh git repo and commit it. Adds files under node_modules/,
 * .next/, dist/ (git-ignored) and build/ (not ignored, skipped by name) that would
 * show up as broken imports and API calls if they were scanned.
 */
export function fixtureRepo(name: string): TestRepo {
  const t = new TestRepo(tmpDir());
  cpSync(path.join(FIXTURES, name), t.dir, { recursive: true });
  t.write('.gitignore', '.holdline/\nnode_modules/\n.next/\ndist/\n');
  t.write('node_modules/junk/index.ts', "import x from './nope';\nexport const y = fetch('/api/junk');\n");
  t.write('.next/server/app/page.js', "require('./missing');\n");
  t.write('dist/index.js', "import './missing.js';\n");
  t.write('build/out.js', "import './missing.js';\nfetch('/api/build-only');\n");
  t.git('init', '-q', '-b', 'main');
  t.commitAll('fixture');
  return t;
}

export async function fixtureProject(name: string, projectType: ProjectType, extra: Parameters<typeof writeConfig>[2] = {}): Promise<TestRepo> {
  const t = fixtureRepo(name);
  await writeConfig(t.dir, {}, { projectType, ...extra });
  return t;
}
