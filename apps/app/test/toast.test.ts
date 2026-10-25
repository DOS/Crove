// Toasts (#1384): a result shows, leaves on its own after TOAST_MS (an error stays), closes on request, and a burst
// keeps the newest three.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TOAST_MS, currentToasts, dismissToast, subscribeToasts, toast } from '../src/lib/toast.ts';

afterEach(() => {
  for (const t of currentToasts()) dismissToast(t.id);
  vi.useRealTimers();
});

describe('toast', () => {
  it('shows a result and lets it go after TOAST_MS', () => {
    vi.useFakeTimers();
    const seen: number[] = [];
    const stop = subscribeToasts(() => seen.push(currentToasts().length));
    toast('Đã chép địa chỉ');
    expect(currentToasts().map((t) => t.message)).toEqual(['Đã chép địa chỉ']);
    vi.advanceTimersByTime(TOAST_MS);
    expect(currentToasts()).toEqual([]);
    expect(seen).toEqual([1, 0]);
    stop();
  });

  it('keeps an error until it is closed', () => {
    vi.useFakeTimers();
    const id = toast('Trình duyệt không cho chép', 'error');
    vi.advanceTimersByTime(TOAST_MS * 3);
    expect(currentToasts()).toHaveLength(1);
    dismissToast(id);
    expect(currentToasts()).toEqual([]);
  });

  it('keeps the newest three of a burst', () => {
    for (const n of [1, 2, 3, 4, 5]) toast(`kết quả ${n}`);
    expect(currentToasts().map((t) => t.message)).toEqual(['kết quả 3', 'kết quả 4', 'kết quả 5']);
  });
});
