# `holdline after --json`: report schema, version 2

`holdline after --json` prints one JSON document on stdout. Everything else (progress, the human report) goes to stderr. The same document is saved to `.holdline/last-report.json`, `.holdline/runs/<timestamp>-after/report.json` and `.holdline/reports/<timestamp>.json` (next to the HTML report).

The machine-readable JSON Schema is [`schema/after-report.v2.json`](../schema/after-report.v2.json) (draft 2020-12). The previous version stays in [`schema/after-report.v1.json`](../schema/after-report.v1.json).

**Changes from version 1.** Regressions in direct dependents of the task's changes (the callers of a helper whose option the task renamed, a route that reads a column a task migration dropped) used to be filed under `expected-ripple`. They now have their own scope, `broken-by-task`, and their own count. `expected-ripple` only holds changes that didn't break anything. `findings` are ranked outside scope, broken by the task, expected ripple, in scope.

**Versioning.** `schema` is always `"holdline.after-report"`. `schemaVersion` is bumped only for breaking changes: a field removed, renamed or changed in meaning or type. New optional fields may appear within a version, so ignore fields you don't know.

## Top level

| Field | Type | Meaning |
| --- | --- | --- |
| `schema` | `"holdline.after-report"` | Identifies the document. |
| `schemaVersion` | `2` | Version of this format. |
| `task` | string | The task given to `holdline before --task`. |
| `createdAt` | ISO time | When `after` ran. |
| `sessionCreatedAt` | ISO time | When `before` ran. |
| `snapshots` | `{ before, after }` | Snapshot commit SHAs. |
| `headMoved` | `null` or `{ from, to }` | HEAD moved during the task (the agent committed or switched branches). |
| `scope` | object | The task's scope (see below). |
| `regressed` | boolean | Some finding is a regression, in any scope. |
| `exitCode` | `0` or `1` | The process exit code: `1` when `regressed`. |
| `counts` | object | Findings per scope (`outside-scope`, `broken-by-task`, `expected-ripple`, `in-scope`), `regressions`, and `footer` (fixed, already failing, notes). |
| `summary` | string[1–3] | The plain-English summary. |
| `rollbackCommand` | `"holdline rollback"` | The exact command that undoes every change since `before`. |
| `htmlReport` | string or null | Path of the HTML report, relative to the project root. |
| `findings` | Finding[] | Ranked: outside scope, then broken by the task, then expected ripple, then in scope (each by severity), then footer items. |
| `probes` | `{ id, title, status, summary }[]` | One line per probe; `status` is `ok`, `changed`, `regressed` or `skipped`. |
| `ownOutputs` | object | Files written by holdline's own checks in `before`. `excluded` were not counted as agent changes. `agentEdited` were also changed by the agent and were counted. `gitignoreSuggestion` lists the lines to add to `.gitignore`. |

### `scope`

| Field | Meaning |
| --- | --- |
| `terms` | `{ text, kind, files, routes, tables }[]`: words, phrases, names, paths and routes from the task that matched the project. `kind` is `path`, `route`, `name`, `phrase` or `word`. `files` is a count. |
| `dropped` | `{ text, why }[]`: terms ignored because they match too much of the project. |
| `unmatched` | Terms that matched nothing. |
| `globs`, `globsGiven` | The `--scope` globs, with the number of files each matched. |
| `fallback` | `true` when nothing in the task matched and there were no globs. The agent's edits were then taken as the task area. |
| `files`, `routes`, `tables` | Everything in the task area. |
| `edited` | `{ inScope, ripple, outside }`: how many files the agent changed in each group. |

## Finding

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Stable within a report (`<probe>-<hash>`). |
| `probe` | string | `checks`, `files`, `dependencies`, `database`, `api`, `visual` (or a custom probe id). |
| `kind` | `regression` \| `change` \| `fixed` \| `still-failing` \| `info` | A regression made the exit code 1. |
| `severity` | `critical` \| `high` \| `medium` \| `low` \| `info` | `critical`: a check that went from passing to failing, or a broken import. `high`: a database or API break. `medium`: a visual problem. `low`: any change. `info`: fixed, already failing and notes. |
| `scope` | `outside-scope` \| `broken-by-task` \| `expected-ripple` \| `in-scope` | `broken-by-task`: a regression in a direct dependent of a file, route or table the agent changed for the task. `expected-ripple`: such a dependent changed but didn't break. See [task-scope.md](task-scope.md#how-scope-is-decided). |
| `reason` | string | One line explaining the scope, e.g. `app/billing/page.tsx was edited by the agent, but the task doesn't name it …`. |
| `title` | string | What happened. |
| `detail` | string? | Check output (the command, the end of its output and the log path). |
| `files` | string[] | Files the finding is about (repo-relative, `/` separators). |
| `lines` | `{ file, line, text? }[]` | Source locations: errors in check output, lines that still read a removed field or column, callers of a changed route, the line of a broken import. |
| `notes` | string[] | The extra lines shown under the finding in the terminal. |
| `pages`, `routes`, `tables`, `viewports` | string[]? | What else the finding is about. |
| `affects` | string[]? | Files that consume the subject: callers of a route, direct users of a table, dependents of a changed file. |
| `images` | `{ before?, after?, diff? }`? | Screenshot paths (repo-relative) for a visual difference. |

## Example

```json
{
  "schema": "holdline.after-report",
  "schemaVersion": 2,
  "task": "add pagination to the users list",
  "regressed": true,
  "exitCode": 1,
  "summary": ["The agent broke 1 thing outside the task: the build.", "Edited: 1 file in the task area, 1 outside it."],
  "rollbackCommand": "holdline rollback",
  "findings": [
    {
      "id": "checks-3f2a91c0de",
      "probe": "checks",
      "kind": "regression",
      "severity": "critical",
      "scope": "outside-scope",
      "reason": "the error is in app/billing/page.tsx, which was edited by the agent, but the task doesn't name it and it isn't next to or imported by a file the task covers",
      "title": "build: passed before, fails now",
      "files": ["app/billing/page.tsx"],
      "lines": [{ "file": "app/billing/page.tsx", "line": 7 }],
      "notes": []
    }
  ]
}
```

(This example is abbreviated. A real document has every required field.)
