// The org's address (issue #324), as the public tax registry records it: prefilled from the tax code lookup when a
// firm adds a client company, and changed in Settings. Owners and admins set or clear it; the runtime audits every
// change. The detail says whether it changed and keeps a marker naming the class in place of the old and the new value
// (a household business's address is a person's; auditValue, #1626). Stored as
// one line: runs of whitespace (line breaks included) become one space; other control characters are refused, as the
// column's CHECK constraint refuses them.
import { z } from 'zod';
import { auditValue } from '@crove/kernel-contract';
import { DomainError, defineCommand } from '@crove/kernel-runtime';
import { kernelManifest } from './manifest.ts';

const TENANT = kernelManifest.tables.crove_kernel.tenant;

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
  sideEffect: 'internal',
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
    const changed = before.address !== address;
    ctx.audit({ previous: auditValue(TENANT, 'address', before.address), address: auditValue(TENANT, 'address', address), changed });
    return { address };
  },
});

// The org's contact email (issue #669): where the org's own mail goes, today Finance's request for the purchase
// invoices the tax portal lists and Crove lacks. Owners and admins set or clear it in Settings; those mails name the
// org's inbound address (which only they see) as the Reply-To, so nobody else may redirect them, and a database guard
// (tenant_contact_email_guard) refuses any other writer. Stored lower-cased and trimmed. The audit row and the activity
// feed say that it changed, never the address: both are kept for good, an address is personal data.
export const CONTACT_EMAIL_MAX_LENGTH = 320;

export const setContactEmail = defineCommand({
  name: 'kernel.org.set_contact_email',
  input: z.object({ email: z.email().max(CONTACT_EMAIL_MAX_LENGTH).nullable() }),
  risk: 'R1',
  sideEffect: 'internal',
  access: ['owner', 'admin'],
  handler: async (ctx, input) => {
    const email = input.email === null ? null : input.email.trim().toLowerCase();
    const before = await ctx.trx.selectFrom('crove_kernel.tenant').select('contact_email').where('org_id', '=', ctx.orgId).executeTakeFirstOrThrow();
    const changed = before.contact_email !== email;
    if (changed) {
      await ctx.trx.updateTable('crove_kernel.tenant').set({ contact_email: email }).where('org_id', '=', ctx.orgId).execute();
      await ctx.activity('kernel.tenant', ctx.orgId, 'org.contact_email_changed', email ? 'Cập nhật email liên hệ của tổ chức' : 'Xóa email liên hệ của tổ chức');
    }
    ctx.audit({ changed, cleared: email === null });
    return { contactEmail: email };
  },
});
