// The note editor's autosave (issue #1671): one save at a time, edits during a save go in the next one, "saved" only
// when nothing came after, a conflict stops autosaving until the server's copy is taken, and a flush saves what waits.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAutosaver, type NoteValues, type SaveState } from '../src/lib/note-autosave.ts';

const v = (title: string, body = ''): NoteValues => ({ title, body, tags: '' });

function setup(save: (revision: number, values: NoteValues) => Promise<number>) {
  const states: SaveState[] = [];
  const saver = createAutosaver({ revision: 1, delayMs: 800, save, isConflict: (e) => (e as { code?: string }).code === 'NOTE_REVISION_CONFLICT', onState: (s) => states.push(s) });
  return { saver, states };
}

describe('note autosave (#1671)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('saves once a pause after the last edit, against the revision it holds', async () => {
    const save = vi.fn(async (revision: number) => revision + 1);
    const { saver, states } = setup(save);
    saver.edit(v('a'));
    await vi.advanceTimersByTimeAsync(500);
    saver.edit(v('ab'));
    await vi.advanceTimersByTimeAsync(800);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(1, v('ab'));
    expect(saver.revision()).toBe(2);
    expect(saver.dirty()).toBe(false);
    expect(states.at(-1)).toBe('saved');
  });

  it('sends one save at a time and the edits made during it in the next, with the new revision', async () => {
    let release: (n: number) => void = () => {};
    const save = vi.fn((revision: number) => new Promise<number>((resolve) => (release = () => resolve(revision + 1))));
    const { saver, states } = setup(save);
    saver.edit(v('a'));
    await vi.advanceTimersByTimeAsync(800);
    saver.edit(v('ab'));
    await vi.advanceTimersByTimeAsync(800);
    // Still one out: the second waits.
    expect(save).toHaveBeenCalledTimes(1);
    release(0);
    await vi.advanceTimersByTimeAsync(0);
    // Not "saved": an edit came after the first save started.
    expect(states).not.toContain('saved');
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith(2, v('ab'));
    release(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(states.at(-1)).toBe('saved');
    expect(saver.revision()).toBe(3);
  });

  it('stops on a conflict until the server copy is taken, then saves against it', async () => {
    const save = vi.fn<(revision: number, values: NoteValues) => Promise<number>>(async () => {
      throw Object.assign(new Error('conflict'), { code: 'NOTE_REVISION_CONFLICT' });
    });
    const { saver, states } = setup(save);
    saver.edit(v('a'));
    await vi.advanceTimersByTimeAsync(800);
    expect(states.at(-1)).toBe('conflict');
    // More typing neither saves nor clears the conflict.
    saver.edit(v('ab'));
    await vi.advanceTimersByTimeAsync(2000);
    expect(save).toHaveBeenCalledTimes(1);
    expect(states.at(-1)).toBe('conflict');
    saver.reset(5);
    expect(saver.dirty()).toBe(false);
    save.mockImplementation(async () => 6);
    saver.edit(v('c'));
    await vi.advanceTimersByTimeAsync(800);
    expect(save).toHaveBeenLastCalledWith(5, v('c'));
    expect(states.at(-1)).toBe('saved');
  });

  it('saves what waits when the editor is left, and nothing when nothing waits', async () => {
    const save = vi.fn(async (revision: number) => revision + 1);
    const { saver } = setup(save);
    await saver.flush();
    expect(save).not.toHaveBeenCalled();
    saver.edit(v('a'));
    await saver.flush();
    expect(save).toHaveBeenCalledTimes(1);
    saver.dispose();
    await vi.advanceTimersByTimeAsync(2000);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('keeps edits after a failed save, and saves them with the next edit', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValue(2);
    const { saver, states } = setup(save);
    saver.edit(v('a'));
    await vi.advanceTimersByTimeAsync(800);
    expect(states.at(-1)).toBe('error');
    expect(saver.dirty()).toBe(true);
    saver.edit(v('ab'));
    await vi.advanceTimersByTimeAsync(800);
    expect(save).toHaveBeenLastCalledWith(1, v('ab'));
    expect(states.at(-1)).toBe('saved');
  });
});
