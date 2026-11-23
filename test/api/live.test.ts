/**
 * Live mode safety: only listed requests are sent, non-local databases are refused, no
 * values or headers are stored or printed, and the dev server's whole process tree is
 * always killed (success, timeout, early exit, abort, Ctrl+C).
 */
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { afterCommand } from '../../src/commands/after.js';
import { apiCommand } from '../../src/commands/api.js';
import { beforeCommand } from '../../src/commands/before.js';
import { databaseSafety, redactPath, runLive } from '../../src/probes/api/live.js';
import { apiSettings, type LiveSettings } from '../../src/probes/api/types.js';
import { cleanupAll, fakeIo, makeRepo, tmpDir, writeConfig, type TestRepo } from '../helpers/tmpRepo.js';
import { WINDOWS } from '../helpers/platform.js';
import { sentinel } from '../helpers/secrets.js';

afterEach(cleanupAll);

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Values that must never be stored or printed. */
const SECRETS = {
  email: `${sentinel('email')}@example.com`,
  token: sentinel('token'),
  auth: sentinel('auth'),
  cookie: sentinel('cookie'),
  query: sentinel('query'),
};

/**
 * A dev server stand-in: logs every request it receives, starts a grandchild process, and
 * writes both pids so the test can check they are gone afterwards.
 */
const SERVER = `
const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');
const dir = __dirname;
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
fs.writeFileSync(dir + '/pids.json', JSON.stringify({ server: process.pid, grandchild: grandchild.pid }));
let version = fs.existsSync(dir + '/v2') ? 2 : 1;
http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    fs.appendFileSync(dir + '/requests.log', JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body }) + '\\n');
    const json = (status, v) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(v)); };
    if (req.url === '/api/users') return json(200, version === 1
      ? { users: [{ id: 1, email: '${SECRETS.email}' }], token: '${SECRETS.token}' }
      : { users: [{ id: '1' }], token: '${SECRETS.token}' });
    if (req.url === '/api/redirect') { res.statusCode = 302; res.setHeader('location', '/api/private'); return res.end(); }
    if (req.url === '/api/items' && req.method === 'POST') return json(version === 1 ? 201 : 500, { id: 7 });
    if (req.url.startsWith('/api/slow')) return setTimeout(() => json(200, { ok: true }), 20000);
    json(404, { error: 'not found' });
  });
}).listen(Number(process.env.PORT), '127.0.0.1');
`;

function serverRepo(): TestRepo {
  const t = makeRepo();
  t.write('server.cjs', SERVER);
  t.write('package.json', JSON.stringify({ name: 'live-fixture', private: true, scripts: { dev: 'node server.cjs' } }));
  t.write('.gitignore', '.holdline/\nrequests.log\npids.json\nv2\n');
  t.commitAll('server');
  return t;
}

const settings = (over: Partial<LiveSettings> = {}): LiveSettings => ({
  ...apiSettings({ live: { enabled: true } }).live,
  startupTimeoutSec: 20,
  requestTimeoutSec: 10,
  ...over,
});

