// Personal to-dos (issues #1673 and #1674): the fractional order keys, the due-day groups in a to-do's own time zone,
// the tasks of My work, the hand-over's input, and the commands' access (no agent runs any of them, ADR-0029, notes
// plan §3.5).
import { describe, expect, it } from 'vitest';
import { taskStanding, todoDueGroup, todoDueInstant, todoLocalTime, todoStanding, zTodoCreate, zTodoHandOver, zTodoReorder } from '@crove/kernel-contract';
import { REBALANCE_AT, isSortKey, keyBetween, myWork, notesCommands, notesQueries, spreadKeys, todoCommands, todoHandOver, todoQueries } from '@crove/mod-notes';

describe('to-do order keys', () => {
  it('finds a key between any two, and at both ends', () => {
    expect(keyBetween(null, null)).toBe('V');
    const pairs: Array<[string | null, string | null]> = [
      [null, 'V'],
      ['V', null],
      ['V', 'W'],
      ['V', 'V1'],
      ['Vz', 'W'],
      ['0', '1'],
      [null, '01'],
      ['zzz', null],
      ['a0', null],
      [null, 'a0'],
    ];
    for (const [a, b] of pairs) {
      const key = keyBetween(a, b);
      expect(isSortKey(key), `${a} ${b} -> ${key}`).toBe(true);
      if (a !== null) expect(a < key, `${a} < ${key}`).toBe(true);
      if (b !== null) expect(key < b, `${key} < ${b}`).toBe(true);
      expect(key.endsWith('0'), key).toBe(false);
    }
    expect(() => keyBetween('W', 'V')).toThrow();
    expect(() => keyBetween('V', 'V')).toThrow();
  });

  it('keeps order through many inserts at one place, and grows slowly', () => {
    let lo = 'V';
    const hi = 'W';
    for (let i = 0; i < 200; i++) {
      const key = keyBetween(lo, hi);
      expect(lo < key && key < hi).toBe(true);
      lo = key;
    }
    expect(lo.length).toBeLessThan(REBALANCE_AT);
    // Always first: every new key sorts before the last.
    let first = 'V';
    for (let i = 0; i < 200; i++) {
      const key = keyBetween(null, first);
      expect(key < first).toBe(true);
      first = key;
    }
  });

  it('spreads fresh keys evenly and in order', () => {
    for (const n of [0, 1, 2, 61, 62, 500, 5000]) {
      const keys = spreadKeys(n);
      expect(keys).toHaveLength(n);
      expect([...keys].sort()).toEqual(keys);
      expect(new Set(keys).size).toBe(n);
      for (const k of keys) expect(isSortKey(k) && !k.endsWith('0'), k).toBe(true);
    }
    expect(spreadKeys(3)).toEqual(['F', 'V', 'k']);
  });
});

describe('to-do due days', () => {
  it('groups a due day against today in the same zone', () => {
    expect(todoDueGroup(null, '2026-11-03')).toBe('none');
    expect(todoDueGroup('2026-11-02', '2026-11-03')).toBe('overdue');
    expect(todoDueGroup('2026-11-03', '2026-11-03')).toBe('today');
    expect(todoDueGroup('2026-11-04', '2026-11-03')).toBe('next7');
    expect(todoDueGroup('2026-11-10', '2026-11-03')).toBe('next7');
    expect(todoDueGroup('2026-11-11', '2026-11-03')).toBe('later');
    // Across a month and a year.
    expect(todoDueGroup('2027-01-02', '2026-12-30')).toBe('next7');
  });

  it("reads today in the to-do's own time zone", () => {
    // 2026-11-03 20:00 UTC is 4 November in Vietnam and 3 November in New York.
    const now = new Date('2026-11-03T20:00:00Z');
    expect(todoStanding({ dueOn: '2026-11-04', dueAt: null, timeZone: 'Asia/Ho_Chi_Minh' }, now)).toEqual({ group: 'today', overdue: false });
    expect(todoStanding({ dueOn: '2026-11-04', dueAt: null, timeZone: 'America/New_York' }, now)).toEqual({ group: 'next7', overdue: false });
    expect(todoStanding({ dueOn: '2026-11-03', dueAt: null, timeZone: 'Asia/Ho_Chi_Minh' }, now)).toEqual({ group: 'overdue', overdue: true });
    // Due today at a time already past: still today, but late.
    const at = todoDueInstant('2026-11-04', '02:00', 'Asia/Ho_Chi_Minh');
    expect(at.toISOString()).toBe('2026-11-03T19:00:00.000Z');
    expect(todoStanding({ dueOn: '2026-11-04', dueAt: at, timeZone: 'Asia/Ho_Chi_Minh' }, now)).toEqual({ group: 'today', overdue: true });
    expect(todoLocalTime(at, 'Asia/Ho_Chi_Minh')).toBe('02:00');
    expect(todoLocalTime(at, 'UTC')).toBe('19:00');
  });

  it('refuses a due time without a day, and a move next to itself', () => {
    expect(zTodoCreate.safeParse({ title: 'x', dueTime: '09:00' }).success).toBe(false);
    expect(zTodoCreate.safeParse({ title: 'x', dueOn: '2026-11-05', dueTime: '24:00' }).success).toBe(false);
    expect(zTodoCreate.safeParse({ title: 'x', timeZone: 'Mars/Olympus' }).success).toBe(false);
    expect(zTodoCreate.parse({ title: '  x  ' })).toEqual({ title: 'x', details: '', checklist: [], dueOn: null, dueTime: null, timeZone: 'Asia/Ho_Chi_Minh' });
    const id = '018f0000-0000-7000-8000-000000000001';
    expect(zTodoReorder.safeParse({ todoId: id, place: 'before', anchorId: id }).success).toBe(false);
  });
});

