import { describe, expect, it } from 'vitest';
import { planOrder } from '../src/review-links.ts';

describe('the order of a plan link\'s posts (#902)', () => {
  it('goes by the time each post goes out, posts without one last, ties as given', () => {
    const at = (iso: string) => new Date(iso);
    expect(
      planOrder([
        { id: 'untimed-1', at: null },
        { id: 'late', at: at('2026-11-20T09:00:00Z') },
        { id: 'early', at: at('2026-11-02T09:00:00Z') },
        { id: 'untimed-2', at: null },
        { id: 'tie-b', at: at('2026-11-10T09:00:00Z') },
        { id: 'tie-a', at: at('2026-11-10T09:00:00Z') },
      ]),
    ).toEqual(['early', 'tie-b', 'tie-a', 'late', 'untimed-1', 'untimed-2']);
    expect(planOrder([])).toEqual([]);
  });
});
