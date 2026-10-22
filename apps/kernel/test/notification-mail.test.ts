// The Social notification mail (#579) for a queue running low (#1079): the link opens a new post for the channel, and
// no other path is accepted.
import { describe, expect, it } from 'vitest';
import { renderNotificationMail } from '../src/notification-mail.ts';

const CHANNEL = '0190a3c4-0000-7000-8000-000000000002';
const render = (payload: Record<string, unknown>) =>
  renderNotificationMail({
    messageId: 'm1',
    subject: 'Hàng đợi của kênh Trang thử sắp hết bài',
    payload,
    publicUrl: 'https://crove.example/',
    inboundAddress: null,
    execute: () => Promise.reject(new Error('not used')),
  });

describe('notification mail for a low queue (#1079)', () => {
  it('links to a new post for the channel and names the window', async () => {
    const mail = await render({ kind: 'queue_low', org: 'Cửa hàng A', post: null, channel: 'Trang thử', decision: null, days: '7', path: `/o/cua-hang-a/social/new?channel=${CHANNEL}` });
    expect(mail?.subject).toBe('Hàng đợi của kênh Trang thử sắp hết bài');
    expect(mail?.text).toContain(`Viết bài cho kênh này: https://crove.example/o/cua-hang-a/social/new?channel=${CHANNEL}`);
    expect(mail?.text).toContain('7 ngày tới');
    expect(mail?.html).toContain(`href="https://crove.example/o/cua-hang-a/social/new?channel=${CHANNEL}"`);
  });

  it('refuses any other new-post path', async () => {
    for (const path of ['/o/cua-hang-a/social/new', '/o/cua-hang-a/social/new?channel=x', `/o/cua-hang-a/social/new?channel=${CHANNEL}&next=//evil.example`, `/o/cua-hang-a/social/newxchannel=${CHANNEL}`]) {
      expect(await render({ kind: 'queue_low', org: 'Cửa hàng A', path })).toBeNull();
    }
  });
});
