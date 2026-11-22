#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Command, InvalidArgumentError } from 'commander';
import { afterCommand } from './commands/after.js';
import { beforeCommand } from './commands/before.js';
import { initCommand } from './commands/init.js';
import { pruneCommand } from './commands/prune.js';
import { rollbackCommand } from './commands/rollback.js';
import { undoRollbackCommand } from './commands/undoRollback.js';
import { unlockCommand } from './commands/unlock.js';
import { HoldlineError } from './core/errors.js';
import { GitError } from './core/git.js';
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
      process.exitCode = 1;
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
  .version(pkg.version);

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
  .action((o: { task: string; force?: boolean; yes?: boolean }) =>
    run(async () => void (await beforeCommand(process.cwd(), o, createCliIo()))),
  );

program
  .command('after')
  .description('re-run checks; report what went from passing to failing and which files changed (exit 1 on regressions)')
  .option('--json', 'print the report as JSON on stdout')
  .action((o: { json?: boolean }) =>
    run(async () => {
      const report = await afterCommand(process.cwd(), o, createCliIo({ json: o.json }));
      if (o.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      return report.regressed ? 1 : 0;
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
  .command('unlock')
  .description('remove a leftover lock file (only needed if holdline was killed on another machine)')
  .option('-y, --yes', 'do not ask for confirmation')
  .action((o: { yes?: boolean }) => run(async () => void (await unlockCommand(process.cwd(), o, createCliIo()))));

await program.parseAsync(process.argv);
