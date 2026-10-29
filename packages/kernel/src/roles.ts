// Role assignments (issue #1279, plan §4.6): the built-in roles a member can hold on top of their base role
// (crove_kernel.role, role_permission, role_assignment, 20261101060000_crove_kernel_roles.sql).
// - kernel.member.roles.list: owners and admins read the roles the deployment offers and who holds which.
// - kernel.member.role.assign / kernel.member.role.revoke: owners only, R3 (fresh MFA, P11), like every membership
//   change. The runtime audits each one; the detail names the member, the role, the legal entity and whether anything
//   changed. The definers they call check again that the caller owns the org, so no other path grants a role.
// What an assignment does: an org-wide finance.chief_accountant approves the ledger's proposals (P12, approval.ts) and
// unlocks a period (finance.period.unlock); an external_accountant assignment limits a member or viewer to its legal
// entity (enter_context's le_scope). Every check reads the assignments in the command's own transaction, so a revoke or
// a removal applies from the member's next command.
import { sql } from 'kysely';
import { z } from 'zod';
import { BUILTIN_ROLE_KEYS, zId, zRoleAssignInput, type BuiltinRoleKey, type MemberRoles, type RoleAssignment } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@crove/kernel-runtime';
import { lastChiefAccountant } from './approval.ts';
import { positionsHeldBy, rerouteStrandedTasks } from './task-reroute.ts';

const ADMINS: readonly MemberRole[] = ['owner', 'admin'];

// How the activity log and the refusals name each role.
export const ROLE_LABELS: Record<BuiltinRoleKey, string> = {
  'finance.chief_accountant': 'Kế toán trưởng',
  'finance.accountant': 'Kế toán viên',
  'finance.viewer': 'Người xem số liệu kế toán',
  'crm.sales': 'Nhân viên kinh doanh',
  'desk.agent': 'Nhân viên chăm sóc khách hàng',
  'hr.manager': 'Quản lý nhân sự',
  external_accountant: 'Kế toán thuê ngoài',
  'finance.entity_chief_accountant': 'Kế toán trưởng pháp nhân',
};

const isBuiltin = (key: string): key is BuiltinRoleKey => (BUILTIN_ROLE_KEYS as readonly string[]).includes(key);

// The roles of the catalog whose module the deployment runs ('kernel' always), with their permissions.
async function offeredRoles(ctx: QueryContext) {
  const rows = await ctx.trx
    .selectFrom('crove_kernel.role as r')
    .leftJoin('crove_kernel.role_permission as p', 'p.role_key', 'r.key')
    .select(['r.key', 'r.module', 'r.scope', 'p.permission'])
    .orderBy('r.key')
    .orderBy('p.permission')
    .execute();
  const roles = new Map<BuiltinRoleKey, MemberRoles['roles'][number]>();
  for (const row of rows) {
    if (!isBuiltin(row.key) || (row.module !== 'kernel' && !ctx.installed(row.module))) continue;
    const role = roles.get(row.key) ?? { key: row.key, scope: row.scope, permissions: [] };
    if (row.permission) role.permissions.push(row.permission);
    roles.set(row.key, role);
  }
  // In the order of the contract's list, so every screen shows them the same way.
  return BUILTIN_ROLE_KEYS.flatMap((key) => roles.get(key) ?? []);
}

export const memberRolesQuery = defineQuery({
  name: 'kernel.member.roles.list',
  input: z.object({}),
  access: ADMINS,
  handler: async (ctx): Promise<MemberRoles> => {
    const rows = await ctx.trx
      .selectFrom('crove_kernel.role_assignment')
      .select(['id', 'user_id', 'role_key', 'legal_entity_id', 'granted_at'])
      .where('org_id', '=', ctx.orgId)
      .orderBy('granted_at')
      .orderBy('id')
      .execute();
    const assignments: RoleAssignment[] = rows.flatMap((r) =>
      isBuiltin(r.role_key)
        ? [{ id: r.id, userId: r.user_id, roleKey: r.role_key, legalEntityId: r.legal_entity_id, grantedAt: new Date(r.granted_at).toISOString() }]
        : [],
    );
    return { roles: await offeredRoles(ctx), assignments };
  },
});

// The sorted permissions the signed-in user holds in the org in context through org-wide assignments (org.get).
export async function myPermissions(ctx: QueryContext): Promise<string[]> {
  if (ctx.actor.type !== 'user') return [];
  const rows = await ctx.trx
    .selectFrom('crove_kernel.role_assignment as a')
    .innerJoin('crove_kernel.role_permission as p', 'p.role_key', 'a.role_key')
    // A viewer holds no permission (crove_kernel.ctx_has_permission says the same).
    .innerJoin('crove_kernel.tenant_member as m', (join) => join.onRef('m.org_id', '=', 'a.org_id').onRef('m.user_id', '=', 'a.user_id'))
    .select('p.permission')
    .distinct()
    .where('a.org_id', '=', ctx.orgId)
    .where('a.user_id', '=', ctx.actor.userId)
    .where('a.legal_entity_id', 'is', null)
    .where('m.role', '<>', 'viewer')
    .orderBy('p.permission')
    .execute();
  return rows.map((r) => r.permission);
}

