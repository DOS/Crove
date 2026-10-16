// Which role changes the settings screen confirms inline before sending them (#119).
import { describe, expect, it } from 'vitest';
import { translatorFor } from '../src/i18n/runtime.ts';
import { ROLES, roleChangeConfirmation, roleChangeKind, type Role } from '../src/lib/members.ts';

const vi = translatorFor('vi');
const change = (from: Role, to: Role, self = false) => {
  const kind = roleChangeKind({ from, to, self });
  return kind && roleChangeConfirmation(kind, { name: 'An', to }, vi);
};

describe('roleChangeConfirmation', () => {
  it("confirms every change of the owner's own role", () => {
    for (const to of ['admin', 'member', 'viewer'] as const) {
      expect(change('owner', to, true)).toMatchObject({ title: expect.stringContaining('vai trò của bạn'), action: 'Xác nhận đổi vai trò' });
    }
  });

  it('confirms a promotion to owner and the demotion of another owner', () => {
    for (const from of ['admin', 'member', 'viewer'] as const) {
      expect(change(from, 'owner')).toMatchObject({ title: 'Đặt An làm chủ sở hữu?', action: 'Xác nhận đặt làm chủ sở hữu' });
    }
    for (const to of ['admin', 'member', 'viewer'] as const) {
      expect(change('owner', to)?.title).toContain('từ Chủ sở hữu');
    }
  });

  it('keeps the reason, not the words, so the same pending change reads in either locale', () => {
    expect(roleChangeKind({ from: 'owner', to: 'admin', self: true })).toBe('self');
    expect(roleChangeKind({ from: 'owner', to: 'admin', self: false })).toBe('demote');
    expect(roleChangeConfirmation('demote', { name: 'An', to: 'admin' }, translatorFor('en')).title).toBe(
      translatorFor('en')('members.demoteTitle', { name: 'An', role: translatorFor('en')('roles.admin') }),
    );
  });

  it('sends other role changes at once, and never asks for a change that changes nothing', () => {
    const plain = ['admin', 'member', 'viewer'] as const;
    for (const from of plain) for (const to of plain) expect(change(from, to)).toBeNull();
    for (const role of ROLES) expect(change(role, role, role === 'owner')).toBeNull();
  });

  it('speaks the given locale', () => {
    expect(roleChangeKind({ from: 'member', to: 'owner', self: false })).toBe('promote');
    expect(roleChangeConfirmation('promote', { name: 'An', to: 'owner' }, translatorFor('en'))).toMatchObject({
      title: 'Make An an owner?',
      action: 'Confirm new owner',
    });
  });
});
