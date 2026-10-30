// What an outbox event may carry (#1949): ids and codes only. ctx.emit refuses anything else, so every emitting test
// in the repository checks its events; this file pins the rule itself.
import { describe, expect, it } from 'vitest';
import { eventCode, eventPayloadProblem, normalizeEventPayload } from '../src/event-payload.ts';

describe('eventPayloadProblem', () => {
  it('lets ids, codes, numbers, booleans and nulls through, nested', () => {
    expect(
      eventPayloadProblem({
        proposalId: '0193a3f4-5b6c-7d8e-9f01-23456789abcd',
        kind: 'finance.purchase',
        command: 'finance.purchase.record',
        status: 'token_expired',
        reason: 'refresh_refused:invalid_grant',
        period: '2026-Q3',
        at: '2026-10-30T12:00:00.000Z',
        offset: '2026-10-30T19:00:00+07:00',
        amount: '-1250000.5000',
        count: 3,
        ratio: 0.25,
        held: false,
        legalEntityId: null,
        taskIds: ['0193a3f4-5b6c-7d8e-9f01-23456789abcd'],
        nested: { scope: 'global', empty: '' },
        bankAccount: '112100001',
        absent: undefined,
      }),
    ).toBeNull();
  });

  it('refuses free text, a name, an email, a phone number or tax code, and says where without the value', () => {
    const cases: Array<[unknown, string]> = [
      [{ title: 'HĐ 0001 Công ty An Phát' }, 'payload.title: a string that is neither an id nor a code'],
      [{ draft: { payload: { seller: { name: 'Nguyễn Văn A' } } } }, 'payload.draft.payload.seller.name: a string that is neither an id nor a code'],
      [{ to: 'ketoan@example.com' }, 'payload.to: a string that is neither an id nor a code'],
      [{ phone: '0901234567' }, 'payload.phone: a key that names personal data'],
      [{ sellerTaxCode: '0101234564' }, 'payload.sellerTaxCode: a key that names personal data'],
      [{ to: { email: 'x' } }, 'payload.to.email: a key that names personal data'],
      [{ recipients: ['a'] }, 'payload.recipients: a key that names personal data'],
      [{ display_name: 'Lan' }, 'payload.display_name: a key that names personal data'],
      [{ title: 'Rà soát bài' }, 'payload.title: a string that is neither an id nor a code'],
      [{ reason: 'refresh refused (invalid_grant)' }, 'payload.reason: a string that is neither an id nor a code'],
      [{ list: ['ok', 'two words'] }, 'payload.list[1]: a string that is neither an id nor a code'],
      [{ long: 'x'.repeat(201) }, 'payload.long: a string longer than 200 characters'],
      [{ n: Number.NaN }, 'payload.n: not a finite number'],
    ];
    for (const [payload, problem] of cases) expect(eventPayloadProblem(payload), JSON.stringify(payload)).toBe(problem);
  });

  it('reduces a code a provider gave to a code, under the code keys only', () => {
    expect(normalizeEventPayload({ code: 'refresh refused (invalid_grant)', reason: '(oops) x', error: 'Lỗi', nested: { errorCode: 'a b' }, title: 'a b' })).toEqual({
      code: 'refresh',
      reason: 'other',
      error: 'L',
      nested: { errorCode: 'a' },
      title: 'a b',
    });
    // Only the leading word: what follows may name an account, and never reaches the event.
    expect(normalizeEventPayload({ reason: 'refused for ketoan@example.com' })).toEqual({ reason: 'refused' });
    expect(normalizeEventPayload({ reason: 'invalid_grant:ketoan@example.com' })).toEqual({ reason: 'invalid_grant' });
    expect(JSON.stringify(normalizeEventPayload({ code: 'Account Nguyen Van A (0901234567) blocked' }))).not.toMatch(/Nguyen|0901234567/);
    expect(eventCode('(((')).toBe('other');
    expect(eventPayloadProblem(normalizeEventPayload({ code: 'Rate limit hit, retry later' }))).toBeNull();
  });

  it("lets a task title through only as its event type's template (#1970)", () => {
    const task = (title: string) => ({ post_id: '0193a3f4-5b6c-7d8e-9f01-23456789abcd', agent_task: { title, ref: { type: 'social.post', id: '0193a3f4-5b6c-7d8e-9f01-23456789abcd' } } });
    expect(eventPayloadProblem(task('Rà soát bài gửi duyệt: 2 kênh'), 'social.post.submitted')).toBeNull();
    expect(eventPayloadProblem({ agent_task: { title: 'Khách hủy lịch hẹn' } }, 'crm.booking.cancelled')).toBeNull();
    const refused = 'payload.agent_task.title: a string that is neither an id nor a code';
    // Another type's template, a template with an org's words added, and the template under another key.
    expect(eventPayloadProblem(task('Rà soát bài gửi duyệt: 2 kênh'), 'crm.booking.cancelled')).toBe(refused);
    expect(eventPayloadProblem({ agent_task: { title: 'Khách hủy lịch hẹn: Tư vấn với chị Lan' } }, 'crm.booking.cancelled')).toBe(refused);
    expect(eventPayloadProblem(task('Rà soát bài gửi duyệt: 2 kênh'), 'social.post.created')).toBe(refused);
    expect(eventPayloadProblem({ title: 'Khách hủy lịch hẹn' }, 'crm.booking.cancelled')).toBe('payload.title: a string that is neither an id nor a code');
    // The session revoke carries no identity provider subject any more: a non-uuid one is refused like any text.
    expect(eventPayloadProblem({ subject: 'auth0|abc' }, 'kernel.session.revoked')).toBe('payload.subject: a string that is neither an id nor a code');
  });

  it('refuses a payload nested too deep', () => {
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 9; i++) deep = { d: deep };
    expect(eventPayloadProblem(deep)).toMatch(/nested deeper than 8/);
  });
});
