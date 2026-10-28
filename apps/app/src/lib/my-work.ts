// "Việc của tôi" (My work, issue #1673, notes plan docs/plan/notes.md §3.10): the member's own to-dos, grouped by the
// due day in each to-do's time zone (the kernel works the group out), in the member's own order. The pure parts of the
// screen live here: the groups, the keyboard shortcuts and where a move puts a to-do.
import { DEFAULT_TIME_ZONE, TODO_DUE_GROUPS, isTimeZone, type TodoDueGroup, type TodoSummary } from '@crove/kernel-contract';

export interface TodoGroup {
  id: TodoDueGroup;
  items: TodoSummary[];
}

/** The open to-dos in the groups of My work, in group order and, within a group, in the list's own order. */
export function groupTodos(todos: readonly TodoSummary[]): TodoGroup[] {
  return TODO_DUE_GROUPS.map((id) => ({ id, items: todos.filter((t) => (t.group ?? 'none') === id) })).filter((g) => g.items.length > 0);
}

/** The browser's time zone, which a new to-do's due day is read in; Vietnam's when the browser names none we know. */
export function browserTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && isTimeZone(zone) ? zone : DEFAULT_TIME_ZONE;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

/**
 * Where moving a to-do one place up or down its group puts it: right before the one above it, or right after the one
 * below. Null at the group's top or bottom.
 */
export function moveTarget(group: readonly TodoSummary[], id: string, direction: 'up' | 'down'): { place: 'before' | 'after'; anchorId: string } | null {
  const at = group.findIndex((t) => t.id === id);
  if (at < 0) return null;
  const neighbor = group[direction === 'up' ? at - 1 : at + 1];
  return neighbor ? { place: direction === 'up' ? 'before' : 'after', anchorId: neighbor.id } : null;
}

// The shortcuts of the screen (DESIGN.md §5.2): N a new to-do, J and K the next and previous one, X done, E edit.
export type MyWorkAction = 'new' | 'next' | 'previous' | 'done' | 'edit';
const KEYS: Readonly<Record<string, MyWorkAction>> = { n: 'new', j: 'next', k: 'previous', x: 'done', e: 'edit' };

interface KeyLike {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
  target: EventTarget | null;
}

// A field, a list box or anything editable takes its own keys.
function typing(target: EventTarget | null): boolean {
  const el = target as { tagName?: unknown; isContentEditable?: unknown; closest?: (selector: string) => unknown } | null;
  if (!el || typeof el.tagName !== 'string') return false;
  if (el.isContentEditable === true) return true;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return true;
  return typeof el.closest === 'function' && el.closest('[role="dialog"], [contenteditable="true"]') !== null;
}

/** The action a key press asks for, or null: none for a key typed in a field, with a modifier or held down. */
export function myWorkShortcut(event: KeyLike): MyWorkAction | null {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.repeat || typing(event.target)) return null;
  return KEYS[event.key.toLowerCase()] ?? null;
}

/** The id one step from `current` in `order` (the first or the last when nothing is selected yet). */
export function stepSelection(order: readonly string[], current: string | null, step: 1 | -1): string | null {
  if (order.length === 0) return null;
  const at = current === null ? -1 : order.indexOf(current);
  if (at < 0) return step === 1 ? (order[0] as string) : (order[order.length - 1] as string);
  return order[Math.min(order.length - 1, Math.max(0, at + step))] as string;
}
