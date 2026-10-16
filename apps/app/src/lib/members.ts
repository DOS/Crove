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

// Why a role change needs confirming: the owner's own role, a promotion to owner, or the demotion of another owner.
export type RoleChangeKind = 'self' | 'promote' | 'demote';

// Whether a role change is confirmed first, and why; null when it is sent at once. Every change that gives or takes
// owner rights is confirmed: promoting to owner, demoting an owner, and so every change of the owner's own role.
export function roleChangeKind(change: { from: Role; to: Role; self: boolean }): RoleChangeKind | null {
  const { from, to, self } = change;
  if (from === to) return null;
  if (self) return 'self';
  if (to === 'owner') return 'promote';
  if (from === 'owner') return 'demote';
  return null;
}

// The words of the confirmation, made while rendering so they follow the active locale (issue #215).
export function roleChangeConfirmation(kind: RoleChangeKind, change: { name: string; to: Role }, t: Translate): RoleChangeConfirmation {
  const { name } = change;
  const role = t(`roles.${change.to}`);
  if (kind === 'self') return { title: t('members.selfTitle', { role }), body: t('members.selfBody'), action: t('members.confirmRole') };
  if (kind === 'promote') return { title: t('members.promoteTitle', { name }), body: t('members.promoteBody'), action: t('members.confirmPromote') };
  return { title: t('members.demoteTitle', { name, role }), body: t('members.demoteBody'), action: t('members.confirmRole') };
}
