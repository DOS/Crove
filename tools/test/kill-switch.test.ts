// The operator's kill-switch script (#886): what it accepts before it touches the database.
import { describe, expect, it } from 'vitest';
import { GUARDED_RELAY_TYPES, parseArgs } from '../ops/kill-switch.mjs';

describe('ops kill-switch arguments', () => {
  it('reads status and a change with who and why', () => {
    expect(parseArgs(['status'])).toEqual({ action: 'status' });
    expect(parseArgs(['ai', 'on', '--reason', ' AI endpoint lộ khóa ', '--by', 'Trực ca'])).toEqual({ action: 'set', key: 'ai', engaged: true, by: 'Trực ca', reason: 'AI endpoint lộ khóa' });
    expect(parseArgs(['mail', 'off', '--by', 'Trực ca'])).toEqual({ action: 'set', key: 'mail', engaged: false, by: 'Trực ca', reason: null });
  });

  it('reads a relay switch for one event type (#1696)', () => {
    expect(parseArgs(['relay:kernel.org.export_requested', 'on', '--reason', 'export crashes', '--by', 'Trực ca'])).toEqual({
      action: 'set',
      key: 'relay:kernel.org.export_requested',
      engaged: true,
      by: 'Trực ca',
      reason: 'export crashes',
    });
    expect(parseArgs(['relay:social.post.submitted', 'off', '--by', 'Trực ca'])).toMatchObject({ key: 'relay:social.post.submitted', engaged: false });
  });

  it('engages a relay switch that holds a security step only with --force, and releases it without', () => {
    for (const type of GUARDED_RELAY_TYPES) {
      expect(() => parseArgs([`relay:${type}`, 'on', '--reason', 'r', '--by', 'x']), type).toThrow(/--force/);
      const forced = { action: 'set', key: `relay:${type}`, engaged: true, by: 'x', reason: 'r' };
      expect(parseArgs([`relay:${type}`, 'on', '--force', '--reason', 'r', '--by', 'x'])).toEqual(forced);
      expect(parseArgs([`relay:${type}`, 'on', '--reason', 'r', '--by', 'x', '--force'])).toEqual(forced);
      expect(parseArgs([`relay:${type}`, 'off', '--by', 'x'])).toMatchObject({ engaged: false });
    }
    expect(GUARDED_RELAY_TYPES).toEqual(['kernel.session.revoked', 'kernel.member.removed', 'kernel.member.role_changed']);
    // --force changes nothing else: it takes no value and still needs who and why.
    expect(parseArgs(['relay:kernel.org.export_requested', 'on', '--force', '--reason', 'r', '--by', 'x'])).toMatchObject({ engaged: true });
    expect(() => parseArgs(['relay:kernel.session.revoked', 'on', '--force', '--by', 'x'])).toThrow(/--reason/);
    expect(() => parseArgs(['relay:kernel.session.revoked', 'on', '--force'])).toThrow(/--by/);
  });

  it('refuses a relay key that is not an event type', () => {
    for (const key of ['relay:', 'relay:kernel', 'relay:Kernel.File', 'relay:kernel.file.*', 'relay:kernel..file', 'relay: kernel.file', 'relay:kernel.file.', `relay:a.${'b'.repeat(200)}`, 'relays:kernel.file']) {
      expect(() => parseArgs([key, 'off', '--by', 'x']), key).toThrow(/usage/);
    }
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
