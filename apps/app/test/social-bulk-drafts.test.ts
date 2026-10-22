// Drafts from library files (#1080): the order of the picks and the request the panel sends.
import { describe, expect, it } from 'vitest';
import { DRAFTS_FROM_MEDIA_MAX, draftsRequest, mediaNumber, togglePick } from '../src/lib/social-bulk-drafts.ts';

describe('drafts from library files', () => {
  it('keeps the files in the order picked, unpicks in place and stops at the cap', () => {
    expect(togglePick([], 'a')).toEqual(['a']);
    expect(togglePick(['a', 'b'], 'c')).toEqual(['a', 'b', 'c']);
    expect(togglePick(['a', 'b', 'c'], 'b')).toEqual(['a', 'c']);
    expect(togglePick(['a', 'b'], 'c', 2)).toEqual(['a', 'b']);
    expect(DRAFTS_FROM_MEDIA_MAX).toBe(50);
  });

  it('sends a request only with a file, a channel and, for a snippet caption, the snippet', () => {
    const form = { fileIds: ['f1', 'f2'], connectionIds: ['c1'], caption: 'none' as const, snippetId: null, queue: false };
    expect(draftsRequest(form)).toEqual({ fileIds: ['f1', 'f2'], connectionIds: ['c1'], caption: { kind: 'none' } });
    expect(draftsRequest({ ...form, caption: 'filename', queue: true })).toEqual({ fileIds: ['f1', 'f2'], connectionIds: ['c1'], caption: { kind: 'filename' }, queue: true });
    expect(draftsRequest({ ...form, caption: 'snippet' })).toBeNull();
    expect(draftsRequest({ ...form, caption: 'snippet', snippetId: 's1' })?.caption).toEqual({ kind: 'snippet', snippetId: 's1' });
    expect(draftsRequest({ ...form, connectionIds: [] })).toBeNull();
    expect(draftsRequest({ ...form, fileIds: [] })).toBeNull();
    expect(draftsRequest({ ...form, fileIds: Array.from({ length: 51 }, (_, i) => `f${i}`) })).toBeNull();
  });

  it('counts the file of an issue from 1', () => {
    expect(mediaNumber('media.0')).toBe(1);
    expect(mediaNumber('media')).toBe(1);
  });
});
