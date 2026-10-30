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

// What a value is, for the finder: which columns a searched email, phone or code is compared with. free_text: words
// among which a value may be written (a note's body, an activity line, a comment, a description; #1678, #1948), matched
// by freeTextMatch below.
export const PERSONAL_DATA_KINDS = ['email', 'phone', 'address', 'name', 'tax_code', 'email_list', 'free_text', 'other'] as const;
export type PersonalDataKind = (typeof PERSONAL_DATA_KINDS)[number];

// The handlings of personal data held in the org's own tables: what the finder reports and an erasure reads.
const SEARCHABLE_HANDLINGS = ['erase', 'keep_legal', 'keep_org', 'keep_record'] as const;
type SearchableHandling = (typeof SEARCHABLE_HANDLINGS)[number];
const searchable = (handling: PersonalDataHandling): handling is SearchableHandling => (SEARCHABLE_HANDLINGS as readonly string[]).includes(handling);

export interface PersonalDataColumn {
  kind: PersonalDataKind;
  handling: PersonalDataHandling;
  reason: string;
  // A row whose boolean column `when` is true is handled as this says instead (the org's default legal entity is the
  // business itself; the other entities are the businesses and households it keeps books for).
  override?: { when: string; handling: SearchableHandling; reason: string };
  // Private items (ADR-0037): the finder lists a row only when it is shared ('unless_shared': its visibility is 'org'),
  // or never ('always'); private ones are counted per author through crove_notes.private_matches instead, with no text.
  privateRows?: 'unless_shared' | 'always';
  // A text[] column searched as its items joined by a space, as crove_notes.private_matches reads a note's tags.
  list?: true;
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
  // A visitor's booking on a public booking page (#1318).
  'crove_crm.booking.visitor_name': { kind: 'name', handling: 'erase', reason: 'The name a visitor gave when booking a meeting' },
  'crove_crm.booking.email': { kind: 'email', handling: 'erase', reason: 'The address a visitor gave when booking a meeting' },
  'crove_crm.booking.phone': { kind: 'phone', handling: 'erase', reason: 'The number a visitor gave when booking a meeting' },
  'crove_crm.booking.note': { kind: 'other', handling: 'erase', reason: 'Free text a visitor wrote when booking a meeting, which may name or describe them' },
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
  'crove_kernel.inbound_message.body_text': { kind: 'other', handling: 'erase', reason: 'The text of a forwarded mail (#779), which may name or describe its sender; erased with the address of its sender' },
  'crove_kernel.inbound_drop.address_id': { kind: 'other', handling: 'not_personal', reason: 'The id of an inbound address row' },
  // The org itself.
  'crove_kernel.tenant.tax_code': { kind: 'tax_code', handling: 'keep_org', reason: "The business's own tax code" },
  'crove_kernel.tenant.address': { kind: 'address', handling: 'keep_org', reason: "The business's registered address, printed on its returns" },
  'crove_kernel.tenant.contact_email': { kind: 'email', handling: 'erase', reason: 'A contact person of the business' },
  // Legal entities (#1278): the companies, branches and household businesses the org keeps books for. In an accounting
  // firm's org they are its clients, and a household's name and 12-digit code are usually its owner's name and national
  // ID number, so only the default entity, the org itself, is the org's own identity (#1312).
  'crove_kernel.legal_entity.name': {
    kind: 'name',
    handling: 'keep_legal',
    reason: "The legal name of a business or household the org keeps books for; a household's is usually its owner's name. Kept with its books",
    override: { when: 'is_default', handling: 'keep_org', reason: "The name of the org's default legal entity, the business itself" },
  },
  'crove_kernel.legal_entity.tax_code': {
    kind: 'tax_code',
    handling: 'keep_legal',
    reason: "The tax code of a business or household the org keeps books for; a household's is its owner's national ID number. Kept with its books",
    override: { when: 'is_default', handling: 'keep_org', reason: "The tax code of the org's default legal entity, the org's own" },
  },
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
  // Free text that can name a person (#1948): searched for the value anywhere inside it. Social's posts and comments
  // are left out while Social is paused (decision D5).
  'crove_kernel.activity.summary': {
    kind: 'free_text',
    handling: 'erase',
    reason: "A line of a record's timeline, which may quote a person's email or phone; the value is replaced inside it",
  },
  'crove_kernel.task_comment.body': {
    kind: 'free_text',
    handling: 'keep_record',
    reason: 'A comment on a task is an append-only record of the work, which the erase command cannot change; it goes with the org',
  },
  'crove_finance.journal_entry.description': {
    kind: 'free_text',
    handling: 'keep_legal',
    reason: 'The description of a posted journal entry is part of the books, append-only and anchored in the WORM archive',
  },
  'crove_finance.cash_voucher.description': {
    kind: 'free_text',
    handling: 'keep_legal',
    reason: 'The reason written on a phiếu thu or phiếu chi is part of the accounting voucher, append-only and kept by law (Accounting Law 88/2015, Art. 41)',
  },
  'crove_finance.journal_voucher.description': {
    kind: 'free_text',
    handling: 'keep_legal',
    reason: 'The reason written on a journal voucher is part of the accounting voucher, append-only and kept by law (Accounting Law 88/2015, Art. 41)',
  },
  // Social.
  'crove_social.report_branding.display_name': { kind: 'name', handling: 'keep_org', reason: "The agency's name on its white-label client reports (#1053), the business itself" },
  'crove_social.report_schedule.recipients': { kind: 'email_list', handling: 'erase', reason: 'Addresses a scheduled client report is mailed to' },
  'crove_social.review_feedback.reviewer_name': {
    kind: 'name',
    handling: 'keep_record',
    reason: 'Review feedback is an append-only record of what a client said about a post; it is removed with the org',
  },
  // Notes and to-dos (#1678, notes step N9, ADR-0037 section 5): free text a member wrote, which may name or describe a
  // person. A shared note is listed with its text; a private note and every to-do (always private) are counted per
  // author, never shown. The folded search words are rebuilt from the text, so they are not searched themselves.
  'crove_notes.note.title': { kind: 'free_text', handling: 'erase', reason: 'A shared note; the erasure does not change notes yet (#1678): ask its author to edit it, or archive or delete it', privateRows: 'unless_shared' },
  'crove_notes.note.body': { kind: 'free_text', handling: 'erase', reason: 'A shared note; the erasure does not change notes yet (#1678): ask its author to edit it, or archive or delete it', privateRows: 'unless_shared' },
  'crove_notes.note.tags': { kind: 'free_text', handling: 'erase', reason: 'A shared note; the erasure does not change notes yet (#1678): ask its author to edit it, or archive or delete it', privateRows: 'unless_shared', list: true },
  'crove_notes.note.search': { kind: 'other', handling: 'erase', reason: "The folded search words of a note's title, tags and body, rebuilt from them" },
  'crove_notes.todo.title': { kind: 'free_text', handling: 'erase', reason: 'Free text of a to-do, private to its owner: counted per owner, never shown', privateRows: 'always' },
  'crove_notes.todo.details': { kind: 'free_text', handling: 'erase', reason: 'Free text of a to-do, private to its owner: counted per owner, never shown', privateRows: 'always' },
  'crove_notes.todo.checklist': { kind: 'free_text', handling: 'erase', reason: 'Steps of a to-do, private to its owner: counted per owner, never shown', privateRows: 'always' },
  'crove_notes.todo.search': { kind: 'other', handling: 'erase', reason: "The folded search words of a to-do's title, details and steps, rebuilt from them" },
} as const satisfies Record<string, PersonalDataColumn>;

