// In-app notifications (#637): the kinds, in the order the settings list them, what an item opens, and the count on
// the menu.
import { SOCIAL_NOTIFICATION_KINDS } from '@crove/kernel-contract';

export type NotificationKind = (typeof SOCIAL_NOTIFICATION_KINDS)[number];
export const NOTIFICATION_KINDS: readonly NotificationKind[] = SOCIAL_NOTIFICATION_KINDS;

export type NotificationTarget = { to: 'post'; postId: string } | { to: 'channels' } | { to: 'feeds' } | { to: 'compose'; channelId: string };

// What an item opens: its post, or the channels page for a channel that needs connecting again or a publishing hold.
export function notificationTarget(item: { kind: NotificationKind; postId: string | null; connectionId?: string | null }): NotificationTarget | null {
  if (item.postId) return { to: 'post', postId: item.postId };
  if (item.kind === 'channel_expired') return { to: 'channels' };
  // A feed that stopped being read (#708).
  if (item.kind === 'feed_paused') return { to: 'feeds' };
  // The org's publishing held or released (#946): the channels page, where it is put on and taken off.
  if (item.kind === 'publishing_hold') return { to: 'channels' };
  // A queue running low (#1079): a new post for its channel, to fill it; the channels page when the channel is gone.
  if (item.kind === 'queue_low') return item.connectionId ? { to: 'compose', channelId: item.connectionId } : { to: 'channels' };
  return null;
}

// The unread count as the menu shows it; the list reports at most 100.
export function unreadLabel(n: number): string | null {
  if (n <= 0) return null;
  return n > 99 ? '99+' : String(n);
}
