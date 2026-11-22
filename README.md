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

Each kind of check is a **probe** with `snapshot()` and `compare()` methods (`src/probes/types.ts`). Phase 1 ships two:

- `checks`: build, typecheck, lint and tests.
- `files`: files changed since the snapshot.

Adding a probe means adding a module and registering it in `src/probes/registry.ts`; the core stays unchanged. A probe can be disabled with `"probes": { "<id>": { "enabled": false } }` in `.holdline/config.json`.

## Development

```sh
npm install
npm run build
npm test        # creates throwaway git repos in the OS temp dir
```
