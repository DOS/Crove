// Toasts (#1384): a result shows, leaves on its own after TOAST_MS (an error stays), closes on request, and a burst
// keeps the newest three. A toast's action (an undo, #2003) runs once and closes it; such a toast stays ACTION_TOAST_MS
// and waits while it is hovered or focused.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACTION_TOAST_MS, TOAST_MS, currentToasts, dismissToast, pauseToast, resumeToast, runToastAction, subscribeToasts, toast } from '../src/lib/toast.ts';

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

  it('starts the time of a toast held for a screen change once it settles, and keeps it while it never does (#1547)', async () => {
    vi.useFakeTimers();
    let arrive = () => {};
    const navigation = new Promise<void>((resolve) => (arrive = resolve));
    toast('Đã duyệt và ghi sổ Công ty A', 'success', { holdUntil: navigation });
    // A slow screen change does not use up the toast's time.
    vi.advanceTimersByTime(TOAST_MS * 2);
    expect(currentToasts().map((t) => t.message)).toEqual(['Đã duyệt và ghi sổ Công ty A']);
    arrive();
    await vi.advanceTimersByTimeAsync(TOAST_MS - 1);
    expect(currentToasts()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(currentToasts()).toEqual([]);

    // A navigation that never settles (superseded) leaves the toast until it is closed.
    const id = toast('Đã từ chối Công ty B', 'success', { holdUntil: new Promise(() => {}) });
    await vi.advanceTimersByTimeAsync(TOAST_MS * 5);
    expect(currentToasts()).toHaveLength(1);
    dismissToast(id);
    // A failed one starts the time as well.
    toast('Đã duyệt Công ty C', 'success', { holdUntil: Promise.reject(new Error('cancelled')) });
    await vi.advanceTimersByTimeAsync(TOAST_MS);
    expect(currentToasts()).toEqual([]);
  });

  it('keeps the newest three of a burst', () => {
    for (const n of [1, 2, 3, 4, 5]) toast(`kết quả ${n}`);
    expect(currentToasts().map((t) => t.message)).toEqual(['kết quả 3', 'kết quả 4', 'kết quả 5']);
  });

  it('runs an undo once and closes its toast (#2003)', () => {
    const run = vi.fn();
    const id = toast('Đã lưu trữ ghi chú', 'success', { action: { label: 'Hoàn tác', run } });
    expect(currentToasts()).toEqual([{ id, message: 'Đã lưu trữ ghi chú', tone: 'success', action: { label: 'Hoàn tác', run } }]);
    runToastAction(id);
    expect(run).toHaveBeenCalledTimes(1);
    expect(currentToasts()).toEqual([]);
    // A second press, or a toast without an action, does nothing.
    runToastAction(id);
    const plain = toast('Đã chép địa chỉ');
    runToastAction(plain);
    expect(run).toHaveBeenCalledTimes(1);
    expect(currentToasts().map((t) => t.message)).toEqual(['Đã chép địa chỉ']);
  });

  it('keeps a toast with an undo for ACTION_TOAST_MS, and holds it while it is hovered or focused', () => {
    vi.useFakeTimers();
    const run = vi.fn();
    toast('Đã chuyển ghi chú vào thùng rác', 'success', { action: { label: 'Hoàn tác', run } });
    vi.advanceTimersByTime(TOAST_MS);
    expect(currentToasts()).toHaveLength(1);
    vi.advanceTimersByTime(ACTION_TOAST_MS - TOAST_MS);
    expect(currentToasts()).toEqual([]);
    expect(run).not.toHaveBeenCalled();

    const id = toast('Đã đánh dấu xong: Gọi khách', 'success', { action: { label: 'Hoàn tác', run } });
    vi.advanceTimersByTime(ACTION_TOAST_MS - 1);
    pauseToast(id);
    vi.advanceTimersByTime(ACTION_TOAST_MS * 3);
    expect(currentToasts()).toHaveLength(1);
    // Leaving starts its time again, whole.
    resumeToast(id);
    vi.advanceTimersByTime(ACTION_TOAST_MS - 1);
    expect(currentToasts()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(currentToasts()).toEqual([]);
  });

  it('holds a toast still waiting for its screen change, and starts it only once that settles', async () => {
    vi.useFakeTimers();
    let arrive = () => {};
    const navigation = new Promise<void>((resolve) => (arrive = resolve));
    const id = toast('Đã lưu trữ ghi chú', 'success', { holdUntil: navigation, action: { label: 'Hoàn tác', run: () => {} } });
    // Hovered and left before the screen changed: its time has not begun, so leaving does not start it.
    pauseToast(id);
    resumeToast(id);
    await vi.advanceTimersByTimeAsync(ACTION_TOAST_MS * 2);
    expect(currentToasts()).toHaveLength(1);
    arrive();
    await vi.advanceTimersByTimeAsync(ACTION_TOAST_MS);
    expect(currentToasts()).toEqual([]);
    // An error toast with an action still stays until closed.
    const error = toast('Chưa hoàn tác được', 'error', { action: { label: 'Thử lại', run: () => {} } });
    pauseToast(error);
    resumeToast(error);
    vi.advanceTimersByTime(ACTION_TOAST_MS * 3);
    expect(currentToasts()).toHaveLength(1);
  });
});
