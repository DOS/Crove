// The org's approval policy preset (issue #1402, plan §4.7): founder (owners, admins and the chief accountant approve
// the ledger's proposals) or accountant (P09: only a human holding the ledger's approval permission does). Only an
// owner switches it, R3 (a second factor, P11), audited with the old and the new preset and the new version. The
// tenant_approval_policy_guard and tenant_approval_policy_requires_audit triggers refuse any other write of it.
import { z } from 'zod';
import { DomainError, defineCommand } from '@crove/kernel-runtime';
import { ledgerApproverCount, orgApprovalPolicy } from './approval.ts';

export const setApprovalPreset = defineCommand({
  name: 'kernel.org.set_approval_preset',
  input: z.object({ preset: z.string().regex(/^[a-z][a-z0-9_]*$/).max(50) }),
  risk: 'R3',
  sideEffect: 'internal',
  access: ['owner'],
  handler: async (ctx, input) => {
    // The tenant row first, so two switches meet on it and each version is used once.
    const before = await ctx.trx
      .selectFrom('crove_kernel.tenant')
      .select(['approval_preset', 'approval_policy_version'])
      .where('org_id', '=', ctx.orgId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const preset = await ctx.trx
      .selectFrom('crove_kernel.approval_preset')
      .select(['key', 'ledger_chief_accountant_only'])
      .where('key', '=', input.preset)
      .executeTakeFirst();
    if (!preset) throw new DomainError('UNKNOWN_PRESET', 422, 'Không có bộ quy tắc duyệt này');
    let version = before.approval_policy_version;
    if (before.approval_preset !== preset.key) {
      // Liveness: with nobody holding the permission, no proposal of the ledger could be approved.
      if (preset.ledger_chief_accountant_only && (await ledgerApproverCount(ctx.trx, ctx.orgId)) === 0) {
        throw new DomainError('NO_CHIEF_ACCOUNTANT', 422, 'Hãy giao vai trò kế toán trưởng cho một thành viên trước khi chọn bộ quy tắc này');
      }
      version += 1;
      await ctx.trx
        .updateTable('crove_kernel.tenant')
        .set({ approval_preset: preset.key, approval_policy_version: version })
        .where('org_id', '=', ctx.orgId)
        .execute();
      const summary = preset.ledger_chief_accountant_only
        ? 'Chọn quy tắc duyệt cho công ty kế toán: chỉ kế toán trưởng duyệt bút toán'
        : 'Chọn quy tắc duyệt mặc định: chủ sở hữu, quản trị viên và kế toán trưởng duyệt bút toán';
      await ctx.activity('kernel.tenant', ctx.orgId, 'org.approval_preset_changed', summary);
    }
    ctx.audit({ previous: before.approval_preset, preset: preset.key, version });
    const policy = await orgApprovalPolicy(ctx.trx, ctx.orgId);
    return { preset: policy.preset, version: policy.version };
  },
});