export type PersonalDataColumnKey = keyof typeof PERSONAL_DATA_COLUMNS;

// Columns that hold personal data the finder and the erasure cannot handle yet, with the step that registers them
// (#1874). Empty since notes step N9 registered the notes' text (#1678); a column a module classifies as pii before the
// finder can reach it waits here. apps/kernel/test/personal-data.test.ts asks every pii column of crove_notes to be in
// one list or the other.
export const PERSONAL_DATA_PENDING: Readonly<Record<string, string>> = {};

// The column names the invariant test treats as personal data. A column of crove_kernel, crove_finance, crove_social,
// crove_crm or crove_notes whose name matches must be in PERSONAL_DATA_COLUMNS. Control-plane tables (the user's own
// sign-in account and the deployment's own records) are not tenant data and are left out: the identity provider
// handles a user's own account, and no tenant code reads them (control-plane-reads.test.ts).
export const PERSONAL_DATA_NAME_PATTERN =
  '(^|_)(email|emails|phone|phones|address|addresses|tax_code|recipient|recipients|person_name|reviewer_name|display_name|from_address|to_address|national_id|id_number|birth_date|full_name)($|_)';
export const PERSONAL_DATA_SCHEMAS = ['crove_kernel', 'crove_finance', 'crove_social', 'crove_crm', 'crove_notes'] as const;

