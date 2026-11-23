import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { afterCommand } from '../src/commands/after.js';
import { beforeCommand } from '../src/commands/before.js';
import { initCommand } from '../src/commands/init.js';
import { loadConfig } from '../src/core/config.js';
import { looksLikeSql, sqlTables, ddlTables, prismaModels } from '../src/probes/dependencies/sql.js';
import { buildGraph, dependentsOf, indexGraph } from '../src/probes/dependencies/graph.js';
import { compareGraphs, dependenciesProbe } from '../src/probes/dependencies/index.js';
import { normaliseUrl } from '../src/probes/dependencies/extract.js';
import { matchRoute, nextFileRole } from '../src/probes/dependencies/routes.js';
import { parsePnpmWorkspace } from '../src/probes/dependencies/workspaces.js';
import type { DepGraph, DepGraphRef } from '../src/probes/dependencies/types.js';
import { fixtureProject, fixtureRepo } from './helpers/fixtures.js';
import { cleanupAll, fakeIo, makeRepo, writeConfig } from './helpers/tmpRepo.js';

afterEach(cleanupAll);

const has = (g: DepGraph, from: string, to: string, type?: string) =>
  g.edges.some((e) => e.from === from && e.to === to && (!type || e.type === type));
const dependents = (g: DepGraph, node: string) => dependentsOf(indexGraph(g), node).map((d) => d.node).sort();

describe('helpers', () => {
  it('normalises URLs from literals and templates', () => {
    expect(normaliseUrl('/api/users?limit=1')).toBe('/api/users');
    expect(normaliseUrl('http://localhost:3000/api/orders#x')).toBe('/api/orders');
    expect(normaliseUrl('${}/api/users/${}')).toBe('/api/users/:param');
    expect(normaliseUrl('/api/users/${}.json')).toBe('/api/users/:param');
    expect(normaliseUrl('${}')).toBeNull();
    expect(normaliseUrl('hello world')).toBeNull();
  });

  it('matches calls against route patterns', () => {
    expect(matchRoute('/api/users/:param', '/api/users/:id')).toBeGreaterThan(-1);
    expect(matchRoute('/api/users/42', '/api/users/:id')).toBeGreaterThan(-1);
    expect(matchRoute('/api/users', '/api/users/:id')).toBe(-1);
    expect(matchRoute('/api/files/a/b', '/api/files/*')).toBeGreaterThan(-1);
    expect(matchRoute('/api/files', '/api/files/*')).toBe(-1);
    expect(matchRoute('/api/files', '/api/files/*?')).toBeGreaterThan(-1);
    expect(matchRoute('/api/users/me', '/api/users/me')).toBeGreaterThan(matchRoute('/api/users/me', '/api/users/:id'));
  });

  it('maps Next.js files to routes and pages', () => {
    expect(nextFileRole('app/api/users/[id]/route.ts')).toEqual({ kind: 'api', pattern: '/api/users/:id' });
    expect(nextFileRole('src/app/(admin)/api/x/[...slug]/route.ts')).toEqual({ kind: 'api', pattern: '/api/x/*' });
    expect(nextFileRole('pages/api/index.ts')).toEqual({ kind: 'api', pattern: '/api' });
    expect(nextFileRole('app/(dashboard)/users/page.tsx')).toEqual({ kind: 'page' });
    expect(nextFileRole('pages/_app.tsx')).toBeNull();
    expect(nextFileRole('app/_lib/route.ts')).toBeNull();
    expect(nextFileRole('lib/route.ts')).toBeNull();
  });

  it('finds tables in SQL and Prisma schemas', () => {
    expect(looksLikeSql('Select a file from your computer')).toBe(true); // shape only…
    expect(looksLikeSql('Please select a file')).toBe(false);
    expect(sqlTables('SELECT i.* FROM public.invoices i JOIN "Orders" o ON o.id = i.order_id').sort()).toEqual(['invoices', 'orders']);
    expect(sqlTables('WITH recent AS (SELECT * FROM events) SELECT * FROM recent')).toEqual(['events']);
    expect(sqlTables("SELECT EXTRACT(year FROM created_at) FROM logs WHERE a IS DISTINCT FROM b")).toEqual(['logs']);
    expect(sqlTables('UPDATE accounts SET x = 1')).toEqual(['accounts']);
    expect(ddlTables('create table if not exists public.users (id int); ALTER TABLE posts ADD x int;')).toEqual(['users', 'posts']);
    expect(prismaModels('model OrderItem {\n id Int @id\n @@map("order_items")\n}\nmodel User { id Int }')).toEqual({
      OrderItem: 'order_items',
      User: 'user',
    });
  });

  it('parses pnpm-workspace.yaml', () => {
    expect(parsePnpmWorkspace("packages:\n  - 'apps/*'\n  - \"packages/*\" # x\n  - '!packages/old'\ncatalog:\n  a: 1\n")).toEqual([
      'apps/*',
      'packages/*',
      '!packages/old',
    ]);
    expect(parsePnpmWorkspace("packages: ['a/*', 'b']\n")).toEqual(['a/*', 'b']);
  });
});

