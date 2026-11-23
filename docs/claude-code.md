# Running automatically with Claude Code

```sh
npx holdline install-hooks            # just for you: .claude/settings.local.json (git-ignored)
npx holdline install-hooks --shared   # for the whole team: .claude/settings.json (commit it)
npx holdline uninstall-hooks          # remove them again (--shared for the team file)
```

`install-hooks` runs `holdline init --yes` first if the project has no config. It merges holdline's entries into the settings file: your other settings and other tools' hooks are left exactly as they are, running it again changes nothing, and `uninstall-hooks` removes only holdline's entries. The hooks call the project's own holdline (`node_modules/.bin/holdline`) when it is installed there, otherwise `holdline` on your PATH; `--shared` requires one of the two so it works for teammates. Claude Code picks up the change by itself (check with `/hooks`).

## What happens then

- **When a session starts** (`SessionStart`), holdline records a baseline in the background (`holdline hook warm`): the same snapshot and checks as `before`, while you are still typing.
- **When you send a prompt** (`UserPromptSubmit`), holdline starts a session with the prompt as the task. If the working tree is exactly the state the last `after` (or the background run) checked, it reuses those results instead of running the checks again, so this usually takes a second or two. Otherwise it runs the checks, for at most `hooks.promptBudgetSec` (180 s by default). It prints nothing into Claude's context.
- **A follow-up prompt** while the last `after` still showed problems outside the task doesn't take a new snapshot (that would hide the earlier breaks). The prompt is added to the task text and the task scope instead, and the next `after` still compares against the original "before". The same happens when a turn was interrupted before `after` could run.
- **When Claude finishes** (`Stop`), holdline runs `after`. If something outside the task, or something broken by the task's changes, went from working to broken, it sends Claude a short summary (what broke, where, why) and Claude carries on to fix it before handing back. Regressions inside the task area and plain changes never start a fix round. Afterwards you see one line: "nothing broken outside the task", "the regressions it found are fixed (1 automatic fix round)", or the problems still left.

## Fix-round limit

At most **2 automatic fix rounds** per prompt. After that, or as soon as a round changed nothing (Claude Code's `stop_hook_active` flag tells holdline it is already continuing because of a stop hook), holdline stops asking and shows you the report path and the rollback command instead. holdline never tells Claude to roll back: undoing the task is your decision.

## What Claude is sent

The summary is built from the JSON report. holdline's own wording (what broke, file and line, the round number) comes first. Everything taken from the project (check output, console errors, titles) follows in one marked block that says it is tool output to treat as data, not instructions. Each item there is cut to 200 characters, and ANSI codes, control characters, role markers and lines that look like instructions are removed. Project text could otherwise be used to steer Claude.

## Fail open

A hook never blocks or holds up the session when something goes wrong. In each of these cases the hook exits successfully with at most one line for you:

- holdline is not configured;
- the lock is held (for example you are running `holdline after` yourself);
- a check takes longer than the budget (the checks are stopped);
- holdline crashes, or the hook input can't be read.

That turn is then simply not checked. Each hook's Claude Code `timeout` is set above holdline's own budget (`hooks.promptBudgetSec`, `hooks.stopBudgetSec`, 540 s by default; change them in `.holdline/config.json` and run `install-hooks` again). `HOLDLINE_HOOKS=off` turns the hooks off for one shell. What each hook did, and how long it took, is logged in `.holdline/hooks/log.jsonl`.

## Several Claude sessions in one project

One session is tracked at a time. While a session's turn is being tracked, prompts and stops from another session leave it alone: no snapshot, no change to the task, no `after`. Instead they show "holdline: already tracking another Claude session in this project". The turn can be taken over when its session ends (`SessionEnd`), or when it has not been touched for `hooks.staleTurnHours` (2 by default).

## Next.js and agent detection

Next.js 16.4+ stops `next dev` when it detects an AI agent (`CLAUDECODE`, `CURSOR_AGENT`, `CODEX_*`, …) and the project sets `experimental.agentUpgrade`. It shows an upgrade recommendation instead of starting. Run from a hook, holdline is inside the agent's environment, so the visual and live API checks are reported as **skipped**, with that reason. holdline doesn't hide the agent variables or retry around this. To run those checks, either:

- upgrade Next.js;
- remove `experimental.agentUpgrade` from next.config;
- run `holdline before`/`after` from a terminal outside the agent.

`holdline doctor` warns about this setting.

## Other agents (Cursor, Codex, Aider, …)

holdline works the same way by hand around any agent:

```sh
npx holdline before --task "add pagination to the users page" --reuse-baseline
# … let the agent work …
npx holdline after --json | jq -r '.findings[] | select(.kind == "regression" and (.scope == "outside-scope" or .scope == "broken-by-task")) | "\(.title) (\(.files | join(", "))): \(.reason)"'
```

Feed those lines back to the agent, run `holdline after` again, and use `holdline rollback` if you want to undo the whole task. The exit code of `after` is 1 when anything regressed, so it also works in scripts and CI. If the agent has its own hook system, call `holdline before --yes --task "…"` when a task starts and `holdline after --json` when it ends.
