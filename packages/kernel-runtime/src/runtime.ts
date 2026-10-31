// The single write path. Every state change is a typed command executed through Runtime.execute(),
// inside one transaction that enters the tenant context checked by RLS, and writes audit + outbox.
import { PostgresQueryCompiler, sql, type KyselyPlugin, type RawBuilder, type Transaction } from 'kysely';
import { createHmac, randomUUID } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type { z } from 'zod';
import { contextTaint, singleCell, type CellResolver, type Database, type Db, type MemberRole } from '@crove/db';
import { DomainError, toDomainError } from './errors.ts';
import { eventPayloadProblem, normalizeEventPayload } from './event-payload.ts';
import { sha256Hex } from './storage.ts';

export type Risk = 'R0' | 'R1' | 'R2' | 'R3';

// What a command does (plan §4.2, §4.7 "Derived risk", #1563): none (reads or computes only), internal (a reversible
// write inside Crove), external (an effect outside Crove or visible to customers, including a queued send), financial,
// legal or irreversible. It covers everything the command's transaction does, the commands it runs included (an
// approval runs the approved command), but not what a later command does with what it leaves behind. The declared
// risk is at least the risk it derives.
export const SIDE_EFFECTS = Object.freeze(['none', 'internal', 'external', 'financial', 'legal', 'irreversible'] as const);
export type SideEffect = (typeof SIDE_EFFECTS)[number];

const RISK_ORDER: Record<Risk, number> = { R0: 0, R1: 1, R2: 2, R3: 3 };

// The lowest risk a side effect allows: financial, legal or irreversible R3; external R2; internal R1; none R0.
export function deriveRisk(sideEffect: SideEffect): Risk {
  if (sideEffect === 'financial' || sideEffect === 'legal' || sideEffect === 'irreversible') return 'R3';
  if (sideEffect === 'external') return 'R2';
  return sideEffect === 'internal' ? 'R1' : 'R0';
}

// Authenticator assurance level of the user's access token: aal2 means the session passed MFA.
export type Aal = 'aal1' | 'aal2';

export interface UserActor {
  type: 'user';
  userId: string;
  aal: Aal;
  // Supabase Auth session of the access token (`session_id`). Required when the runtime checks sessions.
  sessionId?: string;
  // Unix seconds of the newest second-factor `amr` entry, or null. R3 needs it within STEP_UP_MAX_AGE_S.
  mfaAt?: number | null;
  // Live check of this request's access token with Supabase Auth (ADR-0028 section 5), bound by the authenticator
  // so the token itself never travels with the actor. Resolves when Auth confirms the session's user; throws 401
  // or 503 otherwise.
  confirmLive?: () => Promise<void>;
}

// A position-holding agent acting in one of its runs (ADR-0029). It enters only in the worker, through
// crove_kernel.enter_agent_context, which checks the run is live and derives everything else from the database.
export interface AgentActor {
  type: 'agent';
  agentId: string;
  runId: string;
}

export type SystemActor = { type: 'system'; component: string };

export type Actor = UserActor | AgentActor | SystemActor;

// What enter_agent_context derived for this transaction: the agent's position, its role key (permissions come from
// it, never from tenant_member), the effective max_risk (the lower of the agent's and its template's) and whether
// the run is tainted. Never taken from the caller.
export interface AgentGrant {
  agentId: string;
  runId: string;
  positionId: string;
  roleKey: string;
  module: string;
  maxRisk: Exclude<Risk, 'R3'>;
  tainted: boolean;
}

// Which agents may run a command or query (ADR-0029 section 2). Absent means no agent may: the default for every
// command, so user-only commands (the chart, templates, budgets, kill switches, approvals, membership) never declare
// it. roles: the role keys of positions whose agent may run it, or 'any' position-holding agent (the handler then
// confines it to its own position's work).
export interface AgentAccess {
  roles: readonly string[] | 'any';
  // 'propagate': the command writes only kernel collaboration data (tasks, comments, wake-ups) whose rows carry the
  // run's taint forward, never a business record. A tainted run may run such a command at R1; every other command
  // refuses a tainted run at R1 and above (P03).
  taint?: 'propagate';
}

// What a built-in agent program gets for one run (ADR-0029 section 8): commands and queries bound to the run's agent
// actor and org. It holds no Runtime, so a program (and later a model or tool runner behind it) cannot act as another
// actor, in another org or as another run.
export interface AgentRuntime {
  readonly orgId: string;
  readonly agentId: string;
  readonly runId: string;
  execute<O = unknown>(name: string, input: unknown, options?: { idempotencyKey?: string }): Promise<O>;
  query<O = unknown>(name: string, input: unknown): Promise<O>;
}

// A built-in agent program (ADR-0029 section 8): what one run of a template does, only through its AgentRuntime.
export type AgentProgram = (agent: AgentRuntime) => Promise<void>;

// The AgentRuntime of one run: a frozen object whose methods close over the runtime and a copy of the actor.
export function agentRuntime(runtime: Runtime, orgId: string, actor: AgentActor): AgentRuntime {
  const bound: AgentActor = Object.freeze({ type: 'agent', agentId: actor.agentId, runId: actor.runId });
  return Object.freeze({
    orgId,
    agentId: bound.agentId,
    runId: bound.runId,
    execute: <O = unknown>(name: string, input: unknown, options?: { idempotencyKey?: string }) =>
      runtime.execute<O>(name, input, { actor: bound, orgId, ...(options?.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {}) }),
    query: <O = unknown>(name: string, input: unknown) => runtime.query<O>(name, input, { actor: bound, orgId }),
  });
}

const RISK_RANK: Record<Risk, number> = { R0: 0, R1: 1, R2: 2, R3: 3 };

// 'members' = owner/admin/member; 'system' = system actor only;
// 'proposal' = only run by the command that approved the proposal: the proposal is in state 'approved' for this
//   command, and its executed_command_id is the calling command (kernel.proposal.approve), checked in the database;
// 'proposal_revision' = only run by the proposal editor (the command that declares `proposalEditor`) on a pending
//   proposal of the command the reviser declares in `revises` (a module reviser computing the next revision), checked
//   in the database.
export type Access = readonly MemberRole[] | 'system' | 'proposal' | 'proposal_revision';

export interface CommandDef<I = unknown, O = unknown> {
  name: string;
  input: z.ZodType<I>;
  risk: Risk;
  // What it does beyond its transaction; register() refuses a command without one (#1637) and a declared risk below
  // deriveRisk(sideEffect) (#1563).
  sideEffect: SideEffect;
  access: Access;
  // A permission a user may hold through an org-wide role assignment (plan §4.6, issue #1279): a member whose role is
  // not in `access` still passes the role check when they hold it. Only with a role list as access, and only for user
  // actors; the runtime reads it in the command's own transaction (crove_kernel.ctx_has_permission), so a revoke
  // applies from the next command, and a user without it is refused FORBIDDEN before any step-up. The handler still
  // decides per record (the approval policy for approvals).
  permission?: string;
  // 'legal_entity' (#1507): a user who holds the permission for some legal entities only (entity-scoped assignments,
  // crove_kernel.ctx_permission_entities) passes the gate too, with those entities, and the handler must name the entity
  // it acts on through ctx.permissionEntity: one outside them is refused, and a command that names none fails (fails
  // closed) after its handler returns. Such a holder is past the gate, so an R3 command asks them for the step-up first
  // and refuses another entity after it. Default 'org': an org-wide assignment only, exactly as before. Only beside a
  // permission.
  permissionScope?: 'org' | 'legal_entity';
  target?: (input: I) => { type: string; id: string } | null;
  // Org-less commands (creating an org) start without an org. `bootstrap` calls a definer that creates the
  // org with the actor as a member, or returns the org an earlier request with the same idempotency key
  // created. executeOrgless() then enters that org as the actor, so membership is checked as on every other
  // command, and writes the handler's changes, the audit row and the idempotency key in one transaction.
  // `env` says how the runtime checks sessions, for definers that also read the upstream Auth records (invites).
  bootstrap?: (trx: Transaction<Database>, actor: UserActor, input: I, idempotencyKey: string | null, env: BootstrapEnv) => Promise<string>;
  // access 'proposal_revision' only, and required there: the proposal command whose pending proposals this reviser
  // revises. The runtime refuses the reviser for a proposal of any other command. One reviser per proposal command;
  // the edit finds it through reviserOf() on its context, so this is the only place the pairing is written.
  revises?: string;
  // The proposal editor (#161, #216): the one command that may run a reviser. The kernel's proposal edit command
  // declares it: it locks the pending proposal and writes the revision the reviser computes. The runtime checks this
  // declaration on the calling definition, never a command name, and registers at most one editor, run by users.
  proposalEditor?: true;
  // Agents that may run it (absent: none). A command that declares it declares its writes too (#1710), and a command
  // that declares writes of a `contact` or `payment` column never declares it (P04: an agent's change of a contact
  // point, payee or bank account is reviewed, so it asks for a proposal instead); register() refuses both.
  agent?: AgentAccess;
  // What it writes (plan §4.7 "Derived risk", #1697): one entry per table its statements write, directly, through a
  // definer it calls or a trigger they fire, with the columns they set (database defaults and the columns triggers
  // derive aside). The rows the runtime writes for it (ctx.emit, ctx.activity, ctx.audit, ctx.numbering, its audit row)
  // are not listed, and a nested command declares its own. Each entry carries the classes of its table from the
  // module's manifest (tableWrite() in @crove/kernel-contract builds it); register() refuses a column the classes do
  // not have, an unknown class, a table listed twice or an empty column list, and, on a runtime given the manifests
  // (RuntimeOptions.manifests), a table no manifest has or classes that are not its manifest's (#1710). An empty list
  // says the command writes no table (only the runtime's rows for it). An agent's proposal of the command is
  // flagged P04 when a declared column is `contact` or `payment` (read per table since #1785: a declared table that
  // holds such a column counts as written there, whichever columns the command names, and the execution check compares
  // tables, not columns), and also when the command declares no writes at all
  // (nothing says it writes none). A proposal command whose declared writes have no such column may run, as a nested
  // command at any depth, only commands that declare none either: the runtime refuses any other at execution, so a
  // nested write cannot escape P04. Events it emits are not writes: a command that handles them runs on its own, under
  // its own declaration, so such a proposal command emits, itself or through a nested command, only the events on
  // P04_CLEAN_EVENTS, whose handlers were reviewed to write no contact or payment column (#1710); no command declares
  // the outbox table (crove_kernel.outbox_event), events are the runtime's. Nor does such a proposal command, or a
  // command run under it, declare a job table (JOB_TABLES): a job it queued would run later under its own declaration
  // (#2107).
  writes?: readonly CommandWrite[];
  // access 'proposal' only, R1 or R2 only (ADR-0029 section 6): the role keys of positions whose agents may approve
  // a proposal of this command, within their max_risk and only when the proposal's outcome names none of P03 to
  // P07 and the agent is neither an author nor in its causal chain. Absent: humans only. R3 is always human. The
  // command declares its writes, none of them a `contact` or `payment` column (P04); the old noContactOrPayment form,
  // which said so without declaring them, is gone (#1710).
  agentApprovers?: AgentApprovers;
  // access 'proposal' only: the kind its proposals carry (the Inbox renders a proposal by its kind), within the
  // command's module. Absent: the command's name. A proposal an agent asks for always takes its kind from here,
  // never from what the agent's run prepared (#435).
  proposalKind?: string;
  handler: (ctx: CommandContext, input: I) => Promise<O>;
}

// Who may approve a proposal of a command besides humans (ADR-0029 section 6).
export interface AgentApprovers {
  roles: readonly string[];
}

// One table a command writes (CommandDef.writes): the shape of TableWrite in @crove/kernel-contract.
export interface CommandWrite {
  // `<schema>.<table>`.
  readonly table: string;
  // The class of every column of the table, from its module's manifest.
  readonly classes: Readonly<Record<string, string>>;
  // The columns the command sets.
  readonly columns: readonly string[];
}

// The data classes of the manifests (DATA_CLASSES in @crove/kernel-contract, which this package does not import;
// apps/kernel/test/invariant/command-writes.test.ts checks the two lists are the same).
export const WRITE_DATA_CLASSES = Object.freeze(['internal', 'pii', 'contact', 'payment', 'national_id', 'national_id_if_individual', 'sensitive'] as const);
// The classes whose write is policy P04 (plan §4.7: changing a payee, bank account or contact point).
const P04_DATA_CLASSES: readonly string[] = ['contact', 'payment'];

// The events a proposal command declared free of contact and payment writes may emit, itself or through a command it
// runs at any depth (P04, #1710). An event is not a write of the command that emits it: its handlers (a job, the outbox
// relay) run later under their own declarations, so nothing in the proposal's declaration says they write no contact or
// payment column. Deny by default: such a command emits none until an event is listed here, and an event is listed only
// with a review of every handler it reaches (the invariant suite pins this list, so a change to it is a protected-path
// change). Empty: no proposal command declares its writes yet. A frozen array, read into a set once, so nothing can add
// an event at run time. The list is not scoped to a command: an event listed is allowed for every such command.
export const P04_CLEAN_EVENTS: readonly string[] = Object.freeze([]);
const CLEAN_EVENTS: ReadonlySet<string> = new Set(P04_CLEAN_EVENTS);

// The pg-boss tables a row in which starts work later (a job, a dependency between jobs, a schedule, a subscription, a
// queue, a bulk request): a proposal command declared free of contact and payment writes, and the commands run under it,
// do not declare them, since the job they start runs under its own declaration and the proposal's says nothing of what
// it writes (#2107). The other crove_jobs tables start nothing: queue_stats and warning are statistics and a log, instance
// is the workers' heartbeat, and version holds the leases of the maintenance passes (no job content). The invariant suite
// pins the list against the manifest, so a table a pg-boss upgrade adds is classified before it is used. Which tables
// start nothing rests on reading the vendored pg-boss schema: re-check them on every `pnpm db:vendor:pgboss` bump, a new
// pg-boss version or a new schema version of it, before the list or the manifest is changed to match.
const JOB_TABLES: ReadonlySet<string> = new Set(['crove_jobs.job', 'crove_jobs.job_dependency', 'crove_jobs.schedule', 'crove_jobs.subscription', 'crove_jobs.queue', 'crove_jobs.bam']);
const jobTablesOf = (writes: readonly CommandWrite[] | undefined): string[] => (writes ?? []).filter((w) => JOB_TABLES.has(w.table)).map((w) => w.table);

// What a handler may learn about a registered command (ADR-0029 section 6): enough to judge a proposal of it.
export interface CommandInfo {
  name: string;
  risk: Risk;
  access: Access;
  agentApprovers: readonly string[];
  // The kind of its proposals: the declared proposalKind, or the command's name.
  proposalKind: string;
  // Whether an agent's proposal of it is flagged P04: it declares a write of a `contact` or `payment` column, or it
  // declares no writes, so nothing says it writes none.
  contactOrPayment: boolean;
}

export interface BootstrapEnv {
  // The session check's mode, or null when the runtime checks no sessions (tests and tools). 'db' means the
  // deployment reads Supabase Auth's own tables in the shared database.
  sessionMode: SessionStatusSource['mode'] | null;
}

export interface QueryDef<I = unknown, O = unknown> {
  name: string;
  input: z.ZodType<I>;
  access: readonly MemberRole[] | 'system';
  // Agents that may read it (absent: none).
  agent?: Pick<AgentAccess, 'roles'>;
  // A streamed read (the org export, #212): it runs only through Runtime.stream(), which hands the handler a sink for
  // its batches and opens one REPEATABLE READ, READ ONLY transaction, so every batch comes from the same snapshot.
  // Runtime.query() and ctx.query refuse it (STREAM_ONLY) after the usual context and access checks.
  stream?: true;
  // sink is set exactly when the query runs through Runtime.stream().
  handler: (ctx: QueryContext, input: I, sink?: QuerySink) => Promise<O>;
}

// Receives a streamed query's batches in order. The query waits for each call, so a slow consumer slows the read and
// nothing piles up in memory.
export type QuerySink = (batch: unknown) => Promise<void>;

// The answer of a lookup into another module (plan Decision 12, ADR-0031). A deployment may leave a module out
// (CROVE_MODULES), so a module that is not installed is an expected answer, not an error.
export type Lookup<O> = { status: 'ok'; value: O } | { status: 'not_installed'; module: string };