describe('file encodings', () => {
  it('reads UTF-16 files with a byte-order mark (e.g. generated Supabase types)', async () => {
    const t = makeRepo();
    t.write('types_db.ts', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('export type Tables = { id: string };\nexport interface Database {}\n', 'utf16le')]));
    t.write('src/use.ts', "import type { Tables, Database } from '../types_db';\nexport type T = Tables | Database;\n");
    t.write('src/bom8.ts', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("export const x = 1;\n")]));
    t.write('src/use8.ts', "import { x } from './bom8';\nexport const y = x;\n");
    t.commitAll('encodings');
    const g = await buildGraph(t.dir);
    expect(g.broken).toEqual([]);
    expect(has(g, 'src/use.ts', 'types_db.ts', 'import')).toBe(true);
  });
});

describe('graph: Next.js + Supabase fixture', () => {
  it('links pages, API routes, server actions and tables', async () => {
    const t = fixtureRepo('next-supabase');
    const g = await buildGraph(t.dir, { projectType: 'nextjs' });

    // tsconfig alias (with comments and trailing commas), barrel index file, relative imports.
    expect(has(g, 'app/api/users/route.ts', 'lib/supabase.ts', 'import')).toBe(true);
    expect(has(g, 'app/api/users/[id]/route.ts', 'lib/supabase.ts', 'import')).toBe(true);
    expect(has(g, 'app/(dashboard)/users/page.tsx', 'components/index.ts', 'import')).toBe(true);
    expect(has(g, 'components/index.ts', 'components/UserCard.tsx', 'import')).toBe(true);

    // Routes: app router (route group dropped, [id] → :id) and pages router.
    expect(Object.keys(g.routes).sort()).toEqual(['/api/health', '/api/users', '/api/users/:id']);
    expect(g.routes['/api/users']!.methods).toEqual(['GET', 'POST']);
    expect(g.files['app/(dashboard)/users/page.tsx']!.role).toBe('page');
    expect(g.files['app/api/users/route.ts']!.role).toBe('api-route');

    // fetch with a literal and with a template string (dynamic base + :param).
    expect(has(g, 'app/(dashboard)/users/page.tsx', 'route:/api/users', 'calls-api')).toBe(true);
    expect(has(g, 'app/users/[id]/page.tsx', 'route:/api/users/:id', 'calls-api')).toBe(true);
    expect(has(g, 'route:/api/users/:id', 'app/api/users/[id]/route.ts', 'handles-route')).toBe(true);

    // Server actions.
    expect(g.files['app/actions.ts']!.role).toBe('server-action');
    expect(has(g, 'components/NewPostForm.tsx', 'app/actions.ts', 'server-action')).toBe(true);

    // Supabase tables, defined by the migration. Array.from('ok') is not a table.
    expect(g.tables).toEqual({
      posts: { definedIn: ['supabase/migrations/0001_init.sql'] },
      users: { definedIn: ['supabase/migrations/0001_init.sql'] },
    });
    expect(has(g, 'app/api/users/route.ts', 'table:users', 'uses-table')).toBe(true);
    expect(has(g, 'app/api/users/[id]/route.ts', 'table:posts', 'uses-table')).toBe(true);
    expect(has(g, 'app/actions.ts', 'table:posts', 'uses-table')).toBe(true);

    // Nothing from node_modules/.next/dist/build, and nothing broken.
    expect(Object.keys(g.files).filter((f) => /^(node_modules|\.next|dist|build)\//.test(f))).toEqual([]);
    expect(g.broken).toEqual([]);
    expect(g.unmatchedCalls).toEqual([]);
  });

  it('computes blast radius through imports, routes and tables', async () => {
    const t = fixtureRepo('next-supabase');
    const g = await buildGraph(t.dir, { projectType: 'nextjs' });

    expect(dependents(g, 'lib/supabase.ts')).toEqual([
      'app/(dashboard)/users/page.tsx',
      'app/actions.ts',
      'app/api/users/[id]/route.ts',
      'app/api/users/route.ts',
      'app/users/[id]/page.tsx',
      'components/NewPostForm.tsx',
      'components/index.ts',
      'route:/api/users',
      'route:/api/users/:id',
    ]);
    // A migration change reaches the tables, the code using them, their routes and the pages calling those.
    const fromMigration = dependents(g, 'supabase/migrations/0001_init.sql');
    expect(fromMigration).toEqual(
      expect.arrayContaining(['table:users', 'table:posts', 'app/api/users/route.ts', 'route:/api/users', 'app/(dashboard)/users/page.tsx']),
    );
    // A page nobody imports has no dependents.
    expect(dependents(g, 'app/page.tsx')).toEqual([]);
  });
});

describe('graph: Vite/React fixture', () => {
  it('resolves aliases from referenced tsconfigs, .js → .ts, barrels and assets', async () => {
    const t = fixtureRepo('vite-react');
    const g = await buildGraph(t.dir, { projectType: 'vite-react' });
    expect(has(g, 'src/App.tsx', 'src/components/index.ts')).toBe(true);
    expect(has(g, 'src/App.tsx', 'src/hooks/useTodos.ts')).toBe(true); // './hooks/useTodos.js'
    expect(has(g, 'src/hooks/useTodos.ts', 'src/components/TodoItem.tsx')).toBe(true); // '@/components/TodoItem'
    expect(has(g, 'src/components/TodoItem.tsx', 'src/lib/api.ts')).toBe(true);
    expect(has(g, 'src/lib/slug.ts', 'src/lib/legacy.js')).toBe(true);
    // No false positives: CSS, /public asset, a CommonJS module, an external package.
    expect(g.broken).toEqual([]);
    // The backend lives elsewhere, so the axios-instance and fetch calls are unmatched.
    expect(g.unmatchedCalls.map((c) => c.url).sort()).toEqual(['/api/todos', '/api/todos/:param/toggle']);
    expect(dependents(g, 'src/lib/api.ts')).toEqual(
      expect.arrayContaining(['src/components/TodoItem.tsx', 'src/components/TodoList.tsx', 'src/components/index.ts', 'src/App.tsx', 'src/main.tsx']),
    );
  });
});

describe('graph: Node API fixture', () => {
  it('finds Express routes with mount prefixes and Prisma, Drizzle and raw SQL tables', async () => {
    const t = fixtureRepo('node-api');
    const g = await buildGraph(t.dir, { projectType: 'node' });
    expect(Object.keys(g.routes).sort()).toEqual(['/api/customers', '/api/orders', '/api/orders/:id/invoice', '/health', '/legacy']);
    expect(g.routes['/api/orders']!.files).toEqual(['src/routes/orders.ts']);
    // fetch('http://localhost:3000/api/orders?limit=1')
    expect(has(g, 'scripts/smoke.ts', 'route:/api/orders', 'calls-api')).toBe(true);
    // Prisma model Order @@map("orders"), raw SQL, Drizzle table resolved across files.
    expect(has(g, 'src/routes/orders.ts', 'table:orders', 'uses-table')).toBe(true);
    expect(has(g, 'src/routes/orders.ts', 'table:invoices', 'uses-table')).toBe(true);
    expect(has(g, 'src/routes/customers.ts', 'table:customers', 'uses-table')).toBe(true);
    expect(g.tables.orders!.definedIn).toEqual(['prisma/schema.prisma']);
    expect(g.tables.customers!.definedIn).toEqual(['src/db/schema.ts']);
    expect(g.broken).toEqual([]);

    expect(dependents(g, 'src/routes/orders.ts')).toEqual(
      expect.arrayContaining(['route:/api/orders', 'route:/api/orders/:id/invoice', 'scripts/smoke.ts', 'src/index.ts']),
    );
    expect(dependents(g, 'prisma/schema.prisma')).toEqual(
      expect.arrayContaining(['table:orders', 'src/routes/orders.ts', 'route:/api/orders', 'scripts/smoke.ts']),
    );
  });
});

describe('graph: monorepo fixture', () => {
  it('uses the nearest tsconfig per file and resolves workspace packages to source', async () => {
    const t = fixtureRepo('monorepo');
    const g = await buildGraph(t.dir, { projectType: 'node' });
    // '@/…' means apps/web/src in the app and packages/ui/src/lib in the ui package.
    expect(has(g, 'apps/web/src/app/page.tsx', 'apps/web/src/components/Header.tsx')).toBe(true);
    expect(has(g, 'packages/ui/src/button.tsx', 'packages/ui/src/lib/cn.ts')).toBe(true);
    // Workspace package imports via package.json exports pointing at dist/ → src/.
    expect(has(g, 'apps/web/src/app/page.tsx', 'packages/ui/src/index.ts')).toBe(true);
    expect(has(g, 'apps/web/src/components/Header.tsx', 'packages/ui/src/button.tsx')).toBe(true);
    // Next.js detected from apps/web/package.json even though the root is not a Next app.
    expect(g.files['apps/web/src/app/page.tsx']!.role).toBe('page');
    expect(g.broken).toEqual([]);
    expect(dependents(g, 'packages/ui/src/button.tsx')).toEqual(
      expect.arrayContaining(['apps/web/src/components/Header.tsx', 'apps/web/src/app/page.tsx', 'packages/ui/src/index.ts']),
    );
  });

  it('reads pnpm-workspace.yaml', async () => {
    const t = fixtureRepo('monorepo');
    t.write('package.json', '{ "name": "acme", "private": true }\n');
    renameSync(t.p('pnpm-workspace.yaml.variant'), t.p('pnpm-workspace.yaml'));
    const g = await buildGraph(t.dir, { projectType: 'node' });
    expect(has(g, 'apps/web/src/components/Header.tsx', 'packages/ui/src/button.tsx')).toBe(true);
    expect(g.broken).toEqual([]);
  });

  it('reports an export removed across the package boundary', async () => {
    const t = fixtureRepo('monorepo');
    const before = await buildGraph(t.dir, { projectType: 'node' });
    t.write('packages/ui/src/button.tsx', 'export function PrimaryButton() { return null; }\n');
    const after = await buildGraph(t.dir, { projectType: 'node' });
    expect(after.broken).toEqual([
      expect.objectContaining({ file: 'apps/web/src/components/Header.tsx', reason: 'missing-export', name: 'Button', target: 'packages/ui/src/button.tsx' }),
    ]);
    const report = compareGraphs(before, after);
    expect(report.status).toBe('regressed');
  });
});

// Each case below was a false positive in a run against a ~2,200-file Next.js monorepo.
describe('real-world false positives', () => {
  it('only treats strings as SQL when they are run as queries', async () => {
    const t = fixtureRepo('next-supabase');
    t.write('lib/misc.ts', [
      "import { sql } from 'drizzle-orm';",
      "import { prisma, pool, db } from './db';",
      'export function check(hostname: string, ok: boolean) {',
      '  // UI text that reads like SQL',
      "  if (!ok) throw new Error('Select a hostname from your allowlist.');",
      '  // A query for another service (Google Ads GAQL) passed as an option',
      "  return searchStream({ query: 'SELECT customer.id FROM customer_client WHERE customer_client.status = ENABLED' });",
      '}',
      'export async function real(id: string) {',
      "  await pool.query('SELECT * FROM audit_log WHERE id = $1', [id]);",
      '  await prisma.$queryRaw`SELECT count(*) FROM page_views WHERE id = ${id}`;',
      '  await db.execute(sql`DELETE FROM sessions WHERE user_id = ${id}`);',
      "  const userQuery = 'UPDATE profiles SET seen = true WHERE id = $1';",
      '  await pool.query({ text: "INSERT INTO events (id) VALUES ($1)", values: [id] });',
      '  return userQuery;',
      '}',
      'declare function searchStream(o: object): unknown;',
      '',
    ].join('\n'));
    const g = await buildGraph(t.dir, { projectType: 'nextjs' });
    const used = g.edges.filter((e) => e.from === 'lib/misc.ts' && e.type === 'uses-table').map((e) => e.to).sort();
    expect(used).toEqual(['table:audit_log', 'table:events', 'table:page_views', 'table:profiles', 'table:sessions']);
  });

  it('does not match calls to other hosts, fully dynamic URLs, or ambiguous ones', async () => {
    const t = fixtureRepo('next-supabase');
    for (const name of ['a', 'b', 'c', 'd']) {
      t.write(`app/api/users/[id]/${name}/route.ts`, 'export async function GET() { return new Response(); }\n');
    }
    t.write('lib/calls.ts', [
      'export async function calls(path: string, base: string, key: string, id: string, isA: boolean, x: string) {',
      '  await fetch(`https://googleads.googleapis.com/v17/${path}`);',
      '  await fetch(`${base}/${key}`);',
      '  await fetch(`/api/users/${id}/${x}`);',
      "  await fetch(`/api/users/${id}/${isA ? `a?x=${x}` : 'b'}`);",
      "  await fetch('http://localhost:3000/api/users');",
      '}',
      '',
    ].join('\n'));
    const g = await buildGraph(t.dir, { projectType: 'nextjs' });
    const linked = g.edges.filter((e) => e.from === 'lib/calls.ts' && e.type === 'calls-api').map((e) => e.to).sort();
    // Only the conditional (both branches) and the localhost call are linked.
    expect(linked).toEqual(['route:/api/users', 'route:/api/users/:id/a', 'route:/api/users/:id/b']);
    const unmatched = g.unmatchedCalls.filter((c) => c.file === 'lib/calls.ts').map((c) => c.url);
    // External hosts are dropped entirely; the dynamic and ambiguous calls are listed as unmatched.
    expect(unmatched.sort()).toEqual(['/:param', '/api/users/:param/:param']);
  });
});

describe('broken imports', () => {
  it('reports removed exports (through a barrel) and deleted files as new regressions', async () => {
    const t = fixtureRepo('next-supabase');
    const before = await buildGraph(t.dir, { projectType: 'nextjs' });
    t.write('components/UserCard.tsx', 'export function PersonCard() { return null; }\n');
    t.rm('lib/format.ts');
    const after = await buildGraph(t.dir, { projectType: 'nextjs' });

    const summary = after.broken.map((b) => `${b.file} ${b.reason} ${b.spec} ${b.name ?? ''}`.trim()).sort();
    // The barrel's re-export breaks (the page importing from the barrel is fine as written);
    // the page importing the deleted file breaks.
    expect(summary).toEqual([
      'app/users/[id]/page.tsx missing-file @/lib/format',
      'components/index.ts missing-export ./UserCard UserCard',
    ]);

    const report = compareGraphs(before, after);
    expect(report.status).toBe('regressed');
    expect(report.findings.filter((f) => f.kind === 'regression')).toHaveLength(2);
    // The deleted file's former importers show up as its blast radius.
    const deleted = report.findings.find((f) => f.path === 'lib/format.ts' && f.kind === 'change')!;
    expect(deleted.title).toMatch(/lib\/format\.ts \(deleted\)/);
    expect(deleted.lines!.join('\n')).toContain('components/UserCard.tsx');
  });

  it('reports imports that were already broken as pre-existing, not regressions', async () => {
    const t = fixtureRepo('vite-react');
    t.write('src/old.ts', "import { gone } from './nowhere';\nexport const x = gone;\n");
    const before = await buildGraph(t.dir, { projectType: 'vite-react' });
    t.write('src/App.tsx', t.read('src/App.tsx') + '\n// touched\n');
    const after = await buildGraph(t.dir, { projectType: 'vite-react' });
    const report = compareGraphs(before, after);
    expect(report.status).not.toBe('regressed');
    expect(report.findings.filter((f) => f.kind === 'still-failing').map((f) => f.title)).toEqual([
      'src/old.ts:1 imports "./nowhere", which doesn\'t exist (already broken before the task)',
    ]);
  });

  it('does not flag CommonJS targets, external star re-exports or git-ignored generated code', async () => {
    const t = fixtureRepo('vite-react');
    t.write('src/reexports.ts', "export * from 'some-package';\nexport const local = 1;\n");
    t.write('src/uses.ts', [
      "import { anything } from './reexports';",
      "import def, { slugify } from './lib/legacy.js';",
      "import { client } from './generated/client';",
      "import * as ns from './lib/api';",
      'export const all = [anything, def, slugify, client, ns];',
      '',
    ].join('\n'));
    t.write('.gitignore', t.read('.gitignore') + 'src/generated/\n');
    const g = await buildGraph(t.dir, { projectType: 'vite-react' });
    expect(g.broken).toEqual([]);
  });
});

describe('caching', () => {
  it('parses each file once and re-parses only changed files', async () => {
    const t = await fixtureProject('next-supabase', 'nextjs');
    const first = await buildGraph(t.dir, { projectType: 'nextjs' });
    expect(first.stats.parsed).toBe(13);
    expect(first.stats.cached).toBe(0);
    expect(existsSync(t.p('.holdline/cache/deps-v1.json'))).toBe(true);

    const second = await buildGraph(t.dir, { projectType: 'nextjs' });
    expect(second.stats.parsed).toBe(0);
    expect(second.stats.cached).toBe(13);
    expect(second.edges).toEqual(first.edges);

    t.write('lib/format.ts', t.read('lib/format.ts') + '\nexport const extra = 1;\n');
    const third = await buildGraph(t.dir, { projectType: 'nextjs' });
    expect(third.stats.parsed).toBe(1);
    expect(third.stats.cached).toBe(12);

    // A new extractor version invalidates everything.
    const bumped = await buildGraph(t.dir, { projectType: 'nextjs', extractorVersion: 999 });
    expect(bumped.stats.parsed).toBe(13);
  });

  it('does not create .holdline/ when it does not exist', async () => {
    const t = fixtureRepo('vite-react');
    await buildGraph(t.dir, { projectType: 'vite-react' });
    expect(existsSync(t.p('.holdline'))).toBe(false);
  });
});

describe('probe: config and storage', () => {
  it('init writes probes.dependencies.enabled = true', async () => {
    const t = fixtureRepo('next-supabase');
    await initCommand(t.dir, { yes: true }, fakeIo());
    const config = await loadConfig(t.dir);
    expect(config.probes).toEqual({ dependencies: { enabled: true }, database: { enabled: true }, api: { enabled: true }, visual: { enabled: false, pages: ['/', '/users'] } });
    expect(dependenciesProbe.enabled(config)).toBe(true);
  });

  it('is enabled for configs without a probes section, and can be turned off', async () => {
    const t = makeRepo();
    await writeConfig(t.dir);
    const config = await loadConfig(t.dir);
    expect(config.probes).toBeUndefined();
    expect(dependenciesProbe.enabled(config)).toBe(true);
    expect(dependenciesProbe.enabled({ ...config, probes: { dependencies: { enabled: false } } })).toBe(false);
  });

  it('with enabled: false, before/after skip the probe and write no graph', async () => {
    const t = await fixtureProject('next-supabase', 'nextjs', { probes: { dependencies: { enabled: false } } });
    const session = await beforeCommand(t.dir, { task: 'x', yes: true }, fakeIo());
    expect(session.probes).not.toHaveProperty('dependencies');
    const report = await afterCommand(t.dir, {}, fakeIo());
    expect(report.reports.map((r) => r.probeId)).not.toContain('dependencies');
    expect(existsSync(t.p('.holdline/deps'))).toBe(false);
  });

  it('keeps only a reference in session.json and the graph in its own files', async () => {
    const t = await fixtureProject('next-supabase', 'nextjs');
    const session = await beforeCommand(t.dir, { task: 'x', yes: true }, fakeIo());
    const ref = session.probes.dependencies as DepGraphRef;
    expect(ref.file).toBe('.holdline/deps/graph-before.json');
    expect(Object.keys(ref).sort()).toEqual(['file', 'sha256', 'stats']);
    const sessionText = readFileSync(t.p('.holdline/session.json'), 'utf8');
    expect(sessionText).not.toContain('handles-route');
    expect(sessionText.length).toBeLessThan(4000);
    const graph = JSON.parse(readFileSync(t.p(ref.file), 'utf8')) as DepGraph;
    expect(graph.edges.length).toBeGreaterThan(10);

    await afterCommand(t.dir, {}, fakeIo());
    expect(existsSync(t.p('.holdline/deps/graph-after.json'))).toBe(true);
  });

  it('reports "skipped" instead of crashing when the before graph is gone', async () => {
    const t = await fixtureProject('next-supabase', 'nextjs');
    await beforeCommand(t.dir, { task: 'x', yes: true }, fakeIo());
    rmSync(t.p('.holdline/deps/graph-before.json'));
    const report = await afterCommand(t.dir, {}, fakeIo());
    const deps = report.reports.find((r) => r.probeId === 'dependencies')!;
    expect(deps.status).toBe('skipped');
    expect(deps.summary).toMatch(/run before again/);
  });
});

describe('before → after end to end', () => {
  it('reports blast radius and new broken imports', async () => {
    const t = await fixtureProject('next-supabase', 'nextjs');
    await beforeCommand(t.dir, { task: 'rename the supabase client', yes: true }, fakeIo());

    t.write('lib/supabase.ts', t.read('lib/supabase.ts') + '\nexport const schema = "public";\n');
    t.write('lib/format.ts', "export function formatName(u: { name: string }) { return u.name; }\n");

    const io = fakeIo();
    const report = await afterCommand(t.dir, {}, io);
    expect(report.regressed).toBe(true);
    const deps = report.reports.find((r) => r.probeId === 'dependencies')!;
    expect(deps.status).toBe('regressed');
    expect(deps.findings.filter((f) => f.kind === 'regression').map((f) => f.title).sort()).toEqual([
      'Broken import: app/users/[id]/page.tsx:1 imports { formatUser } from "@/lib/format", which lib/format.ts doesn\'t export',
      'Broken import: components/UserCard.tsx:1 imports { formatUser } from "../lib/format", which lib/format.ts doesn\'t export',
    ]);
    const supa = deps.findings.find((f) => f.path === 'lib/supabase.ts')!;
    expect(supa.title).toBe('lib/supabase.ts (modified) → 2 pages, 2 API routes, 5 files depend on it');
    const out = io.logs.join('\n');
    expect(out).toContain('route GET|POST /api/users  (handled by app/api/users/route.ts)');
    expect(out).toContain('page app/(dashboard)/users/page.tsx  (calls /api/users)');
  });

  it('is quiet on a plain repo with no source changes', async () => {
    const t = makeRepo();
    t.write('.gitignore', '.holdline/\n');
    await writeConfig(t.dir);
    await beforeCommand(t.dir, { task: 'docs', yes: true }, fakeIo());
    t.write('docs/new.md', 'hello\n');
    const report = await afterCommand(t.dir, {}, fakeIo());
    const deps = report.reports.find((r) => r.probeId === 'dependencies')!;
    expect(deps.status).toBe('ok');
    expect(deps.summary).toBe('no source files changed');
  });
});

describe('holdline graph', () => {
  it('prints dependencies and dependents of a file', async () => {
    const { graphCommand } = await import('../src/commands/graph.js');
    const t = await fixtureProject('next-supabase', 'nextjs');
    const io = fakeIo();
    const r = await graphCommand(t.dir, 'lib/supabase.ts', {}, io);
    expect(r.node).toBe('lib/supabase.ts');
    const out = io.logs.join('\n');
    expect(out).toContain('Depends on (0):');
    expect(out).toMatch(/Depended on by \(9\): 2 pages, 2 API routes, 5 files/);
    expect(out).toContain('directly:');
    expect(out).toContain('app/api/users/route.ts  imports lib/supabase.ts');
    expect(out).toContain('indirectly:');
  });

  it('accepts paths relative to a subfolder, routes and tables, and returns JSON data', async () => {
    const { graphCommand } = await import('../src/commands/graph.js');
    const t = await fixtureProject('next-supabase', 'nextjs');
    const fromSub = await graphCommand(path.join(t.dir, 'app'), 'api/users/route.ts', { json: true }, fakeIo());
    expect(fromSub.node).toBe('app/api/users/route.ts');
    expect(fromSub.dependsOn.map((e) => e.to).sort()).toEqual(['lib/supabase.ts', 'table:users']);
    expect(fromSub.dependents.map((d) => d.node)).toEqual(['route:/api/users', 'app/(dashboard)/users/page.tsx']);

    const route = await graphCommand(t.dir, 'route:/api/users/42', { json: true }, fakeIo());
    expect(route.node).toBe('route:/api/users/:id');
    expect(route.dependents.map((d) => d.node)).toEqual(['app/users/[id]/page.tsx']);

    const table = await graphCommand(t.dir, 'table:posts', { json: true }, fakeIo());
    expect(table.dependsOn.map((e) => e.to)).toEqual(['supabase/migrations/0001_init.sql']);
    expect(table.dependents.map((d) => d.node)).toEqual(
      expect.arrayContaining(['app/actions.ts', 'app/api/users/[id]/route.ts', 'components/NewPostForm.tsx']),
    );
  });

  it('errors for files outside the graph', async () => {
    const { graphCommand } = await import('../src/commands/graph.js');
    const t = await fixtureProject('next-supabase', 'nextjs');
    await expect(graphCommand(t.dir, 'README.md', {}, fakeIo())).rejects.toThrow(/not in the dependency graph/);
    await expect(graphCommand(t.dir, 'node_modules/junk/index.ts', {}, fakeIo())).rejects.toThrow(/not in the dependency graph/);
  });
});
