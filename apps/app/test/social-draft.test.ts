import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearDraft, DRAFT_TTL_MS, insertText, loadDraft, saveDraft } from '../src/lib/social-draft.ts';

describe('unsaved Social edits kept in the browser (#634)', () => {
  let store: Map<string, string>;
  beforeEach(() => {
    store = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('keeps one entry per org and post, with the revision it started from', () => {
    saveDraft('cong-ty', 'new', null, { body: 'Khai trương' }, new Date('2026-10-20T10:00:00Z'));
    saveDraft('cong-ty', 'post-1', 3, { body: 'Sửa dở' }, new Date('2026-10-20T10:00:00Z'));
    saveDraft('cong-ty-khac', 'new', null, { body: 'Khác' });
    const now = Date.parse('2026-10-20T11:00:00Z');
    expect(loadDraft('cong-ty', 'new', now)).toEqual({ savedAt: '2026-10-20T10:00:00.000Z', revision: null, data: { body: 'Khai trương' } });
    expect(loadDraft('cong-ty', 'post-1', now)).toMatchObject({ revision: 3, data: { body: 'Sửa dở' } });
    clearDraft('cong-ty', 'new');
    expect(loadDraft('cong-ty', 'new', now)).toBeNull();
    expect(loadDraft('cong-ty-khac', 'new')).toMatchObject({ data: { body: 'Khác' } });
  });

  it('drops an entry that is too old or unreadable', () => {
    saveDraft('cong-ty', 'new', null, { body: 'Cũ' }, new Date('2026-10-01T00:00:00Z'));
    expect(loadDraft('cong-ty', 'new', Date.parse('2026-10-01T00:00:00Z') + DRAFT_TTL_MS + 1)).toBeNull();
    expect(store.size).toBe(0);
    store.set('crove.social.draft:cong-ty:new', '{not json');
    expect(loadDraft('cong-ty', 'new')).toBeNull();
  });

  it('works without storage at all', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    });
    expect(() => saveDraft('cong-ty', 'new', null, {})).not.toThrow();
    expect(loadDraft('cong-ty', 'new')).toBeNull();
    expect(() => clearDraft('cong-ty', 'new')).not.toThrow();
  });

  it('puts an emoji at the cursor or over the selection', () => {
    expect(insertText('Khai trương', 4, 4, '🎉')).toEqual({ text: 'Khai🎉 trương', cursor: 6 });
    expect(insertText('Giá XX', 4, 6, '🔥')).toEqual({ text: 'Giá 🔥', cursor: 6 });
    expect(insertText('abc', 99, 99, '✅')).toEqual({ text: 'abc✅', cursor: 4 });
  });
});