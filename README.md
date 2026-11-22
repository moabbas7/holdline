# holdline

A local CLI that catches what AI coding agents break outside the task they were given, and puts everything back when they do.

- **Local only.** No cloud services and no accounts. Data lives in `.holdline/` in your project (git-ignored) and in git refs under `refs/holdline/`.
- **Never touches your branch, index or stash list** when it takes a snapshot.
- **Rollback can be undone.** The current state is always snapshotted first.

Requires Node ≥ 20.17 and git.

## Usage

```sh
holdline init                                   # detect project type + build/typecheck/lint/test commands
holdline before --task "add pagination to /users"
# … let the agent work …
holdline after                                  # what went from passing to failing + changed files (exit 1 on regressions)
holdline graph lib/db.ts                        # what depends on a file (check the blast radius before a change)
holdline rollback                               # restore the working tree to the "before" snapshot
holdline undo-rollback                          # changed your mind: restore the state from just before the rollback
```

Other commands:

- `holdline prune --keep <n> [--dry-run]` deletes old snapshot history. The newest 20 are kept automatically after each `before`. Snapshots still in use (the session, `after`, `pre-rollback`, `pre-undo`) are never pruned.
- `holdline unlock` removes a leftover lock file. Commands take `.holdline/lock` so only one runs at a time, and a lock from a dead process is cleared automatically. You only need `unlock` for a lock left on another machine (for example a shared folder).
- `holdline after --json` prints a machine-readable report.

## What a snapshot covers

Snapshots include tracked files (with uncommitted edits), untracked files, deletions, file modes and symlinks, plus what was staged. They are plain git commits built through a temporary index, so they work in linked worktrees too; each worktree has its own namespace under `refs/holdline/`.

**Git-ignored files are not covered** (`node_modules/`, an ignored `.env`, build output). Rollback leaves them alone. If an ignored file or directory sits exactly where a restored file must go, it is moved to `.holdline/displaced/` rather than deleted.

Before snapshotting, holdline warns when untracked, non-ignored files add up to more than 100 MB (`largeUntrackedWarnMB` in the config) and lists the biggest ones. Those are usually build artefacts or data that belong in `.gitignore`.

If the agent committed or switched branches, `rollback` still restores your files and staging area exactly, but it does not move branches. It prints the `git reset --soft` command if you want that too.

## Probes

Each kind of check is a **probe** with `snapshot()` and `compare()` methods (`src/probes/types.ts`). Built in:

- `checks`: build, typecheck, lint and tests.
- `files`: files changed since the snapshot.
- `dependencies`: a dependency graph of the project (see below).

Adding a probe means adding a module and registering it in `src/probes/registry.ts`; the core stays unchanged. A probe can be disabled with `"probes": { "<id>": { "enabled": false } }` in `.holdline/config.json`.

## Dependency graph

The `dependencies` probe builds a graph of the project with [ts-morph](https://ts-morph.com) on every `before` and `after`:

- **Imports between files**: relative imports, `index` files, `.js` specifiers that point at `.ts` files, `require()` and `import()`. Aliases come from `paths`/`baseUrl` in the **nearest** `tsconfig.json`/`jsconfig.json` to each file (walking up to the repo root), following `extends` and, for Vite's layout, `references`. npm/yarn `workspaces` and `pnpm-workspace.yaml` are detected, and imports of workspace packages (`@acme/ui/button`) resolve to their source through `exports`, `main`/`module`/`types`, mapping `dist/` paths back to `src/`.
- **API calls**: `fetch`, `axios` (including `axios.create({ baseURL })` instances, also when imported from another file) and `useSWR` with literal or template-string URLs, matched to Next.js route handlers (`app/**/route.ts`, `pages/api/**`) and Express/Fastify/Hono-style routes (including `app.use('/prefix', router)` mounts). Next.js server actions (`'use server'` files) are linked to the components that import them.
- **Database tables**: Supabase `.from('table')`, Prisma (`prisma.user.findMany`, with models and `@@map` read from `*.prisma`), Drizzle (`pgTable`/`mysqlTable`/`sqliteTable` definitions and the queries that use them) and raw SQL passed to query calls (`pool.query`, `$queryRaw`, `` sql`…` ``, …). Tables defined in `.sql` migrations, Prisma schemas or Drizzle schema files depend on those files.

`holdline after` then reports, for every changed file, its **blast radius**: everything that depends on it, including pages that call a changed API route and routes that use a table whose schema or migration changed. It also reports imports that now point at a missing file or a missing export as regressions (exit 1). Imports that were already broken before the task are listed separately.

`holdline graph <file>` prints the same information for one file before you ask an agent to change it: what it depends on, what depends on it (directly and indirectly), and any broken imports. It also accepts `route:/api/users/42` and `table:users`, and `--json`. It works without `holdline init` (results are only cached once `.holdline/` exists).

Speed: `node_modules`, build output (`.next`, `dist`, `build`, …) and git-ignored files are skipped. Parsed results are cached by content hash in `.holdline/cache/`, so only changed files are parsed again. On a 2,200-file Next.js monorepo a cold run takes about 2–3 s and a warm one about 0.3 s. The graphs are stored in `.holdline/deps/graph-{before,after}.json`; `session.json` keeps only a reference.

Limits: URLs must be literals or template strings (a base path held in a variable, like `` `${apiPath}/export` ``, isn't resolved), calls to other hosts are ignored, and aliases defined only in `vite.config` or webpack config aren't read. Turn the probe off with `"probes": { "dependencies": { "enabled": false } }` in `.holdline/config.json` (`holdline init` writes it as `true`).

## Development

```sh
npm install
npm run build
npm test        # creates throwaway git repos in the OS temp dir
```
