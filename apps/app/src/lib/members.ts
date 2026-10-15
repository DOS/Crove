// Which member changes an owner confirms inline before they are sent (#119). The server enforces every rule (owners
// only, the org keeps an owner, fresh MFA); confirming only keeps one select change from moving owner rights by
// accident.
export const ROLE_LABEL = { owner: 'Chủ sở hữu', admin: 'Quản trị', member: 'Thành viên', viewer: 'Chỉ xem' } as const;
export type Role = keyof typeof ROLE_LABEL;
export const ROLES = Object.keys(ROLE_LABEL) as Role[];

export interface RoleChangeConfirmation {
  title: string;
  body: string;
  action: string;
}

// The confirmation a role change needs, or null when it is sent at once. Every change that gives or takes owner
// rights is confirmed: promoting to owner, demoting an owner, and so every change of the owner's own role.
export function roleChangeConfirmation(change: { name: string; from: Role; to: Role; self: boolean }): RoleChangeConfirmation | null {
  const { name, from, to, self } = change;
  if (from === to) return null;
  if (self) {
    return {
      title: `Đổi vai trò của bạn thành ${ROLE_LABEL[to]}?`,
      body: 'Bạn mất quyền chủ sở hữu ngay từ yêu cầu tiếp theo và không tự lấy lại được: chỉ một chủ sở hữu khác mới trả lại quyền này cho bạn.',
      action: 'Xác nhận đổi vai trò',
    };
  }
  if (to === 'owner') {
    return {
      title: `Đặt ${name} làm chủ sở hữu?`,
      body: 'Chủ sở hữu có toàn quyền như bạn: đổi vai trò và xóa thành viên, kể cả hạ vai trò của bạn hoặc xóa bạn khỏi tổ chức.',
      action: 'Xác nhận đặt làm chủ sở hữu',
    };
  }
  if (from === 'owner') {
    return {
      title: `Đổi vai trò của ${name} từ Chủ sở hữu thành ${ROLE_LABEL[to]}?`,
      body: 'Người này mất quyền chủ sở hữu ngay từ yêu cầu tiếp theo.',
      action: 'Xác nhận đổi vai trò',
    };
  }
  return null;
}
