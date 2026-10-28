// My work (#1673): the groups of the screen, where a move puts a to-do, and the keyboard shortcuts.
import { describe, expect, it } from 'vitest';
import type { TodoSummary } from '@crove/kernel-contract';
import { groupTodos, moveTarget, myWorkShortcut, stepSelection } from '../src/lib/my-work.ts';

const todo = (id: string, group: TodoSummary['group']): TodoSummary => ({
  id,
  title: id,
  status: 'open',
  dueOn: null,
  dueAt: null,
  dueTime: null,
  timeZone: 'Asia/Ho_Chi_Minh',
  group,
  overdue: group === 'overdue',
  steps: { done: 0, total: 0 },
  taskId: null,
  revision: 1,
  createdAt: '2026-11-03T00:00:00.000Z',
  updatedAt: '2026-11-03T00:00:00.000Z',
  doneAt: null,
  deletedAt: null,
});

const key = (k: string, more: Partial<{ altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; repeat: boolean; target: EventTarget | null }> = {}) => ({
  key: k,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  repeat: false,
  target: null,
  ...more,
});

describe('My work', () => {
  it('groups open to-dos in the order of the screen, keeping the list order within a group', () => {
    const list = [todo('a', 'none'), todo('b', 'today'), todo('c', 'overdue'), todo('d', 'today'), todo('e', 'later')];
    expect(groupTodos(list).map((g) => [g.id, g.items.map((t) => t.id)])).toEqual([
      ['overdue', ['c']],
      ['today', ['b', 'd']],
      ['later', ['e']],
      ['none', ['a']],
    ]);
  });

  it('moves a to-do next to its neighbor in the group', () => {
    const group = [todo('a', 'today'), todo('b', 'today'), todo('c', 'today')];
    expect(moveTarget(group, 'b', 'up')).toEqual({ place: 'before', anchorId: 'a' });
    expect(moveTarget(group, 'b', 'down')).toEqual({ place: 'after', anchorId: 'c' });
    expect(moveTarget(group, 'a', 'up')).toBeNull();
    expect(moveTarget(group, 'c', 'down')).toBeNull();
    expect(moveTarget(group, 'x', 'up')).toBeNull();
  });

  it('reads N, J, K, X and E, but not in a field, with a modifier or held down', () => {
    expect(['n', 'j', 'k', 'x', 'e', 'N'].map((k) => myWorkShortcut(key(k)))).toEqual(['new', 'next', 'previous', 'done', 'edit', 'new']);
    expect(myWorkShortcut(key('q'))).toBeNull();
    expect(myWorkShortcut(key('j', { ctrlKey: true }))).toBeNull();
    expect(myWorkShortcut(key('j', { metaKey: true }))).toBeNull();
    expect(myWorkShortcut(key('j', { repeat: true }))).toBeNull();
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
      expect(myWorkShortcut(key('x', { target: { tagName, closest: () => null } as unknown as EventTarget })), tagName).toBeNull();
    }
    expect(myWorkShortcut(key('x', { target: { tagName: 'DIV', isContentEditable: true } as unknown as EventTarget }))).toBeNull();
    expect(myWorkShortcut(key('x', { target: { tagName: 'BUTTON', closest: () => null } as unknown as EventTarget }))).toBe('done');
  });

  it('steps the selection through the list, stopping at its ends', () => {
    const order = ['a', 'b', 'c'];
    expect(stepSelection(order, null, 1)).toBe('a');
    expect(stepSelection(order, null, -1)).toBe('c');
    expect(stepSelection(order, 'a', 1)).toBe('b');
    expect(stepSelection(order, 'c', 1)).toBe('c');
    expect(stepSelection(order, 'a', -1)).toBe('a');
    expect(stepSelection(order, 'gone', 1)).toBe('a');
    expect(stepSelection([], 'a', 1)).toBeNull();
  });
});