describe('tasks in My work and the hand-over (#1674)', () => {
  it("groups a task by its due day in the member's time zone", () => {
    const now = new Date('2026-11-03T20:00:00Z');
    expect(taskStanding(null, 'Asia/Ho_Chi_Minh', now)).toEqual({ group: 'none', overdue: false });
    // Now is 4 November in Vietnam and 3 November in New York; the task is due 4 November in both.
    const at = new Date('2026-11-04T06:00:00Z');
    expect(taskStanding(at, 'Asia/Ho_Chi_Minh', now)).toEqual({ group: 'today', overdue: false });
    expect(taskStanding(at, 'America/New_York', now)).toEqual({ group: 'next7', overdue: false });
    // Earlier today and past: today, late; a day before: overdue.
    expect(taskStanding(new Date('2026-11-03T19:00:00Z'), 'Asia/Ho_Chi_Minh', now)).toEqual({ group: 'today', overdue: true });
    expect(taskStanding(new Date('2026-11-02T10:00:00Z'), 'Asia/Ho_Chi_Minh', now)).toEqual({ group: 'overdue', overdue: true });
  });

  it('takes the text the member confirmed, within a task title and description', () => {
    const id = '018f0000-0000-7000-8000-000000000001';
    const base = { todoId: id, revision: 1, positionId: id, title: '  Nộp tờ khai  ', description: '' };
    expect(zTodoHandOver.parse(base)).toEqual({ ...base, title: 'Nộp tờ khai' });
    expect(zTodoHandOver.safeParse({ ...base, title: ' ' }).success).toBe(false);
    expect(zTodoHandOver.safeParse({ ...base, title: 'x'.repeat(301) }).success).toBe(false);
    expect(zTodoHandOver.safeParse({ ...base, description: 'x'.repeat(10_001) }).success).toBe(false);
    // No source of its own: the kernel sets it.
    expect(zTodoHandOver.safeParse({ ...base, sourceRef: { type: 'kernel.proposal', id } }).success).toBe(false);
  });

  it('registers notes.todo.hand_over and notes.my_work, for people only', () => {
    expect(notesCommands).toContain(todoHandOver);
    expect(notesQueries).toContain(myWork);
    expect(todoHandOver.access).toEqual(['owner', 'admin', 'member']);
    expect((myWork as { agent?: unknown }).agent).toBeUndefined();
  });
});

describe('to-do commands', () => {
  it('are registered, and none lets an agent run it', () => {
    for (const def of todoCommands) expect(notesCommands).toContain(def);
    for (const def of todoQueries) expect(notesQueries).toContain(def);
    for (const def of [...todoCommands, ...todoQueries]) {
      expect(def.name.startsWith('notes.todo.'), def.name).toBe(true);
      expect((def as { agent?: unknown }).agent, def.name).toBeUndefined();
    }
    for (const def of todoCommands) {
      expect(def.access, def.name).toEqual(['owner', 'admin', 'member']);
      expect(def.risk, def.name).toBe('R1');
    }
  });
});