const requests = (t: TestRepo) =>
  existsSync(t.p('requests.log'))
    ? readFileSync(t.p('requests.log'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { method: string; url: string; headers: Record<string, string>; body: string })
    : [];

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function expectTreeGone(t: TestRepo): Promise<void> {
  const pids = JSON.parse(readFileSync(t.p('pids.json'), 'utf8')) as { server: number; grandchild: number };
  for (let i = 0; i < 40 && (alive(pids.server) || alive(pids.grandchild)); i++) await new Promise((r) => setTimeout(r, 50));
  expect(alive(pids.server)).toBe(false);
  expect(alive(pids.grandchild)).toBe(false);
}

const cleanEnv = () => {
  const env = { ...process.env };
  for (const v of ['DATABASE_URL', 'POSTGRES_URL', 'DIRECT_URL', 'SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL']) delete env[v];
  return env;
};

describe('live mode', () => {
  it('calls only the listed requests, never follows redirects, never sends unlisted non-GETs, and kills the tree', async () => {
    const t = serverRepo();
    const cap = await runLive({
      root: t.dir,
      packageManager: 'npm',
      env: cleanEnv(),
      settings: settings({
        requests: [
          { path: '/api/users' },
          { method: 'POST', path: '/api/items' }, // no body: never sent
          { path: '/api/redirect' },
          { path: 'http://example.com/api/users' }, // other host: never sent
        ],
      }),
    });
    expect(cap.status).toBe('ok');
    const seen = requests(t).map((r) => `${r.method} ${r.url}`);
    expect(seen).toEqual(['GET /api/users', 'GET /api/redirect']);
    expect(cap.results.map((r) => [r.method, r.path, r.status ?? r.error])).toEqual([
      ['GET', '/api/users', 200],
      ['POST', '/api/items', 'skipped'],
      ['GET', '/api/redirect', 302],
      ['GET', 'http://example.com/api/users', 'skipped'],
    ]);
    expect(cap.results[1]!.note).toMatch(/need a sample "body"/);
    await expectTreeGone(t);
  });

  it('stores shapes only: no response values, and headers only sent when configured, never stored', async () => {
    const t = serverRepo();
    const env = cleanEnv();
    const cap = await runLive({
      root: t.dir,
      packageManager: 'npm',
      env,
      settings: settings({
        headers: { authorization: `Bearer ${SECRETS.auth}` },
        requests: [{ path: `/api/users?token=${SECRETS.query}` }, { method: 'POST', path: '/api/items', body: { name: 'x' }, headers: { cookie: `sid=${SECRETS.cookie}` } }],
      }),
    });
    const text = JSON.stringify(cap);
    for (const secret of Object.values(SECRETS)) expect(text, `leaked ${secret}`).not.toContain(secret);
    expect(cap.results[0]!.path).toBe('/api/users?token=…');
    const [get, post] = requests(t);
    expect(get!.headers.authorization).toBe(`Bearer ${SECRETS.auth}`);
    expect(get!.headers.cookie).toBeUndefined();
    expect(post!.headers.cookie).toBe(`sid=${SECRETS.cookie}`);
    expect(JSON.parse(post!.body)).toEqual({ name: 'x' });
    await expectTreeGone(t);

    // Without configured headers, none are sent.
    const t2 = serverRepo();
    await runLive({ root: t2.dir, packageManager: 'npm', env, settings: settings({ requests: [{ path: '/api/users' }] }) });
    const [plain] = requests(t2);
    expect(plain!.headers.authorization).toBeUndefined();
    expect(plain!.headers.cookie).toBeUndefined();
    await expectTreeGone(t2);
  });

  it('refuses to start when the database URL points at a non-local host, and says why', async () => {
    const t = serverRepo();
    const [user, password] = [sentinel('user'), sentinel('password')];
    t.write('.env', `DATABASE_URL=postgres://${user}:${password}@db.prod.example.com:5432/app\n`);
    const cap = await runLive({ root: t.dir, packageManager: 'npm', env: cleanEnv(), settings: settings({ requests: [{ path: '/api/users' }] }) });
    expect(cap.status).toBe('refused');
    expect(cap.message).toContain('DATABASE_URL in .env points at db.prod.example.com');
    expect(cap.message).toContain('allowNonLocalDatabase');
    expect(cap.message).not.toContain(user);
    expect(cap.message).not.toContain(password);
    expect(existsSync(t.p('pids.json'))).toBe(false); // never started

    // From the environment, other schemes too; unparsable values are refused as well.
    expect(await databaseSafety(t.dir, undefined, { ...cleanEnv() })).toMatchObject({ ok: false });
    const t2 = serverRepo();
    expect(await databaseSafety(t2.dir, undefined, { ...cleanEnv(), DATABASE_URL: 'mysql://u:p@aws.connect.psdb.cloud/db' })).toMatchObject({ ok: false });
    expect(await databaseSafety(t2.dir, undefined, { ...cleanEnv(), SUPABASE_URL: 'https://abc.supabase.co' })).toMatchObject({ ok: false });
    expect(await databaseSafety(t2.dir, 'MY_DB', { ...cleanEnv(), MY_DB: 'not a url' })).toMatchObject({ ok: false });
    expect(await databaseSafety(t2.dir, undefined, { ...cleanEnv(), DATABASE_URL: 'postgres://u:p@127.0.0.1:54322/postgres', SUPABASE_URL: 'http://localhost:54321' })).toEqual({ ok: true });
    expect(await databaseSafety(t2.dir, undefined, { ...cleanEnv(), DATABASE_URL: 'file:./dev.db' })).toEqual({ ok: true });

    // Explicitly allowed: runs.
    const ok = await runLive({ root: t.dir, packageManager: 'npm', env: cleanEnv(), settings: settings({ allowNonLocalDatabase: true, requests: [{ path: '/api/users' }] }) });
    expect(ok.status).toBe('ok');
    await expectTreeGone(t);
  });

  it('kills the server after a startup timeout and reports an early exit', async () => {
    const t = serverRepo();
    t.write('hang.cjs', "require('fs').writeFileSync(__dirname + '/pids.json', JSON.stringify({ server: process.pid, grandchild: require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }).pid }));\nsetInterval(() => {}, 1000);\n");
    const cap = await runLive({ root: t.dir, packageManager: 'npm', env: cleanEnv(), settings: settings({ command: 'node hang.cjs', startupTimeoutSec: 1, requests: [{ path: '/api/users' }] }) });
    expect(cap.status).toBe('failed');
    expect(cap.message).toMatch(/did not accept connections on port \d+ within 1s/);
    await expectTreeGone(t);

    const early = await runLive({ root: t.dir, packageManager: 'npm', env: cleanEnv(), settings: settings({ command: 'node -e "process.exit(3)"', requests: [{ path: '/api/users' }] }) });
    expect(early.status).toBe('failed');
    expect(early.message).toMatch(/exited with code 3/);
  });

  it('kills the server when cancelled mid-request', async () => {
    const t = serverRepo();
    const ac = new AbortController();
    const p = runLive({ root: t.dir, packageManager: 'npm', env: cleanEnv(), signal: ac.signal, settings: settings({ requests: [{ path: '/api/slow' }, { path: '/api/users' }] }) });
    for (let i = 0; i < 200 && requests(t).length === 0; i++) await new Promise((r) => setTimeout(r, 25));
    ac.abort();
    const cap = await p;
    expect(cap.results[0]!.error).toBe('timeout');
    expect(requests(t).map((r) => r.url)).toEqual(['/api/slow']);
    await expectTreeGone(t);
  });

  it('redacts query values', () => {
    expect(redactPath('/api/x?token=abc&page=2')).toBe('/api/x?token=…&page=…');
    expect(redactPath('/api/x')).toBe('/api/x');
  });

  it('before/after: live status and shape changes are compared and reported', async () => {
    const t = serverRepo();
    await writeConfig(t.dir, {}, {
      probes: { api: { live: { enabled: true, startupTimeoutSec: 20, requests: [{ path: '/api/users' }, { method: 'POST', path: '/api/items', body: { name: 'x' } }] } } },
    });
    const saved = { ...process.env };
    for (const v of ['DATABASE_URL', 'POSTGRES_URL', 'DIRECT_URL', 'SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL']) delete process.env[v];
    try {
      await beforeCommand(t.dir, { task: 'x', yes: true }, fakeIo());
      t.write('v2', '');
      const io = fakeIo();
      const report = await afterCommand(t.dir, {}, io);
      const api = report.reports.find((r) => r.probeId === 'api')!;
      const titles = api.findings.map((f) => `${f.kind}: ${f.title}`);
      expect(titles).toContain('regression: [live] POST /api/items: returned 201, now 500');
      expect(titles).toContain('regression: [live] GET /api/users (200): response field "users[].email" removed (was string)');
      expect(titles).toContain('regression: [live] GET /api/users (200): response field "users[].id" changed type: number → string');
      expect(report.regressed).toBe(true);
      const stored = readFileSync(t.p('.holdline/api/api-after.json'), 'utf8') + readFileSync(t.p('.holdline/session.json'), 'utf8');
      const logs = io.logs.join('\n');
      for (const secret of [SECRETS.token, SECRETS.email]) {
        expect(stored, `stored ${secret}`).not.toContain(secret);
        expect(logs, `printed ${secret}`).not.toContain(secret);
      }
      await expectTreeGone(t);
    } finally {
      process.env = saved;
    }
  });
});

// Windows can't send Ctrl+C (SIGINT) to a child process: `kill('SIGINT')` there is TerminateProcess,
// so holdline's handler never runs. The tree kill itself is covered by the other live tests.
describe.skipIf(WINDOWS)('live mode: Ctrl+C (skipped on Windows: no SIGINT for child processes)', () => {
  let cli: string;
  beforeAll(() => {
    // Build holdline into a temp dir so it can run as a real CLI process.
    const out = tmpDir('holdline-cli-');
    execFileSync(process.execPath, [path.join(REPO, 'node_modules/typescript/bin/tsc'), '-p', path.join(REPO, 'tsconfig.json'), '--outDir', path.join(out, 'dist')], { stdio: 'pipe' });
    cpSync(path.join(REPO, 'package.json'), path.join(out, 'package.json'));
    symlinkSync(path.join(REPO, 'node_modules'), path.join(out, 'node_modules'), 'junction');
    cli = path.join(out, 'dist/cli.js');
  }, 120_000);

  it('Ctrl+C during `holdline api` kills the whole server tree', async () => {
    const t = serverRepo();
    mkdirSync(t.p('.holdline'), { recursive: true });
    await writeConfig(t.dir, {}, { probes: { api: { live: { enabled: true, requests: [{ path: '/api/slow' }] } } } });
    const child = spawn(process.execPath, [cli, 'api'], { cwd: t.dir, env: cleanEnv(), stdio: 'ignore' });
    for (let i = 0; i < 400 && requests(t).length === 0; i++) await new Promise((r) => setTimeout(r, 25));
    expect(requests(t).length).toBe(1);
    child.kill('SIGINT');
    const code = await new Promise<number | null>((r) => child.on('exit', (c) => r(c)));
    expect(code).toBe(130);
    await expectTreeGone(t);
  }, 60_000);
});
