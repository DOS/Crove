// Generated cross-org RLS matrix (MVP exit criterion 2, External-tenant gate T8) on a real PostgreSQL 17.
// The cases come from the catalog: every relation in any non-system schema with an org_id column gets a
// structural check and a read, insert, update and delete probe for each runtime actor, each probe in its own
// transaction as the real login roles (and as the NOLOGIN definer owner the ledger writes run as), never as a
// superuser. A new table with org_id fails here until it has RLS in the expected shape and a row factory below.
// Scope: tables found by an org_id column. Global tables without org_id (user_account, auth_session) and a tenant
// column under another name are not covered; AGENTS.md requires org_id on every tenant table.
// Part of the invariant suite: CI runs this file from the base branch on protected-path PRs (AGENTS.md).
// Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));

// The one tenant policy crove_kernel.apply_tenant_rls creates, as pg_get_expr prints it.
const TENANT_PREDICATE = '(org_id = ( SELECT crove_kernel.ctx_org_id() AS ctx_org_id))';
// Roles that run tenant code. None may own, or inherit the ownership of, a tenant table: RLS is enabled but not
// forced, so the owner bypasses it.
const RUNTIME_ROLES = ['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant', 'crove_auth_reader'];
// Tables with org_id that no role but their owner can touch: only SECURITY DEFINER functions owned by the
// table owner read or write them. They need RLS enabled (so a later grant stays deny-all until a policy is
// added) and must be listed here, so a new table cannot quietly become one.
const MACHINERY = new Set([
  'crove_kernel.auth_session_org',
  'crove_kernel.credential',
  'crove_kernel.oauth_state',
  'crove_kernel.inbound_drop',
  'crove_kernel.outbox_archive',
  'crove_kernel.outbox_pending',
  'crove_kernel.refusal_tally',
  'crove_social.chat_alert_target',
]);
// Tables whose row factory (and MACHINERY entry, for definer-only tables) lands on main before the table itself. CI
// runs main's copy of this file on the PR that adds a table with org_id, so the factory has to be on main first;
// until the table exists, neither its factory nor its MACHINERY entry is stale. Remove an entry once its table is on
// main. One table per line, sorted, with a trailing comma, so PRs adding different tables touch different lines.
const PENDING_TABLES = new Set<string>([
  // 'crove_schema.table_name',
  'crove_crm.booking_feed',
  'crove_finance.categorization_rule',
  'crove_finance.period_balance_delta',
]);
const RLS_DENIED = /new row violates row-level security policy/;
const PRIVILEGE_DENIED = /permission denied for (table|relation)/;

type Values = Record<string, string | number>;
interface Row {
  table: string;
  values: Values;
}
interface OrgFixture {
  id: string;
  owner: string;
  party: string;
  file: string;
  document: string;
  entry: string;
  // A user who is not yet a member of any org, for membership rows.
  freshUser: () => string;
}
interface Built {
  // Rows the target row needs in the same transaction (inserted first, when seeding and in the own-org control).
  setup?: Row[];
  row: Values;
  // Rows that must follow before commit (only when seeding), for example the lines that balance an entry.
  complete?: Row[];
}
interface RowFactory {
  make: (org: OrgFixture) => Built;
  // false when the rows already exist for both orgs (tenant), so seeding adds none.
  seed?: false;
  // Why the own-org insert control cannot run, when it cannot.
  noInsertControl?: string;
  // The 42501 denial a privileged actor gets for another org's row, when a trigger refuses before RLS does.
  insertDenied?: RegExp;
  // For a role that may update some columns but not org_id: the assignment (and extra row filter) the update
  // probes use, when a no-op assignment would be refused by a trigger. Defaults to "<first column> = <itself>".
  update?: { set: string; where?: string };
}

const hex64 = () => randomBytes(32).toString('hex');
const tag = () => randomUUID().slice(0, 8);
let lineNo = 100;
const balancingLine = (org: string, entry: string, lineNo: number, side: 'debit' | 'credit'): Row => ({
  table: 'crove_finance.journal_line',
  values: { org_id: org, entry_id: entry, line_no: lineNo, account_code: side === 'debit' ? '6422' : '331', debit: side === 'debit' ? '100' : '0', credit: side === 'credit' ? '100' : '0' },
});
const agentRow = (o: { id: string; owner: string }) => ({
  org_id: o.id,
  id: randomUUID(),
  template_key: 'finance.chief_accountant',
  display_name: 'RLS matrix agent',
  created_by: o.owner,
});
// A connected channel account (ADR-0025). One live connection per (org, provider, account), so every row gets its
// own account id.
const channelConnectionRow = (o: { id: string; owner: string }) => ({
  org_id: o.id,
  id: randomUUID(),
  provider: 'sandbox',
  external_account_id: `rls-${tag()}`,
  display_name: 'RLS matrix channel',
  connected_by: o.owner,
});
// The org's team chat alert (#863): its kind and alert kinds; the sealed target is in chat_alert_target.
const chatAlertRow = (o: { id: string; owner: string }) => ({
  org_id: o.id,
  id: randomUUID(),
  kind: 'discord',
  events: '{needs_approval}',
  updated_by: o.owner,
});
// An outbound mail (Email plan §3.2, #538), with its id so a delivery event can name it.
const mailMessageRow = (o: { id: string }) => ({
  org_id: o.id,
  id: randomUUID(),
  stream: 'transactional',
  source: 'rls.matrix',
  template_key: 'rls.matrix',
  to_address: `rls-${tag()}@example.com`,
  to_hash: hex64(),
  subject: 'RLS matrix',
  message_id_header: `<${randomUUID()}@rls.matrix>`,
});
// Crove Social (S3): a post, and a variant of it for a fresh channel connection (one variant per connection).
const ZERO_HASH = `sha256:${'0'.repeat(64)}`;
const MUTE_KINDS = ['review_requested', 'decided', 'failed', 'comment'] as const;
const muteRows = new Map<string, number>();
const socialPostRow = (o: { id: string }) => ({ org_id: o.id, id: randomUUID(), body: 'RLS matrix post' });
const socialLabelRow = (o: { id: string; owner: string }) => ({ org_id: o.id, id: randomUUID(), name: `rls-${tag()}`, color: 'blue', created_by: o.owner });
const socialReportScheduleRow = (o: { id: string; owner: string }) => ({
  org_id: o.id,
  id: randomUUID(),
  name: 'RLS matrix schedule',
  cadence: 'weekly',
  weekday: 1,
  period: 'previous_week',
  recipients: '{rls@example.com}',
  next_run_at: new Date(Date.now() + 86_400_000).toISOString(),
  created_by: o.owner,
});
const socialFeedRow = (o: { id: string; owner: string }) => ({ org_id: o.id, id: randomUUID(), url: `https://rls-${tag()}.example/feed.xml`, created_by: o.owner });
const socialBioPageRow = (o: { id: string; owner: string }) => ({ org_id: o.id, id: randomUUID(), slug: `rls-${tag()}`, title: 'RLS matrix bio', created_by: o.owner });
const socialIdeaRow = (o: { id: string; owner: string }) => ({ org_id: o.id, id: randomUUID(), title: 'RLS matrix idea', stage: 'new', created_by: o.owner });
const socialReviewLinkRow = (o: { id: string; owner: string }) => {
  const post = socialPostRow(o);
  return { post, row: { org_id: o.id, id: randomUUID(), post_id: post.id, token_sha256: hex64(), created_by: o.owner, expires_at: new Date(Date.now() + 86_400_000).toISOString() } };
};
const socialVariantRows = (o: { id: string; owner: string }) => {
  const connection = channelConnectionRow(o);
  const post = socialPostRow(o);
  const variant = { org_id: o.id, id: randomUUID(), post_id: post.id, channel_connection_id: connection.id, provider: 'sandbox', content_hash: ZERO_HASH };
  return {
    setup: [
      { table: 'crove_kernel.channel_connection', values: connection },
      { table: 'crove_social.post', values: post },
    ],
    variant,
  };
};
// A short link of a published variant (#706), with what it needs.
const socialShortLinkRows = (o: { id: string; owner: string }) => {
  const { setup, variant } = socialVariantRows(o);
  return {
    setup: [...setup, { table: 'crove_social.post_variant', values: variant }],
    link: { org_id: o.id, id: randomUUID(), code: `rls${tag()}`.slice(0, 16), variant_id: variant.id, post_id: variant.post_id, target_url: 'https://rls.example/' },
  };
};
let portalListYear = 2000;
// A tax obligation is marked done once per period (#921): each row its own year.
let taxObligationYear = 2000;
// Active bookings of one member never overlap (#1313): each calendar event row its own hour.
let calendarHour = 0;
// An org's weekly digest is marked sent once per ISO week (#1104): each row its own year.
let digestWeekYear = 2000;
const portalListRow = (o: { id: string; file: string }) => ({
  org_id: o.id,
  id: randomUUID(),
  period: `${portalListYear++}-09`,
  file_id: o.file,
  filename: 'rls-matrix.xlsx',
});
// A fixed asset of the register (#919): equipment of 36,000,000 VND depreciated over 36 months from October 2026.
const fixedAssetRow = (o: { id: string; owner: string }) => ({
  org_id: o.id,
  id: randomUUID(),
  kind: 'fixed_asset',
  name: 'RLS matrix asset',
  cost: '36000000',
  asset_account: '2111',
  accumulated_account: '2141',
  expense_account: '6422',
  start_month: '2026-10-01',
  months: 36,
  created_by: o.owner,
});
const journalEntry = (org: string, id: string): Row => ({
  table: 'crove_finance.journal_entry',
  values: { org_id: org, id, entry_date: '2026-10-01', description: 'rls matrix', source_type: 'rls.matrix', source_id: randomUUID() },
});

