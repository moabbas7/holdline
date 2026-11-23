# Probes

Each kind of check is a **probe**. holdline runs every enabled probe in `before` and again in `after`, and compares the two. All settings are in [configuration.md](configuration.md).

- [Checks](#checks): build, typecheck, lint and tests.
- [Dependency graph](#dependency-graph): imports, API calls and database tables between files.
- [Database schema](#database-schema): schema files and a local database, read-only.
- [API shapes](#api-shapes): routes, status codes and JSON shapes.
- [Visual check](#visual-check): pages in a real browser (opt-in).
- [Writing a probe](#writing-a-probe).

## Checks

The `checks` probe runs the build, typecheck, lint and test commands that `holdline init` detected (or that you set in `checks` in `.holdline/config.json`; `null` turns one off). A check that passed in `before` and fails in `after` is a regression. Errors in its output that name a project file are linked to that file and line, which is also how the finding is placed in the [task scope](task-scope.md#where-a-finding-goes). A check that was already failing before is listed separately, and one that started passing is listed as fixed. Each check has a timeout (`timeoutSec`: 600 s for build, 300 s for typecheck and lint, 900 s for tests).

The `files` probe lists the files changed since the snapshot.

## Dependency graph

The `dependencies` probe builds a graph of the project on every `before` and `after`:

- **Imports between files**: relative imports, `index` files, `.js` specifiers that point at `.ts` files, `require()` and `import()`. Aliases come from `paths`/`baseUrl` in the **nearest** `tsconfig.json`/`jsconfig.json` to each file (walking up to the repo root), following `extends` and, for Vite's layout, `references`. npm/yarn `workspaces` and `pnpm-workspace.yaml` are detected, and imports of workspace packages (`@acme/ui/button`) resolve to their source through `exports`, `main`/`module`/`types`, mapping `dist/` paths back to `src/`.
- **API calls**: `fetch`, `axios` (including `axios.create({ baseURL })` instances, also when imported from another file) and `useSWR` with literal or template-string URLs, matched to Next.js route handlers (`app/**/route.ts`, `pages/api/**`) and Express/Fastify/Hono-style routes (including `app.use('/prefix', router)` mounts). Next.js server actions (`'use server'` files) are linked to the components that import them.
- **Database tables**: Supabase `.from('table')`, Prisma (`prisma.user.findMany`, with models and `@@map` read from `*.prisma`), Drizzle (`pgTable`/`mysqlTable`/`sqliteTable` definitions and the queries that use them) and raw SQL passed to query calls (`pool.query`, `$queryRaw`, `` sql`…` ``, …). Tables defined in `.sql` migrations, Prisma schemas or Drizzle schema files depend on those files.

`holdline after` then reports, for every changed file, its **blast radius**: everything that depends on it, including pages that call a changed API route and routes that use a table whose schema or migration changed. It also reports imports that now point at a missing file or a missing export as regressions (exit 1). Imports that were already broken before the task are listed separately.

`holdline graph <file>` prints the same information for one file before you ask an agent to change it: what it depends on, what depends on it (directly and indirectly), and any broken imports. It also accepts `route:/api/users/42` and `table:users`, and `--json`. It works without `holdline init` (results are only cached once `.holdline/` exists).

Speed: `node_modules`, build output (`.next`, `dist`, `build`, …) and git-ignored files are skipped. Parsed results are cached by content hash in `.holdline/cache/`, so only changed files are parsed again. On a 2,200-file Next.js monorepo a cold run takes about 2–3 s and a warm one about 0.3 s. The graphs are stored in `.holdline/deps/graph-{before,after}.json`; `session.json` keeps only a reference.

Limits: URLs must be literals or template strings (a base path held in a variable, like `` `${apiPath}/export` ``, isn't resolved), calls to other hosts are ignored, and aliases defined only in `vite.config` or webpack config aren't read. Turn the probe off with `"probes": { "dependencies": { "enabled": false } }` in `.holdline/config.json` (`holdline init` writes it as `true`).

## Database schema

The `database` probe captures the schema on every `before` and `after` from two sources:

- **Schema files** (no connection needed): Supabase migrations (`supabase/migrations/*.sql`, applied in order, and `supabase/schemas/`), other SQL migration folders (`migrations/`, `db/migrations/`, …; `down` migrations and seed files are skipped), `schema.prisma` (including multi-file schemas) and Drizzle table definitions (`pgTable`, `sqliteTable`, `mysqlTable`, `pgEnum`, indexes, references, `pgPolicy`). SQL is parsed with the real Postgres parser, and only DDL is applied: functions, triggers, grants and data changes are ignored, as is everything in `DO` blocks except enum creation. A root `schema.sql` is only used when there are no migrations, because it is usually a copy of them. drizzle-kit and Prisma migration output is skipped when the Drizzle/Prisma schema itself is present.
- **The live database** (Postgres/Supabase or SQLite), when a connection string is found in `.env.development.local`, `.env.local`, `.env.development` or `.env` (`DATABASE_URL`, `POSTGRES_URL`, `DIRECT_URL`, or the name in `probes.database.envVar`). `.env.production*` is never read. When there is no URL there but the project has `supabase/config.toml`, holdline uses the **local Supabase** database: `127.0.0.1` at the `[db] port` from that file (54322 by default), with the Supabase CLI's local credentials. Every safety rule below still applies.

Both cover tables, columns, types, nullability, defaults, primary keys, foreign keys, indexes, unique constraints, enums, views, whether row-level security is on, and RLS policies. With a live connection, holdline compares both sources and reports where the database and the schema files disagree (for example a migration that was never applied).

`holdline after` reports, as **regressions** (exit 1): dropped or renamed tables, columns, views and enum values; type changes; columns that become NOT NULL without a default (or are added that way); row-level security turned off; and policies removed or changed. Removed indexes, foreign keys and unique constraints, additions and default changes are reported as **changes**. For each changed table it lists the routes, pages and files that still use it (from the dependency graph), and for a dropped or renamed column the lines that still use it in a query: Supabase `.select()`/`.eq()`/`.insert()`…, SQL strings, Prisma `where`/`select`/`data` keys and Drizzle `table.column`.

**Safety.** holdline never writes to a database:

- Every live query runs inside a `READ ONLY` transaction with a short statement and lock timeout, and only reads the system catalogs. The transaction is always rolled back. SQLite files are opened read-only, and a missing file is never created.
- holdline connects automatically only to **local** hosts: `localhost`, `127.0.0.1`, `::1`, `host.docker.internal` and single-label Docker service names (`db`, `supabase_db_myapp`). That covers a local Supabase on `127.0.0.1:54322`. Any other host (including private IP ranges) is never contacted unless listed in `probes.database.allowHosts`, and the output says it was skipped. `.env` files often hold production URLs; holdline will not touch them by default.
- The connection string, user name and password are never printed, logged or stored, including in errors and `--json` output. Only the host, port and the variable/file it came from are shown.
- If the connection fails, holdline warns and uses the schema files.
- `holdline rollback` restores files, not the database. When the live schema changed during the task, rollback (and the `after` report) lists those changes and says the database is **not** rolled back, so you can re-run your migrations or restore it.

`holdline db` prints the current schema and where it came from (`--json` for the full model, including drift between the database and the files). It works without `holdline init`.

Settings, all optional, in `.holdline/config.json`:

```json
"probes": {
  "database": {
    "enabled": true,
    "envVar": "SUPABASE_DB_URL",
    "allowHosts": ["db.staging.internal"],
    "schemas": ["public", "billing"],
    "connect": true,
    "statementTimeoutMs": 5000
  }
}
```

By default all user schemas are read, except Supabase's own (`auth`, `storage`, `realtime`, …). Set `"connect": false` to use schema files only. The Postgres client and the SQL parser are loaded only for projects that have SQL schema files or a database connection.

## API shapes

The `api` probe records, for every API route the dependency graph finds (Next.js `app/**/route.ts` and `pages/api/**`, Express/Fastify/Hono-style routes including `app.use('/prefix', router)` mounts), which HTTP methods it handles, the status codes it can return and the shape of each JSON response: keys, types, optional vs required, nesting. Values are never recorded.

**Static mode** (the default; no server, no install needed). Each route is read with the TypeScript type checker, using the nearest `tsconfig.json`/`jsconfig.json` (only route files are loaded; imports are resolved on demand):

- Responses: `NextResponse.json(x, { status })`, `Response.json`, `new Response(JSON.stringify(x), init)`, redirects, `res.json`/`res.status(n).json`/`res.send`/`res.sendStatus`, Fastify `return x`/`reply.code(n).send(x)`, Hono `c.json(x, status)`. Typed values (`NextResponse.json<T>`, `NextApiResponse<T>`, typed variables) come from the checker, with JSON rules applied (`Date` → string, functions dropped, `undefined` → optional). Untyped object and array literals are read directly. Handlers wrapped in helpers (`withAuth(async (ctx) => …)`) and helpers that build the response are followed.
- Methods: exported `GET`/`POST`/… in the app router; `req.method === 'POST'` / `switch (req.method)` branches in the pages router (a `405` for other methods isn't attributed to the listed ones).
- Requests: route params, query parameters read (`searchParams.get('x')`, `req.query.x`, `c.req.query('x')`) and the JSON body: typed through annotations, `as T` or a zod-style schema's input type (`schema.parse(await req.json())`, so `.optional()`/`.default()` fields are optional), otherwise the field names destructured from it.
- Anything it can't determine (an `any`, a handler built by an untyped package, a status held in a variable) is shown as **unknown**, never guessed, and never counts as a regression.

`holdline after` reports, as **regressions** (exit 1):

- a route, or a method of a route, removed while the dependency graph shows files still calling it;
- a response field removed, or a field's type changed (including `null` added or removed);
- a request body field that became required (optional → required, or a new required field) when something in the project calls that route with that method;
- a method that no longer returns any 2xx response, or whose 2xx response was replaced by a 3xx/4xx/5xx.

A change from one 2xx code to another (200 → 201) is a **change**, as are additions, removals nothing calls, new error statuses and request fields that became optional. Each regression lists the files and pages that call the route and, where it can follow the JSON from the call (`await res.json()`, `.then(r => r.json())`, `const { data } = useSWR(…)`, axios `data`, destructuring, `items.map(i => i.x)`), the exact lines that read the removed or changed field. When it can't follow it, lines that mention the field name are listed as "may read".

`holdline api [route] [--json]` prints every route (or the ones matching `/api/users/42`) with its methods, statuses, response shapes and request shape. It works without `holdline init`.

Results are cached in `.holdline/cache/` per route, keyed by the content of everything the route file imports plus declaration files, tsconfigs and the lockfile, so `after` only re-analyses routes the task could have affected. On a Next.js monorepo with 210 routes and 2,200 files (dependencies installed) a cold `holdline api` takes about 6 s; in `after`, the probe takes about 0.5 s when no route's imports changed and 2–5 s after an edit to a widely shared schema file. Projects without API routes never load the analyser.

**Live mode** (opt-in, off by default). When `probes.api.live` lists requests, `before`, `after` and `holdline api` start your dev server, call exactly those requests and record the real status and JSON shape:

```json
"probes": {
  "api": {
    "live": {
      "enabled": true,
      "command": "npm run dev",
      "requests": [
        { "path": "/api/users" },
        { "method": "POST", "path": "/api/users", "body": { "name": "Test" } }
      ],
      "headers": { "Authorization": "Bearer <dev token>" },
      "startupTimeoutSec": 90,
      "requestTimeoutSec": 60,
      "allowNonLocalDatabase": false
    }
  }
}
```

Safety rules:

- Only listed requests are sent. Methods other than GET/HEAD are sent only when listed with a sample `body`. Paths must start with `/`, and redirects are never followed. Readiness is checked with a TCP connection, not an HTTP request.
- Live mode refuses to start when `DATABASE_URL`, `POSTGRES_URL`, `DIRECT_URL`, `probes.database.envVar`, `SUPABASE_URL` or `NEXT_PUBLIC_SUPABASE_URL` (in the `.env` files the dev server loads, or in holdline's own environment) points at a non-local host, or at a host it can't identify, and says which variable and host. Same host rules as the database probe. Set `allowNonLocalDatabase: true` to allow it.
- Cookies and auth headers are sent only when the config provides them, and are never stored or printed. Response values are never stored or printed either, only types; query values in paths are shown as `…`.
- The server runs on a free port (`PORT` is set; `{port}` in `command` is replaced), in its own process group. The whole process tree is killed afterwards: on success, on errors, on a startup timeout and on Ctrl+C.

Live results are compared like static ones (labelled `[live]`): a 2xx that became a non-2xx, removed fields and type changes are regressions. A field that is `null` in one run and a value in another is not a type change.

Limits: response shapes built from a variable the checker sees as `any` (common when `node_modules` isn't installed) are unknown, as are statuses not written as numbers or constants; errors thrown and turned into responses by a wrapper are not listed (the output notes "errors thrown are handled elsewhere"); `res.statusCode = n` assignments aren't followed. Turn the probe off with `"probes": { "api": { "enabled": false } }`, and set `probes.api.timeoutSec` (default 60) to cap static analysis time; routes not reached in time are unknown.

## Visual check

The `visual` probe (opt-in, **off by default**) starts your dev server, loads the pages you list in headless Chromium at a desktop (1280×800) and a mobile (390×844) width, and records for each:

- a full-page screenshot;
- console errors and uncaught page errors;
- failed requests to the app's own origin (4xx/5xx and network failures; requests to other hosts are ignored);
- whether the page is blank or shows a framework error screen (the Next.js error overlay, Next's "Application error" page, the Vite or webpack overlay), and whether it loaded at all.

**Install.** Playwright is not a dependency of holdline. Install it in your project when you turn the check on:

```sh
npm install -D playwright
npx playwright install chromium
```

(or the `pnpm`/`yarn`/`bun` equivalents). If it isn't installed, `before`/`after` print these commands, skip the visual check and carry on.

**Turn it on.** `holdline init` suggests pages from the routes the dependency graph finds (static Next.js pages, `/` otherwise) and asks before enabling the check; with `--yes` the suggestions are written but the check stays off. Settings in `.holdline/config.json`:

```json
"probes": {
  "visual": {
    "enabled": true,
    "pages": ["/", "/pricing", { "path": "/dashboard", "mask": [".avatar"] }],
    "mask": ["[data-testid=timestamp]", ".ad-slot"],
    "storageState": "../auth/dev-user.json",
    "command": "npm run dev",
    "startupTimeoutSec": 90,
    "pageTimeoutSec": 60,
    "networkIdleTimeoutSec": 5,
    "params": { "locale": "en", "id": "1" },
    "threshold": 0.0002,
    "minPixels": 25,
    "failOnUnexpectedChange": false,
    "allowNonLocalDatabase": false
  }
}
```

`command` and `startupTimeoutSec` default to the `probes.api.live` values, then to `<pm> run dev` and 90 s. Every key is listed in [configuration.md](configuration.md#probesvisual).

`holdline after` reports, as **regressions** (exit 1):

- a page that loaded before now fails to load (HTTP 4xx/5xx, a navigation error or a timeout), is blank, or shows an error screen;
- new console errors or uncaught errors;
- new failed requests to the app's own origin.

Error messages are compared without the dev server's port, line and column numbers, hashes and long numbers, so the same error in two runs counts as the same error.

Each new problem is **confirmed** before it is reported: the page is reloaded in a fresh browser context up to 2 more times, and only problems that show up again are regressions. A problem that appears once and not on the reloads is reported as a **flaky** change, listing what appeared. In `before`, every page is loaded twice; a problem seen in only one of the two loads is recorded as flaky and never counts as new in `after`.

**Visual differences** above a small threshold (more than 0.02% of pixels and at least 25 pixels) are **changes**, not regressions, because the task may have changed the UI on purpose. A difference must also show on every load: when the after screenshot differs, the page is reloaded up to 2 times, and if a reload matches the before screenshot the difference came from content that varies per load (a random tip, a rotating banner) and is only noted. Content that moved by a single pixel (sub-pixel layout jitter) is not counted. The report lists the before, after and diff images (`.holdline/visual/{before,after,diff}/`), and the HTML report embeds them. A difference on a page outside the task's scope is an **unexpected visual change** (see [task scope](task-scope.md#where-a-finding-goes); `failOnUnexpectedChange: true` makes it a regression).

**Pages under dynamic segments.** Pages can be templates: `"/[locale]/pricing"`, `"/users/[id]"`, `"/docs/[...slug]"` or `"/users/:id"`. Values come from `probes.visual.params`, e.g. `"params": { "locale": "en", "id": "1", "slug": "intro" }`. An optional catch-all (`[[...slug]]`) without a value is left out of the URL. A page whose value is missing is skipped with a warning naming the missing value. `holdline init` suggests pages under dynamic segments too. It guesses locale segments (`locale`, `lang`, …) from the `defaultLocale` in your Next.js or i18n config, or `en`. When you turn the check on, it asks for other values, and an empty answer skips those pages. With `--yes`, pages it can't fill are left out and listed.

**Stable screenshots.** Animations, transitions and the text caret are disabled; the viewport, device scale, timezone (UTC), locale (en-US), colour scheme and reduced motion are fixed; holdline waits for the network to go quiet (at most `networkIdleTimeoutSec`, 5 s by default, since pages that poll never go quiet) and for fonts to load. Selectors in `mask` (and a page's own `mask`) are painted over. Dev-server overlays and indicators (the Next.js dev tools badge, Vite and webpack overlays) are hidden in screenshots; error overlays are still detected and reported. During `before`, two screenshots are taken a second apart; regions that differ (clocks, carousels, live counters), plus a margin of 32px, are recorded as **noisy** and ignored when comparing. The second `before` load adds regions that differ between loads (a random avatar, a per-request timestamp). Content that is the same for every load of one server run but different in the next (a "server started at" time, a build id) is not caught that way. Mask it. When more than half of a page is noisy or masked, the report says how much was left to compare.

**Pages behind login.** Set `storageState` to a Playwright storage-state file you created yourself (for example with `npx playwright codegen --save-storage=auth.json http://localhost:3000`). holdline reads it into memory for the run and never copies, prints or stores its contents. Because the dev server runs on a random port, `localStorage` saved for a local origin (`http://localhost:3000`) is applied to holdline's server, and cookies saved for `127.0.0.1` also apply to `localhost` (pages are loaded as `http://localhost:<port>`, which dev servers like Next.js require for their dev resources). Keep it outside the project or git-ignored: holdline snapshots untracked files into `refs/holdline/`, so it refuses a file inside the project that git doesn't ignore.

**The dev server** is started exactly as in API live mode, with the same safety rules (free port, TCP readiness check, refusal when a database URL points at a non-local host, the whole process tree killed afterwards, on errors and on Ctrl+C). When the API live check and the visual check are both on, the server is started once per run and used by both.

`holdline visual [pages…] [--json]` runs the check now and prints what each page shows, without a snapshot or comparison. Pages on the command line replace the configured ones; screenshots go to `.holdline/visual/current/`. It works without `holdline init`.

Speed: each page is loaded at both widths in parallel, twice in `before` (plus a one-second pause for the noise screenshot) and once in `after` (plus up to 2 reloads for a new problem). On a plain server that is about 1 s per page in `before`; a dev server that compiles pages on first request adds its compile time. **On a typical app, the visual check adds roughly 30–70 seconds to `before`**, mostly dev-server startup and first-request compilation.

## Writing a probe

A probe is a module with `snapshot()` and `compare()` methods (see `src/probes/types.ts`), registered in `src/probes/registry.ts`; the core stays unchanged. Any probe can be turned off with `"probes": { "<id>": { "enabled": false } }` in `.holdline/config.json`.
