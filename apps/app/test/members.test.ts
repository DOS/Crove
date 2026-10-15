// Which role changes the settings screen confirms inline before sending them (#119).
import { describe, expect, it } from 'vitest';
import { ROLES, roleChangeConfirmation, type Role } from '../src/lib/members.ts';

const change = (from: Role, to: Role, self = false) => roleChangeConfirmation({ name: 'An', from, to, self });

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

  it('sends other role changes at once, and never asks for a change that changes nothing', () => {
    const plain = ['admin', 'member', 'viewer'] as const;
    for (const from of plain) for (const to of plain) expect(change(from, to)).toBeNull();
    for (const role of ROLES) expect(change(role, role, role === 'owner')).toBeNull();
  });
});
