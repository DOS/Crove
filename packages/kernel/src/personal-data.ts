// The personal-data registry (issue #923, PDPL: Law 91/2025 and Decree 356/2025, plan §7.9 deletion map): every column
// of a tenant schema that holds data about a person, and what an erasure request does to it. The finder and the erase
// command (kernel.personal_data.*) work from this list only. An invariant test
// (apps/kernel/test/invariant/personal-data.db.test.ts) compares it with the database catalog: a column whose name looks
// like personal data (an email, a phone, an address, a tax code, a person's name, a recipient) must be listed here,
// and every listed column must exist, so a new column cannot slip past an erasure unclassified.
//
// handling:
// - erase: cleared (set to null, or the person's entry removed from a list) when the person asks.
// - keep_legal: kept, because accounting or tax law requires it (Accounting Law 88/2015, Art. 41: at least 10 years);
//   the erasure reports it with its reason.
// - keep_org: the tenant's own identity (the business, not a person), kept while the org exists.
// - hashed: a keyed hash, not the value; kept so a suppression still holds after the address itself is gone.
// - not_personal: the name matches the pattern but the column holds no data about a person.
import { sql, type RawBuilder } from 'kysely';
import type { MemberRole } from '@crove/db';
import { zPersonalDataQuery, type PersonalDataResult } from '@crove/kernel-contract';
import { DomainError, defineQuery } from '@crove/kernel-runtime';

const ADMINS: readonly MemberRole[] = ['owner', 'admin'];

export const PERSONAL_DATA_HANDLINGS = ['erase', 'keep_legal', 'keep_org', 'hashed', 'not_personal'] as const;
export type PersonalDataHandling = (typeof PERSONAL_DATA_HANDLINGS)[number];

// What a value is, for the finder: which columns a searched email, phone or code is compared with.
export const PERSONAL_DATA_KINDS = ['email', 'phone', 'address', 'name', 'tax_code', 'email_list', 'other'] as const;
export type PersonalDataKind = (typeof PERSONAL_DATA_KINDS)[number];

export interface PersonalDataColumn {
  kind: PersonalDataKind;
  handling: PersonalDataHandling;
  reason: string;
}

// Keyed by schema.table.column.
export const PERSONAL_DATA_COLUMNS = {
  // Parties: suppliers, customers and other counterparties, people among them.
  'crove_kernel.party.name': {
    kind: 'name',
    handling: 'keep_legal',
    reason: 'The legal name of a party on recorded invoices and vouchers is part of the accounting records; a party with no document is erased',
  },
  'crove_kernel.party.tax_code': {
    kind: 'tax_code',
    handling: 'keep_legal',
    reason: 'The tax code of a party on recorded invoices and vouchers is part of the accounting records; a party with no document is erased',
  },
  'crove_kernel.party.email': { kind: 'email', handling: 'erase', reason: 'Contact detail, not part of the books' },
  'crove_kernel.party.phone': { kind: 'phone', handling: 'erase', reason: 'Contact detail, not part of the books' },
  'crove_kernel.party.address': {
    kind: 'address',
    handling: 'erase',
    reason: 'Contact detail; the address printed on an invoice stays in the stored invoice file',
  },
  // Invites and mail.
  'crove_kernel.member_invite.email': { kind: 'email', handling: 'erase', reason: 'The invited address; the invite is history once used or revoked' },
  'crove_kernel.mail_message.to_address': {
    kind: 'email',
    handling: 'erase',
    reason: 'The recipient of a mail Crove sent; the keyed hash stays so a suppression still holds',
  },
  'crove_kernel.mail_message.to_hash': { kind: 'other', handling: 'hashed', reason: 'Keyed hash of the recipient (crove_kernel.mail_address_hash), not the address' },
  'crove_kernel.mail_suppression.to_hash': { kind: 'other', handling: 'hashed', reason: 'Keyed hash; keeps a bounced or unsubscribed address suppressed after erasure' },
  'crove_kernel.inbound_message.from_address': { kind: 'email', handling: 'erase', reason: 'The sender of a forwarded mail; the stored file keeps the document itself' },
  'crove_kernel.inbound_drop.address_id': { kind: 'other', handling: 'not_personal', reason: 'The id of an inbound address row' },
  // The org itself.
  'crove_kernel.tenant.tax_code': { kind: 'tax_code', handling: 'keep_org', reason: "The business's own tax code" },
  'crove_kernel.tenant.address': { kind: 'address', handling: 'keep_org', reason: "The business's registered address, printed on its returns" },
  'crove_kernel.tenant.contact_email': { kind: 'email', handling: 'erase', reason: 'A contact person of the business' },
  // Agents and connected accounts.
  'crove_kernel.agent.display_name': { kind: 'other', handling: 'not_personal', reason: 'The name of an AI agent' },
  'crove_kernel.channel_connection.display_name': {
    kind: 'name',
    handling: 'erase',
    reason: 'The name of a connected social account, which may be a person; disconnecting removes the account',
  },
  // Finance records.
  'crove_finance.cash_voucher.person_name': {
    kind: 'name',
    handling: 'keep_legal',
    reason: 'The payer or payee named on a phiếu thu or phiếu chi is part of the accounting voucher',
  },
  'crove_finance.portal_invoice_list.buyer_tax_code': { kind: 'tax_code', handling: 'keep_legal', reason: "The tax portal's invoice list, kept like the books" },
  'crove_finance.portal_invoice_row.seller_tax_code': { kind: 'tax_code', handling: 'keep_legal', reason: "The tax portal's invoice list, kept like the books" },
  'crove_finance.portal_invoice_row.seller_name': { kind: 'name', handling: 'keep_legal', reason: "The tax portal's invoice list, kept like the books" },
  // Social.
  'crove_social.report_schedule.recipients': { kind: 'email_list', handling: 'erase', reason: 'Addresses a scheduled client report is mailed to' },
  'crove_social.review_feedback.reviewer_name': { kind: 'name', handling: 'erase', reason: 'The name a client reviewer typed on a review link' },
} as const satisfies Record<string, PersonalDataColumn>;

