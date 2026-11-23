# Task scope and the report

`holdline after` sorts every finding by how it relates to the task, and says why in one line (`why: …`).

## The groups

- **Outside the task**: things the task wasn't about. These come first, ranked: confirmed regressions (checks that went from passing to failing, broken imports), then database and API breaks, then visual problems, then changes.
- **Broken by the task's changes**: regressions in direct dependents of what the task changed. For example, the task renamed an option of `timeAgo` and 7 callers still pass the old one, or a task migration dropped a column a route still reads. These are shown right after "Outside the task": the change may be intended, but the code that uses it is now broken.
- **Expected ripple**: direct dependents of files changed for the task that changed without breaking. For example, the files that import a shared helper the agent changed, the callers of an API route whose handler changed, or the code that uses a table a task migration altered. Re-exports are followed by name: when `timeAgo` in `packages/utils/src/functions/time-ago.ts` changes, the files that import `timeAgo` from `@acme/utils` (through its `index.ts` barrels) are ripple, and the files that import other helpers from the same package are not. Pages and layouts that render one of those files are ripple too.
- **In the task area**: collapsed to a count (`holdline after --all` lists them). A regression inside the task area is always shown.

The terminal report ends with a summary of one to three lines and the exact rollback command.

## How scope is decided

Scope is decided deterministically and locally. No AI or network calls are made.

1. **The task text** is matched against the project when `before` runs:
   - paths (`lib/db.ts`, `app/users/`);
   - routes (`/users`, `/api/users/:id`), matched to API route handlers and Next.js pages;
   - component and identifier names (`UserCard`, `formatDate`), matched to file names;
   - table names;
   - plain words and phrases, matched to file and folder names (`link card` matches `link-card.tsx`).

   Plurals are folded, and grammar words and generic words like "page" or "button" are ignored on their own. A word that matches more than 2% of the project's files (at least 12) is too generic to say where the task is and is ignored. `before` prints what matched (`Task scope: "users" → 4 files`).
2. **`--scope "<glob>"`** (repeatable on `before`) adds files explicitly. A plain folder (`--scope lib`) covers everything under it.
3. **The files the agent edited** join the task area when they match the task's terms, sit next to a task file in a small folder (10 source files or fewer), import or are imported by a task file, or are new helpers imported by such a file. An edit to an unrelated component in a large shared folder like `components/` stays **outside**. An edited file that joined only because it imports a task file is a user of the task's code: if it breaks, the regression is **broken by the task's changes**, not "in the task area". When nothing in the task text matches and there are no globs, the agent's edits are taken as the task area.

## Where a finding goes

A finding is placed by what it is about: files, pages (through the Next.js page file and its layouts), API routes (through their handler) or tables. A regression is placed as far out as the code it breaks. For example, a dropped column of a task table that a file outside the task still reads is outside scope, and one that only a direct user of the table still reads is broken by the task's changes. A failing check is placed by the files its output names; when the output names no project file, it is shown outside scope so it is never hidden.

**Visual differences** on a page outside the task are reported as an **unexpected visual change**. They are still a change, not a regression, unless you set `"probes": { "visual": { "failOnUnexpectedChange": true } }`.

## The HTML report

Every `after` writes an HTML report to `.holdline/reports/<timestamp>.html`. It is a single file with no scripts and no external resources, and screenshots and diffs are embedded, so it works offline and can be attached anywhere. `holdline report` opens the latest one, `holdline report --list` lists older ones and `holdline report <n>` opens one of them (`--no-open` only prints the path).

For scripts and other tools, `holdline after --json` prints the same findings as JSON: see [report-schema.md](report-schema.md).
