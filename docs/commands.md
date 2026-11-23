# Commands

Run `holdline --help` or `holdline <command> --help` for the same list in the terminal. If holdline is installed in the project, prefix commands with `npx` (`npx holdline after`).

## The main loop

| Command | What it does |
| --- | --- |
| `holdline init [--yes]` | Detects the project type, package manager and build/typecheck/lint/test commands, and writes `.holdline/config.json`. `--yes` accepts what was detected without prompting (and overwrites an existing config). Adds `.holdline/` to `.gitignore`. |
| `holdline before --task "<task>"` | Snapshots the working tree and records the result of every check before the agent starts. |
| `holdline after` | Runs the checks again and reports what broke or changed, outside the task first. Exit code 1 on any regression. |
| `holdline rollback [--yes]` | Restores the working tree to the "before" snapshot. The current state is saved first. |
| `holdline undo-rollback [--yes]` | Restores the state saved by the last rollback. |

Options for `before`:

- `--scope "<glob>"` (repeatable): files that are part of the task, in addition to what the task text matches. A plain folder (`--scope lib`) covers everything under it. See [task scope](task-scope.md).
- `--reuse-baseline`: reuse the results of the last `after` when the working tree is exactly what that `after` checked, instead of running the checks again (what the Claude Code hooks do).
- `--yes`: non-interactive. Replaces an existing session and continues past warnings.
- `--force`: replace an existing session without asking.

Options for `after`:

- `--all`: also list the changes inside the task area (collapsed to a count by default) and notes.
- `--json`: print a machine-readable report on stdout. Everything else goes to stderr. See [report-schema.md](report-schema.md).

## Looking at a project

These work without `holdline init`.

| Command | What it does |
| --- | --- |
| `holdline report [n] [--list] [--no-open]` | Opens the HTML report of the last `after`. `--list` lists older ones, newest first, and `holdline report <n>` opens one of them. `--no-open` only prints the path. |
| `holdline graph <target> [--json]` | What a file depends on and what depends on it, directly and indirectly, plus any broken imports. Also accepts `route:/api/users/42` and `table:users`. Useful to check the blast radius before you ask an agent to change a file. |
| `holdline db [--json]` | The database schema and where it came from (a local database, read-only, or schema files). `--json` includes drift between the database and the files. |
| `holdline api [route] [--json]` | Every API route (or the ones matching `/api/users/42`) with its methods, status codes, response shapes and request shape. |
| `holdline visual [pages…] [--json]` | Loads pages in headless Chromium and prints what each one shows: errors, failed requests, blank or error screens. Pages given here replace the configured ones; screenshots go to `.holdline/visual/current/`. Needs Playwright (see [probes](probes.md#visual-check)). |

## Claude Code

| Command | What it does |
| --- | --- |
| `holdline install-hooks [--shared] [--command <cmd>]` | Runs holdline automatically around Claude Code tasks. Without `--shared`, the hooks go in `.claude/settings.local.json` (just for you); with it, in `.claude/settings.json` (for the team, commit it). `--command` sets how the hooks call holdline. See [claude-code.md](claude-code.md). |
| `holdline uninstall-hooks [--shared]` | Removes holdline's hooks, and only holdline's. |

## Maintenance

| Command | What it does |
| --- | --- |
| `holdline doctor` | Checks the config, the Claude Code hooks, git state, Playwright, database safety settings and the lock, and prints what to fix (exit 2 if something must be fixed). |
| `holdline prune --keep <n> [--dry-run]` | Deletes old snapshot history. The newest 20 are kept automatically after each `before`. Snapshots still in use (the session, `after`, `pre-rollback`, `pre-undo`) are never pruned. |
| `holdline unlock [--yes]` | Removes a leftover lock file. Commands take `.holdline/lock` so only one runs at a time, and a lock from a dead process is cleared automatically. You only need `unlock` for a lock left by another machine (for example on a shared folder). |

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success. For `after`: nothing went from passing to failing. |
| `1` | `after` found at least one regression, in any scope (outside the task, broken by the task's changes, or inside it). |
| `2` | holdline couldn't do what was asked: not a git repo, no config or session, a lock held by another command, an invalid argument. |
| `3` | An unexpected internal error (a bug in holdline; the stack trace is printed). |
| `130` | Cancelled at a prompt (Ctrl+C or answering no). Nothing was changed. |