export type PersonalDataColumnKey = keyof typeof PERSONAL_DATA_COLUMNS;

// The column names the invariant test treats as personal data. A column of crove_kernel, crove_finance or
// crove_social whose name matches must be in PERSONAL_DATA_COLUMNS. Control-plane tables (the user's own sign-in
// account and the deployment's own records) are not tenant data and are left out: the identity provider handles a
// user's own account, and no tenant code reads them (control-plane-reads.test.ts).
export const PERSONAL_DATA_NAME_PATTERN =
  '(^|_)(email|emails|phone|phones|address|addresses|tax_code|recipient|recipients|person_name|reviewer_name|display_name|from_address|to_address|national_id|id_number|birth_date|full_name)($|_)';
export const PERSONAL_DATA_SCHEMAS = ['crove_kernel', 'crove_finance', 'crove_social'] as const;

// The finder (#923): an owner or admin looks up one person by email address, phone number, or tax code or national ID
// (digits), across the columns above that hold such a value, and gets every matching row as JSON (the search column
// left out). Read in the org's context, so row security keeps it to the org. Each column returns at most
// PERSONAL_DATA_ROW_LIMIT rows; `truncated` says when one had more.
export const PERSONAL_DATA_ROW_LIMIT = 200;

type Probe = { kind: 'email'; email: string } | { kind: 'digits'; digits: string };

export function personalDataProbe(value: string): Probe | null {
  const trimmed = value.trim();
  if (/^[^\s@]+@[^\s@]+$/.test(trimmed)) return { kind: 'email', email: trimmed.toLowerCase() };
  // A phone number (spaces, dots, dashes, brackets and a leading + allowed, as in "(028) 3829 1234"), a tax code (10
  // digits, or 13 with a branch suffix) or a national ID (12 digits).
  if (/^[+(\d][\d\s().-]{7,24}$/.test(trimmed)) {
    const digits = trimmed.replace(/\D/g, '');
    if (digits.length >= 8 && digits.length <= 15) return { kind: 'digits', digits };
  }
  return null;
}

// The columns a probe is compared with, and how. Phone numbers match with or without Vietnam's +84.
function columnMatch(kind: PersonalDataKind, probe: Probe, column: RawBuilder<unknown>): RawBuilder<boolean> | null {
  if (probe.kind === 'email') {
    if (kind === 'email') return sql<boolean>`pg_catalog.lower(${column}) = ${probe.email}`;
    if (kind === 'email_list') return sql<boolean>`EXISTS (SELECT 1 FROM pg_catalog.unnest(${column}) AS r(v) WHERE pg_catalog.lower(r.v) = ${probe.email})`;
    return null;
  }
  const digits = sql`pg_catalog.regexp_replace(${column}, '[^0-9]', '', 'g')`;
  if (kind === 'tax_code') return sql<boolean>`${digits} = ${probe.digits}`;
  if (kind === 'phone') {
    const local = probe.digits.startsWith('84') ? `0${probe.digits.slice(2)}` : probe.digits;
    const international = local.startsWith('0') ? `84${local.slice(1)}` : local;
    return sql<boolean>`${digits} IN (${local}, ${international})`;
  }
  return null;
}

// The registry's columns an erasure or a search reads: personal data held in the org's own tables.
const SEARCHABLE_HANDLINGS = ['erase', 'keep_legal', 'keep_org'] as const;
const searchable = (handling: PersonalDataHandling): handling is (typeof SEARCHABLE_HANDLINGS)[number] =>
  (SEARCHABLE_HANDLINGS as readonly string[]).includes(handling);

export const personalDataFind = defineQuery({
  name: 'kernel.personal_data.find',
  input: zPersonalDataQuery,
  access: ADMINS,
  handler: async (ctx, input): Promise<PersonalDataResult> => {
    const probe = personalDataProbe(input.value);
    if (!probe) {
      throw new DomainError('PERSONAL_DATA_QUERY', 422, 'Hãy nhập một địa chỉ email, một số điện thoại, hoặc một mã số thuế hay số căn cước');
    }
    const matches: PersonalDataResult['matches'] = [];
    let truncated = false;
    for (const [key, entry] of Object.entries(PERSONAL_DATA_COLUMNS) as Array<[string, PersonalDataColumn]>) {
      const handling = entry.handling;
      if (!searchable(handling)) continue;
      const [schema, table, column] = key.split('.') as [string, string, string];
      const match = columnMatch(entry.kind, probe, sql.ref(`t.${column}`));
      if (!match) continue;
      const { rows } = await sql<{ row: Record<string, unknown> }>`
        SELECT pg_catalog.to_jsonb(t) - 'search' AS row
          FROM ${sql.table(`${schema}.${table}`)} AS t
         WHERE t.org_id = ${ctx.orgId}::uuid AND ${match}
         LIMIT ${PERSONAL_DATA_ROW_LIMIT + 1}`.execute(ctx.trx);
      if (rows.length > PERSONAL_DATA_ROW_LIMIT) truncated = true;
      for (const { row } of rows.slice(0, PERSONAL_DATA_ROW_LIMIT)) {
        matches.push({ column: key, handling, reason: entry.reason, rowId: typeof row.id === 'string' ? row.id : null, row });
      }
    }
    return { kind: probe.kind === 'email' ? 'email' : 'digits', matches, truncated };
  },
});

export const personalDataQueries = [personalDataFind];
