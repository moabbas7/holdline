#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Command, CommanderError, InvalidArgumentError } from 'commander';
import { afterCommand } from './commands/after.js';
import { apiCommand } from './commands/api.js';
import { beforeCommand } from './commands/before.js';
import { dbCommand } from './commands/db.js';
import { doctorCommand } from './commands/doctor.js';
import { graphCommand } from './commands/graph.js';
import { installHooksCommand, uninstallHooksCommand } from './commands/hooks.js';
import { initCommand } from './commands/init.js';
import { pruneCommand } from './commands/prune.js';
import { reportCommand } from './commands/report.js';
import { rollbackCommand } from './commands/rollback.js';
import { undoRollbackCommand } from './commands/undoRollback.js';
import { unlockCommand } from './commands/unlock.js';
import { visualCommand } from './commands/visual.js';
import { HoldlineError } from './core/errors.js';
import { GitError } from './core/git.js';
import { hookCli } from './hooks/run.js';
import { createCliIo } from './io.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

async function run(action: () => Promise<number | void>): Promise<void> {
  try {
    const code = await action();
    if (typeof code === 'number') process.exitCode = code;
  } catch (e) {
    const err = e as Error;
    if (err.name === 'ExitPromptError') {
      // Ctrl+C at a prompt.
      process.stderr.write('Cancelled. Nothing was changed.\n');
      process.exitCode = 130;
    } else if (e instanceof HoldlineError) {
      process.stderr.write(`holdline: ${err.message}\n`);
      process.exitCode = e.exitCode;
    } else if (e instanceof GitError) {
      process.stderr.write(`holdline: ${err.message}\n`);
      process.exitCode = 2;
    } else {
      process.stderr.write(`holdline: unexpected error: ${err.stack ?? err.message}\n`);
      // Not 1: that means "regressions found".
      process.exitCode = 3;
    }
  }
}

const parseCount = (v: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new InvalidArgumentError('must be a whole number ≥ 0');
  return n;
};

const program = new Command()
  .name('holdline')
  .description('Catch what AI coding agents break outside the task they were given. Local only.')
  .version(pkg.version)
  // Usage errors exit 2, not commander's default 1 (which means "regressions found").
  .exitOverride();

program
  .command('init')
  .description('detect the project and write .holdline/config.json')
  .option('-y, --yes', 'accept detected settings without prompting (overwrites existing config)')
  .action((o: { yes?: boolean }) => run(async () => void (await initCommand(process.cwd(), o, createCliIo()))));

program
  .command('before')
  .description('snapshot the working tree and record check results before an agent starts')
  .requiredOption('-t, --task <description>', 'what the agent is about to do')
  .option('-f, --force', 'replace an existing session without asking')
  .option('-y, --yes', 'non-interactive: replace an existing session, continue past warnings')
  .option('-s, --scope <glob>', 'files that are part of the task (repeatable), e.g. --scope "app/users/**"', (v: string, prev: string[]) => [...prev, v], [] as string[])
  .option('--reuse-baseline', 'reuse the results of the last `after` when the working tree is exactly what it checked')
  .action((o: { task: string; force?: boolean; yes?: boolean; scope: string[]; reuseBaseline?: boolean }) =>
    run(async () => void (await beforeCommand(process.cwd(), o, createCliIo()))),
  );

program
  .command('after')
  .description('re-run checks and report what changed, grouped by the task\'s scope: outside the task first (exit 1 on regressions)')
  .option('--json', 'print the report as JSON on stdout (schema: docs/report-schema.md)')
  .option('-a, --all', 'also list the changes inside the task area (collapsed to a count by default) and notes')
  .action((o: { json?: boolean; all?: boolean }) =>
    run(async () => {
      const report = await afterCommand(process.cwd(), o, createCliIo({ json: o.json }));
      if (o.json) process.stdout.write(JSON.stringify(report.scoped, null, 2) + '\n');
      return report.scoped.exitCode;
    }),
  );

program
  .command('report [which]')
  .description('open the latest HTML report from `holdline after` (or report number [which] from --list)')
  .option('-l, --list', 'list reports, newest first')
  .option('--no-open', 'print the path without opening a browser')
  .action((which: string | undefined, o: { list?: boolean; open: boolean }) =>
    run(async () => void (await reportCommand(process.cwd(), { ...(which ? { which } : {}), list: o.list, noOpen: !o.open }, createCliIo()))),
  );

