// Member roles in Settings (issue #1279): which roles an owner may still give a member. The kernel checks again.
import type { MemberRoles, RoleAssignment } from '@crove/kernel-contract';

type CatalogRole = MemberRoles['roles'][number];

// An entity role (external_accountant) names one legal entity per assignment.
export const roleNeedsEntity = (role: Pick<CatalogRole, 'scope'>) => role.scope === 'legal_entity';

// The roles an owner may still give the member, as the kernel decides:
// - an entity role, again for another entity, but never to an owner or admin: they see every entity anyway
//   (ROLE_SCOPE_NOT_FOR_ADMINS);
// - an org-wide role the member does not hold yet, but never to a member limited to some entities, whom it would lift
//   to every entity (ROLE_GRANT_WIDENS_SCOPE);
// - never a role that grants a permission to a viewer (ROLE_PRIVILEGED_FOR_VIEWER).
export function assignableRoles(catalog: readonly CatalogRole[], held: readonly Pick<RoleAssignment, 'roleKey' | 'legalEntityId'>[], baseRole: string): CatalogRole[] {
  const admin = baseRole === 'owner' || baseRole === 'admin';
  const limited = !admin && held.length > 0 && held.every((a) => a.legalEntityId !== null);
  return catalog.filter((role) => {
    if (baseRole === 'viewer' && role.permissions.length > 0) return false;
    if (roleNeedsEntity(role)) return !admin;
    return !limited && !held.some((a) => a.roleKey === role.key);
  });
}
