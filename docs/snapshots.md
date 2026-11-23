# Snapshots and rollback

## What a snapshot covers

Snapshots include tracked files (with uncommitted edits), untracked files, deletions, file modes and symlinks, plus what was staged. They are plain git commits built through a temporary index, so taking one never touches your branch, index or stash list, and they work in linked worktrees too. Each worktree has its own namespace under `refs/holdline/`. Everything else holdline stores lives in `.holdline/` in your project, which `holdline init` adds to `.gitignore`.

**Git-ignored files are not covered** (`node_modules/`, an ignored `.env`, build output). Rollback leaves them alone.

**Large untracked files.** Before snapshotting, holdline warns when untracked, non-ignored files add up to more than 100 MB (`largeUntrackedWarnMB` in the config) and lists the biggest ones. Those are usually build artefacts or data that belong in `.gitignore`.

**Build output that isn't git-ignored.** `before` takes its snapshot first and then runs your checks, so files a build writes (an `out/` folder, generated types) appear after the snapshot. holdline records every file its own checks created or changed during `before`. In `after`, a file whose content still matches is not counted as an agent change. If the agent edited it since, it is counted, and its `why` line says so. `before` and `after` suggest the `.gitignore` lines to add.

## Rollback

`holdline rollback` restores the working tree and the staging area to the "before" snapshot. It shows what it will restore and asks first (`--yes` skips the question).

- **It can be undone.** The current state is snapshotted first, and `holdline undo-rollback` brings it back.
- **It doesn't move branches.** If the agent committed or switched branches, rollback still restores your files and staging area exactly, and prints the `git reset --soft` command if you want to move the branch too.
- **It doesn't delete ignored files.** If an ignored file or directory sits exactly where a restored file must go, it is moved to `.holdline/displaced/` rather than deleted.
- **It doesn't restore a database.** When the live database schema changed during the task, rollback (and the `after` report) lists those changes and says the database is **not** rolled back, so you can re-run your migrations or restore it.

## Housekeeping

- The newest 20 snapshots are kept automatically after each `before`. `holdline prune --keep <n> [--dry-run]` deletes older history by hand. Snapshots still in use (the session, `after`, `pre-rollback`, `pre-undo`) are never pruned.
- Commands take `.holdline/lock` so only one runs at a time. A lock left by a dead process is cleared automatically; `holdline unlock` is only needed for a lock left by another machine (for example on a shared folder).
