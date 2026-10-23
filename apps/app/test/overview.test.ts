// The org overview's waiting list (issue #1249): what it lists, in which order, and when it may say nothing waits.
import { describe, expect, it } from 'vitest';
import { allCounted, waitingItems } from '../src/lib/overview.ts';

describe('org overview', () => {
  it('lists what waits, the books first, and leaves out counts of 0', () => {
    expect(waitingItems({ tasks: 2, bankLines: 0, proposals: 3, failedFiles: 1, notifications: 0 })).toEqual([
      { key: 'proposals', count: 3 },
      { key: 'failedFiles', count: 1 },
      { key: 'tasks', count: 2 },
    ]);
    expect(waitingItems({})).toEqual([]);
  });

  it('says nothing waits only once every asked figure is read', () => {
    expect(allCounted({ proposals: 0, failedFiles: 0 }, ['proposals', 'failedFiles'])).toBe(true);
    expect(allCounted({ proposals: 0 }, ['proposals', 'failedFiles'])).toBe(false);
    // A figure the deployment does not run (no finance: no bank lines) is not asked for.
    expect(allCounted({ proposals: 0, tasks: 0 }, ['proposals', 'tasks'])).toBe(true);
  });
});
