// Member roles in Settings (issue #1279): which roles an owner may still give a member. The kernel checks again.
import type { MemberRoles, RoleAssignment } from '@crove/kernel-contract';

type CatalogRole = MemberRoles['roles'][number];

// An entity role (external_accountant) names one legal entity per assignment.
export const roleNeedsEntity = (role: Pick<CatalogRole, 'scope'>) => role.scope === 'legal_entity';

// The roles the member does not hold yet. An entity role may be given again for another entity, but never to an owner
// or admin: they see every entity anyway, so the kernel refuses it (ROLE_SCOPE_NOT_FOR_ADMINS).
export function assignableRoles(catalog: readonly CatalogRole[], held: readonly Pick<RoleAssignment, 'roleKey'>[], baseRole: string): CatalogRole[] {
  const admin = baseRole === 'owner' || baseRole === 'admin';
  return catalog.filter((role) => (roleNeedsEntity(role) ? !admin : !held.some((a) => a.roleKey === role.key)));
}
