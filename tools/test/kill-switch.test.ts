// The operator's kill-switch script (#886): what it accepts before it touches the database.
import { describe, expect, it } from 'vitest';
import { GUARDED_RELAY_TYPES, parseArgs, runSwitch, SET_SQL, STATUS_SQL, statusLine } from '../ops/kill-switch.mjs';

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

  it('runs a change then the status on the client it is given, and prints each switch (#1718)', async () => {
    const asked: Array<[string, unknown[]]> = [];
    const rows = [{ key: 'ai', engaged: true, last: { changed_at: '2026-10-28T01:00:00Z', changed_by: 'Trực ca', reason: 'diễn tập' }, held: null }];
    const client = {
      query: async (text: string, values: unknown[]) => {
        asked.push([text, values]);
        return { rows: text === STATUS_SQL ? rows : [] };
      },
    };
    expect(await runSwitch(client, parseArgs(['ai', 'on', '--reason', 'diễn tập', '--by', 'Trực ca']))).toEqual(rows);
    expect(asked).toEqual([
      [SET_SQL, ['ai', true, 'diễn tập', 'Trực ca']],
      [STATUS_SQL, [['ai', 'mail']]],
    ]);
    asked.length = 0;
    await runSwitch(client, parseArgs(['status']));
    expect(asked.map(([text]) => text)).toEqual([STATUS_SQL]);
    expect(statusLine(rows[0] as never)).toBe('ai: ON (stopped) since 2026-10-28T01:00:00Z by Trực ca (diễn tập)');
    expect(statusLine({ key: 'relay:crm.booking.requested', engaged: true, last: null, held: 3 })).toBe('relay:crm.booking.requested: ON (stopped), holding 3 event(s)');
    expect(statusLine({ key: 'mail', engaged: false, last: null, held: null })).toBe('mail: off');
  });
});
