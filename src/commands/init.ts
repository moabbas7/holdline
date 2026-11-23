import { CHECK_NAMES, DEFAULT_TIMEOUTS, saveConfig, type Config } from '../core/config.js';
import { detectProject, PROJECT_TYPE_LABELS } from '../core/detect.js';
import { CancelledError, HoldlineError } from '../core/errors.js';
import { ensureGitignore, readJson } from '../core/store.js';
import type { Io } from '../io.js';
import { locked } from './common.js';

export interface InitOptions {
  yes?: boolean;
}

function showConfig(config: Config, io: Io): void {
  io.log(`  Project type:     ${io.c.bold(PROJECT_TYPE_LABELS[config.projectType])}`);
  io.log(`  Package manager:  ${io.c.bold(config.packageManager)}`);
  for (const name of CHECK_NAMES) {
    const c = config.checks[name];
    io.log(`  ${(name + ':').padEnd(17)} ${c ? io.c.cyan(c.command) : io.c.dim('(disabled)')}`);
  }
  const deps = config.probes?.dependencies?.enabled !== false;
  io.log(`  Dependency map:   ${deps ? io.c.bold('enabled') : io.c.dim('(disabled)')}`);
  const db = config.probes?.database?.enabled !== false;
  io.log(`  Database schema:  ${db ? io.c.bold('enabled') : io.c.dim('(disabled)')}`);
}

export async function initCommand(cwd: string, opts: InitOptions, io: Io): Promise<Config> {
  return locked(cwd, 'init', io, async ({ root, paths }) => {
    if ((await readJson(paths.config)) !== null && !opts.yes) {
      if (!io.interactive) {
        throw new HoldlineError(`${paths.config} already exists. Pass --yes to overwrite it.`);
      }
      if (!(await io.confirm('.holdline/config.json already exists. Overwrite it?', false))) {
        throw new CancelledError('Kept the existing config.');
      }
    }

    const { config, notes } = await detectProject(root);
    io.log('Detected:');
    showConfig(config, io);
    for (const n of notes) io.log(io.c.dim(`  · ${n}`));
    io.log();

    if (!opts.yes) {
      if (!io.interactive) {
        throw new HoldlineError('Not running in a terminal; pass --yes to accept the detected settings.');
      }
      if (!(await io.confirm('Use these commands?', true))) {
        io.log(io.c.dim('Edit each command. Clear the line to disable that check.'));
        for (const name of CHECK_NAMES) {
          const answer = (await io.input(`${name} command:`, config.checks[name]?.command ?? '')).trim();
          config.checks[name] = answer
            ? { command: answer, timeoutSec: config.checks[name]?.timeoutSec ?? DEFAULT_TIMEOUTS[name] }
            : null;
        }
        io.log();
        showConfig(config, io);
      }
    }

    await saveConfig(root, config);
    const added = await ensureGitignore(root);
    io.log(io.c.green(`Wrote ${paths.config}`));
    if (added) io.log('Added .holdline/ to .gitignore');
    io.log(`Next: ${io.c.bold('holdline before --task "<what the agent is about to do>"')}`);
    return config;
  });
}