// Locks the actor's and the member's tenant_member rows, in user_id order (the order every membership change locks
// in), and refuses unless the actor is an owner and the member belongs to the org. A concurrent demotion of the owner
// or removal of the member is seen here, and an approval that reads the member's roles waits for this command.
async function lockForRoleChange(ctx: CommandContext, targetId: string): Promise<{ actorId: string; role: MemberRole }> {
  if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới giao được vai trò');
  const actorId = ctx.actor.userId;
  const rows = await ctx.trx
    .selectFrom('crove_kernel.tenant_member')
    .select(['user_id', 'role'])
    .where('org_id', '=', ctx.orgId)
    .where('user_id', 'in', [actorId, targetId])
    .orderBy('user_id')
    .forUpdate()
    .execute();
  if (rows.find((r) => r.user_id === actorId)?.role !== 'owner') {
    throw new DomainError('FORBIDDEN', 403, 'Chỉ chủ sở hữu mới giao hoặc thu hồi được vai trò');
  }
  const target = rows.find((r) => r.user_id === targetId);
  if (!target) throw new DomainError('MEMBER_NOT_FOUND', 404, 'Không tìm thấy thành viên này trong tổ chức');
  return { actorId, role: target.role };
}

interface PgError {
  code?: string;
  message?: string;
}

// The refusals of role_assignment_grant() and role_assignment_revoke() (P0001, the code as message) as domain errors.
function roleRefusal(error: unknown): never {
  const pg = error as PgError;
  if (pg?.code === 'P0001') {
    switch (pg.message) {
      case 'ROLE_MEMBER_NOT_FOUND':
        throw new DomainError('MEMBER_NOT_FOUND', 404, 'Không tìm thấy thành viên này trong tổ chức');
      case 'ROLE_NOT_FOUND':
        throw new DomainError('ROLE_NOT_FOUND', 422, 'Không có vai trò này');
      case 'ROLE_SCOPE_REQUIRED':
        throw new DomainError('ROLE_SCOPE_REQUIRED', 422, 'Vai trò này cần chọn một pháp nhân');
      case 'ROLE_SCOPE_NOT_ALLOWED':
        throw new DomainError('ROLE_SCOPE_NOT_ALLOWED', 422, 'Vai trò này áp dụng cho cả tổ chức, không chọn pháp nhân');
      case 'ROLE_LEGAL_ENTITY_NOT_FOUND':
        throw new DomainError('LEGAL_ENTITY_NOT_FOUND', 422, 'Không tìm thấy pháp nhân này trong tổ chức');
      case 'ROLE_SCOPE_NOT_FOR_ADMINS':
        throw new DomainError('ROLE_SCOPE_NOT_FOR_ADMINS', 422, 'Chủ sở hữu và quản trị viên luôn xem được mọi pháp nhân, nên không giới hạn theo pháp nhân được');
      case 'ROLE_PRIVILEGED_FOR_VIEWER':
        throw new DomainError(
          'ROLE_PRIVILEGED_FOR_VIEWER',
          422,
          'Người có vai trò Chỉ xem không được giao vai trò có quyền duyệt hay mở khóa sổ; hãy đổi họ thành Thành viên trước',
        );
      case 'LAST_CHIEF_ACCOUNTANT':
        throw lastChiefAccountant();
      case 'ROLE_GRANT_WIDENS_SCOPE':
        throw new DomainError(
          'ROLE_GRANT_WIDENS_SCOPE',
          409,
          'Thành viên này đang chỉ được xem một số pháp nhân. Giao vai trò cho cả tổ chức sẽ cho họ xem mọi pháp nhân, nên không giao được. Nếu muốn họ làm việc với cả tổ chức, hãy thu hồi các vai trò theo pháp nhân trước; pháp nhân cuối cùng chỉ gỡ được khi đổi họ thành Quản trị hoặc xóa họ khỏi tổ chức rồi mời lại',
        );
      case 'ROLE_ASSIGNMENT_NOT_FOUND':
        throw new DomainError('ROLE_ASSIGNMENT_NOT_FOUND', 404, 'Không tìm thấy vai trò này của thành viên');
      case 'ROLE_REVOKE_WIDENS_SCOPE':
        throw new DomainError(
          'ROLE_REVOKE_WIDENS_SCOPE',
          409,
          'Đây là pháp nhân cuối cùng mà thành viên này được xem. Thu hồi nó thì họ sẽ xem được mọi pháp nhân; nếu họ không còn làm việc cho tổ chức, hãy xóa họ khỏi tổ chức',
        );
    }
  }
  throw error;
}

