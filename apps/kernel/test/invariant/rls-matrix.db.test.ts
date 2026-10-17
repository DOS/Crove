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
  'crove_kernel.outbox_pending',
  'crove_kernel.refusal_tally',
]);
// Tables whose row factory (and MACHINERY entry, for definer-only tables) lands on main before the table itself. CI
// runs main's copy of this file on the PR that adds a table with org_id, so the factory has to be on main first;
// until the table exists, neither its factory nor its MACHINERY entry is stale. Remove an entry once its table is on
// main.
const PENDING_TABLES = new Set<string>(['crove_social.post_media']);
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
// Crove Social (S3): a post, and a variant of it for a fresh channel connection (one variant per connection).
const ZERO_HASH = `sha256:${'0'.repeat(64)}`;
const socialPostRow = (o: { id: string }) => ({ org_id: o.id, id: randomUUID(), body: 'RLS matrix post' });
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
const journalEntry = (org: string, id: string): Row => ({
  table: 'crove_finance.journal_entry',
  values: { org_id: org, id, entry_date: '2026-10-01', description: 'rls matrix', source_type: 'rls.matrix', source_id: randomUUID() },
});

// One factory per table with org_id. Each builds a valid row for the given org; the probes use the same factory
// for the actor's own org (which must be accepted where the role may write) and for the other org (which must be
// refused), so a denial cannot come from a malformed row.
const ROW_FACTORIES: Record<string, RowFactory> = {
  'crove_kernel.tenant': {
    seed: false,
    noInsertControl: 'the only tenant row an actor may write is its own org, which already exists',
    make: (o) => ({ row: { org_id: o.id, slug: `rls-${tag()}`, name: 'RLS matrix', created_by: o.owner } }),
  },
  'crove_kernel.tenant_member': { make: (o) => ({ row: { org_id: o.id, user_id: o.freshUser(), role: 'member' } }) },
  'crove_kernel.idempotency_key': {
    make: (o) => ({ row: { org_id: o.id, actor_key: `user:${o.owner}`, key: randomUUID(), command: 'rls.matrix', request_sha256: hex64() } }),
  },
  'crove_kernel.outbox_event': { make: (o) => ({ row: { org_id: o.id, id: randomUUID(), type: 'rls.matrix', payload: '{}' } }) },
  'crove_kernel.outbox_pending': { make: (o) => ({ row: { org_id: o.id, event_id: randomUUID() } }) },
  'crove_kernel.audit_event': {
    make: (o) => ({
      row: { org_id: o.id, actor_type: 'system', command: 'rls.matrix', command_id: randomUUID(), outcome: 'ok', input_sha256: hex64() },
    }),
  },
  'crove_kernel.party': { make: (o) => ({ row: { org_id: o.id, id: randomUUID(), name: 'RLS matrix party' } }) },
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
  'crove_kernel.inbound_message': { make: (o) => ({ row: { org_id: o.id, message_id: `<${randomUUID()}@rls.test>` } }) },
  'crove_kernel.extraction': { make: (o) => ({ row: { org_id: o.id, file_id: o.file, method: 'unsupported', status: 'failed' } }) },
  'crove_kernel.proposal': {
    make: (o) => ({ row: { org_id: o.id, kind: 'rls.matrix', command: 'rls.matrix', status: 'rejected', title: 'RLS matrix', payload: '{}' } }),
  },
  'crove_kernel.activity': {
    make: (o) => ({ row: { org_id: o.id, record_type: 'party', record_id: o.party, kind: 'rls.matrix', summary: 'RLS matrix' } }),
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
  'crove_kernel.auth_session_org': { make: (o) => ({ row: { org_id: o.id, user_id: o.owner, session_id: randomUUID() } }) },
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
  // Refusals counted per org, window, actor and (command, code) (issue #162). Definer-only machinery: no role but
  // the owner holds a privilege on it. A random code keeps every row its own key.
  'crove_kernel.refusal_tally': {
    make: (o) => ({
      row: { org_id: o.id, window_start: '2026-10-01T00:00:00Z', actor_key: `user:${o.owner}`, command: 'rls.matrix', code: `RLS_${tag()}` },
    }),
  },
  // Pending member invites (issue #35). An open invite per (org, email), so every row gets its own address. Token
  // hash and expiry take their defaults (an unusable random hash, seven days). Tenant roles may update only status,
  // revoked_at and revoked_by (a column grant), so the update probes write status, which the guard trigger allows
  // on a pending invite.
  'crove_kernel.member_invite': {
    make: (o) => ({ row: { org_id: o.id, email: `invite-${tag()}@rls.test`, role: 'member', invited_by: o.owner } }),
  },
  // ADR-0029 Phase 1 (#79): agents in the org chart. An agent row needs a template; every factory that needs an agent
  // adds a fresh one, since an agent runs once at a time and has at most one pending wake-up.
  'crove_kernel.agent': { make: (o) => ({ row: agentRow(o) }) },
  // position is an SQL keyword, so the catalog prints the name quoted.
  'crove_kernel."position"': {
    make: (o) => ({ row: { org_id: o.id, id: randomUUID(), title: 'RLS matrix seat', module: 'finance', role_key: 'finance.chief_accountant' } }),
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
  'crove_kernel.agent_wakeup': {
    make: (o) => {
      const agent = agentRow(o);
      return { setup: [{ table: 'crove_kernel.agent', values: agent }], row: { org_id: o.id, agent_id: agent.id } };
    },
  },
  // One active switch per (org, scope, target), so every row stops its own agent id.
  'crove_kernel.kill_switch': { make: (o) => ({ row: { org_id: o.id, scope: 'agent', target: randomUUID(), engaged_by: o.owner } }) },
  'crove_kernel.budget_policy': {
    make: (o) => ({ row: { org_id: o.id, scope: 'agent', target: randomUUID(), monthly_limit: '100', updated_by: o.owner } }),
  },
  'crove_kernel.channel_connection': { make: (o) => ({ row: channelConnectionRow(o) }) },
  // Definer-only machinery: the sealed token of a connection, one row per connection. The envelope is opaque bytes
  // here; only the vault in the worker opens a real one.
  'crove_social.post': { make: (o) => ({ row: socialPostRow(o) }) },
  'crove_social.post_variant': {
    make: (o) => {
      const { setup, variant } = socialVariantRows(o);
      return { setup, row: variant };
    },
  },
  // An image of a post (issue #372): a file of the org, at a position in the post's media list.
  'crove_social.post_media': {
    make: (o) => {
      const post = socialPostRow(o);
      return { setup: [{ table: 'crove_social.post', values: post }], row: { org_id: o.id, post_id: post.id, file_id: o.file, position: 1 } };
    },
  },
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
  // Definer-only machinery (Social plan §3.5, S6): one single-use OAuth state per connect attempt, holding the hash of
  // the state parameter and the PKCE verifier; only the start and callback definers touch it.
  'crove_kernel.oauth_state': {
    make: (o) => ({ row: { org_id: o.id, user_id: o.owner, provider: 'sandbox', state_hash: `sha256:${hex64()}`, expires_at: '2099-01-01T00:00:00Z' } }),
  },
  'crove_finance.purchase_document': {
    make: (o) => ({
      row: { org_id: o.id, party_id: o.party, invoice_number: tag(), invoice_date: '2026-10-01', subtotal: '100', vat_amount: '10', total: '110' },
    }),
  },
  'crove_finance.purchase_line': {
    make: (o) => ({ row: { org_id: o.id, document_id: o.document, line_no: lineNo++, description: 'RLS matrix', amount: '100', debit_account: '6422' } }),
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
  // An org's sub-accounts under the TT133 chart (#319): one row per (org, code), never deleted. The code extends its
  // parent's (here 6422.<tag>); a trigger fills root_code. Tenant roles update only name, active and updated_by (a
  // column grant), so the update probes assign name to itself.
  'crove_finance.org_account': {
    make: (o) => ({ row: { org_id: o.id, code: `6422.${tag().toUpperCase()}`, name: 'RLS matrix sub-account', parent_code: '6422' } }),
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
        journalEntry(orgId, org.entry),
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
