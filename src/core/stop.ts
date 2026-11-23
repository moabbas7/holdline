/**
 * A gate on starting processes. When a hook runs out of time, holdline kills what it started
 * and closes this gate, so the work it abandons can't start anything new (a check, a dev
 * server, git, a browser) while it winds down. Each hook run opens it again.
 */
import { HoldlineError } from './errors.js';

let stopped = false;

export function stopStarting(): void {
  stopped = true;
}

export function allowStarting(): void {
  stopped = false;
}

export const startingStopped = (): boolean => stopped;

/** Thrown instead of starting a process after the gate closed. */
export class StoppedError extends HoldlineError {
  constructor(what: string) {
    super(`not starting ${what}: holdline ran out of time and is stopping`);
    this.name = 'StoppedError';
  }
}

export function assertStarting(what: string): void {
  if (stopped) throw new StoppedError(what);
}
