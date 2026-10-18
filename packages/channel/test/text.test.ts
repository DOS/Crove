import { describe, expect, it } from 'vitest';
import { holdsLink } from '../src/index.ts';

describe('holdsLink', () => {
  it('finds the link as a whole, never as the start of a longer URL', () => {
    const link = 'https://example.com/a';
    expect(holdsLink(`xem ${link}`, link)).toBe(true);
    expect(holdsLink(`xem ${link}. Hẹn gặp`, link)).toBe(true);
    expect(holdsLink(`(${link})`, link)).toBe(true);
    expect(holdsLink(`xem ${link}bc`, link)).toBe(false);
    expect(holdsLink(`xem ${link}/b và ${link}`, link)).toBe(true);
    expect(holdsLink('không có link', link)).toBe(false);
  });
});
