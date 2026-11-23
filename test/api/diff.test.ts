import { afterEach, describe, expect, it } from 'vitest';
import { afterCommand } from '../../src/commands/after.js';
import { beforeCommand } from '../../src/commands/before.js';
import type { ProbeReport } from '../../src/probes/types.js';
import { fixtureProject } from '../helpers/fixtures.js';
import { cleanupAll, fakeIo, type TestRepo } from '../helpers/tmpRepo.js';

afterEach(cleanupAll);

async function start(name = 'api-next', type: 'nextjs' | 'node' = 'nextjs'): Promise<TestRepo> {
  const t = await fixtureProject(name, type);
  await beforeCommand(t.dir, { task: 'x', yes: true }, fakeIo());
  return t;
}

async function after(t: TestRepo): Promise<{ api: ProbeReport; regressed: boolean; titles: (k: string) => string[]; find: (re: RegExp) => ProbeReport['findings'][number] }> {
  const report = await afterCommand(t.dir, {}, fakeIo());
  const api = report.reports.find((r) => r.probeId === 'api')!;
  return {
    api,
    regressed: report.regressed,
    titles: (k) => api.findings.filter((f) => f.kind === k).map((f) => f.title),
    find: (re) => {
      const f = api.findings.find((x) => re.test(x.title));
      if (!f) throw new Error(`no finding matching ${re}; got:\n${api.findings.map((x) => `${x.kind}: ${x.title}`).join('\n')}`);
      return f;
    },
  };
}

const edit = (t: TestRepo, file: string, from: string | RegExp, to: string) => {
  const text = t.read(file);
  const next = text.replace(from, to);
  if (next === text) throw new Error(`edit did not apply to ${file}`);
  t.write(file, next);
};

