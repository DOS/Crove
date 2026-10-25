// A party, a vendor or a customer (#887): its name and contact details corrected by hand. Owners, admins and members
// edit them (R1). The editor sends the version it read: when someone else saved in between, the edit is refused
// rather than silently overwriting theirs. The runtime audits every edit; the detail keeps the old and the new name,
// tax code and address (public business data) and only the names of the other fields that changed (an email or a
// phone may be a person's).
// The tax code is how an e-invoice finds its party (finance's upsertParty), so it can be added to a party without one
// but never changed or removed: a party recorded under a wrong tax code is merged with "mark duplicate" (#887).
import { sql } from 'kysely';
import { z } from 'zod';
import { normalizeTaxCode, zId } from '@crove/kernel-contract';
import { DomainError, defineCommand, defineQuery } from '@crove/kernel-runtime';
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
  sideEffect: 'internal',
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


// Marking a duplicate (#887; plan §6, "Deduplication is the R1 command 'mark duplicate'"). The duplicate points at the
// party kept; nothing is deleted or moved. Lists and search show only the kept party, and per-party ledger reports add
// the duplicate's lines into it. Unmarking clears the link and undoes that. Owners and admins only: it changes what
// the reports show. One level: the kept party is never a duplicate itself, and a party others point at cannot become
// one (the table's party_duplicate_guard trigger holds the same rule).
const MANAGERS = ['owner', 'admin'] as const;

