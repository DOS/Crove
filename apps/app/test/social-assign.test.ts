import { describe, expect, it } from 'vitest';
import { fromLocalInput, isOverdue, toLocalInput } from '../src/lib/social-assign.ts';

describe('a post due date (#640)', () => {
  it('is overdue only past its date and before it went out', () => {
    const now = Date.parse('2026-10-20T10:00:00Z');
    expect(isOverdue({ dueAt: '2026-10-20T09:00:00Z', status: 'draft' }, now)).toBe(true);
    expect(isOverdue({ dueAt: '2026-10-20T11:00:00Z', status: 'draft' }, now)).toBe(false);
    expect(isOverdue({ dueAt: '2026-10-20T09:00:00Z', status: 'published' }, now)).toBe(false);
    expect(isOverdue({ dueAt: '2026-10-20T09:00:00Z', status: 'cancelled' }, now)).toBe(false);
    expect(isOverdue({ dueAt: null, status: 'draft' }, now)).toBe(false);
  });

  it('goes to and from a datetime-local input in local time', () => {
    const local = toLocalInput('2026-10-20T03:30:00Z');
    expect(local).toMatch(/^2026-10-2\dT\d{2}:30$/);
    expect(fromLocalInput(local)).toBe('2026-10-20T03:30:00.000Z');
    expect(toLocalInput(null)).toBe('');
    expect(fromLocalInput('')).toBeNull();
    expect(fromLocalInput('not a date')).toBeNull();
  });
});