describe('api probe: before/after', () => {
  it('no changes: no findings', async () => {
    const t = await start();
    const r = await after(t);
    expect(r.api.status).toBe('ok');
    expect(r.api.findings.filter((f) => f.kind !== 'info')).toEqual([]);
    expect(r.regressed).toBe(false);
  });

  it('a removed response field used by a page is a regression, with the page and the exact line', async () => {
    const t = await start();
    edit(t, 'app/api/users/[id]/route.ts', ', address: { city: user.city, zip: user.zip }', '');
    const r = await after(t);
    expect(r.regressed).toBe(true);
    const f = r.find(/GET \/api\/users\/:id \(200\): response field "user.address" removed/);
    expect(f.kind).toBe('regression');
    expect(f.lines).toContain('page app/users/[id]/page.tsx:2 calls GET /api/users/:param');
    expect(f.lines!.some((l) => l.startsWith('✗ app/users/[id]/page.tsx:4 reads user.address'))).toBe(true);
  });

  it('a field type change is a regression; lines reading it through .then(r => r.json()) are listed', async () => {
    const t = await start();
    edit(t, 'app/api/users/route.ts', 'total: users.length', 'total: String(users.length)');
    const r = await after(t);
    const f = r.find(/GET \/api\/users \(200\): response field "total" changed type: number → string/);
    expect(f.kind).toBe('regression');
    expect(f.lines!.some((l) => l.startsWith('✗ app/users/page.tsx:11 reads total'))).toBe(true);
  });

  it('a removed method still called is a regression; one nobody calls is a change', async () => {
    const t = await start();
    edit(t, 'app/api/users/[id]/route.ts', /export async function DELETE\(\) \{[\s\S]*?\n\}\n/, '');
    edit(t, 'pages/api/todos.ts', /  if \(req.method === 'POST'\) \{[\s\S]*?\n  \}\n/, '');
    const r = await after(t);
    const del = r.find(/\/api\/users\/:id no longer handles DELETE/);
    expect(del.kind).toBe('regression');
    expect(del.lines).toContain('components/NewUser.tsx:8 calls DELETE /api/users/:param');
    expect(r.find(/\/api\/todos no longer handles POST/).kind).toBe('change');
  });

  it('a removed route still called is a regression; one nobody calls is a change', async () => {
    const t = await start();
    t.rm('app/api/stats/route.js');
    t.rm('app/api/projects/route.ts');
    const r = await after(t);
    const stats = r.find(/Route removed: GET \/api\/stats/);
    expect(stats.kind).toBe('regression');
    expect(stats.lines).toContain('components/Stats.tsx:2 calls GET /api/stats');
    expect(r.find(/Route removed: GET \/api\/projects/).kind).toBe('change');
  });

  it('request fields: optional → required and new required fields are regressions only when the route+method has callers', async () => {
    const t = await start();
    edit(t, 'lib/schema.ts', "role?: 'admin' | 'member'", "role: 'admin' | 'member'; teamId: string");
    const r = await after(t);
    const role = r.find(/POST \/api\/users: request body field "role" is required \(was optional, now required\)/);
    expect(role.kind).toBe('regression');
    expect(role.lines).toContain('components/NewUser.tsx:2 calls POST /api/users');
    expect(r.find(/request body field "teamId" is required \(new required field\)/).kind).toBe('regression');

    // Without a POST caller the same change is not a regression.
    const t2 = await start();
    t2.write('components/NewUser.tsx', "export async function removeUser(id: string) {\n  await fetch(`/api/users/${id}`, { method: 'DELETE' });\n}\n");
    t2.commitAll('no POST caller');
    await beforeCommand(t2.dir, { task: 'y', yes: true }, fakeIo());
    edit(t2, 'lib/schema.ts', "role?: 'admin' | 'member'", "role: 'admin' | 'member'; teamId: string");
    const r2 = await after(t2);
    expect(r2.find(/"role" is required/).kind).toBe('change');
    expect(r2.find(/"teamId" is required/).kind).toBe('change');
    expect(r2.regressed).toBe(false);
  });

  it('status codes: 2xx → 2xx is a change; losing every 2xx or a 2xx replaced by 3xx/4xx/5xx is a regression', async () => {
    const t = await start();
    // 200 → 201: a change (callers check res.ok).
    edit(t, 'app/api/projects/route.ts', 'count: 1 });', 'count: 1 }, { status: 201 });');
    // GET /api/users/:id: the 200 becomes a redirect, leaving only 3xx/4xx.
    edit(t, 'app/api/users/[id]/route.ts', /return NextResponse\.json\(\{\n    user:[\s\S]*?\n  \}\);/, "return NextResponse.redirect('/login');");
    // A route with two success responses where one is replaced by a 409.
    const r = await after(t);
    expect(r.find(/GET \/api\/projects: success status 200 → 201/).kind).toBe('change');
    const lost = r.find(/GET \/api\/users\/:id no longer returns a success response \(was 200; it now returns only 307, 404\)/);
    expect(lost.kind).toBe('regression');
    expect(lost.lines!.some((l) => l.includes('app/users/[id]/page.tsx:2 calls GET'))).toBe(true);
    expect(r.regressed).toBe(true);
  });

  it('a success case replaced by an error status is a regression even when another 2xx remains', async () => {
    const t = await fixtureProject('api-next', 'nextjs');
    t.write(
      'app/api/jobs/route.ts',
      "import { NextResponse } from 'next/server';\n\nexport async function POST(req: Request) {\n  const body = await req.json();\n  if (body.queue) return new Response(null, { status: 202 });\n  return NextResponse.json({ id: 1 }, { status: 200 });\n}\n",
    );
    t.commitAll('jobs');
    await beforeCommand(t.dir, { task: 'x', yes: true }, fakeIo());
    edit(t, 'app/api/jobs/route.ts', 'NextResponse.json({ id: 1 }, { status: 200 })', "NextResponse.json({ error: 'busy' }, { status: 409 })");
    const r = await after(t);
    expect(r.find(/POST \/api\/jobs: the 200 response was replaced by 409/).kind).toBe('regression');
  });

  it("routes it can't analyse never produce a false regression", async () => {
    const t = await start();
    edit(t, 'app/api/external/route.ts', 'NextResponse.json(data)', 'NextResponse.json({ data, extra: data.more })');
    edit(t, 'app/api/legacy/route.ts', "makeHandler('legacy')", "makeHandler('legacy-v2')");
    const r = await after(t);
    expect(r.titles('regression')).toEqual([]);
    expect(r.regressed).toBe(false);
  });

  it('a body read through a schema whose type was unresolved is unknown, so typing it later is not a regression', async () => {
    const t = await fixtureProject('api-next', 'nextjs');
    t.write(
      'app/api/invites/route.ts',
      "import { inviteSchema } from 'untyped-schemas';\n\nexport async function POST(req: Request) {\n  const input = inviteSchema.parse(await req.json());\n  return Response.json({ ok: true, input });\n}\n",
    );
    t.write('components/Invite.ts', "export const invite = () => fetch('/api/invites', { method: 'POST', body: '{}' });\n");
    t.commitAll('invites');
    await beforeCommand(t.dir, { task: 'x', yes: true }, fakeIo());
    // Now the schema resolves to a typed one with required fields.
    t.write('lib/invite.ts', "import type { Schema } from './schema';\nexport declare const inviteSchema: Schema<{ email: string; role: string }>;\n");
    edit(t, 'app/api/invites/route.ts', "from 'untyped-schemas'", "from '@/lib/invite'");
    const r = await after(t);
    expect(r.titles('regression')).toEqual([]);
  });

  it('additions are changes', async () => {
    const t = await start();
    edit(t, 'app/api/stats/route.js', 'ok: true', 'ok: true, version: 2');
    t.write('app/api/ping/route.ts', "export function GET() {\n  return Response.json({ pong: true });\n}\n");
    edit(t, 'app/api/users/[id]/route.ts', "return new Response(null, { status: 204 });", "return new Response(null, { status: 204 });\n}\n\nexport async function PATCH() {\n  return Response.json({ ok: true });");
    const r = await after(t);
    expect(r.find(/GET \/api\/stats \(200\): response field "version" added \(number\)/).kind).toBe('change');
    expect(r.find(/New route: GET \/api\/ping/).kind).toBe('change');
    expect(r.find(/PATCH \/api\/users\/:id: new method/).kind).toBe('change');
    expect(r.regressed).toBe(false);
  });

  it('Express: a removed field used through fetch().json() is a regression with the line', async () => {
    const t = await start('api-express', 'node');
    edit(t, 'src/routes/orders.ts', '  items: { sku: string; qty: number }[];\n', '');
    const r = await after(t);
    const f = r.find(/GET \/api\/orders\/:id \(200\): response field "items" removed/);
    expect(f.kind).toBe('regression');
    expect(f.lines!.some((l) => l.startsWith('✗ client/orders.ts:11 reads items'))).toBe(true);
    // The same type is used by GET /api/orders, read through axios `{ data }`.
    expect(r.find(/GET \/api\/orders \(200\): response field "orders\[\]\.items" removed/).kind).toBe('regression');
  });

  it('can be turned off in config.json', async () => {
    const t = await fixtureProject('api-next', 'nextjs', { probes: { api: { enabled: false } } });
    const report = await beforeCommand(t.dir, { task: 'x', yes: true }, fakeIo());
    expect(report).toBeDefined();
    t.rm('app/api/stats/route.js');
    const r = await afterCommand(t.dir, {}, fakeIo());
    expect(r.reports.find((x) => x.probeId === 'api')).toBeUndefined();
  });
});
