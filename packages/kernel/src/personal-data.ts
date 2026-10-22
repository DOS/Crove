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
// - keep_record: part of an append-only record (an invite, a client's review feedback) that the erase command cannot
//   change; it goes with the org (offboarding), and crypto-shredding (ADR-0017) is the later answer.
// - hashed: a keyed hash, not the value; kept so a suppression still holds after the address itself is gone.
// - not_personal: the name matches the pattern but the column holds no data about a person.
import { sql, type RawBuilder } from 'kysely';
import type { MemberRole } from '@crove/db';
import { zPersonalDataQuery, type PersonalDataErasure, type PersonalDataResult } from '@crove/kernel-contract';
import { DomainError, defineCommand, defineQuery, type QueryContext } from '@crove/kernel-runtime';

const ADMINS: readonly MemberRole[] = ['owner', 'admin'];
const OWNERS: readonly MemberRole[] = ['owner'];

export const PERSONAL_DATA_HANDLINGS = ['erase', 'keep_legal', 'keep_org', 'keep_record', 'hashed', 'not_personal'] as const;
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
  'crove_kernel.member_invite.email': {
    kind: 'email',
    handling: 'keep_record',
    reason: 'An invite is an append-only record of who was invited by whom; the retention purge deletes it 90 days after it is accepted, revoked or expired',
  },
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
  'crove_social.review_feedback.reviewer_name': {
    kind: 'name',
    handling: 'keep_record',
    reason: 'Review feedback is an append-only record of what a client said about a post; it is removed with the org',
  },
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
const SEARCHABLE_HANDLINGS = ['erase', 'keep_legal', 'keep_org', 'keep_record'] as const;
const searchable = (handling: PersonalDataHandling): handling is (typeof SEARCHABLE_HANDLINGS)[number] =>
  (SEARCHABLE_HANDLINGS as readonly string[]).includes(handling);

function requireProbe(value: string): Probe {
  const probe = personalDataProbe(value);
  if (!probe) throw new DomainError('PERSONAL_DATA_QUERY', 422, 'Hãy nhập một địa chỉ email, một số điện thoại, hoặc một mã số thuế hay số căn cước');
  return probe;
}

