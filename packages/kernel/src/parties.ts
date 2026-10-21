// A party, a vendor or a customer (#887): its name and contact details corrected by hand. Owners, admins and members
// edit them (R1). The editor sends the version it read: when someone else saved in between, the edit is refused
// rather than silently overwriting theirs. The runtime audits every edit; the detail keeps the old and the new name,
// tax code and address (public business data) and only the names of the other fields that changed (an email or a
// phone may be a person's).
// The tax code is how an e-invoice finds its party (finance's upsertParty), so it can be added to a party without one
// but never changed or removed: a party recorded under a wrong tax code is merged with "mark duplicate" (#887).
import { z } from 'zod';
import { normalizeTaxCode, zId } from '@crove/kernel-contract';
import { DomainError, defineCommand } from '@crove/kernel-runtime';
import { normalizeAddress } from './org-address.ts';

export const PARTY_NAME_MAX_LENGTH = 300;
const EMAIL_MAX_LENGTH = 254;
const PHONE_PATTERN = /^\+?[0-9 ().-]{3,30}$/;

// Each field as stored: one line, no control characters, null when empty, undefined when it cannot be stored.
function oneLine(raw: string, max: number): string | null | undefined {
  const value = raw.replace(/\s+/g, ' ').trim();
  if (value === '') return null;
  return value.length > max || /\p{Cc}/u.test(value) ? undefined : value;
}

function normalizeEmail(raw: string | null): string | null | undefined {
  const value = raw === null ? null : oneLine(raw, EMAIL_MAX_LENGTH);
  if (!value) return value;
  return z.email().safeParse(value).success ? value : undefined;
}

function normalizePhone(raw: string | null): string | null | undefined {
  const value = raw === null ? null : oneLine(raw, 30);
  if (!value) return value;
  return PHONE_PATTERN.test(value) ? value : undefined;
}

const zText = (max: number) => z.string().max(max).nullable();

export const updateParty = defineCommand({
  name: 'kernel.party.update',
  input: z.object({
    partyId: zId,
    version: z.number().int().min(1),
    name: z.string().max(1000),
    taxCode: zText(40),
    address: zText(2000),
    email: zText(1000),
    phone: zText(100),
  }),
  risk: 'R1',
  access: ['owner', 'admin', 'member'],
  handler: async (ctx, input) => {
    const name = oneLine(input.name, PARTY_NAME_MAX_LENGTH);
    if (!name) throw new DomainError('INVALID_PARTY_NAME', 422, `Tên không hợp lệ: một dòng, tối đa ${PARTY_NAME_MAX_LENGTH} ký tự`);
    const address = input.address === null ? null : normalizeAddress(input.address);
    if (address === undefined) throw new DomainError('INVALID_ADDRESS', 422, 'Địa chỉ không hợp lệ: một dòng, tối đa 500 ký tự');
    const email = normalizeEmail(input.email);
    if (email === undefined) throw new DomainError('INVALID_EMAIL', 422, 'Email không hợp lệ');
    const phone = normalizePhone(input.phone);
    if (phone === undefined) throw new DomainError('INVALID_PHONE', 422, 'Số điện thoại không hợp lệ: chữ số, dấu cách, dấu +, -, . và ngoặc, tối đa 30 ký tự');
    const rawTaxCode = input.taxCode?.trim() || null;
    const taxCode = rawTaxCode ? normalizeTaxCode(rawTaxCode) : null;
    if (rawTaxCode && !taxCode) {
      throw new DomainError('INVALID_TAX_CODE', 422, 'Mã số thuế không hợp lệ: 10 chữ số, 10 chữ số kèm 3 chữ số đơn vị phụ thuộc, hoặc 12 chữ số');
    }

    // Locked: two edits of one party wait for each other, and the second sees the first one's version.
    const before = await ctx.trx
      .selectFrom('crove_kernel.party')
      .select(['id', 'name', 'tax_code', 'address', 'email', 'phone', 'version'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.partyId)
      .forUpdate()
      .executeTakeFirst();
    if (!before) throw new DomainError('PARTY_NOT_FOUND', 404, 'Không tìm thấy đối tác');
    if (before.version !== input.version) {
      throw new DomainError('PARTY_CHANGED', 409, 'Thông tin này vừa được người khác sửa; hãy mở lại rồi sửa tiếp', { version: before.version });
    }
    if (before.tax_code !== null && taxCode !== before.tax_code) {
      throw new DomainError('PARTY_TAX_CODE_LOCKED', 422, 'Mã số thuế đã có thì không sửa hay xóa được; nếu ghi nhầm, hãy gộp với đối tác đúng');
    }
    if (before.tax_code === null && taxCode !== null) {
      const other = await ctx.trx
        .selectFrom('crove_kernel.party')
        .select('id')
        .where('org_id', '=', ctx.orgId)
        .where('tax_code', '=', taxCode)
        .executeTakeFirst();
      if (other) throw new DomainError('PARTY_TAX_CODE_TAKEN', 409, `Mã số thuế ${taxCode} đã thuộc một đối tác khác; hãy gộp hai đối tác`, { partyId: other.id });
    }

    const next = { name, tax_code: taxCode, address, email, phone };
    const changed = (Object.keys(next) as Array<keyof typeof next>).filter((key) => before[key] !== next[key]);
    if (changed.length === 0) return { partyId: before.id, version: before.version };
    const updated = await ctx.trx
      .updateTable('crove_kernel.party')
      .set({ ...next, source_trust: 'user', version: before.version + 1, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', before.id)
      .returning('version')
      .executeTakeFirstOrThrow()
      .catch((error: unknown) => {
        // Another party took the tax code after the check above (the unique index decides).
        if ((error as { code?: string }).code === '23505') {
          throw new DomainError('PARTY_TAX_CODE_TAKEN', 409, `Mã số thuế ${taxCode} đã thuộc một đối tác khác; hãy gộp hai đối tác`);
        }
        throw error;
      });
    const publicFields = { name: 'name', tax_code: 'taxCode', address: 'address' } as const;
    const previous: Record<string, string | null> = {};
    const values: Record<string, string | null> = {};
    for (const key of changed) {
      if (key in publicFields) {
        const field = publicFields[key as keyof typeof publicFields];
        previous[field] = before[key];
        values[field] = next[key];
      }
    }
    ctx.audit({ partyId: before.id, changed: changed.map((key) => (key === 'tax_code' ? 'taxCode' : key)), previous, next: values });
    await ctx.activity('kernel.party', before.id, 'party.updated', before.name === name ? `Sửa thông tin của ${name}` : `Đổi tên ${before.name} thành ${name}`);
    return { partyId: before.id, version: updated.version };
  },
});

export const partyCommands = [updateParty];
