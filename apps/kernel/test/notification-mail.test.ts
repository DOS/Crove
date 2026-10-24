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

  it('links to a new post only for a low queue (#1095)', async () => {
    for (const kind of ['review_requested', 'failed', 'channel_expired', 'mention', 'post_outperforming']) {
      expect(await render({ kind, org: 'Cửa hàng A', post: null, channel: 'Trang thử', ratio: '3.0', path: `/o/cua-hang-a/social/new?channel=${CHANNEL}` }), kind).toBeNull();
    }
    expect(await render({ kind: 'channel_expired', org: 'Cửa hàng A', post: null, channel: 'Trang thử', path: '/o/cua-hang-a/social/channels' })).not.toBeNull();
  });
});

describe('notification mail for an assignment and its due date (#1359)', () => {
  const POST = '0190a3c4-0000-7000-8000-000000000003';
  it('tells the assignee a post is due soon or overdue, with the due date, and links to the post', async () => {
    const soon = await render({ kind: 'assignment_due', org: 'Cửa hàng A', post: 'Khai trương', stage: 'soon', due: '14:30 26/10/2026', path: `/o/cua-hang-a/social/${POST}` });
    expect(soon?.text).toContain('sẽ đến hạn trong vòng 24 giờ tới');
    expect(soon?.text).toContain('Hạn: 14:30 26/10/2026');
    expect(soon?.text).toContain(`Mở bài viết: https://crove.example/o/cua-hang-a/social/${POST}`);
    expect(soon?.html).toContain('Hạn: 14:30 26/10/2026');
    const overdue = await render({ kind: 'assignment_due', org: 'Cửa hàng A', post: 'Khai trương', stage: 'overdue', due: '14:30 26/10/2026', path: `/o/cua-hang-a/social/${POST}` });
    expect(overdue?.text).toContain('đã quá hạn mà vẫn chưa đăng');
    // A due date it did not write is left out; a stage it does not know renders nothing.
    const odd = await render({ kind: 'assignment_due', org: 'Cửa hàng A', stage: 'soon', due: '<b>mai</b>', path: `/o/cua-hang-a/social/${POST}` });
    expect(odd?.text).not.toContain('Hạn:');
    expect(await render({ kind: 'assignment_due', org: 'Cửa hàng A', stage: 'later', path: `/o/cua-hang-a/social/${POST}` })).toBeNull();
  });

  it('tells of an assignment, and of a bulk one with a link to the posts assigned to the reader', async () => {
    const one = await render({ kind: 'assigned', org: 'Cửa hàng A', post: 'Khai trương', path: `/o/cua-hang-a/social/${POST}` });
    expect(one?.text).toContain('Bạn vừa được giao một bài');
    expect(one?.text).toContain(`Mở bài viết: https://crove.example/o/cua-hang-a/social/${POST}`);
    const many = await render({ kind: 'assigned', org: 'Cửa hàng A', count: '3', path: '/o/cua-hang-a/social?assignee=me' });
    expect(many?.text).toContain('Bạn vừa được giao 3 bài');
    expect(many?.text).toContain('Xem các bài được giao cho bạn: https://crove.example/o/cua-hang-a/social?assignee=me');
    expect(many?.html).toContain('href="https://crove.example/o/cua-hang-a/social?assignee=me"');
    // A count it did not write is not shown.
    expect((await render({ kind: 'assigned', org: 'Cửa hàng A', count: '<i>9</i>', path: '/o/cua-hang-a/social?assignee=me' }))?.text).toContain('Bạn vừa được giao một bài');
  });

  it('links to the assigned posts only for an assignment, and accepts no other list path', async () => {
    for (const kind of ['review_requested', 'assignment_due', 'queue_low']) {
      expect(await render({ kind, org: 'Cửa hàng A', stage: 'soon', path: '/o/cua-hang-a/social?assignee=me' }), kind).toBeNull();
    }
    for (const path of ['/o/cua-hang-a/social?assignee=other', '/o/cua-hang-a/social?assignee=me&next=//evil.example', '/o/cua-hang-a/social', '/o/cua-hang-a/socialxassignee=me']) {
      expect(await render({ kind: 'assigned', org: 'Cửa hàng A', path }), path).toBeNull();
    }
  });
});
