// Proposal reminders (#676): which stages are due, when a proposal expires (#876), and the reminder mail.
import { describe, expect, it } from 'vitest';
import { expiryDue, nudgesDue } from '@crove/kernel';
import { renderProposalReminderMail } from '../src/proposal-reminder-mail.ts';

const DAY = 86_400_000;
const now = new Date('2026-10-21T08:00:00Z');
const ago = (days: number) => new Date(now.getTime() - days * DAY);

describe('nudgesDue', () => {
  const policy = { remindAfterDays: 2, escalateAfterDays: 5, expireAfterDays: null };
  it('reminds after the first threshold and escalates after the second, each once', () => {
    expect(nudgesDue({ status: 'pending', createdAt: ago(1), remindedAt: null, escalatedAt: null }, policy, now)).toEqual([]);
    expect(nudgesDue({ status: 'pending', createdAt: ago(2), remindedAt: null, escalatedAt: null }, policy, now)).toEqual(['remind']);
    expect(nudgesDue({ status: 'pending', createdAt: ago(3), remindedAt: ago(1), escalatedAt: null }, policy, now)).toEqual([]);
    expect(nudgesDue({ status: 'pending', createdAt: ago(6), remindedAt: ago(4), escalatedAt: null }, policy, now)).toEqual(['escalate']);
    expect(nudgesDue({ status: 'pending', createdAt: ago(6), remindedAt: null, escalatedAt: null }, policy, now)).toEqual(['remind', 'escalate']);
    expect(nudgesDue({ status: 'pending', createdAt: ago(9), remindedAt: ago(7), escalatedAt: ago(4) }, policy, now)).toEqual([]);
  });

  it('does nothing for a decided proposal or a stage that is off', () => {
    for (const status of ['approved', 'executed', 'rejected', 'failed']) {
      expect(nudgesDue({ status, createdAt: ago(30), remindedAt: null, escalatedAt: null }, policy, now), status).toEqual([]);
    }
    expect(nudgesDue({ status: 'pending', createdAt: ago(30), remindedAt: null, escalatedAt: null }, { remindAfterDays: null, escalateAfterDays: null, expireAfterDays: null }, now)).toEqual([]);
    expect(nudgesDue({ status: 'pending', createdAt: ago(30), remindedAt: null, escalatedAt: null }, { remindAfterDays: null, escalateAfterDays: 7, expireAfterDays: null }, now)).toEqual(['escalate']);
  });
});

describe('expiryDue (#876)', () => {
  const policy = { remindAfterDays: 2, escalateAfterDays: 5, expireAfterDays: 14 };
  it('expires a pending proposal once it waited the days the org set, and not before', () => {
    expect(expiryDue({ status: 'pending', createdAt: ago(13) }, policy, now)).toBe(false);
    expect(expiryDue({ status: 'pending', createdAt: new Date(now.getTime() - 14 * DAY + 1) }, policy, now)).toBe(false);
    expect(expiryDue({ status: 'pending', createdAt: ago(14) }, policy, now)).toBe(true);
    expect(expiryDue({ status: 'pending', createdAt: ago(40) }, policy, now)).toBe(true);
  });

  it('never expires a proposal that is not pending, nor anything while expiry is off', () => {
    for (const status of ['approved', 'executed', 'rejected', 'failed', 'expired']) {
      expect(expiryDue({ status, createdAt: ago(90) }, policy, now), status).toBe(false);
    }
    expect(expiryDue({ status: 'pending', createdAt: ago(90) }, { ...policy, expireAfterDays: null }, now)).toBe(false);
  });
});

describe('proposal reminder mail', () => {
  const input = (payload: Record<string, unknown>, subject: string | null = 'Đề xuất chờ bạn duyệt đã 3 ngày') => ({
    publicUrl: 'https://crove.example.com/',
    subject,
    payload,
  });
  const path = '/o/cong-ty-a/inbox/0192f0aa-1111-7222-8333-944445555666';

  it('renders a reminder and an escalation with the link to the proposal', async () => {
    const remind = await renderProposalReminderMail(input({ stage: 'remind', org: 'Công ty A', title: 'Hóa đơn 0001234', days: 3, path }) as never);
    expect(remind?.subject).toBe('Đề xuất chờ bạn duyệt đã 3 ngày');
    expect(remind?.text).toContain('Một đề xuất đang chờ bạn duyệt đã 3 ngày.');
    expect(remind?.text).toContain(`Mở đề xuất: https://crove.example.com${path}`);
    expect(remind?.html).toContain(`href="https://crove.example.com${path}"`);
    const escalate = await renderProposalReminderMail(input({ stage: 'escalate', org: 'Công ty A', title: null, days: 6, path }, null) as never);
    expect(escalate?.subject).toBe('Một đề xuất của tổ chức chưa được ai duyệt sau 6 ngày.');
    expect(escalate?.text).not.toContain('Đề xuất:');
  });

  it('escapes text and refuses a path, stage or day count it does not expect', async () => {
    const mail = await renderProposalReminderMail(input({ stage: 'remind', org: '<b>A</b>', title: '<script>x</script>\nline', days: 3, path }) as never);
    expect(mail?.html).not.toContain('<script>');
    expect(mail?.html).toContain('&lt;script&gt;x&lt;/script&gt; line');
    for (const bad of [
      { stage: 'remind', org: 'A', days: 3, path: 'https://evil.example.com/x' },
      { stage: 'remind', org: 'A', days: 3, path: '/o/a/social/channels' },
      { stage: 'approve', org: 'A', days: 3, path },
      { stage: 'toString', org: 'A', days: 3, path },
      { stage: 'remind', org: 'A', days: -1, path },
      { stage: 'remind', org: 'A', days: 1.5, path },
      { stage: 'remind', days: 3, path },
    ]) {
      expect(await renderProposalReminderMail(input(bad) as never), JSON.stringify(bad)).toBeNull();
    }
  });
});
