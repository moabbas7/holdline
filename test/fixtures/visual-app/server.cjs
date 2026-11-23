// A tiny app for the visual tests: serves pages/<name>.html from disk on every request.
//   {{LOAD}}  how many times this server process has served that path (1 on the first load)
//   {{NOW}}   the current time (changes on every load)
//   {{ODDFLAG}} 1 when a file named oddload exists (tests create it between runs)
//   {{STARTED}} when this server process started (same for every load of one run)
//   {{USER}}  "logged in" when the request has the session cookie, otherwise "anonymous"
//   POST /count/<key> counts per key (pages use it to behave differently per viewport)
//   a page containing <!-- status:500 --> is served with HTTP 500
// With --die it exits after serving its first page.
// It starts a grandchild process and records pids and starts so tests can check cleanup.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const dir = __dirname;
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
fs.writeFileSync(path.join(dir, 'pids.json'), JSON.stringify({ server: process.pid, grandchild: grandchild.pid }));
fs.appendFileSync(path.join(dir, 'starts.log'), `${process.pid}\n`);
const loads = new Map();
const started = new Date().toISOString() + ' ' + process.pid;
http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    // POST /count/<key>: how many times <key> was counted by this server process.
    if (url.pathname.startsWith('/count/')) {
      const key = 'count:' + url.pathname.slice(7);
      const n = (loads.get(key) ?? 0) + 1;
      loads.set(key, n);
      return res.end(String(n));
    }
    if (url.pathname === '/api/ok') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ ok: true }));
    }
    if (url.pathname.startsWith('/api/')) {
      res.statusCode = 404;
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ error: 'not found' }));
    }
    const name = url.pathname === '/' ? 'index' : url.pathname.slice(1).replace(/[^a-z0-9-]/gi, '');
    const file = path.join(dir, 'pages', `${name}.html`);
    if (!fs.existsSync(file)) {
      res.statusCode = 404;
      return res.end('not found');
    }
    const n = (loads.get(name) ?? 0) + 1;
    loads.set(name, n);
    const cookie = req.headers.cookie ?? '';
    let html = fs.readFileSync(file, 'utf8');
    html = html
      .replaceAll('{{LOAD}}', String(n))
      .replaceAll('{{STARTED}}', started)
      .replaceAll('{{ODDFLAG}}', fs.existsSync(path.join(dir, 'oddload')) ? '1' : '0')
      .replaceAll('{{NOW}}', new Date().toISOString() + ' ' + Math.random().toString(36).slice(2))
      .replaceAll('{{USER}}', /(?:^|;\s*)session=/.test(cookie) ? 'logged in' : 'anonymous');
    res.statusCode = html.includes('<!-- status:500 -->') ? 500 : 200;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(html);
    // --die: exit after the first page (a dev server that stops mid-run).
    if (process.argv.includes('--die')) setTimeout(() => process.exit(3), 50);
  })
  .listen(Number(process.env.PORT), '127.0.0.1');