export const assignRole = defineCommand({
  name: 'kernel.member.role.assign',
  input: zRoleAssignInput,
  risk: 'R3',
  sideEffect: 'internal',
  access: ['owner'],
  target: (input) => ({ type: 'kernel.user', id: input.userId }),
  handler: async (ctx, input): Promise<{ assignmentId: string; created: boolean }> => {
    await lockForRoleChange(ctx, input.userId);
    ctx.audit({ target_user: input.userId, role_key: input.roleKey, legal_entity_id: input.legalEntityId });
    // Only roles of a module the deployment runs: a role of a missing module would grant nothing anyone can use.
    const role = await ctx.trx.selectFrom('crove_kernel.role').select('module').where('key', '=', input.roleKey).executeTakeFirst();
    if (!role) throw new DomainError('ROLE_NOT_FOUND', 422, 'Không có vai trò này');
    if (role.module !== 'kernel' && !ctx.installed(role.module)) {
      throw new DomainError('ROLE_MODULE_NOT_INSTALLED', 422, 'Hệ thống này chưa cài phân hệ của vai trò này');
    }
    let granted: { assignment_id: string; created: boolean } | undefined;
    try {
      const { rows } = await sql<{ assignment_id: string; created: boolean }>`
        SELECT assignment_id, created FROM crove_kernel.role_assignment_grant(${input.userId}::uuid, ${input.roleKey}::text, ${input.legalEntityId}::uuid)`.execute(ctx.trx);
      granted = rows[0];
    } catch (error) {
      roleRefusal(error);
    }
    if (!granted) throw new Error('role_assignment_grant answered no row');
    ctx.audit({ assignment_id: granted.assignment_id, changed: granted.created });
    if (granted.created) {
      // A first legal-entity assignment narrows the person's scope: open tasks of their seats outside it go up (#1799).
      await rerouteStrandedTasks(ctx, await positionsHeldBy(ctx, input.userId));
      await ctx.activity(
        'kernel.member',
        input.userId,
        'member.role_assigned',
        `Giao vai trò ${ROLE_LABELS[input.roleKey]}${input.legalEntityId ? ' (cho một pháp nhân)' : ''}`,
      );
      await ctx.emit('kernel.member.role_assigned', { userId: input.userId, roleKey: input.roleKey, legalEntityId: input.legalEntityId, assignmentId: granted.assignment_id });
    }
    return { assignmentId: granted.assignment_id, created: granted.created };
  },
});

export const revokeRole = defineCommand({
  name: 'kernel.member.role.revoke',
  input: z.object({ assignmentId: zId }),
  risk: 'R3',
  sideEffect: 'internal',
  access: ['owner'],
  target: (input) => ({ type: 'kernel.role_assignment', id: input.assignmentId }),
  handler: async (ctx, input): Promise<{ assignmentId: string }> => {
    const found = await ctx.trx
      .selectFrom('crove_kernel.role_assignment')
      .select('user_id')
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.assignmentId)
      .executeTakeFirst();
    if (!found) throw new DomainError('ROLE_ASSIGNMENT_NOT_FOUND', 404, 'Không tìm thấy vai trò này của thành viên');
    await lockForRoleChange(ctx, found.user_id);
    let revoked: { user_id: string; role_key: string; legal_entity_id: string | null } | undefined;
    try {
      const { rows } = await sql<{ user_id: string; role_key: string; legal_entity_id: string | null }>`
        SELECT user_id, role_key, legal_entity_id FROM crove_kernel.role_assignment_revoke(${input.assignmentId}::uuid)`.execute(ctx.trx);
      revoked = rows[0];
    } catch (error) {
      roleRefusal(error);
    }
    if (!revoked) throw new Error('role_assignment_revoke answered no row');
    ctx.audit({ target_user: revoked.user_id, role_key: revoked.role_key, legal_entity_id: revoked.legal_entity_id, assignment_id: input.assignmentId });
    // Revoking an org-wide or an entity assignment can narrow the person's scope (#1799).
    await rerouteStrandedTasks(ctx, await positionsHeldBy(ctx, revoked.user_id));
    const label = isBuiltin(revoked.role_key) ? ROLE_LABELS[revoked.role_key] : revoked.role_key;
    await ctx.activity('kernel.member', revoked.user_id, 'member.role_revoked', `Thu hồi vai trò ${label}${revoked.legal_entity_id ? ' (của một pháp nhân)' : ''}`);
    await ctx.emit('kernel.member.role_revoked', {
      userId: revoked.user_id,
      roleKey: revoked.role_key,
      legalEntityId: revoked.legal_entity_id,
      assignmentId: input.assignmentId,
    });
    return { assignmentId: input.assignmentId };
  },
});

export const roleCommands = [assignRole, revokeRole];
export const roleQueries = [memberRolesQuery];
