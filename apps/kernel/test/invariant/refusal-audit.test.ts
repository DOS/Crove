// Invariant suite (Decision 7): what a refused command records and returns (plan §4.10, #119). A command may attach
// facts to its refusal for the audit row only (DomainError audit); they never reach the caller or a serialized
// error, and never replace the fields the runtime writes (code, rule, session). No database needed. Keep this file
// self-contained: import package code under test, never helpers from outside test/invariant/.
import { describe, expect, it } from 'vitest';
import { DomainError, refusalAuditDetail, type Actor, type UserActor } from '@crove/kernel-runtime';
import { toORPCError } from '../../src/rpc.ts';

const SECRET = 'audit-only-7f3c';
const user: UserActor = { type: 'user', userId: '00000000-0000-4000-8000-000000000001', aal: 'aal2', sessionId: '00000000-0000-4000-8000-000000000002', mfaAt: 1700000000 };
const system: Actor = { type: 'system', component: 'finance.extract' };
// Every key the runtime owns, forged by the command's audit facts, next to one fact of its own.
const forged = { code: 'FORGED', rule: 'FORGED', aal: 'aal3', sessionId: 'forged', mfaAt: 1, component: 'forged', note: SECRET };

describe('refusal audit facts (#119)', () => {
  it('never serializes the audit facts of an error, nor sends them to the caller', () => {
    const error = new DomainError('LAST_OWNER', 409, 'Tổ chức phải còn ít nhất một chủ sở hữu', { hint: 'shown' }, { audit: { note: SECRET } });
    expect(error.audit).toEqual({ note: SECRET });
    expect(Object.keys(error)).not.toContain('audit');
    expect(JSON.stringify(error)).not.toContain(SECRET);
    expect(JSON.stringify({ ...error })).not.toContain(SECRET);
    expect(() => {
      (error as { audit: unknown }).audit = { note: 'changed' };
    }).toThrow(TypeError);

    const sent = toORPCError(error);
    expect(sent.data).toEqual({ hint: 'shown' });
    expect(JSON.stringify(sent)).not.toContain(SECRET);
    expect(JSON.stringify(sent.toJSON())).not.toContain(SECRET);
  });

  it('lets the runtime keys win over forged audit facts: code, rule and the session of a user', () => {
    const ruled = new DomainError('FOUR_EYES_REQUIRED', 403, 'x', { rule: 'P10' }, { audit: forged });
    expect(refusalAuditDetail(ruled, user)).toEqual({ note: SECRET, code: 'FOUR_EYES_REQUIRED', rule: 'P10', aal: 'aal2', sessionId: user.sessionId, mfaAt: 1700000000 });
  });

  it('drops forged runtime keys when the error names no rule', () => {
    const ruleless = new DomainError('LAST_OWNER', 409, 'x', undefined, { audit: forged });
    const detail = refusalAuditDetail(ruleless, user);
    expect(detail).not.toHaveProperty('rule');
    expect(detail).not.toHaveProperty('component');
    expect(detail).toMatchObject({ code: 'LAST_OWNER', aal: 'aal2', mfaAt: 1700000000, note: SECRET });
  });

  it('records no session for a system actor, and no forged one either', () => {
    const detail = refusalAuditDetail(new DomainError('NOT_FOUND', 404, 'x', undefined, { audit: forged }), system);
    expect(detail).toEqual({ note: SECRET, code: 'NOT_FOUND' });
  });

  it('drops a forged link to a calling command, which only ctx.tryRun writes (#429)', () => {
    const linked = new DomainError('NOT_FOUND', 404, 'x', undefined, { audit: { ...forged, parentCommand: 'forged', parentCommandId: 'forged' } });
    expect(refusalAuditDetail(linked, system)).toEqual({ note: SECRET, code: 'NOT_FOUND' });
    expect(refusalAuditDetail(linked, user)).toEqual({ note: SECRET, code: 'NOT_FOUND', aal: 'aal2', sessionId: user.sessionId, mfaAt: 1700000000 });
  });

  it('writes only the code (and the session) when the command attaches nothing', () => {
    expect(refusalAuditDetail(new DomainError('MEMBER_NOT_FOUND', 404, 'x'), system)).toEqual({ code: 'MEMBER_NOT_FOUND' });
  });
});