// Every row of the org that holds the value, column by column (the finder's answer).
async function findPersonalData(trx: QueryContext['trx'], orgId: string, probe: Probe): Promise<PersonalDataResult> {
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
       WHERE t.org_id = ${orgId}::uuid AND ${match}
       LIMIT ${PERSONAL_DATA_ROW_LIMIT + 1}`.execute(trx);
    if (rows.length > PERSONAL_DATA_ROW_LIMIT) truncated = true;
    for (const { row } of rows.slice(0, PERSONAL_DATA_ROW_LIMIT)) {
      matches.push({ column: key, handling, reason: entry.reason, rowId: typeof row.id === 'string' ? row.id : null, row });
    }
  }
  return { kind: probe.kind === 'email' ? 'email' : 'digits', matches, truncated };
}

export const personalDataFind = defineQuery({
  name: 'kernel.personal_data.find',
  input: zPersonalDataQuery,
  access: ADMINS,
  handler: (ctx, input): Promise<PersonalDataResult> => findPersonalData(ctx.trx, ctx.orgId, requireProbe(input.value)),
});

// Why an erasure keeps the original files of posted invoices (issue #1009), with the end of their retention hold.
export function heldFilesReason(until: Date | null): string {
  const kept = until ? `held in storage until ${new Date(until).toISOString().slice(0, 10)}` : 'kept for the legal period';
  return `Original files behind posted entries that name this party: accounting evidence, ${kept} and never deleted by Crove (Accounting Law 88/2015, Art. 41)`;
}

// The name an erased party keeps: a party row cannot lose its name, and nothing in the books names it.
export const ERASED_PARTY_NAME = 'Đã xóa theo yêu cầu';

// The erase command (#923): an owner erases a person's data on their request, identified by the same value the finder
// takes. R3: it cannot be undone, so it needs a fresh second factor. In the command's transaction it clears
// (`erase` in the registry):
// - on every party the value matches (by email, phone or tax code): its email, phone and address; a party that no
//   recorded invoice, voucher or journal line names also loses its tax code and its name (a placeholder);
// - the sender of forwarded mails and the recipient of mails Crove sent (the keyed hash stays, so a suppression holds);
// - the org's contact email;
// - the address in Social report schedules (a schedule left with nobody to mail is deleted).
// What the law or an append-only record keeps (the names and tax codes of parties in the books, cash vouchers, the tax
// portal's lists, invites, review feedback, and the original files of posted invoices naming the party, under their
// retention hold, #1009) is left as it is and listed with its reason. The audit row holds counts
// only, never the value or the rows.
export const personalDataErase = defineCommand({
  name: 'kernel.personal_data.erase',
  input: zPersonalDataQuery,
  risk: 'R3',
  access: OWNERS,
  handler: async (ctx, input): Promise<PersonalDataErasure> => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới xóa được dữ liệu cá nhân');
    const probe = requireProbe(input.value);
    const erased = new Map<string, number>();
    const add = (column: string, rows: number) => {
      if (rows > 0) erased.set(column, (erased.get(column) ?? 0) + rows);
    };
    const match = (kind: PersonalDataKind, column: string) => columnMatch(kind, probe, sql.ref(column));
    const never = sql<boolean>`false`;

    // Parties the value identifies, and whether the books name them.
    const partyMatch = sql<boolean>`(${match('email', 'p.email') ?? never} OR ${match('phone', 'p.phone') ?? never} OR ${match('tax_code', 'p.tax_code') ?? never})`;
    const { rows: parties } = await sql<{ id: string; email: boolean; phone: boolean; address: boolean; tax_code: boolean; documented: boolean }>`
      SELECT p.id, p.email IS NOT NULL AS email, p.phone IS NOT NULL AS phone, p.address IS NOT NULL AS address,
             p.tax_code IS NOT NULL AS tax_code,
             (EXISTS (SELECT 1 FROM crove_finance.purchase_document d WHERE d.org_id = p.org_id AND d.party_id = p.id)
              OR EXISTS (SELECT 1 FROM crove_finance.cash_voucher v WHERE v.org_id = p.org_id AND v.party_id = p.id)
              OR EXISTS (SELECT 1 FROM crove_finance.journal_line l WHERE l.org_id = p.org_id AND l.party_id = p.id)) AS documented
        FROM crove_kernel.party p
       WHERE p.org_id = ${ctx.orgId}::uuid AND ${partyMatch}
       FOR UPDATE OF p`.execute(ctx.trx);
    let keptParties = 0;
    for (const party of parties) {
      const forget = !party.documented;
      await ctx.trx
        .updateTable('crove_kernel.party')
        .set((eb) => ({
          email: null,
          phone: null,
          address: null,
          ...(forget ? { tax_code: null, name: ERASED_PARTY_NAME } : {}),
          version: eb('version', '+', 1),
          updated_at: ctx.now,
        }))
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', party.id)
        .execute();
      add('crove_kernel.party.email', Number(party.email));
      add('crove_kernel.party.phone', Number(party.phone));
      add('crove_kernel.party.address', Number(party.address));
      if (forget) {
        add('crove_kernel.party.name', 1);
        add('crove_kernel.party.tax_code', Number(party.tax_code));
      } else {
        keptParties += 1;
      }
    }

    if (probe.kind === 'email') {
      const inbound = await sql`
        UPDATE crove_kernel.inbound_message t SET from_address = NULL
         WHERE t.org_id = ${ctx.orgId}::uuid AND ${match('email', 't.from_address') ?? never}`.execute(ctx.trx);
      add('crove_kernel.inbound_message.from_address', Number(inbound.numAffectedRows ?? 0));
      const mails = await sql`
        UPDATE crove_kernel.mail_message t SET to_address = NULL
         WHERE t.org_id = ${ctx.orgId}::uuid AND ${match('email', 't.to_address') ?? never}`.execute(ctx.trx);
      add('crove_kernel.mail_message.to_address', Number(mails.numAffectedRows ?? 0));
      const contact = await sql`
        UPDATE crove_kernel.tenant t SET contact_email = NULL
         WHERE t.org_id = ${ctx.orgId}::uuid AND ${match('email', 't.contact_email') ?? never}`.execute(ctx.trx);
      add('crove_kernel.tenant.contact_email', Number(contact.numAffectedRows ?? 0));
      // A schedule keeps its other recipients; one left with nobody is deleted (it mailed only this person).
      // Deleted first, so an address listed twice in different cases never leaves an empty list.
      const dropped = await sql`
        DELETE FROM crove_social.report_schedule t
         WHERE t.org_id = ${ctx.orgId}::uuid AND ${match('email_list', 't.recipients') ?? never}
           AND NOT EXISTS (SELECT 1 FROM pg_catalog.unnest(t.recipients) AS r(v) WHERE pg_catalog.lower(r.v) <> ${probe.email})`.execute(ctx.trx);
      const schedules = await sql`
        UPDATE crove_social.report_schedule t
           SET recipients = ARRAY(SELECT r.v FROM pg_catalog.unnest(t.recipients) AS r(v) WHERE pg_catalog.lower(r.v) <> ${probe.email})
         WHERE t.org_id = ${ctx.orgId}::uuid AND ${match('email_list', 't.recipients') ?? never}`.execute(ctx.trx);
      add('crove_social.report_schedule.recipients', Number(schedules.numAffectedRows ?? 0) + Number(dropped.numAffectedRows ?? 0));
    }

    // What stays, with its reason: the finder's answer after the erasure (the cleared values no longer match).
    const after = await findPersonalData(ctx.trx, ctx.orgId, probe);
    const kept = new Map<string, { rows: number; reason: string }>();
    for (const m of after.matches) {
      const k = kept.get(m.column) ?? { rows: 0, reason: m.reason };
      k.rows += 1;
      kept.set(m.column, k);
    }
    // The original files behind posted entries that name these parties (issue #1009): accounting evidence the erasure
    // never deletes, held in the bucket for the legal period. Reported with the date the hold runs to, when it is set.
    const partyIds = parties.map((p) => p.id);
    if (partyIds.length > 0) {
      const { rows: held } = await sql<{ files: string; until: Date | null }>`
        SELECT count(DISTINCT f.id) AS files,
               -- A date only when every file has a recorded hold, and then the earliest: never a date one file lacks.
               CASE WHEN bool_and(f.held_until IS NOT NULL) THEN min(f.held_until) END AS until
          FROM crove_finance.purchase_document d
          JOIN crove_finance.journal_entry e ON e.org_id = d.org_id AND e.source_type = 'finance.purchase_document' AND e.source_id = d.id
          JOIN crove_kernel.file f ON f.org_id = d.org_id AND f.id = d.source_file_id
         WHERE d.org_id = ${ctx.orgId}::uuid AND d.party_id = ANY(${partyIds}::uuid[])`.execute(ctx.trx);
      const files = Number(held[0]?.files ?? 0);
      if (files > 0) kept.set('crove_kernel.file', { rows: files, reason: heldFilesReason(held[0]?.until ?? null) });
    }
    const result: PersonalDataErasure = {
      erased: [...erased].map(([column, rows]) => ({ column, rows })),
      kept: [...kept].map(([column, k]) => ({ column, rows: k.rows, reason: k.reason })),
    };
    // Counts only: the value and the rows never reach the audit log.
    ctx.audit({ kind: probe.kind, erased: Object.fromEntries(erased), kept: Object.fromEntries([...kept].map(([c, k]) => [c, k.rows])), kept_parties: keptParties });
    return result;
  },
});

export const personalDataQueries = [personalDataFind];
export const personalDataCommands = [personalDataErase];