// One factory per table with org_id. Each builds a valid row for the given org; the probes use the same factory
// for the actor's own org (which must be accepted where the role may write) and for the other org (which must be
// refused), so a denial cannot come from a malformed row. Kept in table-name order (plain string sort; the catalog
// test checks it), so a new factory goes at its own place instead of at the end, where parallel PRs would conflict.
const ROW_FACTORIES: Record<string, RowFactory> = {
  // #1318: a visitor's booking of an event type, holding an event on the host's calendar.
  'crove_crm.booking': {
    make: (o) => {
      const eventType = randomUUID();
      const event = randomUUID();
      const start = new Date(Date.UTC(2031, 0, 1) + 3_600_000 * calendarHour++);
      return {
        setup: [
          { table: 'crove_crm.event_type', values: { org_id: o.id, id: eventType, slug: `rls-${tag()}`, title: 'RLS matrix event type', duration_min: 30, host_user_id: o.owner, created_by: o.owner } },
          {
            table: 'crove_kernel.calendar_event',
            values: { org_id: o.id, id: event, user_id: o.owner, starts_at: start.toISOString(), ends_at: new Date(start.getTime() + 1_800_000).toISOString(), time_zone: 'Asia/Ho_Chi_Minh', kind: 'booking', created_by: o.owner },
          },
        ],
        row: {
          org_id: o.id,
          id: randomUUID(),
          event_type_id: eventType,
          calendar_event_id: event,
          starts_at: start.toISOString(),
          ends_at: new Date(start.getTime() + 1_800_000).toISOString(),
          status: 'confirmed',
          visitor_name: 'RLS matrix visitor',
          email: 'visitor@rls.example',
          time_zone: 'Asia/Ho_Chi_Minh',
        },
      };
    },
  },
  // #1382: a member's booking feed address (the SHA-256 of its token); the member makes and revokes it.
  'crove_crm.booking_feed': { make: (o) => ({ row: { org_id: o.id, id: randomUUID(), user_id: o.owner, token_sha256: hex64() } }) },
  // #1314: a booking page's event type, hosted by a member; slugs are unique per org.
  'crove_crm.event_type': {
    make: (o) => ({ row: { org_id: o.id, id: randomUUID(), slug: `rls-${tag()}`, title: 'RLS matrix event type', duration_min: 30, host_user_id: o.owner, created_by: o.owner } }),
  },
  // Bank statement lines (#326): append-only, one row per line of an import, on a bank account (112 or an org
  // sub-account under it). Tenant roles read and insert; nothing updates or deletes a line.
  'crove_finance.bank_line': {
    make: (o) => ({
      row: { org_id: o.id, bank_account: '1121', import_id: randomUUID(), position: 1, value_date: '2026-10-01', description: 'RLS matrix', amount: '100' },
    }),
  },
  // Cash and bank vouchers (#327): append-only, numbered per org and type by the insert trigger (the row gives no
  // number). By commit a voucher must have its journal entry, on its date, moving the cash account by its amount, so
  // seeding completes it with that entry (written as the database owner); the probes roll back before that check.
  'crove_finance.cash_voucher': {
    make: (o) => {
      const id = randomUUID();
      const entry = randomUUID();
      return {
        row: { org_id: o.id, id, voucher_type: 'cash_payment', voucher_date: '2026-10-01', cash_account: '1111', party_id: o.party, description: 'RLS matrix', amount: '100' },
        complete: [
          { table: 'crove_finance.journal_entry', values: { ...journalEntry(o.id, entry).values, source_type: 'finance.cash_voucher', source_id: id } },
          { table: 'crove_finance.journal_line', values: { org_id: o.id, entry_id: entry, line_no: 1, account_code: '331', debit: '100', credit: '0' } },
          { table: 'crove_finance.journal_line', values: { org_id: o.id, entry_id: entry, line_no: 2, account_code: '1111', debit: '0', credit: '100' } },
        ],
      };
    },
  },
  // #1399: a learned account rule. An org-wide keyword rule names no vendor and no source document.
  'crove_finance.categorization_rule': {
    make: (o) => ({ row: { org_id: o.id, id: randomUUID(), match_kind: 'keyword', match_text: `rls matrix ${tag()}`, debit_account: '6422' } }),
  },
  // Monthly depreciation and allocation of the register (#919): append-only, one row per asset and month, naming the
  // journal entry that posted it. Tenant roles read and insert; nothing updates or deletes a line.
  'crove_finance.depreciation_line': {
    make: (o) => {
      const asset = fixedAssetRow(o);
      return {
        setup: [{ table: 'crove_finance.fixed_asset', values: asset }],
        row: { org_id: o.id, id: randomUUID(), asset_id: asset.id, month: '2026-10-01', amount: '1000000', entry_id: randomUUID() },
      };
    },
  },
  // The register of fixed assets and prepaid costs (#919): one row per asset, never deleted. Tenant roles update only
  // the end of its schedule (a column grant), so the update probes assign end_reason to itself.
  'crove_finance.fixed_asset': {
    update: { set: 'end_reason = end_reason' },
    make: (o) => ({ row: fixedAssetRow(o) }),
  },
  // The accountant's marks on input invoices that need proof of non-cash payment (#917): append-only, the latest mark of
  // a document wins (paid by bank, optionally with its bank voucher, not deductible, or cleared). Tenant roles read and
  // insert; nothing updates or deletes a mark.
  'crove_finance.input_vat_check': {
    make: (o) => ({ row: { org_id: o.id, id: randomUUID(), document_id: o.document, outcome: 'paid_by_bank', marked_by: o.owner } }),
  },
  'crove_finance.journal_entry': {
    make: (o) => {
      const id = randomUUID();
      return { row: journalEntry(o.id, id).values, complete: [balancingLine(o.id, id, 1, 'debit'), balancingLine(o.id, id, 2, 'credit')] };
    },
  },
  'crove_finance.journal_line': {
    // A line can only join an entry created in the same transaction. The BEFORE INSERT trigger that checks this
    // reads the entry through RLS, so for another org's entry it refuses (42501) before the policy check runs: no
    // actor can see an org B entry, so this probe can never reach the WITH CHECK of journal_line. The behavioral
    // probe therefore rests on journal_entry's RLS, and the structural check (exactly tenant_isolation) covers the
    // WITH CHECK of journal_line itself.
    insertDenied: /row-level security policy|is already posted/,
    make: (o) => {
      const entry = randomUUID();
      return { setup: [journalEntry(o.id, entry)], row: balancingLine(o.id, entry, 1, 'debit').values, complete: [balancingLine(o.id, entry, 2, 'credit')] };
    },
  },
  // General journal vouchers, NVK (#888): append-only, numbered by the database per org. By commit the voucher has its
  // journal entry (source finance.journal_voucher, on the voucher's date), which the probe adds.
  'crove_finance.journal_voucher': {
    make: (o) => {
      const id = randomUUID();
      const entry = randomUUID();
      return {
        row: { org_id: o.id, id, voucher_date: '2026-10-01', description: 'RLS matrix' },
        complete: [
          { table: 'crove_finance.journal_entry', values: { ...journalEntry(o.id, entry).values, source_type: 'finance.journal_voucher', source_id: id } },
          balancingLine(o.id, entry, 1, 'debit'),
          balancingLine(o.id, entry, 2, 'credit'),
        ],
      };
    },
  },
  // An org's sub-accounts under the TT133 chart (#319): one row per (org, code), never deleted. The code extends its
  // parent's (here 6422.<tag>); a trigger fills root_code. Tenant roles update only name, active and updated_by (a
  // column grant), so the update probes assign name to itself.
  'crove_finance.org_account': {
    make: (o) => ({ row: { org_id: o.id, code: `6422.${tag().toUpperCase()}`, name: 'RLS matrix sub-account', parent_code: '6422' } }),
  },
  // What one journal entry adds to one account in its month (#1284): append-only, one row per (org, entry, account),
  // inserted only by the posting definer (tenant roles read). The row names the fixture's entry, with its own account
  // code so every row is unique.
  'crove_finance.period_balance_delta': {
    make: (o) => ({
      row: { org_id: o.id, id: randomUUID(), entry_id: o.entry, account_code: `6422.${tag().toUpperCase()}`, period_month: '2026-10-01', debit: '100', credit: '0', line_count: 1 },
    }),
  },
  // The period lock of an org (#329): one row per org, the months locked so far. Tenant roles only read it; the lock
  // and unlock definers write it. The rows exist for both orgs: the posting guard creates an org's row (nothing locked)
  // at its first journal entry, and the fixtures above post one per org. Locked in 2020, so a probe row would not
  // cover any factory's journal entry.
  'crove_finance.period_lock': {
    seed: false,
    noInsertControl: 'one row per org, which the posting guard already created',
    make: (o) => ({ row: { org_id: o.id, locked_from: '2020-01-01', locked_through: '2020-01-31', updated_by: o.owner } }),
  },
  // The tax portal's purchase lists (#465): one imported file per period, pending until the worker records its outcome;
  // the same file once per period while not removed, so every row gets its own period. Tenant roles update only the
  // outcome and removal columns (a column grant), so the update probes assign error to itself on a pending list.
  'crove_finance.portal_invoice_list': {
    update: { set: 'error = error' },
    make: (o) => ({ row: portalListRow(o) }),
  },
  // Its rows (append-only): a row joins only a pending list, created in the same transaction. Only the system context
  // adds rows (the worker recording a list; a trigger refuses member contexts from #506), so the own-org control, which
  // also runs in member contexts, is skipped. finance-portal-list.db.test.ts covers both sides.
  'crove_finance.portal_invoice_row': {
    noInsertControl: 'only the system context adds rows (the worker recording a list); a member context is refused',
    make: (o) => {
      const list = portalListRow(o);
      return {
        setup: [{ table: 'crove_finance.portal_invoice_list', values: list }],
        row: { org_id: o.id, list_id: list.id, row_no: 1, seller_tax_code: '0100109107', series: 'C26TAA', number: tag(), issue_date: '2026-09-01', status: 'original' },
      };
    },
  },
  // A document is recorded together with its journal entry (#560: from 20261020190000 a document commits only with its
  // own entry), so seeding completes it with that entry (written as the database owner); the probes roll back first.
  'crove_finance.purchase_document': {
    make: (o) => {
      const id = randomUUID();
      const entry = randomUUID();
      return {
        row: { org_id: o.id, id, party_id: o.party, invoice_number: tag(), invoice_date: '2026-10-01', subtotal: '100', vat_amount: '10', total: '110' },
        complete: [
          { table: 'crove_finance.journal_entry', values: { ...journalEntry(o.id, entry).values, source_type: 'finance.purchase_document', source_id: id } },
          balancingLine(o.id, entry, 1, 'debit'),
          balancingLine(o.id, entry, 2, 'credit'),
        ],
      };
    },
  },
  // Voids of purchase documents (#165): a void names the reversal of its document's journal entry, which only the
  // posting definer writes, so the own-org insert control cannot build its setup as a login role. Seeding (as the
  // database owner) inserts a document, its entry, the entry's reversal, the void, then the mirrored lines.
  'crove_finance.purchase_document_void': {
    noInsertControl: 'its setup needs a journal entry and its reversal, which only the posting definer writes',
    make: (o) => {
      const document = randomUUID();
      const entry = randomUUID();
      const reversal = randomUUID();
      const line = (entryId: string, n: number, account: string, debit: string, credit: string): Row => ({
        table: 'crove_finance.journal_line',
        values: { org_id: o.id, entry_id: entryId, line_no: n, account_code: account, debit, credit },
      });
      return {
        setup: [
          {
            table: 'crove_finance.purchase_document',
            values: { org_id: o.id, id: document, party_id: o.party, invoice_number: tag(), invoice_date: '2026-10-01', subtotal: '100', vat_amount: '10', total: '110' },
          },
          { table: 'crove_finance.journal_entry', values: { ...journalEntry(o.id, entry).values, source_type: 'finance.purchase_document', source_id: document } },
          { table: 'crove_finance.journal_entry', values: { ...journalEntry(o.id, reversal).values, reverses_entry_id: entry } },
        ],
        row: { org_id: o.id, document_id: document, reversal_entry_id: reversal, reason: 'RLS matrix' },
        complete: [line(entry, 1, '6422', '100', '0'), line(entry, 2, '331', '0', '100'), line(reversal, 1, '6422', '0', '100'), line(reversal, 2, '331', '100', '0')],
      };
    },
  },
  'crove_finance.purchase_line': {
    make: (o) => ({ row: { org_id: o.id, document_id: o.document, line_no: lineNo++, description: 'RLS matrix', amount: '100', debit_account: '6422' } }),
  },
  // The invoice's own VAT table by rate (#685). It joins its document only before the document's entry is posted
  // (purchase_tax_rate_before_insert), so each row gets a fresh document, completed with its entry after the row.
  'crove_finance.purchase_tax_rate': {
    make: (o) => {
      const document = randomUUID();
      const entry = randomUUID();
      return {
        setup: [
          {
            table: 'crove_finance.purchase_document',
            values: { org_id: o.id, id: document, party_id: o.party, invoice_number: tag(), invoice_date: '2026-10-01', subtotal: '100', vat_amount: '10', total: '110' },
          },
        ],
        row: { org_id: o.id, document_id: document, row_no: 1, vat_rate: '10%', taxable_amount: '100', vat_amount: '10' },
        complete: [
          { table: 'crove_finance.journal_entry', values: { ...journalEntry(o.id, entry).values, source_type: 'finance.purchase_document', source_id: document } },
          balancingLine(o.id, entry, 1, 'debit'),
          balancingLine(o.id, entry, 2, 'credit'),
        ],
      };
    },
  },
  'crove_finance.vendor_account_rule': {
    make: (o) => {
      const party = randomUUID();
      return {
        setup: [{ table: 'crove_kernel.party', values: { org_id: o.id, id: party, name: 'RLS matrix vendor' } }],
        row: { org_id: o.id, party_id: party, debit_account: '6422' },
      };
    },
  },
  // position is an SQL keyword, so the catalog prints the name quoted.
  'crove_kernel."position"': {
    make: (o) => ({ row: { org_id: o.id, id: randomUUID(), title: 'RLS matrix seat', module: 'finance', role_key: 'finance.chief_accountant' } }),
  },
  'crove_kernel.activity': {
    make: (o) => ({ row: { org_id: o.id, record_type: 'party', record_id: o.party, kind: 'rls.matrix', summary: 'RLS matrix' } }),
  },
  // ADR-0029 Phase 1 (#79): agents in the org chart. An agent row needs a template; every factory that needs an agent
  // adds a fresh one, since an agent runs once at a time and has at most one pending wake-up.
  'crove_kernel.agent': { make: (o) => ({ row: agentRow(o) }) },
  'crove_kernel.agent_wakeup': {
    make: (o) => {
      const agent = agentRow(o);
      return { setup: [{ table: 'crove_kernel.agent', values: agent }], row: { org_id: o.id, agent_id: agent.id } };
    },
  },
  'crove_kernel.ai_run': {
    make: (o) => {
      const agent = agentRow(o);
      return {
        setup: [{ table: 'crove_kernel.agent', values: agent }],
        row: {
          org_id: o.id,
          agent_id: agent.id,
          module: 'finance',
          status: 'succeeded',
          started_at: '2026-10-01T00:00:00Z',
          expires_at: '2026-10-01T00:15:00Z',
          finished_at: '2026-10-01T00:10:00Z',
        },
      };
    },
  },
  'crove_kernel.audit_event': {
    make: (o) => ({
      row: { org_id: o.id, actor_type: 'system', command: 'rls.matrix', command_id: randomUUID(), outcome: 'ok', input_sha256: hex64() },
    }),
  },
  'crove_kernel.auth_session_org': { make: (o) => ({ row: { org_id: o.id, user_id: o.owner, session_id: randomUUID() } }) },
  // #1313: a member's weekly working hours, one row per weekday window.
  'crove_kernel.availability_rule': {
    make: (o) => ({ row: { org_id: o.id, id: randomUUID(), user_id: o.owner, weekday: 1, start_minute: 540, end_minute: 1020, time_zone: 'Asia/Ho_Chi_Minh', created_by: o.owner } }),
  },
  'crove_kernel.budget_policy': {
    make: (o) => ({ row: { org_id: o.id, scope: 'agent', target: randomUUID(), monthly_limit: '100', updated_by: o.owner } }),
  },
  // #1313: an event on a member's calendar; busy events of one member never overlap, so each row takes its own hour.
  'crove_kernel.calendar_event': {
    make: (o) => {
      const start = new Date(Date.UTC(2030, 0, 1) + 3_600_000 * calendarHour++);
      return {
        row: { org_id: o.id, id: randomUUID(), user_id: o.owner, starts_at: start.toISOString(), ends_at: new Date(start.getTime() + 1_800_000).toISOString(), time_zone: 'Asia/Ho_Chi_Minh', title: 'RLS matrix event', created_by: o.owner },
      };
    },
  },
  'crove_kernel.channel_connection': { make: (o) => ({ row: channelConnectionRow(o) }) },
  // Definer-only machinery: the sealed token of a connection, one row per connection. The envelope is opaque bytes
  // here; only the vault in the worker opens a real one.
  'crove_kernel.credential': {
    make: (o) => {
      const connection = channelConnectionRow(o);
      return {
        setup: [{ table: 'crove_kernel.channel_connection', values: connection }],
        row: { org_id: o.id, connection_id: connection.id, key_id: 'rls-matrix', envelope: '\\x00' },
      };
    },
  },
  // The ledger of visible calls to outside services (Social plan §3.4, S4): one row per call key. Tenant roles read,
  // insert and update its outcome columns, never delete; the guard trigger refuses any change once a call has its
  // outcome, so the update probes assign a column of a started call to itself.
  'crove_kernel.external_call': {
    update: { set: 'calls = calls' },
    make: (o) => ({
      row: { org_id: o.id, key: `rls.matrix:${randomUUID()}`, module: 'social', target: 'sandbox', step: 'publish', retry_safety: 'reconcile_only' },
    }),
  },
  'crove_kernel.extraction': { make: (o) => ({ row: { org_id: o.id, file_id: o.file, method: 'unsupported', status: 'failed' } }) },
  'crove_kernel.file': {
    make: (o) => {
      const sha256 = hex64();
      return {
        row: { org_id: o.id, id: randomUUID(), sha256, storage_key: `org/${o.id}/${sha256}`, filename: 'probe.xml', content_type: 'application/xml', size_bytes: 1, source: 'upload' },
      };
    },
  },
  // Staged upload grants (issue #109, ADR-0013): one row per presigned upload, used at most once. Created, expiry
  // and used times come from the database clock (a trigger), and the creator from the sealed context when a user
  // is in it. Tenant roles may update only used_at (a column grant), and only to claim an unused, unexpired grant
  // once, so the update probes claim (a no-op assignment would be refused by the guard trigger, not by RLS).
  'crove_kernel.file_upload': {
    update: { set: 'used_at = pg_catalog.now()', where: 'used_at IS NULL' },
    make: (o) => ({ row: { org_id: o.id, staging_key: `staging/${hex64()}`, created_by: o.owner, max_bytes: 1 } }),
  },
  'crove_kernel.idempotency_key': {
    make: (o) => ({ row: { org_id: o.id, actor_key: `user:${o.owner}`, key: randomUUID(), command: 'rls.matrix', request_sha256: hex64() } }),
  },
  'crove_kernel.inbound_address': {
    // The ledger of inbound tokens. Login roles hold nothing on it; crove_definer_tenant (inbound_rotate) holds
    // SELECT, INSERT and UPDATE (retired_at) only. An org has at most one active address, so the rows the matrix
    // adds are already retired. The guard trigger refuses every update except retiring an active row once, so
    // the update probes retire (a no-op assignment would be refused by the trigger, not by RLS): for org B that
    // must touch 0 rows, for org A it retires the active row. DELETE and TRUNCATE are refused by privilege before
    // the guard trigger runs.
    update: { set: 'retired_at = pg_catalog.now()', where: 'retired_at IS NULL' },
    make: (o) => ({
      row: { org_id: o.id, token: randomBytes(12).toString('hex'), created_at: '2026-10-01T00:00:00Z', retired_at: '2026-10-02T00:00:00Z' },
    }),
  },
  // How many messages to a retired inbound address were dropped (issue #139): one row per retired address,
  // definer-only machinery. The row points at a retired ledger row of the same org, added first.
  'crove_kernel.inbound_drop': {
    make: (o) => {
      const address = randomUUID();
      return {
        setup: [
          {
            table: 'crove_kernel.inbound_address',
            values: { org_id: o.id, id: address, token: randomBytes(12).toString('hex'), created_at: '2026-10-01T00:00:00Z', retired_at: '2026-10-02T00:00:00Z' },
          },
        ],
        row: { org_id: o.id, address_id: address, dropped_count: 1 },
      };
    },
  },
  'crove_kernel.inbound_message': { make: (o) => ({ row: { org_id: o.id, message_id: `<${randomUUID()}@rls.test>` } }) },
  // One active switch per (org, scope, target), so every row stops its own agent id.
  'crove_kernel.kill_switch': { make: (o) => ({ row: { org_id: o.id, scope: 'agent', target: randomUUID(), engaged_by: o.owner } }) },
  // A legal entity of the org (#1278): a branch beside the default entity every org gets with it (one default per org),
  // without a tax code (one per org).
  'crove_kernel.legal_entity': { make: (o) => ({ row: { org_id: o.id, id: randomUUID(), name: 'RLS matrix branch', kind: 'branch', created_by: o.owner } }) },
  // Delivery events from the mail provider (Email plan §3.3, #539), append-only: one row per provider event, joined to
  // its mail in the same org. Only the system context adds rows (the worker recording a verified webhook or bounce
  // report; a trigger refuses member contexts), so the own-org control, which also runs in member contexts, is skipped.
  'crove_kernel.mail_event': {
    noInsertControl: 'only the system context adds rows (the worker recording a provider event); a member context is refused',
    make: (o) => {
      const message = mailMessageRow(o);
      return {
        setup: [{ table: 'crove_kernel.mail_message', values: message }],
        row: { org_id: o.id, message_id: message.id, provider: 'sandbox', provider_event_id: `rls-${randomUUID()}`, kind: 'delivered', occurred_at: '2026-10-20T00:00:00Z' },
      };
    },
  },
  // Outbound mail (Email plan §3.2, ADR-0034, #538): one row per mail to one recipient. Tenant roles read and insert,
  // update only the status columns, never delete; the guard keeps the identity columns fixed, so the update probes
  // assign the status to itself.
  'crove_kernel.mail_message': {
    update: { set: 'status = status' },
    make: (o) => ({ row: mailMessageRow(o) }),
  },
  // The suppression list (Email plan §3.3, #538): keyed on the address hash, never deleted; lifting writes the lift
  // columns once, so the update probes assign lift_reason to itself on a live row.
  'crove_kernel.mail_suppression': {
    update: { set: 'lift_reason = lift_reason' },
    make: (o) => ({ row: { org_id: o.id, to_hash: hex64(), scope: 'all', reason: 'manual' } }),
  },
  // Pending member invites (issue #35). An open invite per (org, email), so every row gets its own address. Token
  // hash and expiry take their defaults (an unusable random hash, seven days). Tenant roles may update only status,
  // revoked_at and revoked_by (a column grant), so the update probes write status, which the guard trigger allows
  // on a pending invite.
  'crove_kernel.member_invite': {
    make: (o) => ({ row: { org_id: o.id, email: `invite-${tag()}@rls.test`, role: 'member', invited_by: o.owner } }),
  },
  // A notification for one member (#671), the kernel's own for every module (a finance proposal to approve, a file
  // that failed to read). A restrictive policy shows each member only their own; the factory's rows belong to the
  // owner, the user every member-context actor enters as. Members change only read_at.
  'crove_kernel.notification': {
    make: (o) => ({ row: { org_id: o.id, id: randomUUID(), user_id: o.owner, kind: 'kernel.rls_matrix', dedupe_key: `rls-${tag()}` } }),
  },
  // A kind of notification a member turned off (#671), under the same restrictive policy; a kind of its own per row.
  'crove_kernel.notification_mute': { make: (o) => ({ row: { org_id: o.id, user_id: o.owner, kind: `kernel.rls_${tag()}` } }) },
  // Definer-only machinery (Social plan §3.5, S6): one single-use OAuth state per connect attempt, holding the hash of
  // the state parameter and the PKCE verifier; only the start and callback definers touch it.
  'crove_kernel.oauth_state': {
    make: (o) => ({ row: { org_id: o.id, user_id: o.owner, provider: 'sandbox', state_hash: `sha256:${hex64()}`, expires_at: '2099-01-01T00:00:00Z' } }),
  },
  // What an org used of its daily abuse limits (#675), recorded by the worker: append-only, tenants read and insert.
  'crove_kernel.org_usage': { make: (o) => ({ row: { org_id: o.id, id: randomUUID(), metric: 'inbound_emails', amount: '1' } }) },
  'crove_kernel.outbox_archive': {
    make: (o) => ({ row: { org_id: o.id, day: '2020-01-01', object_key: `outbox/v1/${o.id}/2020-01-01.jsonl`, sha256: 'a'.repeat(64), row_count: 1 } }),
  },
  'crove_kernel.outbox_event': { make: (o) => ({ row: { org_id: o.id, id: randomUUID(), type: 'rls.matrix', payload: '{}' } }) },
  'crove_kernel.outbox_pending': { make: (o) => ({ row: { org_id: o.id, event_id: randomUUID() } }) },
  'crove_kernel.party': { make: (o) => ({ row: { org_id: o.id, id: randomUUID(), name: 'RLS matrix party' } }) },
  'crove_kernel.proposal': {
    make: (o) => ({ row: { org_id: o.id, kind: 'rls.matrix', command: 'rls.matrix', status: 'rejected', title: 'RLS matrix', payload: '{}' } }),
  },
  // #676: per-org reminder and escalation settings for pending proposals (one row per org).
  'crove_kernel.proposal_policy': { make: (o) => ({ row: { org_id: o.id, id: randomUUID(), remind_after_days: 3, escalate_after_days: 7, updated_by: o.owner } }) },
  // Refusals counted per org, window, actor and (command, code) (issue #162). Definer-only machinery: no role but
  // the owner holds a privilege on it. A random code keeps every row its own key.
  'crove_kernel.refusal_tally': {
    make: (o) => ({
      row: { org_id: o.id, window_start: '2026-10-01T00:00:00Z', actor_key: `user:${o.owner}`, command: 'rls.matrix', code: `RLS_${tag()}` },
    }),
  },
  // Who holds which built-in role (issue #1279): tenant roles only read it; two owner-only definers write it. The seeded
  // row gives the org's owner the chief accountant role for the whole org (no legal entity).
  'crove_kernel.role_assignment': {
    make: (o) => ({ row: { org_id: o.id, id: randomUUID(), user_id: o.owner, role_key: 'finance.chief_accountant', granted_by: o.owner } }),
  },
  'crove_kernel.task': {
    make: (o) => ({ row: { org_id: o.id, id: randomUUID(), title: 'RLS matrix task', source: 'human', created_by_type: 'user' } }),
  },
  'crove_kernel.task_comment': {
    make: (o) => {
      const task = randomUUID();
      return {
        setup: [{ table: 'crove_kernel.task', values: { org_id: o.id, id: task, title: 'RLS matrix task', source: 'human', created_by_type: 'user' } }],
        row: { org_id: o.id, task_id: task, body: 'RLS matrix', author_type: 'user' },
      };
    },
  },
  // A tax obligation of the org's calendar marked done for a period (#921), one per obligation and period.
  'crove_kernel.tax_obligation_done': {
    make: (o) => ({ row: { org_id: o.id, id: randomUUID(), obligation: 'license_fee', period: String(taxObligationYear++), done_by: o.owner } }),
  },
  // #921: which tax obligations apply to the org, its PIT filing frequency and fiscal year end (one row per org).
  'crove_kernel.tax_profile': {
    make: (o) => ({ row: { org_id: o.id, id: randomUUID(), pit_filing_period: 'month', fiscal_year_end_month: 12, obligations: '{vat_return}', updated_by: o.owner } }),
  },
  'crove_kernel.tenant': {
    seed: false,
    noInsertControl: 'the only tenant row an actor may write is its own org, which already exists',
    make: (o) => ({ row: { org_id: o.id, slug: `rls-${tag()}`, name: 'RLS matrix', created_by: o.owner } }),
  },
  'crove_kernel.tenant_member': { make: (o) => ({ row: { org_id: o.id, user_id: o.freshUser(), role: 'member' } }) },
  // An item kept for an org's next daily budget (#675): append-only, tenants read and insert.
  'crove_kernel.usage_deferral': {
    make: (o) => ({ row: { org_id: o.id, id: randomUUID(), metric: 'extraction_pages', subject_type: 'file', subject_id: randomUUID(), retry_at: '2099-01-01T00:00:00Z' } }),
  },
  // A channel's daily count of followers (#645), recorded by the worker: one per channel and day.
  'crove_social.account_snapshot': {
    make: (o) => {
      const connection = channelConnectionRow(o);
      return {
        setup: [{ table: 'crove_kernel.channel_connection', values: connection }],
        row: { org_id: o.id, id: randomUUID(), channel_connection_id: connection.id, captured_on: '2026-10-20', followers: 120 },
      };
    },
  },
  // A banned or sensitive phrase of the org (#1055), warned or blocked before approval. One per normalized phrase and
  // org, so each row gets its own phrase however many rows an org gets.
  'crove_social.banned_word': {
    make: (o) => {
      const phrase = `rls matrix ${tag()}`;
      return { row: { org_id: o.id, id: randomUUID(), phrase, normalized: phrase, level: 'warn', created_by: o.owner } };
    },
  },
  // An org's link-in-bio page (#707), and a day's clicks on one of its links; only the page's definer counts clicks.
  'crove_social.bio_click': {
    make: (o) => {
      const page = socialBioPageRow(o);
      return { setup: [{ table: 'crove_social.bio_page', values: page }], row: { org_id: o.id, page_id: page.id, target: 'button:0', day: '2026-10-20', clicks: 2 } };
    },
    noInsertControl: 'only the bio page definer counts clicks, for a visitor following a link; tenant roles may only read them',
  },
  'crove_social.bio_page': { make: (o) => ({ row: socialBioPageRow(o) }) },
  // The org's brand voice for AI drafts, or one channel's (#741).
  'crove_social.brand_voice': { make: (o) => ({ row: { org_id: o.id, id: randomUUID(), description: 'RLS matrix voice', updated_by: o.owner } }) },
  // A private calendar feed of the org's posts (#862): the SHA-256 of its token, who made it, its revocation.
  'crove_social.calendar_feed': { make: (o) => ({ row: { org_id: o.id, id: randomUUID(), token_sha256: hex64(), created_by: o.owner } }) },
  // A team's note on calendar dates (#794): a title over one day or a range, with a colour from the app's palette.
  'crove_social.calendar_note': { make: (o) => ({ row: { org_id: o.id, id: randomUUID(), starts_on: '2026-10-20', ends_on: '2026-10-22', title: 'RLS matrix note', created_by: o.owner, updated_by: o.owner } }) },
  // A channel a limited member may work on (#1081): a member with rows is limited to those channels, a member with none
  // is not limited. The member is the org's owner, the one member the fixture has (tenant roles cannot add members;
  // only the commands skip owners and admins). One row per member and connection, so each row gets its own fresh
  // connection however many rows an org gets.
  'crove_social.channel_access': {
    make: (o) => {
      const connection = channelConnectionRow(o);
      return {
        setup: [{ table: 'crove_kernel.channel_connection', values: connection }],
        row: { org_id: o.id, id: randomUUID(), user_id: o.owner, channel_connection_id: connection.id, created_by: o.owner },
      };
    },
  },
  // A channel's options for the composer (#1120, a Pinterest board's sections), cached per connection and kind: asked
  // for by a member, filled in by the worker. One row per connection and kind, so each row gets its own fresh
  // connection however many rows an org gets.
  'crove_social.channel_option': {
    make: (o) => {
      const connection = channelConnectionRow(o);
      return {
        setup: [{ table: 'crove_kernel.channel_connection', values: connection }],
        row: { org_id: o.id, id: randomUUID(), channel_connection_id: connection.id, kind: 'pinterest_section', status: 'pending', requested_at: new Date().toISOString() },
      };
    },
  },
  // The review policy of a channel (S9, issue #394): how many people approve a variant, and whether its reviewers
  // are reminded (#703), one row per connection.
  'crove_social.channel_policy': {
    make: (o) => {
      const connection = channelConnectionRow(o);
      return {
        setup: [{ table: 'crove_kernel.channel_connection', values: connection }],
        row: { org_id: o.id, channel_connection_id: connection.id, approvals_required: 2, updated_by: o.owner },
      };
    },
  },
  // A saved set of channels for the composer (#774): a name and the connections it picks.
  'crove_social.channel_set': { make: (o) => ({ row: { org_id: o.id, id: randomUUID(), name: `RLS matrix set ${randomUUID().slice(0, 6)}`, updated_by: o.owner } }) },
  // The org's team chat for Social alerts (#863): a Telegram or Discord target, sealed, and the kinds it gets.
  'crove_social.chat_alert': { make: (o) => ({ row: chatAlertRow(o) }) },
  // Definer-only machinery: the sealed target of the org's team chat alert (#863), one row per alert. The envelope is
  // opaque bytes here; only the vault in the worker opens a real one.
  'crove_social.chat_alert_target': {
    make: (o) => {
      const alert = chatAlertRow(o);
      return {
        setup: [{ table: 'crove_social.chat_alert', values: alert }],
        row: { org_id: o.id, alert_id: alert.id, key_id: 'rls-matrix', envelope: '\\x00' },
      };
    },
  },
  // The weekly digest's sent marker (#1104): the worker's sweep writes one row per org and ISO week, so each row gets
  // its own week however many rows an org gets.
  'crove_social.digest_week': { make: (o) => ({ row: { org_id: o.id, id: randomUUID(), iso_week: `${digestWeekYear++}-W01` } }) },
  // The worker's last bring-in of a channel's posts published outside Crove (#1054): one row per connection, so each
  // row gets its own fresh connection.
  'crove_social.external_import': {
    make: (o) => {
      const connection = channelConnectionRow(o);
      return {
        setup: [{ table: 'crove_kernel.channel_connection', values: connection }],
        row: { org_id: o.id, id: randomUUID(), channel_connection_id: connection.id, found: 2 },
      };
    },
  },
  // A post a channel published outside Crove (#1054), brought in by the worker for its counts: one row per connection
  // and platform id.
  'crove_social.external_post': {
    make: (o) => {
      const connection = channelConnectionRow(o);
      return {
        setup: [{ table: 'crove_kernel.channel_connection', values: connection }],
        row: { org_id: o.id, id: randomUUID(), channel_connection_id: connection.id, external_post_id: `rls_${tag()}`, published_at: '2026-10-20T00:00:00Z' },
      };
    },
  },
  // A metrics snapshot of a published variant (S8, issue #238): append-only, one per capture key.
  // An org's label for posts (#639): a name and a colour from the app's palette.
  // A blog feed an org drafts posts from (#708).
  'crove_social.feed': { make: (o) => ({ row: socialFeedRow(o) }) },
  // An item of a feed, once it became a draft (#708).
  'crove_social.feed_item': {
    make: (o) => {
      const feed = socialFeedRow(o);
      return { setup: [{ table: 'crove_social.feed', values: feed }], row: { org_id: o.id, feed_id: feed.id, item_key: hex64(), title: 'RLS matrix item' } };
    },
  },
  // The org's monthly goals (#1056), for the whole org (no connection) or one channel: one row per scope, so each row
  // gets its own fresh connection however many rows an org gets.
  'crove_social.goal': {
    make: (o) => {
      const connection = channelConnectionRow(o);
      return {
        setup: [{ table: 'crove_kernel.channel_connection', values: connection }],
        row: { org_id: o.id, id: randomUUID(), connection_id: connection.id, posts: 12, created_by: o.owner, updated_by: o.owner },
      };
    },
  },
  // An idea on the Social ideas board (#701), before it becomes a draft.
  'crove_social.idea': { make: (o) => ({ row: socialIdeaRow(o) }) },
  // A label on an idea (#701).
  'crove_social.idea_label': {
    make: (o) => {
      const idea = socialIdeaRow(o);
      const label = socialLabelRow(o);
      return {
        setup: [
          { table: 'crove_social.idea', values: idea },
          { table: 'crove_social.label', values: label },
        ],
        row: { org_id: o.id, idea_id: idea.id, label_id: label.id },
      };
    },
  },
  'crove_social.label': { make: (o) => ({ row: socialLabelRow(o) }) },
  // A link's preview card (#641), cached per org and URL: asked for by a member, filled in by the worker.
  'crove_social.link_preview': {
    make: (o) => ({ row: { org_id: o.id, id: randomUUID(), url: `https://example.com/rls-${tag()}`, url_sha256: hex64(), status: 'pending', requested_at: new Date().toISOString() } }),
  },
  // A library file taken out of the Social pickers (#1302): at most one archive row per file (a unique key), so every
  // row gets a file of its own.
  'crove_social.media_archive': {
    make: (o) => {
      const sha256 = hex64();
      const file = { org_id: o.id, id: randomUUID(), sha256, storage_key: `org/${o.id}/${sha256}`, filename: 'archived.jpg', content_type: 'image/jpeg', size_bytes: 1, source: 'social' };
      return { setup: [{ table: 'crove_kernel.file', values: file }], row: { org_id: o.id, id: randomUUID(), file_id: file.id, archived_by: o.owner } };
    },
  },
  // The credit of a library file saved from a stock photo site (#1106): the photographer, the photo's page and its
  // description, one per file. Each row gets a file of its own, since a file has at most one.
  'crove_social.media_attribution': {
    make: (o) => {
      const sha256 = hex64();
      const file = { org_id: o.id, id: randomUUID(), sha256, storage_key: `org/${o.id}/${sha256}`, filename: 'stock.jpg', content_type: 'image/jpeg', size_bytes: 1, source: 'social' };
      return {
        setup: [{ table: 'crove_kernel.file', values: file }],
        row: {
          org_id: o.id,
          id: randomUUID(),
          file_id: file.id,
          provider: 'pexels',
          external_id: `rls-${tag()}`,
          photographer: 'RLS Matrix',
          photographer_url: 'https://www.pexels.com/@rls-matrix',
          source_url: `https://www.pexels.com/photo/rls-${tag()}/`,
          alt_text: 'A photo for the RLS matrix',
          created_by: o.owner,
        },
      };
    },
  },
  // A tag on a media library file (#904): one name per file (case-insensitive), so every row gets its own name.
  'crove_social.media_tag': { make: (o) => ({ row: { org_id: o.id, id: randomUUID(), file_id: o.file, tag: `rls-${tag()}`, created_by: o.owner } }) },
  'crove_social.metric_snapshot': {
    make: (o) => {
      const { setup, variant } = socialVariantRows(o);
      return {
        setup: [...setup, { table: 'crove_social.post_variant', values: variant }],
        row: { org_id: o.id, variant_id: variant.id, capture_key: `rls-${tag()}`, metrics: '{}' },
      };
    },
  },
  // A notification for one member (#637), written once per event and person. A restrictive policy shows each member
  // only their own; the factory's rows belong to the owner, the user every member-context actor enters as.
  'crove_social.notification': { make: (o) => ({ row: { org_id: o.id, id: randomUUID(), user_id: o.owner, kind: 'comment', event_id: randomUUID() } }) },
  // A member who turned Social emails off (#579), under the same restrictive policy as the mutes.
  'crove_social.notification_mail_off': { make: (o) => ({ row: { org_id: o.id, id: randomUUID(), user_id: o.owner } }) },
  // A kind of notification a member turned off (#637), under the same restrictive policy. One row per member and kind:
  // an org's first row (the seeded one) takes the first kind, every later row (a probe, rolled back) another one.
  'crove_social.notification_mute': {
    make: (o) => {
      const n = muteRows.get(o.id) ?? 0;
      muteRows.set(o.id, n + 1);
      return { row: { org_id: o.id, user_id: o.owner, kind: MUTE_KINDS[n === 0 ? 0 : 1 + ((n - 1) % (MUTE_KINDS.length - 1))] ?? 'comment' } };
    },
  },
  'crove_social.post': { make: (o) => ({ row: socialPostRow(o) }) },
  // Append-only review decisions: tenant roles may only read and insert.
  'crove_social.post_approval': {
    make: (o) => {
      const { setup, variant } = socialVariantRows(o);
      return {
        setup: [...setup, { table: 'crove_social.post_variant', values: variant }],
        row: {
          org_id: o.id,
          post_id: variant.post_id,
          variant_id: variant.id,
          revision: 1,
          content_hash: ZERO_HASH,
          decision: 'approved',
          decided_by: o.owner,
          snapshot: '{}',
        },
      };
    },
  },
  // An internal comment on a post (#582), by a member, never published.
  'crove_social.post_comment': {
    make: (o) => {
      const post = socialPostRow(o);
      return {
        setup: [{ table: 'crove_social.post', values: post }],
        row: { org_id: o.id, post_id: post.id, author_user_id: o.owner, body: 'RLS matrix comment' },
      };
    },
  },
  // An image of a post (issue #372): a file of the org, at a position in the post's media list.
  // A label on a post (#639).
  'crove_social.post_label': {
    make: (o) => {
      const post = socialPostRow(o);
      const label = socialLabelRow(o);
      return {
        setup: [
          { table: 'crove_social.post', values: post },
          { table: 'crove_social.label', values: label },
        ],
        row: { org_id: o.id, post_id: post.id, label_id: label.id },
      };
    },
  },
  'crove_social.post_media': {
    make: (o) => {
      const post = socialPostRow(o);
      return { setup: [{ table: 'crove_social.post', values: post }], row: { org_id: o.id, post_id: post.id, file_id: o.file, position: 1 } };
    },
  },
  'crove_social.post_variant': {
    make: (o) => {
      const { setup, variant } = socialVariantRows(o);
      return { setup, row: variant };
    },
  },
  // A saved version of a post's content (#1021), numbered per post. Each row gets its own post, so the per-post unique
  // number never collides however many rows an org gets.
  'crove_social.post_version': {
    make: (o) => {
      const post = socialPostRow(o);
      return {
        setup: [{ table: 'crove_social.post', values: post }],
        row: { org_id: o.id, id: randomUUID(), post_id: post.id, number: 1, revision: 1, body: 'RLS matrix version', created_by: o.owner },
      };
    },
  },
  // A hold on all of an org's publishing (#946), by an owner or admin with a reason. The commands keep one live hold per
  // org under an advisory lock; the table has no unique index, so an org's rows may all be live.
  'crove_social.publish_hold': { make: (o) => ({ row: { org_id: o.id, id: randomUUID(), reason: `RLS matrix hold ${tag()}`, held_by: o.owner } }) },
  // A member's browser push subscription on one device (#1238), under a restrictive policy like the mutes: each member
  // sees and changes only their own. One endpoint per member, so every row gets its own; the keys are a P-256 point and
  // a 16-byte secret, base64url.
  'crove_social.push_subscription': {
    make: (o) => ({
      row: {
        org_id: o.id,
        id: randomUUID(),
        user_id: o.owner,
        endpoint: `https://push.example.com/rls-${tag()}`,
        p256dh: Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString('base64url'),
        auth: randomBytes(16).toString('base64url'),
        user_agent: 'RLS matrix',
      },
    }),
  },
  // One queue per connection, so every queue row gets its own connection.
  'crove_social.queue': {
    make: (o) => {
      const connection = channelConnectionRow(o);
      return { setup: [{ table: 'crove_kernel.channel_connection', values: connection }], row: { org_id: o.id, channel_connection_id: connection.id } };
    },
  },
  'crove_social.queue_slot': {
    make: (o) => {
      const connection = channelConnectionRow(o);
      const queue = { org_id: o.id, id: randomUUID(), channel_connection_id: connection.id };
      return {
        setup: [
          { table: 'crove_kernel.channel_connection', values: connection },
          { table: 'crove_social.queue', values: queue },
        ],
        row: { org_id: o.id, queue_id: queue.id, weekday: 1, minute: 540 },
      };
    },
  },
  // An org's white-label branding of its client reports (#1053): a display name, the logo as a small inline data URL
  // (here the eight bytes of a PNG signature), an accent colour. The commands keep one per org under an advisory lock;
  // the table has no unique index, so an org may get several rows.
  'crove_social.report_branding': {
    make: (o) => ({ row: { org_id: o.id, id: randomUUID(), display_name: `RLS agency ${tag()}`, logo: 'data:image/png;base64,iVBORw0KGgo=', accent: '#1d4ed8', updated_by: o.owner } }),
  },
  // A client report link of a period (#643): the SHA-256 of its token, the period, the channels (none: all), an expiry.
  'crove_social.report_link': {
    make: (o) => ({
      row: { org_id: o.id, id: randomUUID(), token_sha256: hex64(), period_start: '2026-10-01T00:00:00Z', period_end: '2026-11-01T00:00:00Z', created_by: o.owner, expires_at: new Date(Date.now() + 86_400_000).toISOString() },
    }),
  },
  // A schedule that mails the client report (#704): weekly or monthly, its period, channels and recipients.
  'crove_social.report_schedule': { make: (o) => ({ row: socialReportScheduleRow(o) }) },
  // One time a schedule sent (or a test send): the period, written by the worker or an owner's test.
  'crove_social.report_schedule_run': {
    make: (o) => {
      const schedule = socialReportScheduleRow(o);
      return {
        setup: [{ table: 'crove_social.report_schedule', values: schedule }],
        row: { org_id: o.id, id: randomUUID(), schedule_id: schedule.id, kind: 'scheduled', period_start: '2026-10-12T00:00:00Z', period_end: '2026-10-19T00:00:00Z' },
      };
    },
  },
  // An item of the org's review checklist (#1105), ticked by a reviewer before approving: for every channel (no
  // connection) or one channel, at a position. The table has no unique index (the commands keep at most 10 items per
  // org under an advisory lock), so the rows of an org may share a position; each row gets its own fresh connection.
  'crove_social.review_check': {
    make: (o) => {
      const connection = channelConnectionRow(o);
      return {
        setup: [{ table: 'crove_kernel.channel_connection', values: connection }],
        row: { org_id: o.id, id: randomUUID(), channel_connection_id: connection.id, position: 0, label: `RLS matrix check ${tag()}`, created_by: o.owner },
      };
    },
  },
  // What a client said through a review link (#589): only the review definer adds rows, for a client with the link;
  // members read them.
  'crove_social.review_feedback': {
    make: (o) => {
      const link = socialReviewLinkRow(o);
      return {
        setup: [
          { table: 'crove_social.post', values: link.post },
          { table: 'crove_social.review_link', values: link.row },
        ],
        row: { org_id: o.id, link_id: link.row.id, post_id: link.post.id, reviewer_name: 'RLS matrix client', verdict: 'comment', body: 'RLS matrix feedback' },
      };
    },
    noInsertControl: 'only the review definer adds rows, for a client holding the link; tenant roles may only read them',
  },
  // A client review link of a post (#589): the hash of its token, its expiry (at most 31 days ahead) and its revocation.
  'crove_social.review_link': {
    make: (o) => {
      const link = socialReviewLinkRow(o);
      return { setup: [{ table: 'crove_social.post', values: link.post }], row: link.row };
    },
  },
  // A post of a plan review link (#902): a plan link names no post, its posts are these rows, one per post of a link,
  // so every row gets its own link and post. Members read them; the create command adds them once.
  'crove_social.review_link_post': {
    make: (o) => {
      const post = socialPostRow(o);
      const link = { org_id: o.id, id: randomUUID(), kind: 'plan', token_sha256: hex64(), created_by: o.owner, expires_at: new Date(Date.now() + 86_400_000).toISOString() };
      return {
        setup: [
          { table: 'crove_social.post', values: post },
          { table: 'crove_social.review_link', values: link },
        ],
        row: { org_id: o.id, id: randomUUID(), link_id: link.id, post_id: post.id, position: 0 },
      };
    },
  },
  // A member's saved view of the posts (#1300): a name and the filters it applies, private or shared with the org,
  // under a restrictive policy that shows a private view to its owner alone; the factory's rows belong to the owner,
  // the user every member-context actor enters as. One name per member, so every row gets its own.
  'crove_social.saved_view': {
    make: (o) => ({ row: { org_id: o.id, id: randomUUID(), user_id: o.owner, name: `rls-${tag()}`, filters: '{"assignee":"me"}' } }),
  },
  // A saved snippet of text (#584): hashtags, a signature or a whole post to start from.
  // A post's link as Crove shortened it when the variant went out (#706); the worker writes it.
  'crove_social.short_link': {
    make: (o) => {
      const { setup, link } = socialShortLinkRows(o);
      return { setup, row: link };
    },
  },
  // A day's clicks on a short link (#706): only the redirect's definer counts them; members read them.
  'crove_social.short_link_click': {
    make: (o) => {
      const { setup, link } = socialShortLinkRows(o);
      return { setup: [...setup, { table: 'crove_social.short_link', values: link }], row: { org_id: o.id, short_link_id: link.id, day: '2026-10-20', clicks: 3 } };
    },
    noInsertControl: 'only the redirect definer counts clicks, for a visitor following the link; tenant roles may only read them',
  },
  'crove_social.snippet': { make: (o) => ({ row: { org_id: o.id, name: `rls-${tag()}`, body: '#rls', created_by: o.owner } }) },
  // The org's logo watermark for post images (#834): the logo file, a corner, a size and an opacity.
  'crove_social.watermark': { make: (o) => ({ row: { org_id: o.id, id: randomUUID(), file_id: o.file, corner: 'bottom_right', scale_percent: 20, opacity_percent: 80, updated_by: o.owner } }) },
};

