import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Compile holdline into a temporary folder and return the path of its cli.js (and a cleanup). */
export function buildCli(): { cli: string; cleanup: () => void } {
  // Not a tmpDir(): those are removed after each test, and the build is shared by a file.
  const out = mkdtempSync(path.join(realpathSync(tmpdir()), 'holdline-cli-'));
  execFileSync(process.execPath, [path.join(REPO, 'node_modules/typescript/bin/tsc'), '-p', path.join(REPO, 'tsconfig.json'), '--outDir', path.join(out, 'dist')], { stdio: 'pipe' });
  cpSync(path.join(REPO, 'package.json'), path.join(out, 'package.json'));
  symlinkSync(path.join(REPO, 'node_modules'), path.join(out, 'node_modules'));
  return { cli: path.join(out, 'dist/cli.js'), cleanup: () => rmSync(out, { recursive: true, force: true }) };
}
