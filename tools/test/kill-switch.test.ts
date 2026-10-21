// The operator's kill-switch script (#886): what it accepts before it touches the database.
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../ops/kill-switch.mjs';

describe('ops kill-switch arguments', () => {
  it('reads status and a change with who and why', () => {
    expect(parseArgs(['status'])).toEqual({ action: 'status' });
    expect(parseArgs(['ai', 'on', '--reason', ' AI endpoint lộ khóa ', '--by', 'Trực ca'])).toEqual({ action: 'set', key: 'ai', engaged: true, by: 'Trực ca', reason: 'AI endpoint lộ khóa' });
    expect(parseArgs(['mail', 'off', '--by', 'Trực ca'])).toEqual({ action: 'set', key: 'mail', engaged: false, by: 'Trực ca', reason: null });
  });

  it('refuses an unknown key or state, a missing name, and engaging without a reason', () => {
    for (const argv of [
      [],
      ['status', 'ai'],
      ['social', 'on', '--by', 'x', '--reason', 'y'],
      ['ai', 'maybe', '--by', 'x'],
      ['ai', 'off'],
      ['ai', 'off', '--by', '  '],
      ['ai', 'off', '--by', 'x'.repeat(101)],
      ['ai', 'on', '--by', 'x'],
      ['ai', 'on', '--by', 'x', '--reason', 'y'.repeat(501)],
      ['ai', 'off', '--by'],
      ['ai', 'off', '--who', 'x'],
    ]) {
      expect(() => parseArgs(argv), JSON.stringify(argv)).toThrow();
    }
  });
});