export interface QueryContext {
  trx: Transaction<Database>;
  orgId: string;
  actor: Actor;
  role: MemberRole | null;
  // Runs another registered query in the same transaction, with the same access check as Runtime.query(). A query
  // of a module the deployment ships but leaves out (RuntimeOptions.absentModules) answers not_installed; with that
  // list given, any other unknown query, a misspelled module included, is QUERY_NOT_FOUND (a caller bug). Query handlers must not write:
  // from a command they run in its writable transaction, not in Runtime.query()'s read-only one.
  query<O>(name: string, input: unknown): Promise<Lookup<O>>;
  // The registered reviser of a proposal command (the one command whose `revises` names it), or null when there is
  // none or more than one (Runtime.validate() refuses the latter at startup).
  reviserOf(command: string): string | null;
  // Set exactly when the actor is an agent.
  agent: AgentGrant | null;
  // Whether this runtime registered the module (CROVE_MODULES, ADR-0031), as Runtime.installed().
  installed(module: string): boolean;
  // A registered command's risk, access and agent approvers, or null when none is registered under that name.
  command(name: string): CommandInfo | null;
}

export interface CommandContext extends QueryContext {
  commandId: string;
  proposalId: string | null;
  now: Date;
  // The build this runtime runs (RuntimeOptions.build), for audit rows that record the code they ran under (plan §4.7:
  // an approval names the git SHA of its policy).
  build: string;
  emit(type: string, payload: Record<string, unknown>): Promise<string>;
  // A timeline row about a record. options.legalEntityId names the legal entity the row belongs to when its record
  // names none (a month's lock, a year archive, a mail; #1725): the row is then read only in contexts whose scope holds
  // that entity. The database refuses an entity outside the writer's scope (le_scope) or other than the entity of a
  // record whose type it maps (b_legal_entity, LEGAL_ENTITY_MISMATCH). Without it a mapped record type takes its
  // record's entity and any other row is org-level.
  activity(recordType: string, recordId: string, kind: string, summary: string, options?: { legalEntityId?: string }): Promise<void>;
  // Adds fields to this command's own audit row (for example the policy outcome of an approval).
  audit(detail: Record<string, unknown>): void;
  // Names the legal entity this command acts on, for a command whose permission gate admits entity holders
  // (permissionScope 'legal_entity', #1507). A user let in for some entities only is refused FORBIDDEN for any other; a
  // user let in by role or by an org-wide permission passes for any. Such a command run by an entity holder that names
  // no entity fails once its handler returns. A no-op for every other command.
  permissionEntity(legalEntityId: string): void;
  // Runs another registered command in the same transaction (audited on its own row).
  run<O>(name: string, input: unknown, options?: { proposalId?: string }): Promise<O>;
  // Runs another registered command as run() does, inside a savepoint, for a command that goes on when that one is
  // refused (issue #429: each item of kernel.proposal.approve_many). When the nested command is refused after its
  // input parsed (a DomainError with status 403, 404, 409 or 422 from the runtime's checks or from its handler, as a
  // refused top-level command is audited, and not one of NEVER_RECOVERED) and `recover` accepts the refusal, the
  // runtime rolls the nested command back to the savepoint and answers 'refused' with a frozen copy of the refusal.
  // Once this command's handler returns, the runtime writes that command's own denied/failed audit row in this
  // transaction: the row a refused top-level run of it would get, linked to this command (detail parentCommand and
  // parentCommandId, the command_id of this command's own audit row), and under the same bound
  // (RuntimeOptions.refusalAudit). The row commits with this command, and a command that fails writes none. Any other
  // error, or a refusal `recover` declines, propagates, so the whole command fails as with run(); on every path but
  // success the nested command is rolled back to the savepoint first, so a caller that catches the error and goes on
  // keeps none of its writes. This command's nested commands run one at a time: run and tryRun both throw while
  // another nested command (run or tryRun) of this command runs. A handler that settles while any nested command still
  // runs waits for it, and if it had returned, the command fails with nothing written; once the handler
  // has settled, tryRun, run, emit, activity and audit all throw. What this does not cover: emit, activity or a direct
  // write on ctx.trx made while a tryRun runs is undone if that tryRun rolls back.
  // The row is built from a snapshot the runtime takes when it catches the refusal, before `recover` sees it, and from
  // the nested input as parsed before the nested command ran: neither the caller (with the refusal copy or the
  // original error) nor the nested handler can change it afterwards. A command can make a command it runs refuse,
  // which is that command's own refusal, but it cannot write a refusal row for a command it did not run, nor an ok row.
  tryRun<O>(name: string, input: unknown, options: TryRunOptions): Promise<TryRunResult<O>>;
  // Gapless numbering (ADR-0021 section 2, #1401), on this command's transaction.
  numbering: Numbering;
}

// Thin wrappers over the numbering definers (migration 20261103030000): the database checks the context, the legal
// entity's scope and the actor, and refuses with SQL errors the command maps or lets toDomainError map.
export interface Numbering {
  // crove_kernel.allocate_number: the next number of the series of (legal entity, docType) and the period the
  // document date falls in, recorded as given to (targetType, targetId). The counter row stays locked until the command
  // commits (a rollback gives the number back), so call it as the last step before the document's insert. legalEntityId
  // null: the org's default entity. Refused: LEGAL_ENTITY_NOT_ALLOWED and NUMBER_SERIES_RESERVED (42501), a second
  // number for one target (23505).
  allocate(input: NumberAllocateInput): Promise<NumberAllocated>;
  // crove_kernel.void_number: declares an allocated number void (owners and admins; the R2 command kernel.number.void).
  // Refused: NUMBER_FORBIDDEN (42501), NUMBER_ALLOCATION_NOT_FOUND (23503), NUMBER_VOID_REASON (22023), already void
  // (23505).
  void(input: NumberVoidInput): Promise<{ voidId: string }>;
}

export interface NumberAllocateInput {
  legalEntityId: string | null;
  docType: string;
  // YYYY-MM-DD, in the legal entity's calendar.
  documentDate: string;
  targetType: string;
  targetId: string;
}

export interface NumberAllocated {
  periodKey: string;
  number: number;
  allocationId: string;
}

export interface NumberVoidInput {
  allocationId: string;
  reason: string;
}

export interface TryRunOptions {
  proposalId?: string;
  // Whether this refusal of the nested command lets the calling command go on. Called only for an audited refusal
  // that is not one of NEVER_RECOVERED, with a frozen copy of it.
  recover: (refusal: DomainError) => boolean;
}

export type TryRunResult<O> = { status: 'ok'; value: O } | { status: 'refused'; refusal: DomainError };

// Status of the session behind a user actor (ADR-0028), checked in the request transaction before the
// tenant context is entered (orgId: that org, where an owner may have revoked the session for this member), and
// before org-less work (orgId: null). Throws (or raises in SQL) 401, 403 or 503; never passes a session it cannot
// vouch for.
export interface SessionStatusSource {
  readonly mode: 'db' | 'jwt' | 'off';
  // true when the per-request check does not read Supabase Auth (jwt): every R3 command run by a user then needs
  // the actor's live check (UserActor.confirmLive), and fails closed without one.
  readonly liveCheckForR3: boolean;
  check(trx: Transaction<Database>, actor: UserActor & { sessionId: string }, orgId: string | null): Promise<void>;
}

// Bound on denied/failed audit rows (issue #162, plan §4.10), per window of windowSeconds. A refusal gets its audit row
// when it is the actor's first of its (command, code) in the window, or the actor has fewer than reserve refusals (a
// share the org bound never takes away), or the actor has fewer than perActor and either the org fewer than perOrg
// or the refusal is security relevant (SECURITY_REFUSAL_CODES, or any 404). Otherwise it is only counted in
// crove_kernel.refusal_tally.
export interface RefusalAuditLimits {
  perActor: number;
  perOrg: number;
  windowSeconds: number;
  // Default: DEFAULT_REFUSAL_AUDIT_LIMITS.reserve, or perActor when that is lower.
  reserve?: number;
}

export const DEFAULT_REFUSAL_AUDIT_LIMITS: Required<RefusalAuditLimits> = { perActor: 50, perOrg: 500, windowSeconds: 3600, reserve: 10 };
export const MAX_REFUSAL_AUDIT_LIMIT = 999_999;
export const MIN_REFUSAL_AUDIT_WINDOW_S = 60;
export const MAX_REFUSAL_AUDIT_WINDOW_S = 86_400;

// Refusals that point at a probe or a stolen session rather than a user's slip: they are audited up to the actor's
// own limit even when the org's budget is spent, so one member flooding the org cannot hide them. Every 404 after the
// org was entered counts as well (a record the actor named is not in the org, such as MEMBER_NOT_FOUND for a member
// of another org). Keep this list explicit; a code added here is audited more, never less.
export const SECURITY_REFUSAL_CODES: ReadonlySet<string> = new Set([
  'FORBIDDEN',
  'STEP_UP_REQUIRED',
  'MFA_REQUIRED',
  'NOT_A_MEMBER',
  'MEMBER_NOT_FOUND',
]);

