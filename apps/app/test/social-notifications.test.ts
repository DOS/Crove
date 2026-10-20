import { describe, expect, it } from 'vitest';
import { NOTIFICATION_KINDS, notificationTarget, unreadLabel } from '../src/lib/social-notifications.ts';

describe('social notifications (#637)', () => {
  it('opens the post, or the channels page for an expired channel', () => {
    const postId = '0190a3c4-0000-7000-8000-000000000001';
    expect(notificationTarget({ kind: 'comment', postId })).toEqual({ to: 'post', postId });
    expect(notificationTarget({ kind: 'failed', postId })).toEqual({ to: 'post', postId });
    expect(notificationTarget({ kind: 'channel_expired', postId: null })).toEqual({ to: 'channels' });
    expect(notificationTarget({ kind: 'comment', postId: null })).toBeNull();
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
});