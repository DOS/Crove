// Team chat alerts (#863): which outbox events alert and as which kind, and the lists the database, the module and
// the API contract share.
import { describe, expect, it } from 'vitest';
import { SOCIAL_CHAT_ALERT_KINDS as STORED_KINDS, SOCIAL_CHAT_ALERT_TARGETS as STORED_TARGETS } from '@crove/db';
import { SOCIAL_CHAT_ALERT_KINDS as SENT_KINDS, SOCIAL_CHAT_ALERT_TARGETS as SENT_TARGETS } from '@crove/kernel-contract';
import { CHAT_ALERT_EVENTS, CHAT_ALERT_KINDS, CHAT_ALERT_TEST_CODES, CHAT_ALERTING_EVENTS, chatAlertKindOf, NOTIFYING_EVENTS, zChatAlertKinds } from '../src/index.ts';

describe('team chat alert kinds (#863)', () => {
  it('maps each alerting event to one kind, and nothing else', () => {
    expect(chatAlertKindOf('social.post.submitted')).toBe('needs_approval');
    expect(chatAlertKindOf('social.variant.failed')).toBe('failed');
    expect(chatAlertKindOf('social.variant.needs_attention')).toBe('failed');
    expect(chatAlertKindOf('social.variant.published')).toBe('published');
    expect(chatAlertKindOf('social.review.answered')).toBe('client_answered');
    for (const other of ['social.variant.decided', 'social.post.commented', 'kernel.channel.expired', 'toString', '__proto__', 'constructor']) expect(chatAlertKindOf(other)).toBeNull();
    // Every kind has an event that sends it.
    expect([...new Set(Object.values(CHAT_ALERT_EVENTS))].sort()).toEqual([...CHAT_ALERT_KINDS].sort());
  });

  it('hooks into the events the in-app notifications react to, and the published channel they do not', () => {
    expect(CHAT_ALERTING_EVENTS.filter((e) => !(NOTIFYING_EVENTS as readonly string[]).includes(e))).toEqual(['social.variant.published']);
  });

  it('keeps each picked kind once, in the settings order', () => {
    expect(zChatAlertKinds.parse(['published', 'needs_approval', 'published'])).toEqual(['needs_approval', 'published']);
    expect(zChatAlertKinds.safeParse([]).success).toBe(false);
    expect(zChatAlertKinds.safeParse(['decided']).success).toBe(false);
  });

  it('records test outcomes as codes the column accepts', () => {
    for (const code of CHAT_ALERT_TEST_CODES) expect(code).toMatch(/^[A-Z_]{1,64}$/);
  });

  // check-unions compares the database's CHECK on kind with the db copy; the API's copies must say the same.
  it('lists the same targets and kinds in the database types, the module and the API contract', () => {
    expect([...SENT_TARGETS]).toEqual([...STORED_TARGETS]);
    expect([...SENT_KINDS]).toEqual([...STORED_KINDS]);
    expect([...CHAT_ALERT_KINDS]).toEqual([...STORED_KINDS]);
  });
});
