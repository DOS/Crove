// My work (#1673, #1674): the groups of the screen with the tasks of my positions, where a move puts a to-do, the keyboard
// shortcuts and the text a hand-over proposes.
import { describe, expect, it } from 'vitest';
import type { MyWorkTask, TodoSummary } from '@crove/kernel-contract';
import { groupTodos, handOverDescription, moveTarget, myWorkShortcut, stepSelection } from '../src/lib/my-work.ts';

const todo = (id: string, group: TodoSummary['group']): TodoSummary => ({
  id,
  title: id,
  status: 'open',
  dueOn: null,
  dueAt: null,
  dueTime: null,
  timeZone: 'Asia/Ho_Chi_Minh',
  remindAt: null,
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

  it('puts the tasks of my positions in their groups after the to-dos, and keeps a group with tasks only (#1674)', () => {
    const task = (id: string, group: MyWorkTask['group']): MyWorkTask => ({ id, title: id, status: 'todo', positionId: null, due: null, group, overdue: false, tainted: false });
    const groups = groupTodos([todo('a', 'today')], [task('t1', 'today'), task('t2', 'none')]);
    expect(groups.map((g) => [g.id, g.items.map((t) => t.id), g.tasks.map((t) => t.id)])).toEqual([
      ['today', ['a'], ['t1']],
      ['none', [], ['t2']],
    ]);
  });

  it('proposes the details and the steps as the description a hand-over gives the team (#1674)', () => {
    const steps = [
      { text: 'Xin bảng kê', done: true },
      { text: 'Nộp tờ khai', done: false },
    ];
    expect(handOverDescription({ details: '  Hỏi kế toán trưởng  ', checklist: steps })).toBe('Hỏi kế toán trưởng\n\n- [x] Xin bảng kê\n- [ ] Nộp tờ khai');
    expect(handOverDescription({ details: '', checklist: steps })).toBe('- [x] Xin bảng kê\n- [ ] Nộp tờ khai');
    expect(handOverDescription({ details: '', checklist: [] })).toBe('');
    expect(handOverDescription({ details: 'x'.repeat(20), checklist: [] }, 10)).toHaveLength(10);
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