// The finder (#923): an owner or admin looks up one person by email address, phone number, or tax code or national ID
// (digits), across the columns above that hold such a value, and gets every matching row as JSON (the search column
// left out). Read in the org's context, so row security keeps it to the org. Each column returns at most
// PERSONAL_DATA_ROW_LIMIT rows; `truncated` says when one had more.
export const PERSONAL_DATA_ROW_LIMIT = 200;

export type Probe = { kind: 'email'; email: string } | { kind: 'digits'; digits: string };

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

// Free text (#1678, shared with #1948): whether a text column mentions the probe's email address or digits among other
// words, and the text with every mention replaced by a mark. Both go through crove_kernel.text_mentions and
// text_redact (20261106200000), which hold the one pattern: a whole address, not part of a longer one; digits with the
// spaces, dots, brackets or dashes people write between them, and a phone with or without +84. A column of another
// type is read as text (an array or jsonb as its text form, where an address or a number reads as itself).
export function freeTextMatch(probe: Probe, column: RawBuilder<unknown>): RawBuilder<boolean> {
  return sql<boolean>`crove_kernel.text_mentions(${column}::text, ${probe.kind}, ${probeValue(probe)})`;
}

export function freeTextRedact(probe: Probe, column: RawBuilder<unknown>, mark: string): RawBuilder<string> {
  return sql<string>`crove_kernel.text_redact(${column}::text, ${probe.kind}, ${probeValue(probe)}, ${mark})`;
}

const probeValue = (probe: Probe): string => (probe.kind === 'email' ? probe.email : probe.digits);