program
  .command('graph <target>')
  .description('show what a file depends on and what depends on it (also route:/api/x or table:name)')
  .option('--json', 'print the result as JSON on stdout')
  .action((target: string, o: { json?: boolean }) =>
    run(async () => {
      const result = await graphCommand(process.cwd(), target, o, createCliIo({ json: o.json }));
      if (o.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    }),
  );

program
  .command('db')
  .description('show the database schema (live local database, read-only, or schema files) and where it came from')
  .option('--json', 'print the schema as JSON on stdout')
  .action((o: { json?: boolean }) =>
    run(async () => {
      const result = await dbCommand(process.cwd(), o, createCliIo({ json: o.json }));
      if (o.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    }),
  );

program
  .command('api [route]')
  .description('show every API route with its methods, status codes and JSON shapes (static analysis; live if configured)')
  .option('--json', 'print the result as JSON on stdout')
  .action((route: string | undefined, o: { json?: boolean }) =>
    run(async () => {
      const result = await apiCommand(process.cwd(), { ...o, ...(route ? { route } : {}) }, createCliIo({ json: o.json }));
      if (o.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    }),
  );

program
  .command('visual [pages...]')
  .description('load pages in headless Chromium (desktop + mobile): screenshots, console errors, failed requests, blank/error screens')
  .option('--json', 'print the result as JSON on stdout')
  .action((pages: string[], o: { json?: boolean }) =>
    run(async () => {
      const result = await visualCommand(process.cwd(), { ...o, pages }, createCliIo({ json: o.json }));
      if (o.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    }),
  );

program
  .command('rollback')
  .description('restore the working tree to the "before" snapshot (the current state is saved first)')
  .option('-y, --yes', 'do not ask for confirmation')
  .action((o: { yes?: boolean }) => run(async () => void (await rollbackCommand(process.cwd(), o, createCliIo()))));

program
  .command('undo-rollback')
  .description('restore the state saved by the last rollback')
  .option('-y, --yes', 'do not ask for confirmation')
  .action((o: { yes?: boolean }) =>
    run(async () => void (await undoRollbackCommand(process.cwd(), o, createCliIo()))),
  );

program
  .command('prune')
  .description('delete old snapshot history refs (snapshots still in use are always kept)')
  .option('-k, --keep <n>', 'how many recent snapshots to keep', parseCount, 20)
  .option('--dry-run', 'only show what would be deleted')
  .action((o: { keep: number; dryRun?: boolean }) =>
    run(async () => void (await pruneCommand(process.cwd(), o, createCliIo()))),
  );

program
  .command('install-hooks')
  .description('run holdline automatically around Claude Code tasks (adds hooks to .claude/settings.local.json)')
  .option('--shared', 'install in .claude/settings.json for the whole team instead')
  .option('--command <command>', 'how the hooks should call holdline (default: detected)')
  .action((o: { shared?: boolean; command?: string }) => run(async () => void (await installHooksCommand(process.cwd(), o, createCliIo()))));

program
  .command('uninstall-hooks')
  .description("remove holdline's Claude Code hooks (only holdline's; other settings stay)")
  .option('--shared', 'remove them from .claude/settings.json instead')
  .action((o: { shared?: boolean }) => run(async () => void (await uninstallHooksCommand(process.cwd(), o, createCliIo()))));

program
  .command('doctor')
  .description('check the config, Claude Code hooks, git state, Playwright, database safety and the lock, and say what to fix')
  .action(() => run(async () => (await doctorCommand(process.cwd(), {}, createCliIo())).exitCode));

// Called by the Claude Code hooks (always exits 0: holdline never blocks a session).
program
  .command('hook <event>', { hidden: true })
  .option('--root <dir>')
  .option('--session <id>')
  .action((event: string, o: { root?: string; session?: string }) => hookCli(event, o));

program
  .command('unlock')
  .description('remove a leftover lock file (only needed if holdline was killed on another machine)')
  .option('-y, --yes', 'do not ask for confirmation')
  .action((o: { yes?: boolean }) => run(async () => void (await unlockCommand(process.cwd(), o, createCliIo()))));

try {
  await program.parseAsync(process.argv);
} catch (e) {
  if (e instanceof CommanderError) {
    // Help and --version exit 0; commander has already printed any usage error.
    process.exitCode = e.exitCode === 0 ? 0 : 2;
  } else throw e;
}