export const markDuplicate = defineCommand({
  name: 'kernel.party.mark_duplicate',
  input: z.object({ partyId: zId, keepId: zId }),
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  handler: async (ctx, { partyId, keepId }) => {
    if (partyId === keepId) throw new DomainError('SAME_PARTY', 422, 'Hãy chọn hai đối tác khác nhau');
    // Both rows locked, in id order, so two marks of the same pair wait for each other instead of deadlocking.
    const rows = await ctx.trx
      .selectFrom('crove_kernel.party')
      .select(['id', 'name', 'duplicate_of', 'version'])
      .where('org_id', '=', ctx.orgId)
      .where('id', 'in', [partyId, keepId])
      .orderBy('id')
      .forUpdate()
      .execute();
    const party = rows.find((r) => r.id === partyId);
    const keep = rows.find((r) => r.id === keepId);
    if (!party || !keep) throw new DomainError('PARTY_NOT_FOUND', 404, 'Không tìm thấy đối tác');
    if (party.duplicate_of !== null) {
      if (party.duplicate_of === keepId) return { partyId, keepId };
      throw new DomainError('PARTY_ALREADY_DUPLICATE', 409, `${party.name} đã được gộp vào một đối tác khác; hãy tách ra trước`);
    }
    if (keep.duplicate_of !== null) {
      throw new DomainError('PARTY_IS_DUPLICATE', 422, `${keep.name} đã được gộp vào đối tác khác; hãy gộp vào đối tác được giữ lại`, { keepId: keep.duplicate_of });
    }
    const merged = await ctx.trx
      .selectFrom('crove_kernel.party')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('duplicate_of', '=', partyId)
      .limit(1)
      .executeTakeFirst();
    if (merged) throw new DomainError('PARTY_HAS_DUPLICATES', 422, `Đã có đối tác gộp vào ${party.name}; hãy gộp ${keep.name} vào ${party.name} thay vì ngược lại`);
    await ctx.trx
      .updateTable('crove_kernel.party')
      .set({ duplicate_of: keepId, version: party.version + 1, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', partyId)
      .execute();
    ctx.audit({ partyId, keepId, name: party.name, keepName: keep.name });
    await ctx.activity('kernel.party', partyId, 'party.marked_duplicate', `Gộp ${party.name} vào ${keep.name}`);
    return { partyId, keepId };
  },
});

export const unmarkDuplicate = defineCommand({
  name: 'kernel.party.unmark_duplicate',
  input: z.object({ partyId: zId }),
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  handler: async (ctx, { partyId }) => {
    const party = await ctx.trx
      .selectFrom('crove_kernel.party')
      .select(['id', 'name', 'duplicate_of', 'version'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', partyId)
      .forUpdate()
      .executeTakeFirst();
    if (!party) throw new DomainError('PARTY_NOT_FOUND', 404, 'Không tìm thấy đối tác');
    if (party.duplicate_of === null) return { partyId };
    const keep = await ctx.trx
      .selectFrom('crove_kernel.party')
      .select('name')
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', party.duplicate_of)
      .executeTakeFirstOrThrow();
    await ctx.trx
      .updateTable('crove_kernel.party')
      .set({ duplicate_of: null, version: party.version + 1, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', partyId)
      .execute();
    ctx.audit({ partyId, keepId: party.duplicate_of, name: party.name, keepName: keep.name });
    await ctx.activity('kernel.party', partyId, 'party.unmarked_duplicate', `Tách ${party.name} khỏi ${keep.name}`);
    return { partyId };
  },
});

// Duplicate hints (#887): pairs of parties that look like one, for a person to mark. Reasons: the tax codes of one
// enterprise (the same 10 digits, one of them a branch), the same phone, or names alike once folded (marks, case and
// punctuation away) and stripped of the legal form ("Công ty TNHH", "CP", ...), compared by character trigrams. Only
// parties not marked as duplicates count, the most recently changed HINT_PARTY_LIMIT of them; at most
// HINT_PAIR_LIMIT pairs, strongest first. In each pair `keep` is the one to keep: the one with a tax code, else the
// older one.
export const HINT_PARTY_LIMIT = 1000;
export const HINT_PAIR_LIMIT = 50;
export const NAME_SIMILARITY = 0.6;
export type DuplicateReason = 'tax_code' | 'phone' | 'name';

export interface HintParty {
  id: string;
  name: string;
  folded: string;
  taxCode: string | null;
  phone: string | null;
  createdAt: string;
}

export interface DuplicateHint {
  keep: { id: string; name: string; taxCode: string | null };
  duplicate: { id: string; name: string; taxCode: string | null };
  reasons: DuplicateReason[];
}

const LEGAL_FORMS = new Set(['cong', 'ty', 'cty', 'tnhh', 'co', 'phan', 'cp', 'mtv', 'hkd', 'jsc', 'ltd', 'llc', 'company', 'limited', 'corp', 'corporation', 'inc']);
const LEGAL_PHRASES = [/\bmot thanh vien\b/g, /\bho kinh doanh\b/g, /\bchi nhanh\b/g];

// The folded name without its legal form, or null when too little is left to compare.
export function nameCore(folded: string): string | null {
  let text = ` ${folded} `;
  for (const phrase of LEGAL_PHRASES) text = text.replace(phrase, ' ');
  const core = text
    .split(' ')
    .filter((word) => word !== '' && !LEGAL_FORMS.has(word))
    .join(' ');
  return core.replace(/ /g, '').length >= 3 ? core : null;
}

function trigrams(text: string): Set<string> {
  const padded = `  ${text} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= padded.length; i += 1) out.add(padded.slice(i, i + 3));
  return out;
}

// Jaccard similarity of the two sets of character trigrams (pg_trgm's measure), 0 to 1.
export function nameSimilarity(a: string, b: string): number {
  const x = trigrams(a);
  const y = trigrams(b);
  let shared = 0;
  for (const t of x) if (y.has(t)) shared += 1;
  return shared / (x.size + y.size - shared);
}

// The last 9 digits of a Vietnamese phone number (+84 or 0 in front), or null for fewer than 9 digits.
export function phoneKey(phone: string | null): string | null {
  const digits = (phone ?? '').replace(/\D/g, '');
  return digits.length >= 9 ? digits.slice(-9) : null;
}

const enterprise = (taxCode: string | null) => (taxCode && /^\d{10}(-\d{3})?$/.test(taxCode) ? taxCode.slice(0, 10) : null);

export function duplicateHints(parties: readonly HintParty[]): DuplicateHint[] {
  const cores = parties.map((p) => nameCore(p.folded));
  const grams = cores.map((core) => (core ? trigrams(core) : null));
  const scored: Array<{ hint: DuplicateHint; score: number }> = [];
  for (let i = 0; i < parties.length; i += 1) {
    for (let j = i + 1; j < parties.length; j += 1) {
      const a = parties[i] as HintParty;
      const b = parties[j] as HintParty;
      const reasons: DuplicateReason[] = [];
      let score = 0;
      const ea = enterprise(a.taxCode);
      if (ea && ea === enterprise(b.taxCode)) {
        reasons.push('tax_code');
        score += 3;
      }
      const pa = phoneKey(a.phone);
      if (pa && pa === phoneKey(b.phone)) {
        reasons.push('phone');
        score += 2;
      }
      const ga = grams[i];
      const gb = grams[j];
      if (ga && gb) {
        let shared = 0;
        for (const t of ga) if (gb.has(t)) shared += 1;
        const similarity = shared / (ga.size + gb.size - shared);
        if (similarity >= NAME_SIMILARITY) {
          reasons.push('name');
          score += similarity;
        }
      }
      // Two different tax codes of two enterprises are two parties, however alike the names.
      if (reasons.length === 0 || (a.taxCode && b.taxCode && !reasons.includes('tax_code'))) continue;
      const aFirst = a.taxCode !== null && b.taxCode === null ? true : b.taxCode !== null && a.taxCode === null ? false : a.createdAt <= b.createdAt;
      const [keep, duplicate] = aFirst ? [a, b] : [b, a];
      scored.push({
        hint: { keep: { id: keep.id, name: keep.name, taxCode: keep.taxCode }, duplicate: { id: duplicate.id, name: duplicate.name, taxCode: duplicate.taxCode }, reasons },
        score,
      });
    }
  }
  return scored
    .sort((x, y) => y.score - x.score)
    .slice(0, HINT_PAIR_LIMIT)
    .map((s) => s.hint);
}

export const duplicateHintsQuery = defineQuery({
  name: 'kernel.party.duplicate_hints',
  input: z.object({}),
  access: ['owner', 'admin', 'member'],
  handler: async (ctx) => {
    const rows = await ctx.trx
      .selectFrom('crove_kernel.party')
      .select(['id', 'name', 'tax_code', 'phone', 'created_at'])
      .select(sql<string>`crove_kernel.search_fold(name)`.as('folded'))
      .where('org_id', '=', ctx.orgId)
      .where('duplicate_of', 'is', null)
      .orderBy('updated_at', 'desc')
      .limit(HINT_PARTY_LIMIT)
      .execute();
    return duplicateHints(
      rows.map((r) => ({ id: r.id, name: r.name, folded: r.folded ?? '', taxCode: r.tax_code, phone: r.phone, createdAt: new Date(r.created_at).toISOString() })),
    );
  },
});

export const partyCommands = [updateParty, markDuplicate, unmarkDuplicate];
export const partyQueries = [duplicateHintsQuery];