// The columns a probe is compared with, and how. Phone numbers match with or without Vietnam's +84. Free text is
// searched for the value anywhere inside it (#1678, #1948): freeTextMatch.
function columnMatch(kind: PersonalDataKind, probe: Probe, column: RawBuilder<unknown>): RawBuilder<boolean> | null {
  if (kind === 'free_text') return freeTextMatch(probe, column);
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

// What an erasure does to one matched row: the column's handling, or its override when the row says so.
export function rowHandling(entry: PersonalDataColumn, row: Record<string, unknown>): { handling: PersonalDataHandling; reason: string } {
  const override = entry.override;
  if (override && row[override.when] === true) return { handling: override.handling, reason: override.reason };
  return { handling: entry.handling, reason: entry.reason };
}

function requireProbe(value: string): Probe {
  const probe = personalDataProbe(value);
  if (!probe) throw new DomainError('PERSONAL_DATA_QUERY', 422, 'Hãy nhập một địa chỉ email, một số điện thoại, hoặc một mã số thuế hay số căn cước');
  return probe;
}

// Every row of the org that holds the value, column by column (the finder's answer), and per author how many of their
// private notes and to-dos mention it (ADR-0037: counted, never shown, whoever runs the finder).
async function findPersonalData(trx: QueryContext['trx'], orgId: string, probe: Probe): Promise<PersonalDataResult> {
  const matches: PersonalDataResult['matches'] = [];
  let truncated = false;
  for (const [key, entry] of Object.entries(PERSONAL_DATA_COLUMNS) as Array<[string, PersonalDataColumn]>) {
    if (!searchable(entry.handling)) continue;
    if (entry.privateRows === 'always') continue;
    const [schema, table, column] = key.split('.') as [string, string, string];
    const ref = sql.ref(`t.${column}`);
    const match = columnMatch(entry.kind, probe, entry.list ? sql`pg_catalog.array_to_string(${ref}, ' ')` : ref);
    if (!match) continue;
    // Row security already hides other members' private notes; the finder's own private ones are counted below too,
    // not listed, so every author's are reported alike.
    const shared = entry.privateRows === 'unless_shared' ? sql`AND t.visibility = 'org'` : sql``;
    const { rows } = await sql<{ row: Record<string, unknown> }>`
      SELECT pg_catalog.to_jsonb(t) - 'search' AS row
        FROM ${sql.table(`${schema}.${table}`)} AS t
       WHERE t.org_id = ${orgId}::uuid AND ${match} ${shared}
       LIMIT ${PERSONAL_DATA_ROW_LIMIT + 1}`.execute(trx);
    if (rows.length > PERSONAL_DATA_ROW_LIMIT) truncated = true;
    for (const { row } of rows.slice(0, PERSONAL_DATA_ROW_LIMIT)) {
      const { handling, reason } = rowHandling(entry, row);
      if (!searchable(handling)) continue;
      matches.push({ column: key, handling, reason, rowId: typeof row.id === 'string' ? row.id : null, row });
    }
  }
  const { rows: privateItems } = await sql<{ author_user_id: string; notes: string; todos: string }>`
    SELECT author_user_id, notes, todos FROM crove_notes.private_matches(${probe.kind}, ${probeValue(probe)})`.execute(trx);
  return {
    kind: probe.kind === 'email' ? 'email' : 'digits',
    matches,
    privateItems: privateItems.map((p) => ({ authorUserId: p.author_user_id, notes: Number(p.notes), todos: Number(p.todos) })),
    truncated,
  };
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

// The fewest digits a value needs before the erasure replaces it inside activity lines (#1948): a shorter number may be
// an amount or a voucher number there, so its lines are listed for the owner instead, with this reason.
export const ACTIVITY_REDACT_MIN_DIGITS = 10;
export const ACTIVITY_SHORT_NUMBER_REASON =
  'A number of fewer than 10 digits may also be an amount or a voucher number in a timeline line, so the erasure does not replace it there; check these lines and tell the person, or ask for a longer value';

// The name an erased party keeps: a party row cannot lose its name, and nothing in the books names it.
export const ERASED_PARTY_NAME = 'Đã xóa theo yêu cầu';

// The erase command (#923): an owner erases a person's data on their request, identified by the same value the finder
// takes. R3: it cannot be undone, so it needs a fresh second factor. In the command's transaction it clears
// (`erase` in the registry):
// - on every party the value matches (by email, phone or tax code): its email, phone and address; a party that no
//   recorded invoice, voucher or journal line names also loses its tax code and its name (a placeholder);
// - the sender of forwarded mails and the recipient of mails Crove sent (the keyed hash stays, so a suppression holds);
// - the org's contact email;
// - the visitor's name, email, phone and note on bookings from a public booking page;
// - the address in Social report schedules (a schedule left with nobody to mail is deleted);
// - the value wherever an activity line quotes it (#1948), replaced inside the line.
// What the law or an append-only record keeps (the names and tax codes of parties in the books and of the legal entities
// the org keeps books for, #1312, cash vouchers, the tax portal's lists, invites, review feedback, task comments and the
// descriptions of journal entries and vouchers that quote the value, #1948, and the original files of posted invoices
// naming the party, under their retention hold, #1009) is left as it is and listed with its reason.
// The audit row holds counts only, never the value or the rows.
export const personalDataErase = defineCommand({
  name: 'kernel.personal_data.erase',
  input: zPersonalDataQuery,
  risk: 'R3',
  sideEffect: 'irreversible',
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

    // Bookings the visitor made on a public booking page (#1318), matched by their email or phone: the visitor's name,
    // email, phone and note all go (the booking keeps its time and its link to the calendar event).
    const bookingMatch = sql<boolean>`(${match('email', 'b.email') ?? never} OR ${match('phone', 'b.phone') ?? never})`;
    const { rows: bookings } = await sql<{ visitor_name: boolean; email: boolean; phone: boolean; note: boolean }>`
      UPDATE crove_crm.booking b SET visitor_name = NULL, email = NULL, phone = NULL, note = NULL
        FROM crove_crm.booking o
       WHERE o.org_id = b.org_id AND o.id = b.id AND b.org_id = ${ctx.orgId}::uuid AND ${bookingMatch}
       RETURNING o.visitor_name IS NOT NULL AS visitor_name, o.email IS NOT NULL AS email, o.phone IS NOT NULL AS phone,
                 o.note IS NOT NULL AS note`.execute(ctx.trx);
    for (const b of bookings) {
      add('crove_crm.booking.visitor_name', Number(b.visitor_name));
      add('crove_crm.booking.email', Number(b.email));
      add('crove_crm.booking.phone', Number(b.phone));
      add('crove_crm.booking.note', Number(b.note));
    }

    if (probe.kind === 'email') {
      // A mail from the person goes with its text (#779), which may name or describe them.
      const { rows: inbound } = await sql<{ body_text: boolean }>`
        UPDATE crove_kernel.inbound_message t SET from_address = NULL, body_text = NULL
          FROM crove_kernel.inbound_message o
         WHERE o.org_id = t.org_id AND o.id = t.id AND t.org_id = ${ctx.orgId}::uuid AND ${match('email', 't.from_address') ?? never}
         RETURNING o.body_text IS NOT NULL AS body_text`.execute(ctx.trx);
      add('crove_kernel.inbound_message.from_address', inbound.length);
      add('crove_kernel.inbound_message.body_text', inbound.filter((m) => m.body_text).length);
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

    // Activity lines that quote the person (#1948): the mention is replaced inside the line, through the owner-only
    // definer (tenant roles may not update activity rows). Comments and the books' descriptions are append-only and
    // stay; the finder's answer below lists them with their reasons.
    // A number of 8 or 9 digits may as well be an amount or a voucher number in a line, and a redaction cannot be
    // undone: those lines are left as they are and listed with ACTIVITY_SHORT_NUMBER_REASON (the definer refuses them
    // too).
    const shortNumber = probe.kind === 'digits' && probe.digits.length < ACTIVITY_REDACT_MIN_DIGITS;
    if (!shortNumber) {
      const { rows: redacted } = await sql<{ rows: number }>`
        SELECT crove_kernel.personal_data_redact_activity(${probe.kind}, ${probeValue(probe)}) AS rows`.execute(ctx.trx);
      add('crove_kernel.activity.summary', Number(redacted[0]?.rows ?? 0));
    }

    // What stays, with its reason: the finder's answer after the erasure (the cleared values no longer match).
    const after = await findPersonalData(ctx.trx, ctx.orgId, probe);
    // Grouped by column and reason: rows of one column may be kept for different reasons (the default legal entity and
    // the others).
    const kept = new Map<string, { column: string; rows: number; reason: string }>();
    for (const m of after.matches) {
      const reason = shortNumber && m.column === 'crove_kernel.activity.summary' ? ACTIVITY_SHORT_NUMBER_REASON : m.reason;
      const group = `${m.column}\n${reason}`;
      const k = kept.get(group) ?? { column: m.column, rows: 0, reason };
      k.rows += 1;
      kept.set(group, k);
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
      if (files > 0) kept.set('crove_kernel.file', { column: 'crove_kernel.file', rows: files, reason: heldFilesReason(held[0]?.until ?? null) });
    }
    const keptRows = new Map<string, number>();
    for (const k of kept.values()) keptRows.set(k.column, (keptRows.get(k.column) ?? 0) + k.rows);
    const result: PersonalDataErasure = {
      erased: [...erased].map(([column, rows]) => ({ column, rows })),
      kept: [...kept.values()].map((k) => ({ column: k.column, rows: k.rows, reason: k.reason })),
    };
    // Counts only: the value and the rows never reach the audit log.
    ctx.audit({ kind: probe.kind, erased: Object.fromEntries(erased), kept: Object.fromEntries(keptRows), kept_parties: keptParties });
    return result;
  },
});

export const personalDataQueries = [personalDataFind];
export const personalDataCommands = [personalDataErase];
