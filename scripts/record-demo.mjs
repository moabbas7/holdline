#!/usr/bin/env node
// Records the README demo from a real holdline run. Nothing in the output is written by hand.
//
//   npm run build
//   node scripts/record-demo.mjs <scratch-dir>
//
// It copies test/fixtures/scope-app into <scratch-dir>/acme-app, makes it a git repo, and runs
// init → before → (a scripted "agent" edit) → after → rollback in a pseudo-terminal, so holdline
// prints exactly what it prints in a real terminal (colours included). Every output chunk is
// timestamped into an asciicast v2 file. Two presentational changes only: commands are "typed" at
// a fixed speed, and long idle gaps are capped (like asciinema's --idle-time-limit). The scratch
// path is shown as ~/acme-app.
//
// Then it renders the cast to an animated SVG (svg-term-cli through npx, cached in
// <scratch-dir>/npm-cache) and screenshots the HTML report of that run with Playwright.
// Needs macOS or Linux, python3 (for the pseudo-terminal) and Playwright's Chromium.
//
// Outputs: docs/media/demo.cast, docs/media/demo.svg, docs/media/report.png.

import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratchArg = process.argv[2];
if (!scratchArg) {
  console.error('usage: node scripts/record-demo.mjs <scratch-dir>');
  process.exit(2);
}
const scratch = path.resolve(scratchArg);
const cli = path.join(repoRoot, 'dist', 'cli.js');
if (!existsSync(cli)) {
  console.error('dist/cli.js is missing: run `npm run build` first.');
  process.exit(2);
}
const media = path.join(repoRoot, 'docs', 'media');
mkdirSync(media, { recursive: true });

const COLS = 110;
const ROWS = 44;
const TYPE_DELAY = 0.035; // seconds per typed character
const IDLE_LIMIT = 1.0; // longest gap kept between output chunks
const PROMPT = '\x1b[36m~/acme-app\x1b[39m $ ';

// --- The demo project -------------------------------------------------------------------------

const app = path.join(scratch, 'acme-app');
rmSync(app, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });
cpSync(path.join(repoRoot, 'test', 'fixtures', 'scope-app'), app, { recursive: true });
// The fixture's stand-in type checker doubles as the project's typecheck script.
const pkgFile = path.join(app, 'package.json');
const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
pkg.scripts.typecheck = 'node scripts/check.mjs';
writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
const git = (...args) => execFileSync('git', ['-c', 'user.name=demo', '-c', 'user.email=demo@example.com', ...args], { cwd: app, stdio: 'ignore' });
git('init', '-q');
git('add', '-A');
git('commit', '-qm', 'Initial commit');

// `holdline` on PATH, pointing at this checkout's build.
const bin = path.join(scratch, 'bin');
mkdirSync(bin, { recursive: true });
writeFileSync(path.join(bin, 'holdline'), `#!/bin/sh\nexec "${process.execPath}" "${cli}" "$@"\n`);
chmodSync(path.join(bin, 'holdline'), 0o755);
const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, COLUMNS: String(COLS), LINES: String(ROWS), TERM: 'xterm-256color' };
delete env.NO_COLOR;
for (const k of Object.keys(env)) if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE') || k === 'CURSOR_AGENT' || k.startsWith('CODEX_')) delete env[k];

/** What the "agent" does: the task (pagination), a shared helper renamed, an unrelated component renamed. */
function agentEdits() {
  const edit = (file, find, replace) => {
    const p = path.join(app, file);
    const s = readFileSync(p, 'utf8');
    if (!s.includes(find)) throw new Error(`${file} has no ${JSON.stringify(find)}`);
    writeFileSync(p, s.replace(find, replace));
  };
  edit(
    'app/users/page.tsx',
    "export default async function UsersPage() {\n  const res = await fetch('/api/users');",
    "export default async function UsersPage({ searchParams }: { searchParams: { page?: string } }) {\n  const page = Number(searchParams.page ?? 1);\n  const res = await fetch(`/api/users?page=${page}`);",
  );
  edit('lib/format.ts', 'formatMoney', 'formatCurrency');
  edit('components/Header.tsx', 'function Header', 'function SiteHeader');
}

// --- Pseudo-terminal runner --------------------------------------------------------------------