function insertSql(row: Row): { text: string; values: Array<string | number> } {
  const columns = Object.keys(row.values);
  return {
    text: `INSERT INTO ${row.table} (${columns.map((c) => `"${c}"`).join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
    values: Object.values(row.values),
  };
}

interface Relation {
  name: string;
  kind: string;
  rls: boolean;
  owner: string;
}

// Creates the database, applies the migrations and reads the catalog before the cases are collected, so every
// relation with org_id becomes its own describe block.
async function prepare() {
  const dbName = `crove_test_rls_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const root = new pg.Client({ connectionString: ADMIN });
  await root.connect();
  await root.query(`CREATE DATABASE ${dbName}`);
  await root.end();
  const url = new URL(ADMIN as string);
  url.pathname = `/${dbName}`;
  const adminUrl = url.toString();
  const admin = new pg.Client({ connectionString: adminUrl });
  try {
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    await admin.connect();
    const { rows } = await admin.query<Relation>(
      `SELECT pg_catalog.format('%I.%I', n.nspname, c.relname) AS name, c.relkind::text AS kind, c.relrowsecurity AS rls,
              pg_catalog.pg_get_userbyid(c.relowner) AS owner
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
         AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
         AND EXISTS (
           SELECT 1 FROM pg_catalog.pg_attribute a
           WHERE a.attrelid = c.oid AND a.attname = 'org_id' AND a.attnum > 0 AND NOT a.attisdropped)
       ORDER BY 1`,
    );
    return { dbName, adminUrl, relations: rows };
  } catch (error) {
    const cleanup = new pg.Client({ connectionString: ADMIN });
    await cleanup.connect();
    await cleanup.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
    await cleanup.end();
    throw error;
  } finally {
    await admin.end().catch(() => {});
  }
}

const setup = ADMIN ? await prepare() : undefined;
const suite = setup ? describe : describe.skip;
const relations = setup?.relations ?? [];

type Op = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';
type Outcome = { ok: true; rows: Array<{ org: string }>; rowCount: number } | { ok: false; code: string; message: string };

suite('generated cross-org RLS matrix on PostgreSQL (T8)', () => {
  const { dbName, adminUrl } = setup ?? { dbName: '', adminUrl: '' };
  const clients: pg.Client[] = [];
  let pool: pg.Pool | undefined;
  const orgs: Record<'A' | 'B', OrgFixture> = {} as Record<'A' | 'B', OrgFixture>;
  let admin: pg.Client;

  interface Actor {
    name: string;
    role: string;
    client: pg.Client;
    // The org whose context the actor runs in, or null for no context.
    org: 'A' | null;
    enter: (c: pg.Client) => Promise<void>;
  }
  const actors: Actor[] = [];
  // privileges[table][role] = the table privileges the role holds.
  const privileges = new Map<string, Map<string, Set<Op>>>();

  async function connect(url: string) {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    clients.push(client);
    return client;
  }

  async function adminTx(rows: Row[]) {
    await admin.query('BEGIN');
    try {
      for (const row of rows) {
        const q = insertSql(row);
        await admin.query(q.text, q.values);
      }
      await admin.query('COMMIT');
    } catch (error) {
      await admin.query('ROLLBACK');
      throw error;
    }
  }

  // Runs one probe in its own transaction as the actor and always rolls back.
  async function probe(actor: Actor, run: (c: pg.Client) => Promise<pg.QueryResult>): Promise<Outcome> {
    const c = actor.client;
    await c.query('BEGIN');
    try {
      await actor.enter(c);
      try {
        const result = await run(c);
        return { ok: true, rows: result.rows as Array<{ org: string }>, rowCount: result.rowCount ?? 0 };
      } catch (error) {
        const e = error as { code?: string; message: string };
        return { ok: false, code: e.code ?? '', message: e.message };
      }
    } finally {
      await c.query('ROLLBACK');
    }
  }

  // Runs a statement with no WHERE clause that reads no column, so only the policies of its own command apply (a
  // WHERE clause would also apply the SELECT policies and hide a leak in an UPDATE or DELETE policy). Returns how
  // many rows it changed next to how many the actor could see, or null when the statement failed (nothing changed:
  // an append-only trigger or a foreign key may refuse it).
  async function sweep(actor: Actor, table: string, statement: string, params: string[]) {
    const c = actor.client;
    await c.query('BEGIN');
    try {
      await actor.enter(c);
      const { rows } = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
      try {
        const result = await c.query(statement, params);
        return { visible: rows[0]?.n ?? 0, changed: result.rowCount ?? 0 };
      } catch {
        return null;
      }
    } finally {
      await c.query('ROLLBACK');
    }
  }

  const can = (table: string, role: string, op: Op) => privileges.get(table)?.get(role)?.has(op) ?? false;
  // updatable[table][role] = the columns the role may update (all of them for a table-level grant).
  const updatable = new Map<string, Map<string, string[]>>();
  const columnsToUpdate = (table: string, role: string) => updatable.get(table)?.get(role) ?? [];

  function expectDenied(outcome: Outcome, pattern: RegExp, where: string) {
    if (outcome.ok) throw new Error(`${where}: expected 42501 matching ${pattern}, but it succeeded (${outcome.rowCount} rows)`);
    // A 23xxx error would mean the probe row is malformed, so the denial would prove nothing.
    expect(outcome, `${where}: expected 42501 matching ${pattern}`).toMatchObject({ code: '42501', message: expect.stringMatching(pattern) });
  }

  function expectRows(outcome: Outcome, where: string): { rows: Array<{ org: string }>; rowCount: number } {
    if (!outcome.ok) throw new Error(`${where}: expected the statement to run, got ${outcome.code} ${outcome.message}`);
    return outcome;
  }

  function factoryFor(table: string): RowFactory {
    const factory = ROW_FACTORIES[table];
    if (!factory) {
      throw new Error(`${table} has org_id but no row factory: add one to ROW_FACTORIES in apps/kernel/test/invariant/rls-matrix.db.test.ts`);
    }
    return factory;
  }

  beforeAll(async () => {
    admin = await connect(adminUrl);
    const loginUrl = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      return url.toString();
    };
    pool = createPool({ connectionString: loginUrl('crove_app', 'test-app-pw'), max: 2 });
    const db = createDb(pool);
    const runtime = new Runtime(db).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: 'in.test' }) });
    const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });

    // Users who belong to no org yet, for membership rows.
    const { rows: pooled } = await admin.query<{ id: string }>(
      `INSERT INTO crove_kernel.user_account (issuer, subject, email)
       SELECT 'rls-matrix', 'pool-' || g, 'pool-' || g || '@rls.test' FROM pg_catalog.generate_series(1, 40) g RETURNING id`,
    );
    const free = pooled.map((r) => r.id);
    const freshUser = () => {
      const id = free.pop();
      if (!id) throw new Error('the RLS matrix ran out of pooled users');
      return id;
    };

    for (const key of ['A', 'B'] as const) {
      const owner = await upsertIdentity(db, { issuer: 'rls-matrix', subject: `owner-${key}`, email: `owner-${key}@rls.test`, name: null });
      const { orgId } = await createOrg(runtime, asUser(owner), `RLS matrix ${key}`);
      const org: OrgFixture = { id: orgId, owner, party: randomUUID(), file: randomUUID(), document: randomUUID(), entry: randomUUID(), freshUser };
      const sha256 = hex64();
      // Parents the factories point at, one set per org.
      await adminTx([
        { table: 'crove_kernel.party', values: { org_id: orgId, id: org.party, name: `Vendor ${key}` } },
        {
          table: 'crove_kernel.file',
          values: { org_id: orgId, id: org.file, sha256, storage_key: `org/${orgId}/${sha256}`, filename: 'hd.xml', content_type: 'application/xml', size_bytes: 1, source: 'upload' },
        },
        {
          table: 'crove_finance.purchase_document',
          values: { org_id: orgId, id: org.document, party_id: org.party, invoice_number: `base-${key}`, invoice_date: '2026-10-01', subtotal: '100', vat_amount: '10', total: '110' },
        },
        // The document's own entry (#560).
        { table: 'crove_finance.journal_entry', values: { ...journalEntry(orgId, org.entry).values, source_type: 'finance.purchase_document', source_id: org.document } },
        balancingLine(orgId, org.entry, 1, 'debit'),
        balancingLine(orgId, org.entry, 2, 'credit'),
      ]);
      orgs[key] = org;
    }

    // Seed one row per org in every table that has a factory, as the database owner.
    for (const relation of relations) {
      const factory = ROW_FACTORIES[relation.name];
      if (!factory || factory.seed === false || !['r', 'p'].includes(relation.kind)) continue;
      for (const org of [orgs.A, orgs.B]) {
        const built = factory.make(org);
        await adminTx([...(built.setup ?? []), { table: relation.name, values: built.row }, ...(built.complete ?? [])]);
      }
    }

    const roles = ['crove_app', 'crove_worker', 'crove_definer_tenant'];
    const { rows: grants } = await admin.query<{ tbl: string; role: string; op: Op }>(
      `SELECT t AS tbl, r AS role, p AS op
       FROM pg_catalog.unnest($1::text[]) t, pg_catalog.unnest($2::text[]) r, pg_catalog.unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p
       WHERE pg_catalog.has_table_privilege(r, t, p)`,
      [relations.map((r) => r.name), roles],
    );
    for (const g of grants) {
      const byRole = privileges.get(g.tbl) ?? new Map<string, Set<Op>>();
      privileges.set(g.tbl, byRole);
      const ops = byRole.get(g.role) ?? new Set<Op>();
      byRole.set(g.role, ops);
      ops.add(g.op);
    }

    const { rows: columns } = await admin.query<{ tbl: string; role: string; col: string }>(
      `SELECT t AS tbl, r AS role, a.attname::text AS col
       FROM pg_catalog.unnest($1::text[]) t, pg_catalog.unnest($2::text[]) r, pg_catalog.pg_attribute a
       WHERE a.attrelid = t::regclass AND a.attnum > 0 AND NOT a.attisdropped
         AND pg_catalog.has_column_privilege(r, t, a.attname, 'UPDATE')
       ORDER BY a.attnum`,
      [relations.filter((r) => ['r', 'p'].includes(r.kind)).map((r) => r.name), roles],
    );
    for (const c of columns) {
      const byRole = updatable.get(c.tbl) ?? new Map<string, string[]>();
      updatable.set(c.tbl, byRole);
      byRole.set(c.role, [...(byRole.get(c.role) ?? []), c.col]);
    }

    const app = await connect(loginUrl('crove_app', 'test-app-pw'));
    const worker = await connect(loginUrl('crove_worker', 'test-worker-pw'));
    const definer = await connect(adminUrl);
    const none = async () => {};
    actors.push(
      {
        name: 'crove_app as a member of org A',
        role: 'crove_app',
        client: app,
        org: 'A',
        enter: async (c) => {
          await c.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [orgs.A.owner, orgs.A.id]);
        },
      },
      {
        name: 'crove_worker in the system context of org A',
        role: 'crove_worker',
        client: worker,
        org: 'A',
        enter: async (c) => {
          await c.query('SELECT crove_kernel.enter_system_context($1::uuid)', [orgs.A.id]);
        },
      },
      {
        // The NOLOGIN owner of the definers that write the ledger, in the context a definer inherits.
        name: 'crove_definer_tenant in the context of org A',
        role: 'crove_definer_tenant',
        client: definer,
        org: 'A',
        enter: async (c) => {
          // Entered through enter_context (as the admin connection, before switching role), never by writing the
          // context settings by hand: a hand-written context grants nothing once the context is sealed (T11).
          await c.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [orgs.A.owner, orgs.A.id]);
          await c.query('SET LOCAL ROLE crove_definer_tenant');
          const { rows } = await c.query<{ who: string }>('SELECT current_user AS who');
          if (rows[0]?.who !== 'crove_definer_tenant') throw new Error('SET ROLE crove_definer_tenant did not take effect');
        },
      },
      { name: 'crove_app with no context', role: 'crove_app', client: app, org: null, enter: none },
      { name: 'crove_worker with no context', role: 'crove_worker', client: worker, org: null, enter: none },
    );
  });

  afterAll(async () => {
    for (const c of clients) await c.end().catch(() => {});
    await pool?.end();
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('finds the tenant tables in the catalog, and every row factory names one of them', () => {
    const names = relations.map((r) => r.name);
    expect(names).toContain('crove_kernel.party');
    expect(names).toContain('crove_finance.journal_line');
    const stale = Object.keys(ROW_FACTORIES).filter((t) => !names.includes(t) && !PENDING_TABLES.has(t));
    expect(stale, 'row factories for tables that no longer have org_id: remove them').toEqual([]);
    const staleMachinery = [...MACHINERY].filter((t) => !names.includes(t) && !PENDING_TABLES.has(t));
    expect(staleMachinery, 'MACHINERY lists tables that no longer have org_id').toEqual([]);
    const factories = Object.keys(ROW_FACTORIES);
    expect(factories, 'ROW_FACTORIES is kept in table-name order: add a factory at its sorted place').toEqual(
      [...factories].sort(),
    );
    const pending = [...PENDING_TABLES];
    expect(pending, 'PENDING_TABLES is kept sorted, one table per line').toEqual([...pending].sort());
  });

  it('runs no runtime role as a superuser or with BYPASSRLS', async () => {
    const { rows } = await admin.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT rolname, rolsuper, rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = ANY($1::text[]) ORDER BY rolname',
      [RUNTIME_ROLES],
    );
    expect(rows.map((r) => r.rolname)).toEqual([...RUNTIME_ROLES].sort());
    expect(rows.filter((r) => r.rolsuper || r.rolbypassrls)).toEqual([]);
  });

  for (const relation of relations) {
    const table = relation.name;
    describe(table, () => {
      it('has RLS enabled, the tenant policy or no access at all, a safe owner and a row factory', async () => {
        expect(['r', 'p'], `${table} is a relation of kind '${relation.kind}' with org_id; the RLS matrix covers tables only`).toContain(relation.kind);
        expect(relation.rls, `${table} has org_id but row-level security is not enabled; in a new migration run SELECT crove_kernel.apply_tenant_rls('${table}') ` +
            `(tenant table) or ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY (definer-only machinery, listed in MACHINERY)`).toBe(true);
        factoryFor(table);

        // RLS is enabled, not forced, so the owner bypasses it: no runtime role may own the table or act as its owner.
        const { rows: owners } = await admin.query<{ role: string }>(
          `SELECT r AS role FROM pg_catalog.unnest($1::text[]) r WHERE pg_catalog.pg_has_role(r, $2::text, 'MEMBER')`,
          [RUNTIME_ROLES, relation.owner],
        );
        expect(owners.map((o) => o.role), `runtime roles that own ${table} (owner ${relation.owner})`).toEqual([]);

        // Every role other than the owner (and roles acting as it) and superusers.
        const { rows: grants } = await admin.query<{ role: string; op: string; bypass: boolean }>(
          `SELECT r.rolname AS role, p AS op, r.rolbypassrls AS bypass
           FROM pg_catalog.pg_roles r, pg_catalog.unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
           WHERE NOT r.rolsuper AND r.rolname NOT LIKE 'pg\\_%'
             AND NOT pg_catalog.pg_has_role(r.oid, (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = $1::regclass), 'MEMBER')
             AND pg_catalog.has_table_privilege(r.oid, $1::regclass, p)
           ORDER BY 1, 2`,
          [table],
        );
        // TRUNCATE ignores RLS; REFERENCES and TRIGGER let a role probe or intercept rows outside it.
        expect(grants.filter((g) => !['SELECT', 'INSERT', 'UPDATE', 'DELETE'].includes(g.op)), `privileges on ${table} that RLS does not govern`).toEqual([]);
        expect(grants.filter((g) => g.bypass), `roles with BYPASSRLS and privileges on ${table}`).toEqual([]);
        // Column-level grants are invisible to has_table_privilege, so the read and insert probes would not expect
        // them. Column-level UPDATE is allowed: the update probes read the updatable columns per role.
        const { rows: columnGrants } = await admin.query<{ role: string; op: string }>(
          `SELECT r.rolname AS role, p AS op
           FROM pg_catalog.pg_roles r, pg_catalog.unnest(ARRAY['SELECT', 'INSERT', 'REFERENCES']) p
           WHERE NOT r.rolsuper AND r.rolname NOT LIKE 'pg\\_%'
             AND NOT pg_catalog.pg_has_role(r.oid, (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = $1::regclass), 'MEMBER')
             AND pg_catalog.has_any_column_privilege(r.oid, $1::regclass, p)
             AND NOT pg_catalog.has_table_privilege(r.oid, $1::regclass, p)
           ORDER BY 1, 2`,
          [table],
        );
        expect(columnGrants, `column-level privileges on ${table}: grant on the table instead, so the matrix probes them`).toEqual([]);

        const { rows: policies } = await admin.query<{ name: string; permissive: boolean; cmd: string; roles: string[]; qual: string | null; check: string | null }>(
          `SELECT p.polname AS name, p.polpermissive AS permissive, p.polcmd::text AS cmd,
                  ARRAY(SELECT CASE WHEN o = 0 THEN 'public' ELSE pg_catalog.pg_get_userbyid(o) END FROM pg_catalog.unnest(p.polroles) o ORDER BY 1)::text[] AS roles,
                  pg_catalog.pg_get_expr(p.polqual, p.polrelid) AS qual, pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) AS check
           FROM pg_catalog.pg_policy p WHERE p.polrelid = $1::regclass ORDER BY 1`,
          [table],
        );
        const permissive = policies.filter((p) => p.permissive);
        if (MACHINERY.has(table)) {
          expect(grants, `${table} is listed as definer-only machinery, but these roles hold privileges on it`).toEqual([]);
          expect(permissive, `${table} is definer-only machinery and needs no permissive policy`).toEqual([]);
          return;
        }
        expect(grants.length, `${table} has org_id, no role may access it and it is not listed in MACHINERY`).toBeGreaterThan(0);
        // Exactly the tenant policy; any other permissive policy would widen it (policies are OR-ed).
        expect(permissive, `${table} must have exactly the tenant_isolation policy of crove_kernel.apply_tenant_rls`).toEqual([
          { name: 'tenant_isolation', permissive: true, cmd: '*', roles: ['crove_tenant'], qual: TENANT_PREDICATE, check: TENANT_PREDICATE },
        ]);
      });

      it('lets no actor read another org, and no context reads nothing', async () => {
        factoryFor(table);
        const { rows: seeded } = await admin.query<{ org: string; n: number }>(`SELECT org_id::text AS org, count(*)::int AS n FROM ${table} GROUP BY 1`);
        const count = (org: OrgFixture) => seeded.find((s) => s.org === org.id)?.n ?? 0;
        expect(count(orgs.B), `${table} has no org B rows to probe`).toBeGreaterThan(0);
        expect(count(orgs.A), `${table} has no org A rows to probe`).toBeGreaterThan(0);
        for (const actor of actors) {
          const where = `${actor.name} reading ${table}`;
          const outcome = await probe(actor, (c) => c.query(`SELECT org_id::text AS org FROM ${table}`));
          if (!can(table, actor.role, 'SELECT')) {
            expectDenied(outcome, PRIVILEGE_DENIED, where);
            continue;
          }
          const { rows } = expectRows(outcome, where);
          if (actor.org === null) {
            expect(rows, `${where}: no context must read no rows`).toEqual([]);
          } else {
            expect(rows.filter((r) => r.org !== orgs.A.id), `${where}: rows of other orgs`).toEqual([]);
            // Control: the same query sees the actor's own rows, so the empty result for org B is the org filter.
            expect(rows.length, `${where}: its own org's rows`).toBe(count(orgs.A));
          }
          // Asking for org B by name changes nothing.
          const byOrg = expectRows(await probe(actor, (c) => c.query(`SELECT org_id::text AS org FROM ${table} WHERE org_id = $1`, [orgs.B.id])), where);
          expect(byOrg.rows, `${where}: org B rows by org_id`).toEqual([]);
        }
      });

      it('lets no actor insert a row for another org, and no context inserts nothing', async () => {
        const factory = factoryFor(table);
        for (const actor of actors) {
          const where = `${actor.name} inserting into ${table} for org B`;
          const outcome = await probe(actor, (c) => {
            const q = insertSql({ table, values: factory.make(orgs.B).row });
            return c.query(q.text, q.values);
          });
          if (!can(table, actor.role, 'INSERT')) {
            expectDenied(outcome, PRIVILEGE_DENIED, where);
            continue;
          }
          expectDenied(outcome, factory.insertDenied ?? RLS_DENIED, where);
          if (actor.org === null || factory.noInsertControl) continue;
          // Control: the same factory's row for the actor's own org is accepted, so the refusal above is about the org.
          const control = await probe(actor, async (c) => {
            const built = factory.make(orgs.A);
            for (const row of built.setup ?? []) {
              const s = insertSql(row);
              await c.query(s.text, s.values);
            }
            const q = insertSql({ table, values: built.row });
            return c.query(q.text, q.values);
          });
          expect(expectRows(control, `${actor.name} inserting into ${table} for its own org (control)`).rowCount).toBe(1);
        }
      });

      it('lets no actor update another org, or move its own rows there', async () => {
        const factory = factoryFor(table);
        for (const actor of actors) {
          const where = `${actor.name} updating ${table}`;
          const cols = columnsToUpdate(table, actor.role);
          const byOrg = cols.includes('org_id');
          // The assignment the probes use: org_id itself when the role may update it (or may update nothing, so
          // the probe must be refused), else a granted column.
          const set = byOrg || cols.length === 0 ? 'org_id = org_id' : (factory.update?.set ?? `"${cols[0]}" = "${cols[0]}"`);
          const filter = !byOrg && factory.update?.where ? ` AND (${factory.update.where})` : '';
          const others = await probe(actor, (c) => c.query(`UPDATE ${table} SET ${set} WHERE org_id = $1${filter}`, [orgs.B.id]));
          const moved = await probe(actor, (c) => c.query(`UPDATE ${table} SET org_id = $1 WHERE org_id = $2`, [orgs.B.id, orgs.A.id]));
          if (cols.length === 0 || !can(table, actor.role, 'SELECT')) {
            expectDenied(others, PRIVILEGE_DENIED, `${where} (org B rows)`);
            expectDenied(moved, PRIVILEGE_DENIED, `${where} (moving org A rows to org B)`);
            continue;
          }
          expect(expectRows(others, `${where} (org B rows)`).rowCount, `${where}: org B rows updated`).toBe(0);
          // Update every row without reading a column: only rows the actor already sees may change.
          const pulled = byOrg
            ? await sweep(actor, table, `UPDATE ${table} SET org_id = $1`, [orgs.A.id])
            : await sweep(actor, table, `UPDATE ${table} SET ${set}`, []);
          if (pulled) expect(pulled.changed, `${where}: rows updated without a WHERE clause`).toBeLessThanOrEqual(pulled.visible);
          if (!byOrg) {
            // The role may not touch org_id at all.
            expectDenied(moved, PRIVILEGE_DENIED, `${where} (moving org A rows to org B)`);
          } else if (actor.org === null) {
            expect(expectRows(moved, `${where} (moving org A rows to org B)`).rowCount, `${where}: rows moved without a context`).toBe(0);
          } else {
            expectDenied(moved, RLS_DENIED, `${where} (moving org A rows to org B)`);
          }
          if (actor.org === null) continue;
          // Control: the same update on its own rows runs, so the zero above is the org filter.
          const own = await probe(actor, (c) => c.query(`UPDATE ${table} SET ${set} WHERE org_id = $1${filter}`, [orgs.A.id]));
          expect(expectRows(own, `${where} (own rows, control)`).rowCount, `${where}: own rows updated`).toBeGreaterThan(0);
        }
      });

      it('lets no actor delete or truncate another org', async () => {
        factoryFor(table);
        for (const actor of actors) {
          const where = `${actor.name} deleting from ${table}`;
          const outcome = await probe(actor, (c) => c.query(`DELETE FROM ${table} WHERE org_id = $1`, [orgs.B.id]));
          if (!(can(table, actor.role, 'DELETE') && can(table, actor.role, 'SELECT'))) {
            expectDenied(outcome, PRIVILEGE_DENIED, where);
          } else {
            expect(expectRows(outcome, where).rowCount, `${where}: org B rows deleted`).toBe(0);
            // Delete every row without reading a column: only rows the actor already sees may go.
            const swept = await sweep(actor, table, `DELETE FROM ${table}`, []);
            if (swept) expect(swept.changed, `${where}: rows deleted without a WHERE clause`).toBeLessThanOrEqual(swept.visible);
          }
          // TRUNCATE ignores RLS, so it must be refused outright.
          expectDenied(await probe(actor, (c) => c.query(`TRUNCATE ${table} CASCADE`)), PRIVILEGE_DENIED, `${actor.name} truncating ${table}`);
        }
        const { rows } = await admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE org_id = $1`, [orgs.B.id]);
        expect(rows[0]?.n, `${table} still has its org B rows`).toBeGreaterThan(0);
      });
    });
  }
});
