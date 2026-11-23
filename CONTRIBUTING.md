# Contributing

Thanks for helping. Bug reports and small, focused pull requests are the most useful.

## Setup and tests

You need Node 22.13 or later and git.

```sh
npm install
npm run build
npm run typecheck
npx playwright install chromium   # once, for the visual tests (they are skipped with a message without it)
npm test
```

The tests create throwaway git repos in the OS temp directory. The database tests use embedded Postgres (PGlite) and SQLite, so no Docker is needed. CI runs the same steps on Linux, macOS and Windows with Node 22.13, 22 and 24.

To try a change by hand, run `node dist/cli.js <command>` inside a copy of one of the projects in `test/fixtures/`. `scripts/record-demo.mjs` re-records the README demo the same way.

## Commit messages

Commit messages and pull request descriptions must not contain AI attribution lines (`Co-Authored-By:` lines naming an AI assistant, `Claude-Session:` lines, or "Generated with …" footers). CI checks every commit and fails the build if it finds one.

The repo ships two git hooks in `.githooks/` that enforce the same rule locally. To use them, run this once in your clone:

```sh
git config core.hooksPath .githooks
```

- `commit-msg` removes attribution lines from the message as you commit.
- `pre-push` blocks a push if one of the commits being pushed still has one.

Please don't bypass them with `--no-verify`, and don't edit the files in `.githooks/` in a pull request.

## Pull requests

- Keep each pull request to one change, with tests for new behaviour.
- `npm run typecheck` and `npm test` should pass.
- If you change what users see (a command, an option, a config key, the report), update the README or the page in `docs/` that describes it.