// A refusal noted in security_event when it comes before membership is established: any 4xx the runtime or a
// definer answered for the caller. A 5xx is a fault of Crove's, never the caller's, and is only logged.
export function isPreMembershipRefusal(refusal: DomainError): boolean {
  return refusal.status >= 400 && refusal.status < 500;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSecurityRefusal(refusal: DomainError): boolean {
  return refusal.status === 404 || SECURITY_REFUSAL_CODES.has(refusal.code);
}

// Same ranges as crove_kernel.refusal_tally_note, which refuses anything else.
export function validateRefusalAuditLimits(limits: RefusalAuditLimits): Required<RefusalAuditLimits> {
  const check = (name: string, value: number, min: number, max: number) => {
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  };
  check('refusal audit perActor', limits.perActor, 1, MAX_REFUSAL_AUDIT_LIMIT);
  check('refusal audit perOrg', limits.perOrg, 1, MAX_REFUSAL_AUDIT_LIMIT);
  check('refusal audit windowSeconds', limits.windowSeconds, MIN_REFUSAL_AUDIT_WINDOW_S, MAX_REFUSAL_AUDIT_WINDOW_S);
  const reserve = limits.reserve ?? Math.min(DEFAULT_REFUSAL_AUDIT_LIMITS.reserve, limits.perActor);
  check('refusal audit reserve', reserve, 0, limits.perActor);
  return { perActor: limits.perActor, perOrg: limits.perOrg, windowSeconds: limits.windowSeconds, reserve };
}

export interface RuntimeOptions {
  // null: no session check (tests and tools). The server always passes one (apps/kernel main.ts).
  sessions?: SessionStatusSource | null;
  // R3 commands run by a user need aal2 and a second factor in the last 5 minutes (policy P11). Default required.
  stepUp?: 'required' | 'off';
  // Bound on refusal audit rows. Default DEFAULT_REFUSAL_AUDIT_LIMITS; 'unbounded' writes a row for every refusal.
  refusalAudit?: RefusalAuditLimits | 'unbounded';
  // Modules the deployment ships but leaves out (CROVE_MODULES, ADR-0031; createKernel always passes it). ctx.query
  // into one of them answers not_installed; a query of any other unregistered module is QUERY_NOT_FOUND, so a typo is
  // never mistaken for a module that is off. Unset (tests and tools that register only some modules): every module
  // without a registered command or query answers not_installed.
  absentModules?: readonly string[];
  // The build this runtime runs: the git SHA of the image (CROVE_BUILD). Default 'dev' (a local build, tests).
  build?: string;
  // How a command's input is hashed into audit_event.input_sha256 and idempotency_key.request_sha256 (#1732).
  // 'keyed': crove_kernel.command_input_hash, an HMAC-SHA256 under the deployment's hash key that no runtime role can
  // read, over the org of the sealed context, the actor key, the command and the canonical input ('k1:<hex>'): whoever
  // holds an exported or archived row cannot confirm a guessed input (a private note's title, ADR-0037). The default
  // (#1741), and what the server runs (apps/kernel createKernel). 'sha256': the plain SHA-256 of the canonical input,
  // as before #1732, only for tests: one that shows what the plain hash gives away, and those that seed a database
  // migrated to a version before crove_kernel.command_input_hash exists.
  inputHash?: InputHashMode;
  // The deployment's context token key (#1822, ADR-0028 section 9): base64 of 32 to 64 random bytes, the one the
  // migration runner installed in the database. Given, a user's context is entered with a token the runtime signs
  // with it (crove_kernel.enter_user_context), which raw SQL on the API's login cannot make. Unset:
  // CROVE_CONTEXT_TOKEN_KEY from the environment; null, or neither: today's crove_kernel.enter_context, until step 2
  // of #1822 requires the key.
  contextTokenKey?: string | null;
  // The tables of the module manifests (ModuleManifest['tables'] of each module, #1710). register() checks each
  // declared write (CommandDef.writes) against them: the table is a manifest's and the classes it carries are exactly
  // that manifest's, so P04 rests on the manifests rather than on classes a declaration builds by hand. Required
  // (#1772): a runtime built without them throws, whatever path built it. The server passes every enabled module's
  // (apps/kernel serverRuntime()); a runtime whose commands declare no writes may pass an empty list.
  manifests: readonly ManifestTables[];
}

// One module's tables as its manifest gives them: schema -> table -> column -> data class.
export type ManifestTables = Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, string>>>>>>;

export const INPUT_HASH_MODES = ['keyed', 'sha256'] as const;
export type InputHashMode = (typeof INPUT_HASH_MODES)[number];
// The prefix of a keyed input hash. A row without it was written with the plain SHA-256 (before #1732, or by a
// runtime in 'sha256' mode). The runtime no longer reads it (#1750); it stays exported as the marker readers of the
// audit export and tools tell the two schemes by.
export const KEYED_INPUT_HASH_PREFIX = 'k1:';

// Policy P11 (ADR-0028 section 5): a second factor used within the last 5 minutes.
export const STEP_UP_MAX_AGE_S = 300;
// Clock tolerance for an MFA timestamp from the future, as for token verification.
const CLOCK_TOLERANCE_S = 30;

export function hasFreshMfa(actor: UserActor, nowMs: number = Date.now()): boolean {
  if (actor.aal !== 'aal2' || typeof actor.mfaAt !== 'number' || !Number.isFinite(actor.mfaAt)) return false;
  const now = nowMs / 1000;
  return actor.mfaAt <= now + CLOCK_TOLERANCE_S && now - actor.mfaAt <= STEP_UP_MAX_AGE_S;
}

function sessionDetail(actor: UserActor): Record<string, unknown> {
  return { aal: actor.aal, sessionId: actor.sessionId ?? null, mfaAt: actor.mfaAt ?? null };
}

// Keys of a refusal audit row that only the runtime writes: the code, the policy rule, who refused with which
// session and, for a refusal caught by ctx.tryRun, the command that ran it. A command's own facts (DomainError audit)
// never set them, also when the error names no rule, the actor is a system actor, which has no session, or the
// refusal was not caught by ctx.tryRun.
const RESERVED_REFUSAL_KEYS = ['code', 'rule', 'aal', 'sessionId', 'mfaAt', 'component', 'agentRun', 'parentCommand', 'parentCommandId', 'workerInstance'] as const;

// The statuses a refused command is audited for once its org was entered (executeIn, ctx.tryRun).
const AUDITED_REFUSAL_STATUSES: ReadonlySet<number> = new Set([403, 404, 409, 422]);

// Refusals ctx.tryRun never lets a command go on after, whatever its `recover` answers: they are about the actor, the
// session, the run or the request, never about one item, so the whole command fails. Every code starting with AGENT_
// or SESSION_ is one too. Keep this list explicit; a code added here is recovered less, never more.
export const NEVER_RECOVERED: ReadonlySet<string> = new Set([
  'STEP_UP_REQUIRED',
  'MFA_REQUIRED',
  'NOT_A_MEMBER',
  'USER_DISABLED',
  'UNAUTHENTICATED',
  'AUTH_UNAVAILABLE',
  'REVOKED_ACCESS_TOKEN',
  'RETRY',
  'LEASE_LOST',
  'KILL_SWITCH_ON',
  'IDEMPOTENCY_MISMATCH',
  'CONTEXT_REENTRY',
  'BUDGET_EXHAUSTED',
  'ORG_CLOSED',
]);

export function isNeverRecovered(code: string): boolean {
  return NEVER_RECOVERED.has(code) || code.startsWith('AGENT_') || code.startsWith('SESSION_');
}

// Keys of an audit row only the runtime writes (a ctx.tryRun refusal's parent command, a proposal's link from a
// command run under it, #1706), so ctx.audit never sets them.
const RESERVED_OK_KEYS = ['parentCommand', 'parentCommandId', 'under_proposal', 'workerInstance'] as const;

// A JSON copy of an error's details or audit facts, frozen all the way down (what the audit row stores is JSON), or
// null when the value has no JSON form (a cycle, a BigInt).
function frozenJson(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined | null {
  if (value === undefined) return undefined;
  try {
    return deepFreeze(JSON.parse(JSON.stringify(value)) as Record<string, unknown>);
  } catch {
    return null;
  }
}

// The policy rule a refusal names, if any.
function ruleOf(error: DomainError): string | undefined {
  const rule = error.details?.rule;
  return typeof rule === 'string' ? rule : undefined;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

// The refusal ctx.tryRun hands to `recover` and to its caller: a frozen copy, so nothing they do reaches the original
// or the row.
// Details or facts without a JSON form are dropped; the rule is kept.
function frozenRefusal(error: DomainError): DomainError {
  const audit = frozenJson(error.audit);
  const copied = frozenJson(error.details);
  const rule = ruleOf(error);
  const details = copied === null ? (rule === undefined ? undefined : Object.freeze({ rule })) : copied;
  return Object.freeze(new DomainError(error.code, error.status, error.message, details, audit ? { audit } : {}));
}

// The detail of a caught refusal's row: refusalAuditDetail as JSON. When the command's facts have no JSON form, the
// row keeps what the runtime writes (code, rule, session) without them, so the refusal is still recorded.
function caughtRefusalDetail(error: DomainError, actor: Actor, ids: { command: string; nested: string; orgId: string; commandId: string }): Record<string, unknown> {
  const full = frozenJson(refusalAuditDetail(error, actor));
  if (full) return full;
  console.error(`[command ${ids.command}] TRY_RUN_REFUSAL_FACTS_DROPPED`, {
    orgId: ids.orgId,
    commandId: ids.commandId,
    nested: ids.nested,
    refusal: error.code,
    actorType: actor.type,
    actorId: actorId(actor),
  });
  const rule = ruleOf(error);
  const bare = new DomainError(error.code, error.status, error.message, rule === undefined ? undefined : { rule });
  return frozenJson(refusalAuditDetail(bare, actor)) ?? { code: error.code };
}

// The detail of a denied/failed audit row (plan §4.10): the command's facts about the refusal (for example the roles
// of a LAST_OWNER), then the code, the rule that refused when the error names one (for example P10 or P12) and,
// for a user, the session.
export function refusalAuditDetail(refusal: DomainError, actor: Actor): Record<string, unknown> {
  const detail: Record<string, unknown> = { ...refusal.audit };
  for (const key of RESERVED_REFUSAL_KEYS) delete detail[key];
  detail.code = refusal.code;
  if (typeof refusal.details?.rule === 'string') detail.rule = refusal.details.rule;
  if (actor.type === 'user') Object.assign(detail, sessionDetail(actor));
  if (actor.type === 'agent') detail.agentRun = actor.runId;
  return detail;
}

// The id an actor is recorded and logged under: the user, the agent, or the system component.
export function actorId(actor: Actor): string {
  if (actor.type === 'user') return actor.userId;
  if (actor.type === 'agent') return actor.agentId;
  return actor.component;
}

export function defineCommand<I, O>(def: CommandDef<I, O>): CommandDef<I, O> {
  return def;
}

export function defineQuery<I, O>(def: QueryDef<I, O>): QueryDef<I, O> {
  return def;
}

// What enter() established: the member role of a user, or the grant of an agent; neither for a system actor.
interface Entered {
  role: MemberRole | null;
  agent: AgentGrant | null;
}

// The detail an audit row of this actor carries when the command adds none: the system component, or the agent's
// run (the run ties the row to its wake-up and causal chain).
function actorDetail(actor: Actor): Record<string, unknown> {
  if (actor.type === 'system') return { component: actor.component };
  if (actor.type === 'agent') return { agentRun: actor.runId };
  return {};
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

// Idempotency keys are per user, per agent run (a key never replays another run's answer, such as an old fencing
// token) or per system component.
function actorKey(actor: Actor): string {
  return actor.type === 'agent' ? `agent:${actor.agentId}:${actor.runId}` : `${actor.type}:${actorId(actor)}`;
}

function parseInput<I>(schema: z.ZodType<I>, raw: unknown): I {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new DomainError('VALIDATION', 422, 'Dữ liệu không hợp lệ', { issues: result.error.issues.slice(0, 10) });
  }
  return result.data;
}

export interface ExecuteOptions {
  actor: Actor;
  orgId: string;
  idempotencyKey?: string;
}

export interface ExecuteOrglessOptions {
  actor: UserActor;
  idempotencyKey?: string;
}

// Logs a failure that maps to INTERNAL 500. A context error means a caller bug or an attack, never a user's mistake:
// CONTEXT_REENTRY is a second enter_context in one transaction (T10), CONTEXT_SEAL_INVALID a context or seal that
// does not verify (T11). Each gets its own alert line, `[alert] <code>`, naming the request with ids only, to alert
// on. The db layer's `[db] closing a pooled connection after <code>` is a separate line about the connection; it
// names no request.
function logInternal(where: string, error: unknown, ids: { orgId?: string | null; actor?: Actor } = {}): void {
  const code = contextTaint(error);
  if (!code) {
    console.error(`[${where}]`, error);
    return;
  }
  const actor = ids.actor;
  console.error(`[alert] ${code}`, {
    where,
    orgId: ids.orgId || null,
    actorType: actor?.type ?? null,
    actorId: actor ? actorId(actor) : null,
  });
}

// The module a command, query or event belongs to: the part of its name before the first dot.
function moduleOf(name: string): string {
  const dot = name.indexOf('.');
  return dot === -1 ? name : name.slice(0, dot);
}

// How long a streamed query's transaction may sit idle while its sink works on a batch.
export const STREAM_IDLE_MINUTES = 10;

// A streamed query answers only through Runtime.stream(), which gives it a sink and a single snapshot.
function refuseStreamed(def: QueryDef<unknown, unknown>): void {
  if (def.stream) throw new DomainError('STREAM_ONLY', 400, `Truy vấn ${def.name} chỉ đọc theo luồng`);
}

function isCellResolver(value: CellResolver | Db): value is CellResolver {
  const candidate = value as Partial<CellResolver>;
  return typeof candidate.resolveTenant === 'function' && typeof candidate.controlPlane === 'function';
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// A nested command of ctx.run or ctx.tryRun, resolved and with its input parsed.
interface NestedRun {
  def: CommandDef<unknown, unknown>;
  input: unknown;
  proposalId: string | null;
}

// Everything the audit row of a refusal ctx.tryRun caught is written from, taken when it was caught.
interface CaughtRefusal {
  command: string;
  code: string;
  security: boolean;
  outcome: 'denied' | 'failed';
  // The canonical input (stableStringify), which the row's input hash is computed from when it is written.
  input: string;
  target: { type: string; id: string } | null;
  proposalId: string | null;
  detail: Record<string, unknown>;
}

const WRITE_TABLE = /^crove_[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
// A column name as the manifests write them: never a pattern such as '*'.
const WRITE_COLUMN = /^[a-z_][a-z0-9_]*$/;

// The classes of every manifest table by `<schema>.<table>` (RuntimeOptions.manifests). A table in two manifests, a
// column name that is not one, or an unknown class is refused, so the runtime never starts on a manifest it misreads.
function manifestTableClasses(manifests: readonly ManifestTables[]): Map<string, Readonly<Record<string, string>>> {
  const out = new Map<string, Readonly<Record<string, string>>>();
  for (const tables of manifests) {
    for (const [schema, byTable] of Object.entries(tables)) {
      for (const [table, given] of Object.entries(byTable)) {
        const name = `${schema}.${table}`;
        if (!WRITE_TABLE.test(name)) throw new Error(`manifests: ${name} is not <schema>.<table> of a crove_* schema`);
        if (out.has(name)) throw new Error(`manifests: ${name} is in two manifests`);
        // A frozen copy of the own enumerable classes, read once: a later change of the manifest object, or a getter in
        // it, never reaches the check (#1710).
        const classes: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(Object.entries(given)));
        for (const [column, cls] of Object.entries(classes)) {
          if (!WRITE_COLUMN.test(column) || !(WRITE_DATA_CLASSES as readonly string[]).includes(cls)) {
            throw new Error(`manifests: ${name}.${column} has the unknown class ${String(cls)} or is not a column name`);
          }
        }
        out.set(name, classes);
      }
    }
  }
  return out;
}

// Whether two class maps name the same columns with the same classes.
function sameClasses(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((column) => Object.hasOwn(b, column) && b[column] === a[column]);
}

// Checks a command's declared writes (CommandDef.writes) against the classes they carry and against the manifests'
// (#1710, #1772), and answers the contact and payment columns among them
// (`<schema>.<table>.<column> (<class>)`), for P04.
function checkedWrites(command: string, writes: readonly CommandWrite[], manifests: ReadonlyMap<string, Readonly<Record<string, string>>>): string[] {
  const refuse = (why: string): never => {
    throw new Error(`command ${command}: declared writes ${why}`);
  };
  if (!Array.isArray(writes)) refuse('are a list of table writes');
  const tables = new Set<string>();
  const out: string[] = [];
  for (const w of writes) {
    if (typeof w !== 'object' || w === null || typeof w.table !== 'string' || !WRITE_TABLE.test(w.table)) {
      refuse(`name a table as <schema>.<table> of a crove_* schema (${String((w as Partial<CommandWrite> | null)?.table)})`);
    }
    if (tables.has(w.table)) refuse(`list ${w.table} twice`);
    // Events are the runtime's (ctx.emit): a command that declared the outbox could emit past the P04 gate on them.
    if (w.table === 'crove_kernel.outbox_event') refuse('name crove_kernel.outbox_event: events are the runtime\'s (ctx.emit), never a command\'s declared write');
    tables.add(w.table);
    if (typeof w.classes !== 'object' || w.classes === null || Array.isArray(w.classes)) refuse(`of ${w.table} carry no column classes`);
    // One copy of the own enumerable classes, read once: every check below and the P04 answer use it, so a getter or
    // a hidden key cannot answer one class to the checks and another to P04.
    const classes: Record<string, string> = Object.fromEntries(Object.entries(w.classes));
    if (Object.keys(classes).length === 0) refuse(`of ${w.table} carry no column classes`);
    for (const [column, cls] of Object.entries(classes)) {
      if (!WRITE_COLUMN.test(column)) refuse(`of ${w.table} carry classes for ${column}, which is not a column name`);
      if (!(WRITE_DATA_CLASSES as readonly string[]).includes(cls)) refuse(`of ${w.table} give column ${column} the unknown class ${String(cls)}`);
    }
    const known = manifests.get(w.table);
    if (!known) refuse(`name ${w.table}, a table no module manifest has`);
    if (!sameClasses(classes, known as Readonly<Record<string, string>>)) refuse(`of ${w.table} carry classes that are not its manifest's (build the write with tableWrite())`);
    if (!Array.isArray(w.columns) || w.columns.length === 0) refuse(`of ${w.table} name no column`);
    const seen = new Set<string>();
    for (const column of w.columns) {
      if (typeof column !== 'string' || !Object.hasOwn(classes, column)) refuse(`name ${w.table}.${String(column)}, a column its classes do not have`);
      if (seen.has(column)) refuse(`name ${w.table}.${column} twice`);
      seen.add(column);
      const cls = classes[column] as string;
      if (P04_DATA_CLASSES.includes(cls)) out.push(`${w.table}.${column} (${cls})`);
    }
    // The runtime checks what a command writes per table, not per column (#1710): a declared table that holds a
    // contact or payment column counts as written there too, whichever of its columns the command names.
    const unnamed = Object.entries(classes).filter(([column, cls]) => P04_DATA_CLASSES.includes(cls) && !seen.has(column));
    if (unnamed.length > 0 && !out.some((entry) => entry.startsWith(`${w.table}.`))) {
      out.push(`${w.table} (holds ${unnamed.map(([column, cls]) => `${column} (${cls})`).join(', ')}; writes are checked per table)`);
    }
  }
  return out;
}

// A copy of a plain object (its prototype Object.prototype or null) whose own properties are all enumerable and
// string-keyed, each read once. Anything else would be copied with parts missing (an inherited or hidden `risk` or
// `access`), so it is refused rather than dropped (#1766).
function plainCopy(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${what} is not an object`);
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new Error(`${what} is not a plain object`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || Object.getOwnPropertyDescriptor(value, key)?.enumerable !== true) {
      throw new Error(`${what} has a hidden or symbol property ${String(key)}`);
    }
  }
  // On a null prototype: a field the definition leaves out (agent) reads undefined, whatever is later set on
  // Object.prototype.
  return Object.assign(Object.create(null) as Record<string, unknown>, value);
}

const frozenList = (value: unknown): unknown => (Array.isArray(value) ? Object.freeze([...value]) : value);

// What register() keeps of an agent access or agent approvers declaration: a frozen copy, the roles list copied too.
function snapshotAgent(value: unknown, what: string): unknown {
  if (value === undefined) return undefined;
  const copy = plainCopy(value, what);
  if (Object.hasOwn(copy, 'roles')) copy.roles = frozenList(copy.roles);
  return Object.freeze(copy);
}

// A command definition as register() checks, keeps and runs it (#1766): a frozen copy, with the policy fields it
// holds (access, agent, agentApprovers, writes) copied and frozen as well; keys it did not have stay absent. The
// handler and the other functions are kept as they are.
function snapshotCommand(def: CommandDef<any, any>): CommandDef<unknown, unknown> {
  const label = `command ${String((def as { name?: unknown } | null)?.name)}`;
  const copy = plainCopy(def, `${label}: the definition`);
  if (Object.hasOwn(copy, 'access')) copy.access = frozenList(copy.access);
  if (Object.hasOwn(copy, 'agent')) copy.agent = snapshotAgent(copy.agent, `${label}: agent`);
  if (Object.hasOwn(copy, 'agentApprovers')) copy.agentApprovers = snapshotAgent(copy.agentApprovers, `${label}: agentApprovers`);
  if (Array.isArray(copy.writes)) {
    copy.writes = Object.freeze(
      copy.writes.map((w: unknown, i: number) => {
        // Not an object: checkedWrites() refuses it with its own message.
        if (typeof w !== 'object' || w === null) return w;
        const write = plainCopy(w, `${label}: declared write ${i}`);
        write.columns = frozenList(write.columns);
        if (typeof write.classes === 'object' && write.classes !== null && !Array.isArray(write.classes)) {
          write.classes = Object.freeze(plainCopy(write.classes, `${label}: the classes of declared write ${i}`));
        }
        return Object.freeze(write);
      }),
    );
  }
  return Object.freeze(copy) as unknown as CommandDef<unknown, unknown>;
}

// A query definition as register() keeps it: a frozen copy, its access and agent roles copied too.
function snapshotQuery(def: QueryDef<any, any>): QueryDef<unknown, unknown> {
  const label = `query ${String((def as { name?: unknown } | null)?.name)}`;
  const copy = plainCopy(def, `${label}: the definition`);
  if (Object.hasOwn(copy, 'access')) copy.access = frozenList(copy.access);
  if (Object.hasOwn(copy, 'agent')) copy.agent = snapshotAgent(copy.agent, `${label}: agent`);
  return Object.freeze(copy) as unknown as QueryDef<unknown, unknown>;
}

// The declared-writes check a command runs under (#1710): its own when it declares its writes, otherwise its caller's.
interface WriteScope {
  // Runs work whose writes are not the handler's (the runtime's rows, a nested command that declares its own writes)
  // and sets them aside.
  // rolledBackOnError: the work undoes its rows when it fails (a tryRun's savepoint).
  aside<T>(work: () => Promise<T>, rolledBackOnError?: boolean): Promise<T>;
  // Runs a tryRun of a nested command that declares no writes (#1797): what it wrote counts as the caller's when it
  // commits, and is set aside when its savepoint rolls it back (PostgreSQL keeps the counts of a rolled-back
  // savepoint). `work` gets the counter its handlers' statements add to, so a statement of anyone else meanwhile is
  // seen and the command cannot be checked.
  undoneIfRolledBack<T>(work: (counter: { n: number }) => Promise<T>, rolledBack: (value: T) => boolean): Promise<T>;
  // The statements the scope's handlers issued through their ctx.trx.
  readonly statements: { n: number };
}

// Counts the statements a handler issues through its ctx.trx (raw SQL and SELECTs too, since a function a SELECT
// calls may write): once when each is compiled to run, and again when its result comes back (also for a query the
// handler compiled itself). A statement after the handler returned is refused: the check has already read the counts.
function countWrites(counters: readonly { n: number }[], closed: () => boolean, command: string): KyselyPlugin {
  const count = () => {
    for (const counter of counters) counter.n += 1;
  };
  return Object.freeze({
    transformQuery: ({ node }) => {
      if (closed()) throw new Error(`command ${command}: a statement on ctx.trx after the handler returned (#1710)`);
      count();
      return node;
    },
    transformResult: async ({ result }) => {
      count();
      return result;
    },
  } satisfies KyselyPlugin);
}

// The statements of a SQL text as PostgreSQL's lexer splits them: each with its comments taken out and its literals
// kept, split at the semicolons outside a string ('...', E'...' with backslash escapes, U&'...'), a quoted identifier
// ("..."), a dollar-quoted body ($tag$...$tag$), a line comment (--) or a block comment (/* */, nested). An identifier
// goes on over non-ASCII characters and $, as in PostgreSQL. backslashes: read a backslash as an escape in every
// string, as PostgreSQL does with standard_conforming_strings off (a handler could turn it off for its transaction).
function sqlStatements(text: string, backslashes = false): string[] {
  const statements: string[] = [];
  let current = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    const next = text[i + 1];
    if (ch === '-' && next === '-') {
      // PostgreSQL ends a line comment at a carriage return as well as a newline.
      while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i += 1;
      current += ' ';
      continue;
    }
    if (ch === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < text.length && depth > 0) {
        if (text[i] === '/' && text[i + 1] === '*') {
          depth += 1;
          i += 2;
        } else if (text[i] === '*' && text[i + 1] === '/') {
          depth -= 1;
          i += 2;
        } else i += 1;
      }
      current += ' ';
      continue;
    }
    if (ch === "'" || ch === '"') {
      const escapes = ch === "'" && (backslashes || (/[eE]$/.test(current) && !/[\w$\u0080-￿]$/.test(current.slice(0, -1))));
      let j = i + 1;
      while (j < text.length) {
        if (escapes && text[j] === '\\') j += 2;
        else if (text[j] === ch && text[j + 1] === ch) j += 2;
        else if (text[j] === ch) break;
        else j += 1;
      }
      current += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === '$' && !/[\w$\u0080-￿]$/.test(current)) {
      const tag = /^\$([A-Za-z_\u0080-￿][\w\u0080-￿]*)?\$/.exec(text.slice(i));
      if (tag) {
        const close = text.indexOf(tag[0], i + tag[0].length);
        const stop = close === -1 ? text.length : close + tag[0].length;
        current += text.slice(i, stop);
        i = stop;
        continue;
      }
    }
    if (ch === ';') {
      statements.push(current);
      current = '';
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  statements.push(current);
  return statements;
}

// Why a statement would take control of the transaction from the runtime, or null. The runtime opens, commits and
// rolls back the transaction, and owns the savepoints named crove_* (a tryRun's). A handler may set, release and roll
// back to savepoints of its own (Social's digest does, around one mail), which cannot reach past the runtime's: a
// ROLLBACK TO a savepoint set before a tryRun's removes the runtime's savepoint too, and its own rollback then fails.
function transactionControl(statement: string): string | null {
  const text = statement.trim().replace(/^[(\s]+/, '').toUpperCase();
  if (/^(?:BEGIN|START|COMMIT|END|ABORT|PREPARE)\b/.test(text)) return text.split(/\s+/)[0] ?? text;
  const savepoint = /^(?:SAVEPOINT|RELEASE(?:\s+SAVEPOINT)?|ROLLBACK(?:\s+(?:WORK|TRANSACTION))?\s+TO(?:\s+SAVEPOINT)?)\s+(\S+)/.exec(text);
  if (savepoint) {
    const name = (savepoint[1] ?? '').replace(/^"|"$/g, '');
    // A name spelled with Unicode escapes (U&"...") is refused rather than decoded.
    return name.startsWith('CROVE_') || name.startsWith('U&') ? `a savepoint of the runtime (${name.toLowerCase()})` : null;
  }
  if (/^(?:SAVEPOINT|RELEASE|ROLLBACK)\b/.test(text)) return text.split(/\s+/)[0] ?? text;
  return null;
}

// Refuses a statement of a handler (or a query) that takes control of the transaction (#1831, transactionControl).
// It reads the query as it will run: compiled to SQL, values as placeholders, every statement of it as PostgreSQL's
// lexer splits them (the simple query protocol runs several), once with standard strings and once with backslash
// escapes in every string, so a statement either reading finds is refused. The handler adds no plugin after this one (the
// invariant suite's scan refuses withPlugin in server sources), so the node it checks is the node that runs.
// On top, fail closed: a query is one statement (no handler needs several in one), and no statement runs once the
// handler settled (closed), whether or not its writes are checked: a refused nested command's late statement would
// otherwise land after its savepoint rolled back.
function refuseTransactionControl(command: string, closed: () => boolean = () => false): KyselyPlugin {
  const compiler = new PostgresQueryCompiler();
  return Object.freeze({
    transformQuery: ({ node, queryId }) => {
      if (closed()) throw new Error(`command ${command}: a statement on ctx.trx after the handler returned (#1831)`);
      const text = compiler.compileQuery(node, queryId).sql;
      for (const statements of [sqlStatements(text), sqlStatements(text, true)]) {
        if (statements.slice(1).some((statement) => statement.trim() !== '')) {
          throw new Error(`command ${command}: one query holds several statements, which the runtime refuses (#1831)`);
        }
        for (const statement of statements) {
          const control = transactionControl(statement);
          if (control !== null) throw new Error(`command ${command}: ${control} controls the transaction, which is the runtime's (#1831)`);
        }
      }
      return node;
    },
    transformResult: async ({ result }) => result,
  } satisfies KyselyPlugin);
}

// The rows inserted, updated and deleted so far in this transaction, per crove_* table (#1710). A partition counts
// under the table at the root of its tree (pg-boss creates one per queue at runtime, and a manifest declares the
// partitioned table: crove_jobs.job, crove_jobs.queue_stats; #1797). The counts need
// track_counts, which is on by default; with it off they would read zero, so the runtime refuses to go on.
async function tableWriteCounts(trx: Transaction<Database>): Promise<Map<string, number>> {
  // The counters pg_stat_xact_user_tables reads, for the crove_* tables this transaction changed only.
  const { rows } = await sql<{ counting: boolean; counts: Record<string, string> | null }>`
    SELECT pg_catalog.current_setting('track_counts') = 'on' AS counting,
      (SELECT pg_catalog.json_object_agg(t.name, t.n::text)
         FROM (SELECT rn.nspname || '.' || r.relname AS name,
                      sum(pg_catalog.pg_stat_get_xact_tuples_inserted(c.oid) + pg_catalog.pg_stat_get_xact_tuples_updated(c.oid)
                        + pg_catalog.pg_stat_get_xact_tuples_deleted(c.oid)) AS n
                 FROM pg_catalog.pg_class c
                 JOIN pg_catalog.pg_class r ON r.oid = COALESCE(pg_catalog.pg_partition_root(c.oid), c.oid)
                 JOIN pg_catalog.pg_namespace rn ON rn.oid = r.relnamespace
                WHERE c.relkind = 'r' AND pg_catalog.starts_with(rn.nspname, 'crove_')
                GROUP BY 1) t
        WHERE t.n > 0) AS counts`.execute(trx);
  const row = rows[0];
  if (row?.counting !== true) throw new Error('the declared-writes check needs track_counts on (#1710)');
  return new Map(Object.entries(row.counts ?? {}).map(([table, n]) => [table, Number(n)]));
}

const ACCESS_KINDS: readonly string[] = ['system', 'proposal', 'proposal_revision'];
// A role list (strings), or one of the access kinds a definition may name instead.
const validAccess = (access: unknown, kinds: readonly string[]): boolean =>
  Array.isArray(access) ? access.every((role) => typeof role === 'string' && role.length > 0) : typeof access === 'string' && kinds.includes(access);

// How long a context token is good for, by the kernel's clock (#1822). The database allows 30 seconds of skew either way
// between its clock and the kernel's (crove_kernel.enter_user_context).
export const CONTEXT_TOKEN_TTL_S = 60;

// The wall clock as this module loaded it: a test that mocks Date (vi.useFakeTimers({ toFake: ['Date'] }), a spy on
// Date.now) to move business time still signs tokens against the real time the database checks them with.
const wallClock: () => number = Date.now;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Decodes a context token key (base64, 32 to 64 bytes). The error never shows the value.
export function contextTokenKeyBytes(value: string): Buffer {
  const trimmed = value.trim();
  const bytes = /^[A-Za-z0-9+/_-]+={0,2}$/.test(trimmed) ? Buffer.from(trimmed, 'base64') : Buffer.alloc(0);
  if (bytes.length < 32 || bytes.length > 64) throw new Error('CROVE_CONTEXT_TOKEN_KEY must be base64 of 32 to 64 random bytes');
  return bytes;
}

export interface ContextTokenClaims {
  userId: string;
  sessionId: string | null;
  orgId: string;
  aal: Aal;
  // Unix seconds of the newest second factor, or null.
  mfaAt: number | null;
}

// A context token (#1822, ADR-0028 section 9), signed with the deployment's key:
//   v1.<user>.<session|->.<org>.<aal1|aal2>.<mfa epoch|->.<exp epoch>.<hmac-sha256 hex of everything before it>
// crove_kernel.enter_user_context verifies it and enters that user's context in that org, nothing else.
export function mintContextToken(key: Uint8Array | string, claims: ContextTokenClaims, nowMs: number = wallClock()): string {
  const bytes = typeof key === 'string' ? contextTokenKeyBytes(key) : Buffer.from(key);
  const user = claims.userId.toLowerCase();
  const org = claims.orgId.toLowerCase();
  const session = claims.sessionId === null ? null : claims.sessionId.toLowerCase();
  if (!UUID.test(user) || !UUID.test(org) || (session !== null && !UUID.test(session))) throw new Error('context token: user, org and session are UUIDs');
  const aal = claims.aal === 'aal2' ? 'aal2' : 'aal1';
  // Epoch seconds, at most 12 digits as the database's pattern takes; anything else (milliseconds by mistake) is left out
  // rather than failing every request of the user.
  const mfa = typeof claims.mfaAt === 'number' && Number.isFinite(claims.mfaAt) && claims.mfaAt >= 0 && claims.mfaAt < 1e12 ? String(Math.floor(claims.mfaAt)) : '-';
  const exp = Math.floor(nowMs / 1000) + CONTEXT_TOKEN_TTL_S;
  const message = `v1.${user}.${session ?? '-'}.${org}.${aal}.${mfa}.${exp}`;
  return `${message}.${createHmac('sha256', bytes).update(message, 'utf8').digest('hex')}`;
}

export class Runtime {
  // The registry and the state that P04 and the agent checks read are JavaScript private fields (#), not TypeScript
  // `private`: no cast, Object.create(runtime) or assignment from outside reaches them, and the instance itself is
  // frozen once constructed, so no field or method of it can be replaced either (#1766).
  readonly #commands = new Map<string, CommandDef<unknown, unknown>>();
  readonly #queries = new Map<string, QueryDef<unknown, unknown>>();
  // Modules with at least one registered command or query: the part of a name before its first dot.
  readonly #installedModules = new Set<string>();
  // Proposal command -> the revisers registered for it, derived from `revises` (one source for the pairing).
  readonly #revisers = new Map<string, string[]>();
  // Command -> whether an agent's proposal of it is flagged P04 (CommandInfo.contactOrPayment), derived once at
  // registration from its declared writes.
  readonly #contactOrPayment = new Map<string, boolean>();
  // The classes of every manifest table (RuntimeOptions.manifests).
  readonly #manifestTables: ReadonlyMap<string, Readonly<Record<string, string>>>;
  // The context token key (RuntimeOptions.contextTokenKey), or null: never logged, never in an error.
  readonly #contextTokenKey: Buffer | null;
  // Where each transaction opens (Decision 14): tenant work on the org's cell, org-less work on the control plane.
  readonly #cells: CellResolver;
  readonly #sessions: SessionStatusSource | null;
  private readonly stepUp: 'required' | 'off';
  private readonly refusalAudit: Required<RefusalAuditLimits> | 'unbounded';
  // null: absentModules not given, so every unregistered module counts as absent.
  readonly #absentModules: ReadonlySet<string> | null;
  private readonly build: string;
  private readonly inputHash: InputHashMode;
  // Numbers the savepoints of ctx.tryRun, so each call has its own.
  #savepointSeq = 0;

  // A plain Db is one cell that also holds the control plane (singleCell).
  constructor(cells: CellResolver | Db, options: RuntimeOptions) {
    // Read once: the check and the copy below see the same list.
    const manifests: unknown = typeof options === 'object' && options !== null ? options.manifests : undefined;
    if (!Array.isArray(manifests)) throw new Error('RuntimeOptions.manifests: a runtime is built with the module manifests (#1772)');
    this.#cells = isCellResolver(cells) ? cells : singleCell(cells);
    // The runtime's own frozen copy of the session source, read once: changing the object passed in (its check
    // replaced by a no-op) does not turn off the ADR-0028 check here (#1766).
    const sessions = options.sessions ?? null;
    if (sessions !== null && (!['db', 'jwt', 'off'].includes(sessions.mode) || typeof sessions.check !== 'function')) {
      throw new Error('sessions: a session status source has a known mode and a check function');
    }
    this.#sessions =
      sessions === null ? null : Object.freeze({ mode: sessions.mode, liveCheckForR3: sessions.liveCheckForR3 === true, check: sessions.check.bind(sessions) });
    this.stepUp = options.stepUp ?? 'required';
    const refusalAudit = options.refusalAudit ?? DEFAULT_REFUSAL_AUDIT_LIMITS;
    this.refusalAudit = refusalAudit === 'unbounded' ? 'unbounded' : Object.freeze(validateRefusalAuditLimits(refusalAudit));
    this.#absentModules = options.absentModules ? new Set(options.absentModules) : null;
    this.build = options.build ?? 'dev';
    const inputHash = options.inputHash ?? 'keyed';
    if (!(INPUT_HASH_MODES as readonly string[]).includes(inputHash)) throw new Error(`unknown input hash mode ${String(inputHash)}`);
    this.inputHash = inputHash;
    this.#manifestTables = manifestTableClasses(manifests as readonly ManifestTables[]);
    const contextTokenKey = options.contextTokenKey === undefined ? process.env.CROVE_CONTEXT_TOKEN_KEY : options.contextTokenKey;
    this.#contextTokenKey = contextTokenKey?.trim() ? contextTokenKeyBytes(contextTokenKey) : null;
    Object.freeze(this);
  }

  // How sessions are checked (see BootstrapEnv), for org-less reads that apply the same upstream checks as a command.
  get sessionMode(): SessionStatusSource['mode'] | null {
    return this.#sessions?.mode ?? null;
  }

  // Checks each definition on its own; validate() checks how they fit together once every module is registered.
  register(defs: { commands?: CommandDef<any, any>[]; queries?: QueryDef<any, any>[] }): this {
    for (const given of defs.commands ?? []) {
      // The runtime checks, stores and later runs this frozen copy, never the caller's object, so a definition changed
      // after it registers (agent access set on a contact writer, a getter that answers differently later) changes
      // nothing: P04 and authorizeAgent read the same values (#1766).
      const c = snapshotCommand(given);
      if (typeof c.name !== 'string' || c.name.length === 0) throw new Error('a command is named');
      if (this.#commands.has(c.name)) throw new Error(`duplicate command ${c.name}`);
      // Every check below reads risk and access, and so do the agent and role checks when it runs.
      // A string: hasOwn alone would take an object whose toString() names a risk, which the agent checks compare
      // with === and would not see as R2 or R3.
      if (typeof c.risk !== 'string' || !Object.hasOwn(RISK_ORDER, c.risk)) throw new Error(`command ${c.name}: unknown risk ${String(c.risk)}`);
      if (!validAccess(c.access, ACCESS_KINDS)) throw new Error(`command ${c.name}: access is a role list or one of ${ACCESS_KINDS.join(', ')}`);
      if (c.agent !== undefined && (!validAccess(c.agent.roles, ['any']) || (c.agent.taint !== undefined && c.agent.taint !== 'propagate'))) {
        throw new Error(`command ${c.name}: agent access names a role list or 'any', and taint is 'propagate' or absent`);
      }
      // Every command says what it does beyond its transaction (#1637): the risk it derives is the floor of its own.
      if (typeof c.sideEffect !== 'string' || !(SIDE_EFFECTS as readonly string[]).includes(c.sideEffect)) {
        throw new Error(`command ${c.name}: declares no side effect or an unknown one (${String(c.sideEffect)}); one of ${SIDE_EFFECTS.join(', ')}`);
      }
      const derived = deriveRisk(c.sideEffect);
      if (RISK_ORDER[c.risk] < RISK_ORDER[derived]) {
        throw new Error(`command ${c.name}: declared risk ${c.risk} is below ${derived}, the risk its side effect '${c.sideEffect}' derives (plan §4.7)`);
      }
      if (c.permission !== undefined && (typeof c.access === 'string' || !/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(c.permission))) {
        throw new Error(`command ${c.name}: a permission is declared only beside a role list, as <module>.<name>`);
      }
      if (c.permissionScope !== undefined && (c.permission === undefined || (c.permissionScope !== 'org' && c.permissionScope !== 'legal_entity'))) {
        throw new Error(`command ${c.name}: a permission scope is 'org' or 'legal_entity', and only beside a permission`);
      }
      if ((c.access === 'proposal_revision') !== (typeof c.revises === 'string' && c.revises.length > 0)) {
        throw new Error(`command ${c.name}: a reviser (access 'proposal_revision') names the command it revises, and only a reviser does`);
      }
      // The contact and payment columns it declares it writes (P04), or null when it declares no writes.
      const contactOrPayment = c.writes === undefined ? null : checkedWrites(c.name, c.writes, this.#manifestTables);
      // An agent runs it without review, so what it writes is declared and checked against P04 (#1710).
      if (c.agent !== undefined && contactOrPayment === null) {
        throw new Error(`command ${c.name}: an agent may run it, so it declares its writes (P04)`);
      }
      if (contactOrPayment && contactOrPayment.length > 0 && c.agent !== undefined) {
        throw new Error(`command ${c.name}: writes ${contactOrPayment.join(', ')}, so no agent may run it (P04: an agent asks for a proposal instead)`);
      }
      // A proposal command declared free of contact and payment writes starts no job of its own: the job runs under its
      // own declaration, so nothing in the proposal's says what it writes (#2107).
      if (c.access === 'proposal' && contactOrPayment && contactOrPayment.length === 0) {
        const jobs = jobTablesOf(c.writes);
        if (jobs.length > 0) {
          throw new Error(`command ${c.name}: declares no contact or payment write (P04), so it may not declare ${jobs.join(', ')}: the job it starts runs later under its own declaration (#2107)`);
        }
      }
      if (c.agentApprovers !== undefined) {
        if (c.access !== 'proposal' || (c.risk !== 'R1' && c.risk !== 'R2')) {
          throw new Error(`command ${c.name}: agent approvers are declared only on an R1 or R2 proposal command (access 'proposal')`);
        }
        const { roles } = c.agentApprovers;
        if (!Array.isArray(roles) || roles.length === 0 || roles.some((r) => typeof r !== 'string' || r.length === 0) || contactOrPayment === null) {
          throw new Error(`command ${c.name}: agent approvers name at least one role key, and the command declares its writes (P04; the old noContactOrPayment form is gone)`);
        }
        if (contactOrPayment.length > 0) {
          throw new Error(`command ${c.name}: writes ${contactOrPayment.join(', ')}, so only humans approve its proposals (P04): it may not declare agent approvers`);
        }
        if (Object.hasOwn(c.agentApprovers, 'noContactOrPayment')) {
          throw new Error(`command ${c.name}: agent approvers no longer take noContactOrPayment (#1710): the declared writes say what the command writes`);
        }
      }
      if (c.proposalKind !== undefined) {
        const kind = c.proposalKind;
        if (c.access !== 'proposal' || typeof kind !== 'string' || kind.length > 100 || !/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(kind) || moduleOf(kind) !== moduleOf(c.name)) {
          throw new Error(`command ${c.name}: a proposal kind is declared only on a proposal command (access 'proposal'), as <module>.<name> in its own module`);
        }
      }
      if (c.proposalEditor !== undefined) {
        if (c.proposalEditor !== true || typeof c.access === 'string') {
          throw new Error(`command ${c.name}: the proposal editor declares proposalEditor: true and is run by users (access is a role list)`);
        }
        const editor = this.proposalEditor();
        if (editor) throw new Error(`command ${c.name}: ${editor.name} is already the proposal editor`);
      }
      this.#commands.set(c.name, c as CommandDef<unknown, unknown>);
      this.#contactOrPayment.set(c.name, contactOrPayment === null || contactOrPayment.length > 0);
      this.#installedModules.add(moduleOf(c.name));
      if (c.revises) this.#revisers.set(c.revises, [...(this.#revisers.get(c.revises) ?? []), c.name]);
    }
    for (const given of defs.queries ?? []) {
      const q = snapshotQuery(given);
      if (typeof q.name !== 'string' || q.name.length === 0) throw new Error('a query is named');
      if (this.#queries.has(q.name)) throw new Error(`duplicate query ${q.name}`);
      if (!validAccess(q.access, ['system'])) throw new Error(`query ${q.name}: access is a role list or 'system'`);
      if (q.agent !== undefined && !validAccess(q.agent.roles, ['any'])) throw new Error(`query ${q.name}: agent access names a role list or 'any'`);
      this.#queries.set(q.name, q as QueryDef<unknown, unknown>);
      this.#installedModules.add(moduleOf(q.name));
    }
    return this;
  }

  // A registered command's risk, access, agent approvers and proposal kind (CommandInfo), or null.
  commandInfo(name: string): CommandInfo | null {
    const def = this.#commands.get(name);
    if (!def) return null;
    return {
      name: def.name,
      risk: def.risk,
      access: def.access,
      agentApprovers: [...(def.agentApprovers?.roles ?? [])],
      proposalKind: def.proposalKind ?? def.name,
      contactOrPayment: this.#contactOrPayment.get(def.name) !== false,
    };
  }

  // Whether this runtime registered any command or query of the module (plan Decision 12). The server asks it
  // before registering a module's routes and jobs, so the registry is the one source of what is installed.
  installed(module: string): boolean {
    return this.#installedModules.has(module);
  }

  // The installed modules, sorted.
  modules(): string[] {
    return [...this.#installedModules].sort();
  }

  // A query context for a handler: the transaction, the entered org and role (or agent grant), ctx.query for lookups
  // and the reviser registry.
  private queryContext(trx: Transaction<Database>, orgId: string, actor: Actor, entered: Entered): QueryContext {
    return {
      trx,
      orgId,
      actor,
      role: entered.role,
      agent: entered.agent,
      query: (name, input) => this.lookup(trx, orgId, actor, entered, name, input),
      reviserOf: (command) => this.reviserOf(command),
      installed: (module) => this.installed(module),
      command: (name) => this.commandInfo(name),
    };
  }

  // ctx.query: another query in the caller's transaction and context, checked as Runtime.query() checks it.
  private async lookup<O>(
    trx: Transaction<Database>,
    orgId: string,
    actor: Actor,
    entered: Entered,
    name: string,
    rawInput: unknown,
  ): Promise<Lookup<O>> {
    const def = this.#queries.get(name);
    if (!def) {
      const module = moduleOf(name);
      const absent = this.#absentModules ? this.#absentModules.has(module) : true;
      if (absent && !this.#installedModules.has(module)) return { status: 'not_installed', module };
      throw new DomainError('QUERY_NOT_FOUND', 404, `Không có truy vấn ${name}`);
    }
    const input = parseInput(def.input, rawInput);
    this.authorizeQuery(def, actor, entered);
    refuseStreamed(def);
    const value = (await def.handler(this.queryContext(trx, orgId, actor, entered), input)) as O;
    return { status: 'ok', value };
  }

  private authorizeQuery(def: QueryDef<unknown, unknown>, actor: Actor, entered: Entered): void {
    const { role, agent } = entered;
    if (actor.type === 'agent') {
      // Agents read only what a query declares for their role key (ADR-0029); never a system query.
      const roles = def.agent?.roles;
      if (!agent || def.access === 'system' || !roles || (roles !== 'any' && !roles.includes(agent.roleKey))) {
        throw new DomainError('FORBIDDEN', 403, 'Tác tử AI không được xem nội dung này', { rule: 'agent_access' });
      }
      return;
    }
    if (def.access === 'system') {
      if (actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Không có quyền thực hiện');
    } else if (actor.type === 'user' && (!role || !def.access.includes(role))) {
      throw new DomainError('FORBIDDEN', 403, 'Không có quyền xem');
    }
  }

  // Startup check of the whole registry (createKernel calls it after registering every enabled module), so a mistake
  // fails the boot instead of leaving a reviser that can never run: each reviser revises a registered command that
  // runs through a proposal (access 'proposal'), no proposal command has two revisers, and revisers have an editor.
  // `absentModules` names the modules the deployment ships but leaves out (CROVE_MODULES, ADR-0031): a reviser of a
  // command in one of them never runs, as no proposal of that module is raised, so it is not a mistake. Any other
  // missing command is (a typo, also in the module part of the name). register() cannot check these, because a
  // module may register before the commands it refers to.
  validate(options: { absentModules?: readonly string[] } = {}): this {
    const absent = new Set(options.absentModules ?? []);
    const problems: string[] = [];
    for (const c of this.#commands.values()) {
      if (c.access !== 'proposal_revision') continue;
      const revises = c.revises ?? '';
      const revised = this.#commands.get(revises);
      if (!revised) {
        if (!absent.has(moduleOf(revises))) problems.push(`reviser ${c.name} revises ${revises}, which is not a registered command`);
      } else if (revised.access !== 'proposal') {
        problems.push(`reviser ${c.name} revises ${revises}, which does not run through a proposal (access 'proposal')`);
      }
    }
    for (const [command, names] of this.#revisers) {
      if (names.length > 1) problems.push(`proposal command ${command} has more than one reviser: ${names.join(', ')}`);
    }
    if (this.#revisers.size > 0 && !this.proposalEditor()) problems.push('revisers are registered but no proposal editor (proposalEditor: true) is');
    if (problems.length > 0) throw new Error(`invalid command registry:\n- ${problems.join('\n- ')}`);
    return this;
  }

  private proposalEditor(): CommandDef<unknown, unknown> | undefined {
    for (const c of this.#commands.values()) if (c.proposalEditor === true) return c;
    return undefined;
  }

  private reviserOf(command: string): string | null {
    const names = this.#revisers.get(command);
    return names?.length === 1 ? (names[0] ?? null) : null;
  }

  // The session status check, in the caller's transaction. Fails closed: a user actor without a session id is
  // refused whenever the runtime checks sessions.
  private async checkSession(trx: Transaction<Database>, actor: Actor, orgId: string | null): Promise<void> {
    if (actor.type !== 'user' || !this.#sessions) return;
    const sessionId = actor.sessionId;
    if (!sessionId) throw new DomainError('UNAUTHENTICATED', 401, 'Phiên đăng nhập không hợp lệ');
    await this.#sessions.check(trx, { ...actor, sessionId }, orgId);
  }

  private async enter(trx: Transaction<Database>, actor: Actor, orgId: string): Promise<Entered> {
    await this.checkSession(trx, actor, orgId);
    return this.enterContext(trx, actor, orgId);
  }

  // Works on a hot standby too: the re-entry guard's advisory lock and pg_locks read are allowed during recovery
  // (PostgreSQL 17, probed in #105). What a standby refuses is every write (25006, INTERNAL 500): commands, a session
  // check that records a first-seen session, refusal audits. Replica reads are not wired up (plan §3.3).
  private async enterContext(trx: Transaction<Database>, actor: Actor, orgId: string): Promise<Entered> {
    if (actor.type === 'system') {
      await sql`SELECT crove_kernel.enter_system_context(${orgId}::uuid)`.execute(trx);
      return { role: null, agent: null };
    }
    if (actor.type === 'agent') {
      // Worker only; the database checks the run is live and derives the rest (ADR-0029 section 2).
      const { rows } = await sql<{ entered: { role: string; position: string; module: string; maxRisk: string; tainted: boolean } }>`
        SELECT crove_kernel.enter_agent_context(${orgId}::uuid, ${actor.agentId}::uuid, ${actor.runId}::uuid) AS entered`.execute(trx);
      const entered = rows[0]?.entered;
      const maxRisk = entered?.maxRisk;
      if (!entered || (maxRisk !== 'R0' && maxRisk !== 'R1' && maxRisk !== 'R2')) throw new DomainError('INTERNAL', 500, 'Lỗi hệ thống');
      return {
        role: null,
        agent: {
          agentId: actor.agentId,
          runId: actor.runId,
          positionId: entered.position,
          roleKey: entered.role,
          module: entered.module,
          maxRisk,
          tainted: entered.tainted !== false,
        },
      };
    }
    if (this.#contextTokenKey !== null) {
      // Signed right before it is used, as a bind parameter (never in a statement's text).
      const token = mintContextToken(this.#contextTokenKey, { userId: actor.userId, sessionId: actor.sessionId ?? null, orgId, aal: actor.aal, mfaAt: actor.mfaAt ?? null });
      const { rows } = await sql<{ role: MemberRole }>`SELECT crove_kernel.enter_user_context(${orgId}::uuid, ${token}::text) AS role`.execute(trx);
      return { role: rows[0]?.role ?? null, agent: null };
    }
    const { rows } = await sql<{ role: MemberRole }>`SELECT crove_kernel.enter_context(${actor.userId}::uuid, ${orgId}::uuid) AS role`.execute(trx);
    return { role: rows[0]?.role ?? null, agent: null };
  }

  // An agent runs a command only when the command declares agent access for its position's role key, the command is
  // below R2 (R2 and R3 by an agent need review, P05 and P06; agent proposals do not exist yet, so they are refused),
  // the risk is within the agent's max_risk (P02), and, for a tainted run at R1 or above, the command only propagates
  // the taint (P03). Never a system or proposal-only command.
  private authorizeAgent(def: { access: Access; risk: Risk; agent?: AgentAccess | undefined }, agent: AgentGrant | null): void {
    const refuse = (rule: string, message = 'Tác tử AI không được thực hiện việc này') => {
      throw new DomainError('FORBIDDEN', 403, message, { rule });
    };
    if (!agent) refuse('agent_context');
    const grant = agent as AgentGrant;
    if (typeof def.access === 'string' || !def.agent) refuse('agent_access');
    const access = def.agent as AgentAccess;
    if (access.roles !== 'any' && !access.roles.includes(grant.roleKey)) refuse('agent_access');
    // R2 and R3 by an agent need review (P05, P06): the agent asks for a proposal instead (kernel.task.propose).
    if (def.risk === 'R3') refuse('P05');
    if (def.risk === 'R2') refuse('P06');
    if (RISK_RANK[def.risk] > RISK_RANK[grant.maxRisk]) refuse('P02');
    if (grant.tainted && RISK_RANK[def.risk] >= 1 && access.taint !== 'propagate') refuse('P03');
  }

  // Answers the legal entities the user was let in for when only an entity-scoped permission admitted them (#1507),
  // else null (their role, or the permission org-wide).
  private async authorize(trx: Transaction<Database>, def: CommandDef<unknown, unknown>, actor: Actor, entered: Entered, viaProposal: boolean): Promise<readonly string[] | null> {
    try {
      this.authorizeRole(def, actor, entered, viaProposal);
      return null;
    } catch (error) {
      // A member whose role is not in access may still hold the command's permission through an org-wide role
      // assignment (issue #1279). Read only after the role check failed, in this transaction, never cached.
      const held = await this.holdsPermission(trx, def, actor, entered);
      if (held === false) throw error;
      return held;
    }
  }

  // false, or where the permission is held: null for the whole org, else the entity ids (#1507, permissionScope
  // 'legal_entity' only; any other command reads ctx_has_permission, the org-wide answer, as before).
  private async holdsPermission(trx: Transaction<Database>, def: CommandDef<unknown, unknown>, actor: Actor, entered: Entered): Promise<false | readonly string[] | null> {
    if (def.permission === undefined || actor.type !== 'user' || entered.role === null || typeof def.access === 'string') return false;
    if (def.permissionScope === 'legal_entity') {
      const { rows } = await sql<{ entities: string[] }>`SELECT crove_kernel.ctx_permission_entities(${def.permission}::text) AS entities`.execute(trx);
      const entities = rows[0]?.entities ?? [];
      if (entities.length === 0) return false;
      return entities.includes('*') ? null : Object.freeze([...entities]);
    }
    const { rows } = await sql<{ held: boolean }>`SELECT crove_kernel.ctx_has_permission(${def.permission}::text) AS held`.execute(trx);
    return rows[0]?.held === true ? null : false;
  }

  private authorizeRole(def: CommandDef<unknown, unknown>, actor: Actor, entered: Entered, viaProposal: boolean): void {
    if (actor.type === 'agent') {
      this.authorizeAgent(def, entered.agent);
      return;
    }
    const { access } = def;
    const role = entered.role;
    // access [] grants no member role; a system actor does not pass it either (agent-only commands).
    if (actor.type === 'system' && Array.isArray(access) && access.length === 0) {
      throw new DomainError('FORBIDDEN', 403, 'Không có quyền thực hiện');
    }
    if (access === 'proposal' || access === 'proposal_revision') {
      if (!viaProposal) throw new DomainError('FORBIDDEN', 403, 'Lệnh này chỉ chạy qua đề xuất đã duyệt');
      return;
    }
    if (access === 'system') {
      if (actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Không có quyền thực hiện');
      return;
    }
    if (actor.type === 'system') return;
    if (!role || !access.includes(role)) throw new DomainError('FORBIDDEN', 403, 'Vai trò của bạn không được thực hiện việc này');
  }

  // Policy P11: R3 run by a user needs aal2 with a second factor in the last 5 minutes. Checked after the role,
  // so a user who may not run the command at all is told so instead of being sent to an MFA challenge.
  private requireStepUp(def: CommandDef<unknown, unknown>, actor: Actor): void {
    if (def.risk !== 'R3' || actor.type !== 'user' || this.stepUp === 'off') return;
    if (!hasFreshMfa(actor)) {
      throw new DomainError('STEP_UP_REQUIRED', 403, 'Cần xác thực hai lớp (MFA) trong 5 phút gần nhất để thực hiện việc này');
    }
  }

  // ADR-0028 section 5: R3 run by a user is confirmed with Supabase Auth at execution time when the per-request
  // check does not read Auth itself (jwt). After the role and step-up checks, so a user who may not run the command
  // or lacks fresh MFA is told so without a call to Auth. No cache. Fails closed: an actor without a bound live
  // check gets 503. It runs inside the request transaction, so an R3 holds one pooled connection for at most the
  // live check's timeout (5 s); R3 is rare and human-initiated.
  private async requireLiveSession(def: CommandDef<unknown, unknown>, actor: Actor): Promise<void> {
    if (def.risk !== 'R3' || actor.type !== 'user' || !this.#sessions?.liveCheckForR3) return;
    if (!actor.confirmLive) {
      throw new DomainError('AUTH_UNAVAILABLE', 503, 'Chưa kiểm tra được phiên đăng nhập với máy chủ xác thực, hãy thử lại sau');
    }
    await actor.confirmLive();
  }

  // The proposal state gate (#88). A command that only runs through a proposal is checked against the proposal row
  // in the database, not against the caller's say-so: 'proposal' needs the proposal in state 'approved' for exactly
  // this command, approved by the calling command (executed_command_id), so no other path (an edit, a bug, a replay)
  // can reach a posting command; 'proposal_revision' needs a pending proposal of the command the reviser revises,
  // and the calling definition must be the proposal editor (#161, #216: its declared proposalEditor, not its name),
  // so no other command, nor a reviser nested in a reviser, runs one. The caller holds the row lock. The row is read
  // in the org in context only: another org's proposal id is refused exactly like an id that does not exist.
  private async requireProposalState(
    trx: Transaction<Database>,
    orgId: string,
    def: CommandDef<unknown, unknown>,
    proposalId: string,
    caller: { def: CommandDef<unknown, unknown>; commandId: string },
  ): Promise<void> {
    const proposal = await trx
      .selectFrom('crove_kernel.proposal')
      .select(['status', 'command', 'executed_command_id'])
      .where('org_id', '=', orgId)
      .where('id', '=', proposalId)
      .executeTakeFirst();
    const allowed =
      def.access === 'proposal'
        ? proposal?.status === 'approved' && proposal.command === def.name && proposal.executed_command_id === caller.commandId
        : caller.def.proposalEditor === true && proposal?.status === 'pending' && proposal.command === def.revises;
    if (!allowed) throw new DomainError('FORBIDDEN', 403, 'Lệnh này chỉ chạy qua đề xuất đã duyệt', { rule: 'proposal_state' });
  }

  private sessionDetail(actor: UserActor): Record<string, unknown> {
    return sessionDetail(actor);
  }

  private async writeAudit(
    trx: Transaction<Database>,
    row: {
      orgId: string;
      actor: Actor;
      command: string;
      commandId: string;
      outcome: 'ok' | 'denied' | 'failed';
      // The canonical input (stableStringify); the row stores its input hash.
      input: string;
      target: { type: string; id: string } | null;
      proposalId: string | null;
      detail?: Record<string, unknown>;
    },
  ): Promise<void> {
    // Only the ok row of the proposal's own command (access 'proposal', which requireProposalState admitted for this
    // proposal) names the proposal in audit_event.proposal_id, which the database checks against that command and an
    // approved state. Every other row written under a proposal (the edit's reviser, a command the execution runs, a
    // refusal) names it in detail.under_proposal, which the runtime alone writes (#1706, option B). The id is the
    // database's own text form, lower case, as the database compares it.
    const proposalId = row.proposalId?.toLowerCase() ?? null;
    const ownsProposal = proposalId !== null && row.outcome === 'ok' && this.#commands.get(row.command)?.access === 'proposal';
    const detail: Record<string, unknown> = { ...(row.detail ?? actorDetail(row.actor)) };
    delete detail.under_proposal;
    if (proposalId !== null && !ownsProposal) detail.under_proposal = proposalId;
    await trx
      .insertInto('crove_kernel.audit_event')
      .values({
        org_id: row.orgId,
        actor_type: row.actor.type,
        actor_id: row.actor.type === 'user' ? row.actor.userId : row.actor.type === 'agent' ? row.actor.agentId : null,
        command: row.command,
        command_id: row.commandId,
        outcome: row.outcome,
        target_type: row.target?.type ?? null,
        target_id: row.target?.id ?? null,
        input_sha256: this.inputHashOf(row.actor, row.command, row.input),
        proposal_id: ownsProposal ? proposalId : null,
        detail: JSON.stringify(detail),
      })
      .execute();
  }

  // The input hash of a command's audit or idempotency row (RuntimeOptions.inputHash): in 'keyed' mode an expression
  // the row's own statement computes in the database, in the caller's sealed context (so it costs no round trip of
  // its own), else the plain SHA-256.
  private inputHashOf(actor: Actor, command: string, canonical: string): RawBuilder<string> | string {
    if (this.inputHash === 'sha256') return sha256Hex(canonical);
    return sql<string>`crove_kernel.command_input_hash(${actorKey(actor)}, ${command}, ${canonical})`;
  }

  private async runInTx<O>(
    trx: Transaction<Database>,
    def: CommandDef<unknown, unknown>,
    input: unknown,
    // cleanRoot: the proposal command, declared free of contact and payment writes, this command runs under (as
    // itself or nested at any depth below it), if any (P04, #1697).
    // writeScope: the declared-writes check of the nearest caller that declares its writes (#1710), if any.
    // writeCounters: in a caller's scope, the counters this command's handler statements add to.
    base: {
      orgId: string;
      actor: Actor;
      entered: Entered;
      proposalId: string | null;
      cleanRoot?: string;
      writeScope?: WriteScope;
      writeCounters?: readonly { n: number }[];
      // The entities an entity-scoped permission let the user in for (#1507); null: no such limit. Required, so every
      // path that runs a command passes what its gate answered.
      permissionEntities: readonly string[] | null;
    },
  ): Promise<O> {
    const commandId = uuidv7();
    const { permissionEntities } = base;
    // Whether the handler named the entity it acts on (ctx.permissionEntity) when an entity holder ran it.
    let entityNamed = false;
    const cleanRoot = base.cleanRoot ?? (def.access === 'proposal' && this.#contactOrPayment.get(def.name) === false ? def.name : undefined);
    let auditDetail: Record<string, unknown> | undefined;
    // Refusals ctx.tryRun caught and rolled back, written after the handler returns.
    const caught: CaughtRefusal[] = [];
    // The nested commands (ctx.run and ctx.tryRun) running now: each one's gate settles before its answer reaches the
    // caller. They run one at a time (a tryRun's savepoint is this transaction's), and the handler may not return
    // while any runs.
    const running = new Set<Promise<void>>();
    const tracked = <T>(start: () => Promise<T>): Promise<T> => {
      let settle = () => {};
      const gate = new Promise<void>((resolve) => {
        settle = resolve;
      });
      running.add(gate);
      return (async () => {
        try {
          return await start();
        } finally {
          running.delete(gate);
          settle();
        }
      })();
    };
    // Waits for every nested command still running; answers whether any was.
    const settleRunning = async (): Promise<boolean> => {
      const any = running.size > 0;
      while (running.size > 0) await Promise.all(running);
      return any;
    };
    // What the handler writes, table by table, against what the command declares (#1710): a command that declares its
    // writes fails when its transaction's row counts (pg_stat_xact_user_tables) show a change in a crove_* table it
    // does not declare, the rows the runtime writes for it (ctx.emit, ctx.activity, ctx.numbering) and those of nested
    // commands that declare their own writes aside. A nested command that declares none counts as this command's. The
    // check is per table: a column left out of a declared table is not seen.
    // A nested command that declares none runs in its caller's scope: its handler's writes count as the caller's, its
    // runtime rows (audit row, events) are set aside there. A write through a definer the handler calls, or by a
    // trigger its statements fire, is counted like the statement itself: the command declares that table too.
    const windows = { open: 0 };
    const writeCheck =
      def.writes === undefined
        ? null
        : { declared: new Set(def.writes.map((w) => w.table)), start: await tableWriteCounts(trx), aside: new Map<string, number>(), unmeasured: false };
    const scope: WriteScope | null =
      writeCheck === null
        ? (base.writeScope ?? null)
        : {
            statements: { n: 0 },
            // Runs work whose writes are not this handler's, and sets them aside. The counts are the whole
            // transaction's, so a statement the handler issues meanwhile (beside a ctx.emit in Promise.all) would be set
            // aside with them: the command then cannot be checked, and fails.
            aside: async <T>(work: () => Promise<T>, rolledBackOnError = false): Promise<T> => {
              const statements = (scope as WriteScope).statements;
              // One window at a time: two open at once would each set aside the other's rows as well.
              if (windows.open > 0) writeCheck.unmeasured = true;
              windows.open += 1;
              // Read before the first await: a statement the handler starts beside this one is counted from here on.
              const issued = statements.n;
              try {
                const before = await tableWriteCounts(trx);
                const setAside = async () => {
                  const after = await tableWriteCounts(trx);
                  if (statements.n !== issued) writeCheck.unmeasured = true;
                  for (const [table, n] of after) writeCheck.aside.set(table, (writeCheck.aside.get(table) ?? 0) + n - (before.get(table) ?? 0));
                };
                let value: T;
                try {
                  value = await work();
                } catch (error) {
                  // A failed tryRun rolled back to its savepoint, so its rows are gone and the counts can still be read.
                  // Any other failure may leave rows that a caller catching the error would keep (a nested command
                  // refused by its own write check after it wrote), so the command can no longer be checked.
                  if (rolledBackOnError) {
                    await setAside().catch(() => {
                      writeCheck.unmeasured = true;
                    });
                  } else {
                    writeCheck.unmeasured = true;
                  }
                  throw error;
                }
                await setAside();
                return value;
              } finally {
                windows.open -= 1;
              }
            },
            undoneIfRolledBack: async <T>(work: (counter: { n: number }) => Promise<T>, rolledBack: (value: T) => boolean): Promise<T> => {
              const statements = (scope as WriteScope).statements;
              // Not a window of its own (the nested command's emits and declared nested commands open theirs inside),
              // but it may not start inside one.
              if (windows.open > 0) writeCheck.unmeasured = true;
              const counter = { n: 0 };
              const issued = statements.n;
              const before = await tableWriteCounts(trx);
              const asideBefore = new Map(writeCheck.aside);
              const setAsideIfUndone = async () => {
                // A window the nested command left open (an emit it did not await) may still write, after the rollback.
                if (windows.open > 0) writeCheck.unmeasured = true;
                const after = await tableWriteCounts(trx);
                // Every statement since the start is the nested command's (its handlers add to both counters).
                if (statements.n - issued !== counter.n) writeCheck.unmeasured = true;
                for (const [table, n] of after) {
                  const setAsideInside = (writeCheck.aside.get(table) ?? 0) - (asideBefore.get(table) ?? 0);
                  writeCheck.aside.set(table, (writeCheck.aside.get(table) ?? 0) + n - (before.get(table) ?? 0) - setAsideInside);
                }
              };
              let value: T;
              try {
                value = await work(counter);
              } catch (error) {
                // tryNested rolled the savepoint back before the error reached here.
                await setAsideIfUndone().catch(() => {
                  writeCheck.unmeasured = true;
                });
                throw error;
              }
              // Committed: its writes stay counted as the caller's, whoever issued them.
              if (rolledBack(value)) await setAsideIfUndone();
              return value;
            },
          };
    const aside = <T>(work: () => Promise<T>, rolledBackOnError = false): Promise<T> => (scope === null ? work() : scope.aside(work, rolledBackOnError));
    // The handler's own statements, counted for the scope through its ctx.trx: on the scope's counter, and in a caller's
    // scope also on the counters of the nested runs this one is part of (base.writeCounters).
    const counters: readonly { n: number }[] = scope === null ? [] : writeCheck !== null ? [scope.statements] : (base.writeCounters ?? [scope.statements]);
    // Transaction control is the runtime's: a handler's raw COMMIT or ROLLBACK, or a savepoint of the runtime's, could
    // end the command's atomicity or keep a refused nested command's writes past its rollback (#1831), whether or not
    // its writes are checked.
    const guardedTrx = trx.withPlugin(refuseTransactionControl(def.name, () => closed));
    const handlerTrx = scope === null ? guardedTrx : guardedTrx.withPlugin(countWrites(counters, () => closed, def.name));
    // Whether the writes of a nested command are its own to declare (it declares writes) or this command's.
    const ownsWrites = (name: string): boolean => this.#commands.get(name)?.writes !== undefined;
    // Set once the handler settled: from then on the runtime writes this command's rows, and nothing the handler
    // left running may write, run a command or roll back to a savepoint in this transaction.
    let closed = false;
    // The rows the runtime is writing for the handler (ctx.emit, ctx.activity, ctx.numbering) right now. The handler may
    // not await them; they still finish before the command does, and before a refused command's savepoint rolls back,
    // so no row of it lands after its rollback (#1831).
    const writing = new Set<Promise<unknown>>();
    const pending = <T>(work: () => Promise<T>): Promise<T> => {
      const promise = work();
      writing.add(promise);
      void promise.then(
        () => writing.delete(promise),
        () => writing.delete(promise),
      );
      // The handler gets a promise of its own, so a failure it neither awaits nor catches is still an unhandled
      // rejection, as before the tracking above handled the original.
      return promise.then((value) => value);
    };
    const settleWriting = async () => {
      while (writing.size > 0) await Promise.allSettled(writing);
    };
    const refuseClosed = (what: string) => {
      if (closed) throw new Error(`command ${def.name}: ${what} after the handler returned`);
    };
    const ctx: CommandContext = {
      // The handler's statements, and those of the queries it runs (ctx.query), go through handlerTrx, so the write
      // check can tell them from the runtime's (#1710).
      ...this.queryContext(handlerTrx, base.orgId, base.actor, base.entered),
      commandId,
      proposalId: base.proposalId,
      now: new Date(),
      build: this.build,
      emit: (type, payload) =>
        pending(async () => {
          refuseClosed('ctx.emit');
          if (!type.startsWith(`${def.name.split('.')[0]}.`)) throw new Error(`command ${def.name} cannot emit ${type}`);
          // A proposal command declared free of contact and payment writes, or a command it runs, emits only the events
          // whose handlers were reviewed to write none (P04_CLEAN_EVENTS).
          if (cleanRoot !== undefined && !CLEAN_EVENTS.has(type)) {
            throw new Error(`command ${cleanRoot}: declares no contact or payment write (P04), so it cannot emit ${type}, whose handlers are not reviewed to write none (P04_CLEAN_EVENTS)`);
          }
          // Ids and codes only (#1949): an event outlives every erasure, in the outbox and its archive.
          // Checked as it will be stored: as its JSON (a value's toJSON decides what the database sees).
          const checked = normalizeEventPayload(JSON.parse(JSON.stringify(payload)));
          const problem = eventPayloadProblem(checked, type);
          if (problem) throw new Error(`command ${def.name} cannot emit ${type} with ${problem}`);
          const { rows } = await aside(() => sql<{ id: string }>`SELECT crove_kernel.emit(${type}, ${JSON.stringify(checked)}::jsonb, ${commandId}::uuid) AS id`.execute(trx));
          return rows[0]?.id ?? '';
        }),
      activity: (recordType, recordId, kind, summary, options) =>
        pending(async () => {
          refuseClosed('ctx.activity');
          await aside(() =>
            trx
              .insertInto('crove_kernel.activity')
              .values({
                org_id: base.orgId,
                record_type: recordType,
                record_id: recordId,
                kind,
                summary,
                actor_id: base.actor.type === 'user' ? base.actor.userId : null,
                // The database stamps it from the sealed context too (activity_stamp_agent).
                agent_id: base.actor.type === 'agent' ? base.actor.agentId : null,
                ...(options?.legalEntityId === undefined ? {} : { legal_entity_id: options.legalEntityId }),
              })
              .execute(),
          );
        }),
      permissionEntity: (legalEntityId) => {
        refuseClosed('ctx.permissionEntity');
        if (permissionEntities === null) return;
        if (!permissionEntities.includes(legalEntityId)) {
          throw new DomainError('FORBIDDEN', 403, 'Bạn không có quyền này với pháp nhân đó', { rule: 'permission_entity' });
        }
        entityNamed = true;
      },
      audit: (detail) => {
        refuseClosed('ctx.audit');
        const own = { ...detail };
        for (const key of RESERVED_OK_KEYS) delete own[key];
        auditDetail = { ...auditDetail, ...own };
      },
      run: async <R>(name: string, nestedInput: unknown, options?: { proposalId?: string }): Promise<R> => {
        refuseClosed('ctx.run');
        // One nested command at a time: a sibling running beside a tryRun, also one nested inside this run, could have
        // its writes and ok row undone by that tryRun's rollback while it answers success.
        if (running.size > 0) throw new Error(`command ${def.name}: ctx.run runs only while no other nested command runs`);
        const nested = resolveNested(name, nestedInput, options?.proposalId);
        return tracked(() => (ownsWrites(name) ? aside(() => runNested<R>(nested)) : runNested<R>(nested)));
      },
      tryRun: <R>(name: string, nestedInput: unknown, options: TryRunOptions): Promise<TryRunResult<R>> => {
        if (closed) return Promise.reject(new Error(`command ${def.name}: ctx.tryRun after the handler returned`));
        if (running.size > 0) return Promise.reject(new Error(`command ${def.name}: ctx.tryRun runs only while no other nested command runs`));
        if (ownsWrites(name)) return tracked(() => aside(() => tryNested<R>(name, nestedInput, options), true));
        if (scope === null) return tracked(() => tryNested<R>(name, nestedInput, options));
        return tracked(() => scope.undoneIfRolledBack((counter) => tryNested<R>(name, nestedInput, options, counter), (result) => result.status === 'refused'));
      },
      numbering: {
        allocate: (n) =>
          pending(async () => {
            refuseClosed('ctx.numbering.allocate');
            const { rows } = await aside(() => sql<{ period_key: string; number: string; allocation_id: string }>`
              SELECT a.period_key, a.number::text AS number, a.allocation_id
              FROM crove_kernel.allocate_number(${n.legalEntityId}::uuid, ${n.docType}::text, ${n.documentDate}::date, ${n.targetType}::text, ${n.targetId}::uuid) a`.execute(trx));
            const row = rows[0];
            const number = Number(row?.number);
            if (!row || !Number.isSafeInteger(number) || number < 1) throw new Error(`command ${def.name}: allocate_number answered no number`);
            return { periodKey: row.period_key, number, allocationId: row.allocation_id };
          }),
        void: (n) =>
          pending(async () => {
            refuseClosed('ctx.numbering.void');
            const { rows } = await aside(() => sql<{ id: string }>`SELECT crove_kernel.void_number(${n.allocationId}::uuid, ${n.reason}::text) AS id`.execute(trx));
            const voidId = rows[0]?.id;
            if (!voidId) throw new Error(`command ${def.name}: void_number answered no void`);
            return { voidId };
          }),
      },
    };
    // ctx.run and ctx.tryRun call these only while the handler runs, after both are defined.
    const resolveNested = (name: string, nestedInput: unknown, proposalIdOption: string | undefined): NestedRun => {
      const nested = this.#commands.get(name);
      if (!nested || nested.bootstrap) throw new DomainError('COMMAND_NOT_FOUND', 404, `Không có lệnh ${name}`);
      return { def: nested, input: parseInput(nested.input, nestedInput), proposalId: proposalIdOption ?? base.proposalId };
    };
    // counter: for a nested command that declares no writes run in this scope, the counter of this run (undoneIfRolledBack).
    const tryNested = async <R>(name: string, nestedInput: unknown, options: TryRunOptions, counter?: { n: number }): Promise<TryRunResult<R>> => {
      // An unknown command or an input that does not parse is the caller's bug, never a recorded refusal, as for a
      // top-level command (refused before its org is entered, so never audited).
      const nested = resolveNested(name, nestedInput, options.proposalId);
      // The row's input (canonical, hashed when the row is written) and target, from the input as parsed, before the
      // nested handler can change it.
      const canonicalInput = stableStringify(nested.input);
      const declared = nested.def.target?.(nested.input) ?? null;
      const target = declared ? Object.freeze({ type: String(declared.type), id: String(declared.id) }) : null;
      // Unique per call, so a tryRun nested in another one never rolls back to the outer savepoint.
      this.#savepointSeq += 1;
      // With a random part: ROLLBACK TO goes to the newest savepoint of that name, so a nested handler that could guess
      // it could set its own, shadow this one, and keep its writes while the caller sees a refusal (#1797).
      const savepoint = sql.raw(`crove_try_run_${this.#savepointSeq}_${randomUUID().replaceAll('-', '')}`);
      await sql`SAVEPOINT ${savepoint}`.execute(trx);
      // Undoes the nested command. Every path that does not return its value takes it, so a handler that catches the
      // error and goes on never keeps a refused or failed command's writes, and an aborted transaction is usable again.
      const discard = async () => {
        await sql`ROLLBACK TO SAVEPOINT ${savepoint}`.execute(trx);
        await sql`RELEASE SAVEPOINT ${savepoint}`.execute(trx);
      };
      // Before an error propagates: a failed rollback (the connection may be gone) never replaces the original
      // error, which is what the caller needs; it is logged with ids and codes only.
      const discardQuietly = async (original: unknown) => {
        try {
          await discard();
        } catch (rollbackError) {
          const sqlState = (rollbackError as { code?: unknown } | null)?.code;
          console.error(`[command ${def.name}] TRY_RUN_ROLLBACK_FAILED`, {
            orgId: base.orgId,
            commandId,
            nested: nested.def.name,
            error: original instanceof DomainError ? original.code : 'INTERNAL',
            sqlState: typeof sqlState === 'string' ? sqlState : null,
          });
        }
      };
      let value: R;
      try {
        value = await runNested<R>(nested, counter);
      } catch (error) {
        if (!(error instanceof DomainError)) {
          await discardQuietly(error);
          throw error;
        }
        // The snapshot the row is written from, taken before anyone else sees the refusal again.
        const code = error.code;
        const status = error.status;
        if (!AUDITED_REFUSAL_STATUSES.has(status) || isNeverRecovered(code)) {
          await discardQuietly(error);
          throw error;
        }
        let snapshot: CaughtRefusal;
        let refusal: DomainError;
        try {
          snapshot = Object.freeze({
            command: nested.def.name,
            code,
            security: isSecurityRefusal(error),
            outcome: status === 403 ? 'denied' : 'failed',
            input: canonicalInput,
            target,
            proposalId: nested.proposalId,
            detail: deepFreeze({ ...caughtRefusalDetail(error, base.actor, { command: def.name, nested: nested.def.name, orgId: base.orgId, commandId }), parentCommand: def.name, parentCommandId: commandId }),
          });
          refusal = frozenRefusal(error);
        } catch (snapshotError) {
          // Not expected (the copies above fall back), but never leave the savepoint open or replace the refusal.
          console.error(`[command ${def.name}] TRY_RUN_SNAPSHOT_FAILED`, {
            orgId: base.orgId,
            commandId,
            nested: nested.def.name,
            refusal: code,
            error: snapshotError instanceof Error ? snapshotError.name : 'unknown',
          });
          await discardQuietly(snapshotError);
          throw error;
        }
        let recovered: boolean;
        try {
          recovered = options.recover(refusal) === true;
        } catch (recoverError) {
          await discardQuietly(recoverError);
          throw recoverError;
        }
        if (!recovered) {
          await discardQuietly(error);
          throw error;
        }
        // Recovered: the caller goes on, so a failed rollback fails it here rather than keep the refused writes.
        await discard();
        caught.push(snapshot);
        return { status: 'refused', refusal };
      }
      await sql`RELEASE SAVEPOINT ${savepoint}`.execute(trx);
      return { status: 'ok', value };
    };
    const runNested = async <R>(nested: NestedRun, counter?: { n: number }): Promise<R> => {
      // P04 is derived from a proposal command's declared writes, so one that declares no contact or payment write never
      // runs a command that may write one (or declares nothing), whoever runs it and however deep it is nested.
      if (cleanRoot !== undefined && this.#contactOrPayment.get(nested.def.name) !== false) {
        throw new Error(`command ${cleanRoot}: declares no contact or payment write (P04), so it cannot run ${nested.def.name}, which may write one`);
      }
      // Nor one that declares a job table: what it starts runs under the job's own declaration (#2107).
      const startsJobs = cleanRoot === undefined ? [] : jobTablesOf(nested.def.writes);
      if (startsJobs.length > 0) {
        throw new Error(`command ${cleanRoot}: declares no contact or payment write (P04), so it cannot run ${nested.def.name}, which declares ${startsJobs.join(', ')}: the job it starts runs later under its own declaration (#2107)`);
      }
      const { proposalId } = nested;
      const permissionEntities = await this.authorize(trx, nested.def, base.actor, base.entered, proposalId !== null);
      if (proposalId !== null && (nested.def.access === 'proposal' || nested.def.access === 'proposal_revision')) {
        await this.requireProposalState(trx, base.orgId, nested.def, proposalId, { def, commandId });
      }
      this.requireStepUp(nested.def, base.actor);
      // An R3 command already confirmed the session live for this execution.
      if (def.risk !== 'R3') await this.requireLiveSession(nested.def, base.actor);
      return this.runInTx<R>(trx, nested.def, nested.input, {
        ...base,
        proposalId,
        // The nested command's own gate, never its caller's.
        permissionEntities,
        ...(cleanRoot !== undefined ? { cleanRoot } : {}),
        ...(scope !== null ? { writeScope: scope, writeCounters: counter ? [...counters, counter] : counters } : {}),
      });
    };
    let output: O;
    try {
      output = (await def.handler(ctx, input)) as O;
      closed = true;
    } catch (error) {
      closed = true;
      // A nested command or a runtime write the handler left running still uses this transaction's connection: let
      // them settle before the transaction (or a tryRun's savepoint) rolls back.
      await settleWriting();
      await settleRunning();
      throw error;
    }
    // Read before waiting: a nested command the handler left running may fail while the runtime's writes settle, and
    // must still fail this command.
    const leftRunning = running.size > 0;
    await settleWriting();
    // Before the runtime writes this command's rows: a nested command still running would share the connection with
    // them, and a tryRun's rollback could undo them, so the command fails instead and commits nothing.
    if ((await settleRunning()) || leftRunning) throw new Error(`command ${def.name}: the handler returned while a nested command was still running`);
    // An entity holder's command that never named its entity fails closed (#1507).
    if (permissionEntities !== null && !entityNamed) {
      throw new DomainError('FORBIDDEN', 403, 'Bạn không có quyền này với pháp nhân đó', { rule: 'permission_entity' });
    }
    if (writeCheck !== null) {
      if (writeCheck.unmeasured) {
        throw new Error(
          `command ${def.name}: its writes cannot be checked (a nested command failed, or the handler wrote while the runtime wrote for it: run ctx.emit, ctx.activity, ctx.numbering and nested commands one at a time) (#1710)`,
        );
      }
      const undeclared = [...(await tableWriteCounts(trx))]
        .filter(([table, n]) => n - (writeCheck.start.get(table) ?? 0) - (writeCheck.aside.get(table) ?? 0) > 0 && !writeCheck.declared.has(table))
        .map(([table]) => table)
        .sort();
      if (undeclared.length > 0) throw new Error(`command ${def.name}: wrote ${undeclared.join(', ')}, which it does not declare (#1710)`);
    }
    // Each refusal row first counts the refusal in its refusal_tally row (actor, command, code), which stays locked
    // until commit. Written only now, after every nested command ran, and in (command, code) order, so two commands of
    // one actor never wait on each other's tally rows while either still waits for a lock its nested commands take.
    const byKey = (a: CaughtRefusal, b: CaughtRefusal) => compareText(a.command, b.command) || compareText(a.code, b.code);
    // In a caller's scope (no declaration of its own), the rows the runtime writes for this command are set aside there.
    const late = writeCheck === null ? aside : <T>(work: () => Promise<T>) => work();
    for (const refusal of [...caught].sort(byKey)) {
      await late(() => this.writeNestedRefusalAudit(trx, base, refusal));
    }
    // R3 rows record the assurance used: aal, session_id and the MFA timestamp (ADR-0028 section 5). The runtime's
    // keys come last, so a command's ctx.audit facts never replace them.
    const assurance = def.risk === 'R3' && base.actor.type === 'user' ? this.sessionDetail(base.actor) : undefined;
    const detail =
      auditDetail || assurance
        ? { ...auditDetail, ...actorDetail(base.actor), ...assurance }
        : undefined;
    await late(() =>
      this.writeAudit(trx, {
        orgId: base.orgId,
        actor: base.actor,
        command: def.name,
        commandId,
        outcome: 'ok',
        input: stableStringify(input),
        target: def.target?.(input) ?? null,
        proposalId: base.proposalId,
        ...(detail ? { detail } : {}),
      }),
    );
    return output;
  }

  async execute<O = unknown>(name: string, rawInput: unknown, options: ExecuteOptions): Promise<O> {
    const def = this.#commands.get(name);
    if (!def || def.bootstrap) throw new DomainError('COMMAND_NOT_FOUND', 404, `Không có lệnh ${name}`);
    const input = parseInput(def.input, rawInput);
    const orgId = options.orgId;
    return this.executeIn<O>(name, def, input, options.actor, options.idempotencyKey, () => this.#cells.resolveTenant(orgId), async () => orgId);
  }

  // Runs an org-less command (see CommandDef.bootstrap). Only users run them; the org comes from the definer.
  async executeOrgless<O = unknown>(name: string, rawInput: unknown, options: ExecuteOrglessOptions): Promise<O> {
    const def = this.#commands.get(name);
    const bootstrap = def?.bootstrap;
    if (!def || !bootstrap) throw new DomainError('COMMAND_NOT_FOUND', 404, `Không có lệnh ${name}`);
    if (options.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Không có quyền thực hiện');
    const input = parseInput(def.input, rawInput);
    // The session is checked before the definer runs (no org yet), and again for the org when it is entered. There
    // is no org to resolve a cell from, so the transaction opens on the control plane and the new org lives in
    // the control plane's cell (plan §3.6).
    const controlPlane = async () => this.#cells.controlPlane();
    return this.executeIn<O>(name, def, input, options.actor, options.idempotencyKey, controlPlane, async (trx) => {
      await this.checkSession(trx, options.actor, null);
      return bootstrap(trx, options.actor, input, options.idempotencyKey ?? null, { sessionMode: this.sessionMode });
    });
  }

  private async executeIn<O>(
    name: string,
    def: CommandDef<unknown, unknown>,
    input: unknown,
    actor: Actor,
    idempotencyKey: string | undefined,
    cell: () => Promise<Db>,
    resolveOrg: (trx: Transaction<Database>) => Promise<string>,
  ): Promise<O> {
    const canonical = stableStringify(input);
    let orgId = '';
    let context: Entered = { role: null, agent: null };
    let entered = false;
    // An org-less command's org was created by this transaction (not a replay into an org that already existed):
    // the tenant row's xmin is this transaction's id (the definer inserts it outside any subtransaction).
    let orgIsNew = false;
    try {
      const db = await cell();
      return await db.transaction().execute(async (trx) => {
        orgId = await resolveOrg(trx);
        context = await this.enter(trx, actor, orgId);
        entered = true;
        if (def.bootstrap) {
          const { rows } = await sql<{ fresh: boolean }>`
            SELECT COALESCE(t.xmin = pg_catalog.pg_current_xact_id_if_assigned()::xid, false) AS fresh
            FROM crove_kernel.tenant t WHERE t.org_id = ${orgId}::uuid`.execute(trx);
          orgIsNew = rows[0]?.fresh === true;
        }
        const permissionEntities = await this.authorize(trx, def, actor, context, false);
        this.requireStepUp(def, actor);
        await this.requireLiveSession(def, actor);

        if (idempotencyKey) {
          const key = actorKey(actor);
          const requestHash = this.inputHashOf(actor, name, canonical);
          const claimed = await trx
            .insertInto('crove_kernel.idempotency_key')
            .values({ org_id: orgId, actor_key: key, key: idempotencyKey, command: name, request_sha256: requestHash, response: null })
            .onConflict((oc) => oc.doNothing())
            .returning('key')
            .executeTakeFirst();
          if (!claimed) {
            // The stored hash is compared with this runtime's hash of the input only. A row claimed before the switch
            // to keyed hashes (#1732) holds the plain SHA-256, matches no keyed hash, and is refused as another request,
            // so a retry against it never runs the command again; the 7-day retention removes such rows (#1750).
            const existing = await trx
              .selectFrom('crove_kernel.idempotency_key')
              .select(['command', 'response', sql<boolean>`(request_sha256 = ${requestHash})`.as('same_request')])
              .where('org_id', '=', orgId)
              .where('actor_key', '=', key)
              .where('key', '=', idempotencyKey)
              .executeTakeFirst();
            if (!existing || existing.command !== name || existing.same_request !== true) {
              throw new DomainError('IDEMPOTENCY_MISMATCH', 422, 'Khóa idempotency đã dùng cho yêu cầu khác');
            }
            const stored = existing.response as { value?: O } | null;
            if (stored !== null && typeof stored === 'object' && 'value' in stored) return stored.value as O;
            throw new DomainError('RETRY', 409, 'Yêu cầu đang được xử lý');
          }
          const output = await this.runInTx<O>(trx, def, input, { orgId, actor, entered: context, proposalId: null, permissionEntities });
          await trx
            .updateTable('crove_kernel.idempotency_key')
            .set({ response: JSON.stringify({ value: output ?? null }) })
            .where('org_id', '=', orgId)
            .where('actor_key', '=', key)
            .where('key', '=', idempotencyKey)
            .execute();
          return output;
        }
        return this.runInTx<O>(trx, def, input, { orgId, actor, entered: context, proposalId: null, permissionEntities });
      });
    } catch (error) {
      const domain = toDomainError(error);
      // An org-less command that failed after creating its org rolled the org back, so there is no org to audit
      // the refusal in; a refused replay into an org that already existed is audited there. A 404 after the
      // membership was established (plan §4.4 steps 7 and 14: a record the actor named is not in the org, such as
      // MEMBER_NOT_FOUND for a member of another org) is audited as failed like 409 and 422. Other statuses are not
      // audited today.
      if (entered && !orgIsNew && AUDITED_REFUSAL_STATUSES.has(domain.status)) {
        await this.writeRefusalAudit(name, def, input, canonical, actor, orgId, domain);
      } else if ((!entered || orgIsNew) && isPreMembershipRefusal(domain)) {
        // Refused before the caller was a member of the org (or the org-less command's new org rolled back with
        // it): there is no org to audit in, so it is noted in security_event (plan §4.4 step 3, issue #1006).
        await this.noteSecurityEvent(name, actor, orgIsNew ? null : orgId || null, domain.code);
      }
      if (domain.code === 'INTERNAL') logInternal(`execute ${name}`, error, { orgId, actor });
      throw domain;
    }
  }

  // Writes the denied/failed audit row of a refused command in a new short transaction (plan §4.4 step 14,
  // §4.10). The command already rolled back, so a lost refusal row hides no change; the caller still gets the
  // original refusal, never a 500 that would mask it. The loss is never silent: it is logged with ids and
  // codes only (no input, no row content, no driver message, which can quote values). The refusal is counted first
  // (issue #162): past the per-actor or per-org bound it is only counted, and no row is written.
  private async writeRefusalAudit(
    name: string,
    def: CommandDef<unknown, unknown>,
    input: unknown,
    canonical: string,
    actor: Actor,
    orgId: string,
    refusal: DomainError,
  ): Promise<void> {
    const commandId = uuidv7();
    const outcome = refusal.status === 403 ? 'denied' : 'failed';
    try {
      const db = await this.#cells.resolveTenant(orgId);
      await db.transaction().execute(async (trx) => {
        await this.enter(trx, actor, orgId);
        if (!(await this.countRefusal(trx, name, { code: refusal.code, security: isSecurityRefusal(refusal) }, actor, orgId))) return;
        await this.writeAudit(trx, {
          orgId,
          actor,
          command: name,
          commandId,
          outcome,
          input: canonical,
          target: def.target?.(input) ?? null,
          proposalId: null,
          detail: refusalAuditDetail(refusal, actor),
        });
      });
    } catch (auditError) {
      // Every loss is logged, including an actor removed from the org between the command and this write
      // (NOT_A_MEMBER from enter()): the row goes into the org's audit only through the actor's own context.
      const lost = toDomainError(auditError);
      const sqlState = auditError instanceof DomainError ? null : (auditError as { code?: unknown } | null)?.code;
      console.error(`[execute ${name}] AUDIT_WRITE_FAILED`, {
        orgId,
        commandId,
        actorType: actor.type,
        actorId: actorId(actor),
        outcome,
        refusal: refusal.code,
        error: lost.code,
        sqlState: typeof sqlState === 'string' ? sqlState : null,
      });
      if (contextTaint(auditError)) logInternal(`execute ${name} refusal audit`, auditError, { orgId, actor });
      // An actor removed from the org in between: the org's audit no longer takes the row, security_event does.
      if (lost.code === 'NOT_A_MEMBER') await this.noteSecurityEvent(name, actor, orgId, refusal.code);
    }
  }

  // Notes a refusal made before membership was established in crove_kernel.security_event (sampled per caller,
  // kept 30 days), in its own statement with no tenant context. Best effort, like the refusal audit: a failure is
  // logged with ids and codes only and never replaces the caller's refusal. System actors are not noted: they are the
  // deployment's own jobs, never an outside caller.
  private async noteSecurityEvent(name: string, actor: Actor, orgId: string | null, code: string): Promise<void> {
    if (actor.type === 'system') return;
    const caller = actor.type === 'user' ? `user:${actor.userId.toLowerCase()}` : `agent:${actor.agentId.toLowerCase()}`;
    const target = orgId && UUID_RE.test(orgId) ? orgId.toLowerCase() : null;
    try {
      await sql`SELECT crove_kernel.security_event_note(${caller}, ${name}, ${code}, ${target}::uuid)`.execute(this.#cells.controlPlane());
    } catch (error) {
      const sqlState = (error as { code?: unknown } | null)?.code;
      console.error(`[execute ${name}] SECURITY_EVENT_FAILED`, {
        orgId: target,
        actorType: actor.type,
        actorId: actorId(actor),
        refusal: code,
        sqlState: typeof sqlState === 'string' ? sqlState : null,
      });
    }
  }

  // Writes the denied/failed audit row of a nested command refused under ctx.tryRun (issue #429), in the calling
  // command's transaction once its handler returned (the nested command rolled back to its savepoint): the row writeRefusalAudit writes for
  // a refused top-level run of that command (its name, target, input hash and proposal, the refusal's code, rule and
  // the actor's session), plus the calling command and its command id, and under the same bound. A failed write fails
  // the calling command, which then commits nothing.
  private async writeNestedRefusalAudit(trx: Transaction<Database>, base: { orgId: string; actor: Actor }, refusal: CaughtRefusal): Promise<void> {
    if (!(await this.countRefusal(trx, refusal.command, refusal, base.actor, base.orgId))) return;
    await this.writeAudit(trx, {
      orgId: base.orgId,
      actor: base.actor,
      command: refusal.command,
      commandId: uuidv7(),
      outcome: refusal.outcome,
      input: refusal.input,
      target: refusal.target,
      proposalId: refusal.proposalId,
      detail: refusal.detail,
    });
  }

  // Counts the refusal in crove_kernel.refusal_tally (in the refusal transaction, after the context is entered) and
  // answers whether its audit row is written. A failing count never suppresses the row: the count is rolled back to
  // a savepoint, logged with ids and codes only, and the row is written as without a bound.
  private async countRefusal(
    trx: Transaction<Database>,
    name: string,
    refusal: { code: string; security: boolean },
    actor: Actor,
    orgId: string,
  ): Promise<boolean> {
    const limits = this.refusalAudit;
    if (limits === 'unbounded') return true;
    const code = refusal.code;
    await sql`SAVEPOINT refusal_tally`.execute(trx);
    try {
      const { rows } = await sql<{ audit: boolean }>`
        SELECT crove_kernel.refusal_tally_note(${name}, ${code}, ${refusal.security}::boolean,
          ${limits.perActor}::integer, ${limits.perOrg}::integer, ${limits.reserve}::integer,
          ${limits.windowSeconds}::integer) AS audit`.execute(trx);
      await sql`RELEASE SAVEPOINT refusal_tally`.execute(trx);
      return rows[0]?.audit !== false;
    } catch (tallyError) {
      await sql`ROLLBACK TO SAVEPOINT refusal_tally`.execute(trx);
      const sqlState = (tallyError as { code?: unknown } | null)?.code;
      console.error(`[execute ${name}] REFUSAL_TALLY_FAILED`, {
        orgId,
        actorType: actor.type,
        actorId: actorId(actor),
        refusal: code,
        sqlState: typeof sqlState === 'string' ? sqlState : null,
      });
      if (contextTaint(tallyError)) logInternal(`execute ${name} refusal tally`, tallyError, { orgId, actor });
      return true;
    }
  }

  async query<O = unknown>(name: string, rawInput: unknown, options: { actor: Actor; orgId: string }): Promise<O> {
    const def = this.#queries.get(name);
    if (!def) throw new DomainError('QUERY_NOT_FOUND', 404, `Không có truy vấn ${name}`);
    const input = parseInput(def.input, rawInput);
    let reached = false;
    try {
      const db = await this.#cells.resolveTenant(options.orgId);
      return await db.transaction().execute(async (trx) => {
        // The session check may record a first-seen session, so it runs before the transaction turns read-only.
        await this.checkSession(trx, options.actor, options.orgId);
        await sql`SET TRANSACTION READ ONLY`.execute(trx);
        const entered = await this.enterContext(trx, options.actor, options.orgId);
        reached = true;
        this.authorizeQuery(def, options.actor, entered);
        refuseStreamed(def);
        return (await def.handler(this.queryContext(trx.withPlugin(refuseTransactionControl(name)), options.orgId, options.actor, entered), input)) as O;
      });
    } catch (error) {
      const domain = toDomainError(error);
      if (!reached && isPreMembershipRefusal(domain)) await this.noteSecurityEvent(name, options.actor, options.orgId, domain.code);
      if (domain.code === 'INTERNAL') logInternal(`query ${name}`, error, options);
      throw domain;
    }
  }

  /**
   * Runs a streamed query (QueryDef.stream) and hands its batches to `sink` while it reads, in one REPEATABLE READ,
   * READ ONLY transaction of the org with the same session, context and access checks as query(). The snapshot is
   * taken at the transaction's first statement, so every batch sees the database as of one instant; the transaction
   * stays open until the handler returns, so a long stream holds back vacuum for that long.
   */
  async stream<O = unknown>(name: string, rawInput: unknown, options: { actor: Actor; orgId: string }, sink: QuerySink): Promise<O> {
    const def = this.#queries.get(name);
    if (!def) throw new DomainError('QUERY_NOT_FOUND', 404, `Không có truy vấn ${name}`);
    if (!def.stream) throw new DomainError('NOT_STREAMED', 400, `Truy vấn ${name} không đọc theo luồng`);
    const input = parseInput(def.input, rawInput);
    let reached = false;
    try {
      const db = await this.#cells.resolveTenant(options.orgId);
      return await db
        .transaction()
        .setIsolationLevel('repeatable read')
        .execute(async (trx) => {
          await this.checkSession(trx, options.actor, options.orgId);
          await sql`SET TRANSACTION READ ONLY`.execute(trx);
          // The transaction is idle while the sink stores a batch (an 8 MiB export chunk to a bucket can take longer
          // than the pool's 10 s idle-in-transaction limit); every statement keeps the pool's statement_timeout.
          await sql`SET LOCAL idle_in_transaction_session_timeout = ${sql.lit(`${STREAM_IDLE_MINUTES}min`)}`.execute(trx);
          const entered = await this.enterContext(trx, options.actor, options.orgId);
          reached = true;
          this.authorizeQuery(def, options.actor, entered);
          return (await def.handler(this.queryContext(trx.withPlugin(refuseTransactionControl(name)), options.orgId, options.actor, entered), input, sink)) as O;
        });
    } catch (error) {
      const domain = toDomainError(error);
      if (!reached && isPreMembershipRefusal(domain)) await this.noteSecurityEvent(name, options.actor, options.orgId, domain.code);
      if (domain.code === 'INTERNAL') logInternal(`stream ${name}`, error, options);
      throw domain;
    }
  }

  // Org-less reads for a signed-in user (listing orgs): one transaction on the control plane that starts with the
  // session status check. Only definer functions are callable. Creating an org is a command: executeOrgless().
  async forUser<O>(actor: UserActor, fn: (db: Db) => Promise<O>): Promise<O> {
    try {
      return await this.#cells.controlPlane().transaction().execute(async (trx) => {
        await this.checkSession(trx, actor, null);
        return fn(trx);
      });
    } catch (error) {
      const domain = toDomainError(error);
      if (domain.code === 'INTERNAL') logInternal('forUser', error, { actor });
      throw domain;
    }
  }

  // Org-less machinery work without a user (inbound email), on the control plane. User work goes through forUser().
  async orgless<O>(fn: (db: Db) => Promise<O>): Promise<O> {
    try {
      return await fn(this.#cells.controlPlane());
    } catch (error) {
      const domain = toDomainError(error);
      if (domain.code === 'INTERNAL') logInternal('orgless', error);
      throw domain;
    }
  }
}
// Nor can a method be replaced on the class (#1766).
Object.freeze(Runtime.prototype);
Object.freeze(Runtime);
