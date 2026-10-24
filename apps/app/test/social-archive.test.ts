// Archived posts (#1299): who may archive a post, why the post page cannot archive one now (as the server refuses it),
// and the Archived tab in the Social home's address.
import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/messages/en.ts';
import { vi } from '../src/i18n/messages/vi.ts';
import { archiveBlock, mayArchive } from '../src/lib/social-archive.ts';
import { parseSocialSearch, SOCIAL_TABS } from '../src/lib/social.ts';

const author = '00000000-0000-4000-8000-000000000001';
const someone = '00000000-0000-4000-8000-000000000002';

describe('mayArchive', () => {
  it('lets owners and admins archive any post, members their own, viewers none', () => {
    const admin = { canDecide: true, canWrite: true, userId: someone };
    const member = { canDecide: false, canWrite: true, userId: author };
    const viewer = { canDecide: false, canWrite: false, userId: author };
    expect(mayArchive(admin, { authorUserId: author })).toBe(true);
    expect(mayArchive(admin, { authorUserId: null })).toBe(true);
    expect(mayArchive(member, { authorUserId: author })).toBe(true);
    expect(mayArchive(member, { authorUserId: someone })).toBe(false);
    // A post no person wrote (an import, an agent) is for owners and admins.
    expect(mayArchive(member, { authorUserId: null })).toBe(false);
    expect(mayArchive({ ...member, userId: null }, { authorUserId: null })).toBe(false);
    expect(mayArchive(viewer, { authorUserId: author })).toBe(false);
  });
});

describe('archiveBlock', () => {
  it('blocks a post with a channel going out, waiting for a person, scheduled or being taken down', () => {
    for (const status of ['publishing', 'processing', 'ambiguous', 'needs_attention']) expect(archiveBlock([{ status: 'draft' }, { status }])).toBe('in_flight');
    for (const status of ['scheduled', 'paused']) expect(archiveBlock([{ status }])).toBe('scheduled');
    // Going out counts before a schedule elsewhere on the post.
    expect(archiveBlock([{ status: 'scheduled' }, { status: 'publishing' }])).toBe('in_flight');
    expect(archiveBlock([{ status: 'published', removal: { state: 'pending' } }])).toBe('removing');
  });

  it('lets drafts, reviews, approvals, failures and history be archived', () => {
    for (const status of ['draft', 'in_review', 'changes_requested', 'rejected', 'approved', 'failed', 'published', 'cancelled', 'removed']) expect(archiveBlock([{ status }])).toBeNull();
    // A takedown that failed or is unclear waits for a person, not for the post.
    expect(archiveBlock([{ status: 'published', removal: { state: 'failed' } }, { status: 'published', removal: null }])).toBeNull();
    expect(archiveBlock([])).toBeNull();
  });

  it('says why in both languages', () => {
    for (const block of ['in_flight', 'scheduled', 'removing'] as const) {
      expect(vi.social.archive.blocked[block]).toBeTruthy();
      expect(en.social.archive.blocked[block]).toBeTruthy();
    }
  });
});

describe('the Archived tab', () => {
  it('is a tab of the Social home, read from the address', () => {
    expect(SOCIAL_TABS).toContain('archived');
    expect(parseSocialSearch({ tab: 'archived' })).toEqual({ tab: 'archived' });
    expect(vi.social.tabs.archived).toBe('Đã lưu trữ');
    expect(en.social.tabs.archived).toBe('Archived');
    expect(vi.social.empty.archived).toBeTruthy();
  });
});
