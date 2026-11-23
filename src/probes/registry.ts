import type { Config } from '../core/config.js';
import { checksProbe } from './checks.js';
import { databaseProbe } from './database/index.js';
import { dependenciesProbe } from './dependencies/index.js';
import { filesProbe } from './files.js';
import type { Probe } from './types.js';

/**
 * Built-in probes, in report order. Later phases (dependency map, DB schema,
 * API shapes, screenshots) add a module and one entry here; the core is unchanged.
 */
export const builtinProbes: Probe<any>[] = [checksProbe, filesProbe, dependenciesProbe, databaseProbe];

export function enabledProbes(config: Config, probes: Probe<any>[] = builtinProbes): Probe<any>[] {
  return probes.filter((p) => config.probes?.[p.id]?.enabled !== false && p.enabled(config));
}
