import { z } from 'zod';
import { zId } from './schemas.ts';

// Built-in roles a member can hold on top of their base role (issue #1279, plan §4.6). The same list as the database's
// crove_kernel.role rows (roles.db.test.ts checks it). An org-wide role covers the whole org; external_accountant names
// one legal entity per assignment, and a member or viewer who holds only such assignments sees only those entities.
//   finance.chief_accountant  approves the ledger's proposals (P12), unlocks a period (ADR-0021) and marks the VAT
//                             return filed (#1508);
//   finance.entity_chief_accountant  unlocks the periods, and marks the VAT returns filed, of the legal entity it
//                             names, per assignment (#1507, #1508);
//   the others grant nothing more yet: they say what the member does, and their permissions come with their modules.
export const BUILTIN_ROLE_KEYS = [
  'finance.chief_accountant',
  'finance.accountant',
  'finance.viewer',
  'crm.sales',
  'desk.agent',
  'hr.manager',
  'external_accountant',
  'finance.entity_chief_accountant',
] as const;
export type BuiltinRoleKey = (typeof BUILTIN_ROLE_KEYS)[number];
export const zBuiltinRoleKey = z.enum(BUILTIN_ROLE_KEYS);

export const ROLE_SCOPE_VALUES = ['org', 'legal_entity'] as const;
export const zRoleScope = z.enum(ROLE_SCOPE_VALUES);

// Permissions a role grants that something checks today.
export const ROLE_PERMISSIONS = ['finance.proposal.approve', 'finance.period.unlock', 'finance.vat.file'] as const;
export type RolePermission = (typeof ROLE_PERMISSIONS)[number];
// One constant per permission, for the app's display gates (#1641): typed as a RolePermission, so a key that leaves
// ROLE_PERMISSIONS (which the manifest check keeps equal to the declared ones a role grants) fails typecheck, and
// apps/kernel/test/manifest-permissions.test.ts refuses a permission check in apps/app/src that passes anything else.
export const PROPOSAL_APPROVE_PERMISSION: RolePermission = 'finance.proposal.approve';
export const PERIOD_UNLOCK_PERMISSION: RolePermission = 'finance.period.unlock';

// A role the deployment offers (its module is installed), with what it grants.
export const zRoleCatalogEntry = z.object({
  key: zBuiltinRoleKey,
  scope: zRoleScope,
  permissions: z.array(z.string()),
});
export type RoleCatalogEntry = z.infer<typeof zRoleCatalogEntry>;

export const zRoleAssignment = z.object({
  id: zId,
  userId: zId,
  roleKey: zBuiltinRoleKey,
  // null: the whole org.
  legalEntityId: zId.nullable(),
  grantedAt: z.string(),
});
export type RoleAssignment = z.infer<typeof zRoleAssignment>;

export const zMemberRoles = z.object({
  roles: z.array(zRoleCatalogEntry),
  assignments: z.array(zRoleAssignment),
});
export type MemberRoles = z.infer<typeof zMemberRoles>;

// What an owner grants: a role to a member, for the whole org (legalEntityId null) or for one legal entity, as the
// role's scope requires.
export const zRoleAssignInput = z.object({
  userId: zId,
  roleKey: zBuiltinRoleKey,
  legalEntityId: zId.nullable(),
});
export type RoleAssignInput = z.infer<typeof zRoleAssignInput>;
