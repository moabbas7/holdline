# Configuration

`holdline init` writes `.holdline/config.json`. Every key below is optional unless marked otherwise; a missing key takes the default shown. `.holdline/` is git-ignored, so the config is per checkout. Run `holdline doctor` after editing it.

A config written by `holdline init` looks like this:

```json
{
  "version": 1,
  "projectType": "nextjs",
  "packageManager": "npm",
  "largeUntrackedWarnMB": 100,
  "checks": {
    "build": { "command": "npm run build", "timeoutSec": 600 },
    "typecheck": { "command": "npm run typecheck", "timeoutSec": 300 },
    "lint": null,
    "test": null
  },
  "probes": {
    "dependencies": { "enabled": true },
    "database": { "enabled": true },
    "api": { "enabled": true },
    "visual": { "enabled": false, "pages": ["/", "/billing", "/settings", "/users"] }
  }
}
```

## Top level

| Key | Default | Meaning |
| --- | --- | --- |
| `version` | `1` | Config format version. |
| `projectType` | detected | `nextjs`, `vite-react`, `node` or `unknown`. |
| `packageManager` | detected | `npm`, `pnpm`, `yarn` or `bun`. Used for the default dev-server command (`<pm> run dev`). |
| `largeUntrackedWarnMB` | `100` | Warn before snapshotting when untracked, non-ignored files add up to more than this. |
| `checks` | required | The `build`, `typecheck`, `lint` and `test` commands. Each is `null` (off), a command string, or `{ "command": "…", "timeoutSec": n }`. Default timeouts: build 600 s, typecheck 300 s, lint 300 s, test 900 s. |
| `probes` | | Per-probe settings, below. `{ "enabled": false }` turns any probe off. |
| `hooks` | | Claude Code hook settings, below. |

## `hooks`

Run `holdline install-hooks` again after changing these, so Claude Code's hook timeouts match.

| Key | Default | Meaning |
| --- | --- | --- |
| `promptBudgetSec` | `180` | Longest the prompt hook may spend running the "before" checks. |
| `stopBudgetSec` | `540` | Longest the stop hook may spend running `after`. |
| `staleTurnHours` | `2` | A tracked turn untouched for this long can be taken over by another Claude session. |

See [claude-code.md](claude-code.md).

## `probes.dependencies`

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Build the dependency graph. |

## `probes.database`

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Capture the database schema. |
| `envVar` | | Read the connection string from this variable first, before `DATABASE_URL`, `POSTGRES_URL` and `DIRECT_URL`. |
| `allowHosts` | `[]` | Non-local database hosts holdline may connect to. By default only local hosts are contacted. |
| `schemas` | all user schemas | Postgres schemas to read. Supabase's own schemas (`auth`, `storage`, `realtime`, …) are skipped by default. |
| `connect` | `true` | `false` uses schema files only and never connects. |
| `statementTimeoutMs` | `5000` | Statement and lock timeout for each read-only query. |
| `connectTimeoutMs` | `3000` | Connection timeout. |

```json
"probes": {
  "database": {
    "envVar": "SUPABASE_DB_URL",
    "allowHosts": ["db.staging.internal"],
    "schemas": ["public", "billing"]
  }
}
```

See [probes.md](probes.md#database-schema) for the safety rules.

## `probes.api`

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Record API routes and their shapes. |
| `timeoutSec` | `60` | Cap on static analysis time. Routes not reached in time are unknown. |
| `live` | off | Live mode, below. |

### `probes.api.live`

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Start the dev server and call the listed requests. |
| `command` | `<pm> run dev` | How to start the dev server. `{port}` is replaced with the port; `PORT` is also set. |
| `requests` | `[]` | `{ "method"?, "path", "body"? }`. Only these are sent; methods other than GET/HEAD need a sample `body`. |
| `headers` | | Headers sent with every request (for example `Authorization`). Never stored or printed. |
| `startupTimeoutSec` | `90` | How long to wait for the dev server to accept connections. |
| `requestTimeoutSec` | `60` | Timeout for each request. |
| `allowNonLocalDatabase` | `false` | Start the dev server even when its database URL points at a non-local host. |

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
      "headers": { "Authorization": "Bearer <dev token>" }
    }
  }
}
```

## `probes.visual`

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Load pages in headless Chromium. Needs Playwright in the project. |
| `pages` | `[]` | Paths (`"/pricing"`), templates (`"/users/[id]"`, `"/users/:id"`) or `{ "path", "mask" }`. `holdline init` suggests them. |
| `params` | `{}` | Values for dynamic segments, e.g. `{ "locale": "en", "id": "1" }`. |
| `mask` | `[]` | CSS selectors painted over in every screenshot (clocks, ads, avatars). |
| `storageState` | | A Playwright storage-state file for pages behind login. Must be outside the project or git-ignored. |
| `viewports` | desktop 1280×800, mobile 390×844 | `{ "desktop": { "width", "height" }, "mobile": { … } }`. |
| `command` | `probes.api.live.command`, then `<pm> run dev` | How to start the dev server. |
| `startupTimeoutSec` | `probes.api.live.startupTimeoutSec`, then `90` | How long to wait for the dev server. |
| `pageTimeoutSec` | `60` | Timeout for loading one page. |
| `networkIdleTimeoutSec` | `5` | Longest wait for the network to go quiet before a screenshot. |
| `threshold` | `0.0002` | Share of pixels that must differ for a visual difference (0.02%). |
| `minPixels` | `25` | Minimum number of differing pixels for a visual difference. |
| `failOnUnexpectedChange` | `false` | Treat a visual difference on a page outside the task as a regression. |
| `allowNonLocalDatabase` | `false` | Start the dev server even when its database URL points at a non-local host. |

```json
"probes": {
  "visual": {
    "enabled": true,
    "pages": ["/", "/pricing", { "path": "/dashboard", "mask": [".avatar"] }],
    "mask": ["[data-testid=timestamp]"],
    "params": { "locale": "en", "id": "1" }
  }
}
```

See [probes.md](probes.md#visual-check).

## Environment variables

| Variable | Effect |
| --- | --- |
| `HOLDLINE_HOOKS=off` | Turns the Claude Code hooks off for one shell. |
| `NO_COLOR` | Plain output without colours. |
