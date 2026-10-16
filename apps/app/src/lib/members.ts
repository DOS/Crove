// Which member changes an owner confirms inline before they are sent (#119). The server enforces every rule (owners
// only, the org keeps an owner, fresh MFA); confirming only keeps one select change from moving owner rights by
// accident.
import type { Translate } from '../i18n/runtime.ts';

export const ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export interface RoleChangeConfirmation {
  title: string;
  body: string;
  action: string;
}

// The confirmation a role change needs, or null when it is sent at once. Every change that gives or takes owner
// rights is confirmed: promoting to owner, demoting an owner, and so every change of the owner's own role.
export function roleChangeConfirmation(
  change: { name: string; from: Role; to: Role; self: boolean },
  t: Translate,
): RoleChangeConfirmation | null {
  const { name, from, to, self } = change;
  if (from === to) return null;
  const role = t(`roles.${to}`);
  if (self) {
    return { title: t('members.selfTitle', { role }), body: t('members.selfBody'), action: t('members.confirmRole') };
  }
  if (to === 'owner') {
    return { title: t('members.promoteTitle', { name }), body: t('members.promoteBody'), action: t('members.confirmPromote') };
  }
  if (from === 'owner') {
    return { title: t('members.demoteTitle', { name, role }), body: t('members.demoteBody'), action: t('members.confirmRole') };
  }
  return null;
}
