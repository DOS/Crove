import { describe, expect, it } from 'vitest';
import { DIGEST_KIND, NOTIFICATION_KINDS, notificationTarget, unreadLabel } from '../src/lib/social-notifications.ts';

describe('social notifications (#637)', () => {
  it('opens the post, or the channels page for an expired channel', () => {
    const postId = '0190a3c4-0000-7000-8000-000000000001';
    expect(notificationTarget({ kind: 'comment', postId })).toEqual({ to: 'post', postId });
    expect(notificationTarget({ kind: 'failed', postId })).toEqual({ to: 'post', postId });
    expect(notificationTarget({ kind: 'channel_expired', postId: null })).toEqual({ to: 'channels' });
    expect(notificationTarget({ kind: 'comment', postId: null })).toBeNull();
  });

  it('opens a new post for the channel whose queue runs low (#1079), or the channels page without one', () => {
    const channelId = '0190a3c4-0000-7000-8000-000000000002';
    expect(notificationTarget({ kind: 'queue_low', postId: null, connectionId: channelId })).toEqual({ to: 'compose', channelId });
    expect(notificationTarget({ kind: 'queue_low', postId: null, connectionId: null })).toEqual({ to: 'channels' });
    expect(NOTIFICATION_KINDS).toContain('queue_low');
  });

  it('shows the unread count up to 99, and nothing for none', () => {
    expect(unreadLabel(0)).toBeNull();
    expect(unreadLabel(1)).toBe('1');
    expect(unreadLabel(99)).toBe('99');
    expect(unreadLabel(100)).toBe('99+');
  });

  it('lists every kind once, for the settings', () => {
    expect(new Set(NOTIFICATION_KINDS).size).toBe(NOTIFICATION_KINDS.length);
    expect(NOTIFICATION_KINDS).toContain('client_answer');
  });

  it('keeps the weekly digest (#1104), a mail only, out of the in-app kinds', () => {
    expect(DIGEST_KIND).toBe('weekly_digest');
    expect(NOTIFICATION_KINDS).not.toContain(DIGEST_KIND);
  });
});