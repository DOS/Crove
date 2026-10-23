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
    brand: 'Crove',
    inboundAddress: null,
    execute: () => Promise.reject(new Error('not used')),
  });

describe('notification mail for a post doing much better than usual (#1132)', () => {
  const POST = '0190a3c4-0000-7000-8000-000000000003';
  it('names the ratio the Vietnamese way, with the reach when there is one, and links to the post', async () => {
    const mail = await render({ kind: 'post_outperforming', org: 'Cửa hàng A', post: 'Khai trương', channel: 'Trang thử', decision: null, ratio: '2.5', reach: '3', path: `/o/cua-hang-a/social/${POST}` });
    expect(mail?.text).toContain('bài đã được tương tác gấp 2,5 lần mức thường lệ');
    expect(mail?.text).toContain('lượt tiếp cận gấp 3 lần');
    expect(mail?.text).toContain(`Mở bài viết: https://crove.example/o/cua-hang-a/social/${POST}`);
    const plain = await render({ kind: 'post_outperforming', org: 'Cửa hàng A', post: 'Khai trương', channel: 'Trang thử', ratio: '2', reach: null, path: `/o/cua-hang-a/social/${POST}` });
    expect(plain?.text).toContain('gấp 2 lần');
    expect(plain?.text).not.toContain('tiếp cận');
    // Reach below the usual is not named.
    for (const low of ['0', '0.5', '0.9']) {
      const mail = await render({ kind: 'post_outperforming', org: 'Cửa hàng A', ratio: '2', reach: low, path: `/o/cua-hang-a/social/${POST}` });
      expect(mail?.text).not.toContain('tiếp cận');
    }
  });

  it('refuses a ratio it did not write', async () => {
    for (const ratio of [undefined, '', '2,5', '1e9', '<b>9</b>', 3]) {
      expect(await render({ kind: 'post_outperforming', org: 'Cửa hàng A', ratio, path: `/o/cua-hang-a/social/${POST}` })).toBeNull();
    }
  });
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
