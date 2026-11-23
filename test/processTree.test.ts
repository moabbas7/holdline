import { describe, expect, it } from 'vitest';
import { treePids } from '../src/core/processTree.js';

describe('treePids (taskkill /T output)', () => {
  it('collects every pid in the tree and leaves out holdline itself', () => {
    const out = [
      'SUCCESS: The process with PID 4120 (child process of PID 3312) has been terminated.',
      'SUCCESS: The process with PID 3312 (child process of PID 1000) has been terminated.',
      '',
    ].join('\r\n');
    expect(treePids(out, 1000).sort()).toEqual([3312, 4120]);
  });

  it('does not depend on the wording (taskkill output is localized)', () => {
    expect(treePids('ERFOLGREICH: Der Prozess mit PID 77 (untergeordneter Prozess von PID 5) wurde beendet.\r\n', 5)).toEqual([77]);
    expect(treePids('', 5)).toEqual([]);
  });
});
