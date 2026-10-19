// The org's address (issue #324), as the public tax registry records it: prefilled from the tax code lookup when a
// firm adds a client company, and changed in Settings. Owners and admins set or clear it; the runtime audits every
// change, and the detail keeps the old and the new value (a registered address is public business data). Stored as
// one line: runs of whitespace (line breaks included) become one space; other control characters are refused, as the
// column's CHECK constraint refuses them.
import { z } from 'zod';
import { DomainError, defineCommand } from '@crove/kernel-runtime';

export const ADDRESS_MAX_LENGTH = 500;

// The stored form of an address, null for an empty one, or undefined when it cannot be stored.
export function normalizeAddress(raw: string): string | null | undefined {
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  if (oneLine === '') return null;
  if (oneLine.length > ADDRESS_MAX_LENGTH || /\p{Cc}/u.test(oneLine)) return undefined;
  return oneLine;
}

export const setAddress = defineCommand({
  name: 'kernel.org.set_address',
  input: z.object({ address: z.string().max(2000).nullable() }),
  risk: 'R1',
  access: ['owner', 'admin'],
  handler: async (ctx, input) => {
    const address = input.address === null ? null : normalizeAddress(input.address);
    if (address === undefined) {
      throw new DomainError('INVALID_ADDRESS', 422, `Địa chỉ không hợp lệ: một dòng, tối đa ${ADDRESS_MAX_LENGTH} ký tự`);
    }
    const before = await ctx.trx.selectFrom('crove_kernel.tenant').select('address').where('org_id', '=', ctx.orgId).executeTakeFirstOrThrow();
    if (before.address !== address) {
      await ctx.trx.updateTable('crove_kernel.tenant').set({ address }).where('org_id', '=', ctx.orgId).execute();
      await ctx.activity('kernel.tenant', ctx.orgId, 'org.address_changed', address ? `Đặt địa chỉ của tổ chức là ${address}` : 'Xóa địa chỉ của tổ chức');
    }
    ctx.audit({ previous: before.address, address });
    return { address };
  },
});
