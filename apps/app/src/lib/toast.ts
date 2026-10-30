// Toasts for results (DESIGN.md §4.5, #1384): a short line that says what an action did ("Đã duyệt và ghi sổ …"), in
// the action's own verb (§4.1). The list lives outside React, so a toast raised just before a navigation is still shown
// on the next screen; the Toaster (components/toaster.tsx) renders it. A toast may carry one action, an undo where the
// action allows it (#2003): a button in the toast that runs the inverse once and closes it.

export type ToastTone = 'success' | 'error';

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
  action?: ToastAction;
}

// Long enough to read a line twice; a toast with an error stays until closed.
export const TOAST_MS = 5000;
// A toast with an action stays longer, so its button can be reached from the keyboard; it waits while it is hovered or
// holds the focus (pauseToast), and starts its time again after.
export const ACTION_TOAST_MS = 10000;
// The key that moves the focus to the newest toast (#2026), as Radix's toast viewport does; no browser binds it.
export const TOAST_SHORTCUT = 'F8';
// At most this many at once: a burst of results keeps the newest.
const MAX_TOASTS = 3;

let toasts: readonly Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();
// The toasts the pointer or the focus holds, and the success toasts whose time has begun (not those still waiting for
// their screen change).
const paused = new Set<number>();
const started = new Set<number>();

function emit() {
  for (const listener of listeners) listener();
}

export function dismissToast(id: number): void {
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
  paused.delete(id);
  started.delete(id);
  if (!toasts.some((t) => t.id === id)) return;
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

// Starts (again) the whole time of a success toast still shown and not held.
function startTimer(id: number) {
  const item = toasts.find((t) => t.id === id);
  if (!item || item.tone !== 'success' || paused.has(id)) return;
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.set(id, setTimeout(() => dismissToast(id), item.action ? ACTION_TOAST_MS : TOAST_MS));
}

// holdUntil: the screen change the toast goes with (#1547). A result toast starts its time once it has settled,
// so it lives its whole time on the screen it is about; one that never settles (a navigation another one superseded)
// leaves the toast until it is closed or pushed out, never lost.
export function toast(message: string, tone: ToastTone = 'success', options: { holdUntil?: Promise<unknown>; action?: ToastAction } = {}): number {
  const id = nextId++;
  const kept = toasts.slice(-(MAX_TOASTS - 1));
  for (const dropped of toasts.filter((t) => !kept.includes(t))) dismissToast(dropped.id);
  toasts = [...kept, { id, message, tone, ...(options.action ? { action: options.action } : {}) }];
  if (tone === 'success') {
    const start = () => {
      if (!toasts.some((t) => t.id === id)) return;
      started.add(id);
      startTimer(id);
    };
    if (options.holdUntil) void options.holdUntil.then(start, start);
    else start();
  }
  emit();
  return id;
}

// Runs the toast's action once and closes the toast; a second press, or a toast already gone, does nothing.
export function runToastAction(id: number): void {
  const item = toasts.find((t) => t.id === id);
  if (!item?.action) return;
  dismissToast(id);
  item.action.run();
}

// While the pointer is over a toast or the focus is in it, its time stands still; on leaving it starts again whole.
export function pauseToast(id: number): void {
  if (!toasts.some((t) => t.id === id)) return;
  paused.add(id);
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
}

export function resumeToast(id: number): void {
  if (!paused.delete(id)) return;
  if (started.has(id)) startTimer(id);
}

export function isToastShortcut(event: { key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; repeat: boolean }): boolean {
  return event.key === TOAST_SHORTCUT && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.repeat;
}

export function subscribeToasts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function currentToasts(): readonly Toast[] {
  return toasts;
}