const PTY = `
import os, pty, sys, select, struct, fcntl, termios
rows, cols = int(sys.argv[1]), int(sys.argv[2])
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[3], sys.argv[3:])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
inp = sys.stdin.fileno()
while True:
    r, _, _ = select.select([fd, inp], [], [])
    if fd in r:
        try:
            data = os.read(fd, 4096)
        except OSError:
            break
        if not data:
            break
        os.write(1, data)
    if inp in r:
        data = os.read(inp, 1024)
        if data:
            os.write(fd, data)
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
`;

const events = [];
let clock = 0; // seconds, in cast time
const at = (data) => events.push([Number(clock.toFixed(3)), 'o', data]);
const pause = (s) => (clock += s);

const realApp = realpathSync(app);
const hidePaths = (s) => s.split(realApp).join('~/acme-app').split(app).join('~/acme-app');

function type(command) {
  at(PROMPT);
  pause(0.4);
  for (const ch of command) {
    at(ch);
    pause(TYPE_DELAY);
  }
  pause(0.25);
  at('\r\n');
}

/** Run a shell command in the pty, recording its real output with real (capped) timing. */
function run(command, answers = []) {
  type(command);
  return new Promise((resolve) => {
    const child = spawn('python3', ['-c', PTY, String(ROWS), String(COLS), '/bin/sh', '-c', command], { cwd: app, env, stdio: ['pipe', 'pipe', 'inherit'] });
    let last = performance.now();
    let seen = '';
    const pending = [...answers];
    child.stdout.on('data', (buf) => {
      const now = performance.now();
      pause(Math.min((now - last) / 1000, IDLE_LIMIT));
      last = now;
      const text = buf.toString('utf8');
      at(hidePaths(text));
      seen += text;
      if (pending.length && seen.includes(pending[0].when)) {
        const { send } = pending.shift();
        // A short "thinking" pause before the answer is typed.
        setTimeout(() => child.stdin.write(send), 700);
      }
    });
    child.on('exit', (code) => {
      pause(Math.min((performance.now() - last) / 1000, IDLE_LIMIT));
      child.stdin.end();
      resolve(code);
    });
  });
}

// --- The recording -----------------------------------------------------------------------------

await run('holdline init --yes');
pause(1.2);
await run('holdline before --task "add pagination to the users page"');
pause(1.2);
type('# … the agent works on the task …');
agentEdits();
pause(0.6);
await run('git status --short');
pause(1.2);
const afterCode = await run('holdline after');
if (afterCode !== 1) console.warn(`warning: holdline after exited ${afterCode}, expected 1`);
pause(4.5); // time to read the report
const reports = readdirSync(path.join(app, '.holdline', 'reports')).filter((f) => f.endsWith('.html')).sort();
const reportHtml = path.join(app, '.holdline', 'reports', reports.at(-1));
await run('holdline rollback', [{ when: 'Roll back now?', send: 'y\r' }]);
pause(3);
at(PROMPT);
pause(1);

const header = { version: 2, width: COLS, height: ROWS, timestamp: Math.floor(Date.now() / 1000), env: { SHELL: '/bin/sh', TERM: 'xterm-256color' }, title: 'holdline demo' };
const castFile = path.join(media, 'demo.cast');
writeFileSync(castFile, [JSON.stringify(header), ...events.map((e) => JSON.stringify(e))].join('\n') + '\n');
console.log(`demo.cast: ${clock.toFixed(1)} s, ${events.length} events`);

// --- Render the SVG ----------------------------------------------------------------------------

const svgFile = path.join(media, 'demo.svg');
execFileSync('npx', ['--yes', 'svg-term-cli@2.1.1', '--in', castFile, '--out', svgFile, '--window', '--width', String(COLS), '--height', String(ROWS), '--padding', '12'], {
  stdio: 'inherit',
  env: { ...process.env, npm_config_cache: path.join(scratch, 'npm-cache'), npm_config_update_notifier: 'false' },
});

// --- Screenshot the HTML report ----------------------------------------------------------------

const { chromium } = await import('playwright');
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, deviceScaleFactor: 1, colorScheme: 'light' });
  await page.goto('file://' + reportHtml);
  await page.screenshot({ path: path.join(media, 'report.png'), fullPage: true });
} finally {
  await browser.close();
}
console.log('wrote docs/media/demo.cast, docs/media/demo.svg, docs/media/report.png');
