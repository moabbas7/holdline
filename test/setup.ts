import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate every git call made by tests (including holdline's own) from the user's
// global and system git config, without modifying either.
const dir = mkdtempSync(path.join(os.tmpdir(), 'holdline-gitcfg-'));
const cfg = path.join(dir, 'gitconfig');
// On Windows, git only round-trips symlinks with core.symlinks (GitHub's runners may create them).
const windows = process.platform === 'win32' ? '[core]\n\tsymlinks = true\n' : '';
writeFileSync(cfg, `[init]\n\tdefaultBranch = main\n[advice]\n\taddEmbeddedRepo = false\n${windows}`);
process.env.GIT_CONFIG_GLOBAL = cfg;
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_AUTHOR_NAME = 'Test';
process.env.GIT_AUTHOR_EMAIL = 'test@example.invalid';
process.env.GIT_COMMITTER_NAME = 'Test';
process.env.GIT_COMMITTER_EMAIL = 'test@example.invalid';
delete process.env.GIT_DIR;
delete process.env.GIT_WORK_TREE;
delete process.env.GIT_INDEX_FILE;
