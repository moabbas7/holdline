import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FIXTURES } from '../helpers/fixtures.js';
import { TestRepo, tmpDir, writeConfig } from '../helpers/tmpRepo.js';

/** The fixture web app in a fresh git repo, with only the visual probe enabled. */
export async function visualRepo(visual: Record<string, unknown>, probes: Record<string, unknown> = {}): Promise<TestRepo> {
  const t = new TestRepo(tmpDir());
  cpSync(path.join(FIXTURES, 'visual-app'), t.dir, { recursive: true });
  t.write('.gitignore', '.holdline/\npids.json\nstarts.log\noddload\n');
  t.git('init', '-q', '-b', 'main');
  t.commitAll('app');
  await writeConfig(t.dir, {}, {
    probes: {
      dependencies: { enabled: false },
      database: { enabled: false },
      api: { enabled: false },
      visual: { enabled: true, noiseDelayMs: 500, startupTimeoutSec: 20, pageTimeoutSec: 20, ...visual },
      ...probes,
    },
  });
  return t;
}

/** Edit pages/<name>.html. */
export function editPage(t: TestRepo, name: string, fn: (html: string) => string): void {
  const f = t.p(`pages/${name}.html`);
  writeFileSync(f, fn(readFileSync(f, 'utf8')));
}

export const addToBody = (snippet: string) => (html: string) => html.replace('</body>', `${snippet}\n</body>`);

export const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Server and grandchild pids written by the fixture server (null if it never started). */
export function serverPids(t: TestRepo): { server: number; grandchild: number } | null {
  return existsSync(t.p('pids.json')) ? (JSON.parse(readFileSync(t.p('pids.json'), 'utf8')) as { server: number; grandchild: number }) : null;
}

export function starts(t: TestRepo): number {
  return existsSync(t.p('starts.log')) ? readFileSync(t.p('starts.log'), 'utf8').split('\n').filter(Boolean).length : 0;
}

export function expectTreeDead(t: TestRepo): void {
  const pids = serverPids(t);
  if (!pids) throw new Error('the fixture server never started');
  if (alive(pids.server)) throw new Error(`server ${pids.server} still running`);
  if (alive(pids.grandchild)) throw new Error(`grandchild ${pids.grandchild} still running`);
}
