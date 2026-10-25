// Toasts for results (DESIGN.md §4.5, #1384): a short line that says what an action did ("Đã duyệt và ghi sổ …"), in
// the action's own verb (§4.1). The list lives outside React, so a toast raised just before a navigation is still shown
// on the next screen; the Toaster (components/toaster.tsx) renders it.

export type ToastTone = 'success' | 'error';

export interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
}

// Long enough to read a line twice; a toast with an error stays until closed.
export const TOAST_MS = 5000;
// At most this many at once: a burst of results keeps the newest.
const MAX_TOASTS = 3;

let toasts: readonly Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function emit() {
  for (const listener of listeners) listener();
}

export function dismissToast(id: number): void {
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
  if (!toasts.some((t) => t.id === id)) return;
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

// holdUntil: the screen change the toast goes with (#1547). A result toast starts its TOAST_MS once it has settled,
// so it lives its whole time on the screen it is about; one that never settles (a navigation another one superseded)
// leaves the toast until it is closed or pushed out, never lost.
export function toast(message: string, tone: ToastTone = 'success', options: { holdUntil?: Promise<unknown> } = {}): number {
  const id = nextId++;
  const kept = toasts.slice(-(MAX_TOASTS - 1));
  for (const dropped of toasts.filter((t) => !kept.includes(t))) dismissToast(dropped.id);
  toasts = [...kept, { id, message, tone }];
  if (tone === 'success') {
    const start = () => {
      if (toasts.some((t) => t.id === id)) timers.set(id, setTimeout(() => dismissToast(id), TOAST_MS));
    };
    if (options.holdUntil) void options.holdUntil.then(start, start);
    else start();
  }
  emit();
  return id;
}

export function subscribeToasts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function currentToasts(): readonly Toast[] {
  return toasts;
}
