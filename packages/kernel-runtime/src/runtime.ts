// The single write path. Every state change is a typed command executed through Runtime.execute(),
// inside one transaction that enters the tenant context checked by RLS, and writes audit + outbox.
import { sql, type Transaction } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import type { z } from 'zod';
import type { Database, Db, MemberRole } from '@crove/db';
import { DomainError, toDomainError } from './errors.ts';
import { sha256Hex } from './storage.ts';

export type Risk = 'R0' | 'R1' | 'R2' | 'R3';

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
}

export type Actor = UserActor | { type: 'system'; component: string };

// 'members' = owner/admin/member; 'system' = system actor only; 'proposal' = only via an approved proposal.
export type Access = readonly MemberRole[] | 'system' | 'proposal';

export interface CommandDef<I = unknown, O = unknown> {
  name: string;
  input: z.ZodType<I>;
  risk: Risk;
  access: Access;
  target?: (input: I) => { type: string; id: string } | null;
  // Org-less commands (creating an org) start without an org. `bootstrap` calls a definer that creates the
  // org with the actor as a member, or returns the org an earlier request with the same idempotency key
  // created. executeOrgless() then enters that org as the actor, so membership is checked as on every other
  // command, and writes the handler's changes, the audit row and the idempotency key in one transaction.
  bootstrap?: (trx: Transaction<Database>, actor: UserActor, input: I, idempotencyKey: string | null) => Promise<string>;
  handler: (ctx: CommandContext, input: I) => Promise<O>;
}

export interface QueryDef<I = unknown, O = unknown> {
  name: string;
  input: z.ZodType<I>;
  access: readonly MemberRole[] | 'system';
  handler: (ctx: QueryContext, input: I) => Promise<O>;
}

export interface QueryContext {
  trx: Transaction<Database>;
  orgId: string;
  actor: Actor;
  role: MemberRole | null;
}

export interface CommandContext extends QueryContext {
  commandId: string;
  proposalId: string | null;
  now: Date;
  emit(type: string, payload: Record<string, unknown>): Promise<string>;
  activity(recordType: string, recordId: string, kind: string, summary: string): Promise<void>;
  // Adds fields to this command's own audit row (for example the policy outcome of an approval).
  audit(detail: Record<string, unknown>): void;
  // Runs another registered command in the same transaction (audited on its own row).
  run<O>(name: string, input: unknown, options?: { proposalId?: string }): Promise<O>;
}

// Status of the session behind a user actor (ADR-0028), checked in the request transaction before the
// tenant context is entered (orgId: that org, where an owner may have revoked the session for this member), and
// before org-less work (orgId: null). Throws (or raises in SQL) 401, 403 or 503; never passes a session it cannot
// vouch for.
export interface SessionStatusSource {
  readonly mode: 'db' | 'events' | 'off';
  check(trx: Transaction<Database>, actor: UserActor & { sessionId: string }, orgId: string | null): Promise<void>;
}

export interface RuntimeOptions {
  // null: no session check (tests and tools). The server always passes one (apps/kernel main.ts).
  sessions?: SessionStatusSource | null;
  // R3 commands run by a user need aal2 and a second factor in the last 5 minutes (policy P11). Default required.
  stepUp?: 'required' | 'off';
}

// Policy P11 (ADR-0028 section 5): a second factor used within the last 5 minutes.
export const STEP_UP_MAX_AGE_S = 300;
// Clock tolerance for an MFA timestamp from the future, as for token verification.
const CLOCK_TOLERANCE_S = 30;

export function hasFreshMfa(actor: UserActor, nowMs: number = Date.now()): boolean {
  if (actor.aal !== 'aal2' || typeof actor.mfaAt !== 'number' || !Number.isFinite(actor.mfaAt)) return false;
  const now = nowMs / 1000;
  return actor.mfaAt <= now + CLOCK_TOLERANCE_S && now - actor.mfaAt <= STEP_UP_MAX_AGE_S;
}

export function defineCommand<I, O>(def: CommandDef<I, O>): CommandDef<I, O> {
  return def;
}

export function defineQuery<I, O>(def: QueryDef<I, O>): QueryDef<I, O> {
  return def;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

function actorKey(actor: Actor): string {
  return actor.type === 'user' ? `user:${actor.userId}` : `system:${actor.component}`;
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

export class Runtime {
  private readonly commands = new Map<string, CommandDef<unknown, unknown>>();
  private readonly queries = new Map<string, QueryDef<unknown, unknown>>();
  readonly db: Db;
  private readonly sessions: SessionStatusSource | null;
  private readonly stepUp: 'required' | 'off';

  constructor(db: Db, options: RuntimeOptions = {}) {
    this.db = db;
    this.sessions = options.sessions ?? null;
    this.stepUp = options.stepUp ?? 'required';
  }

  register(defs: { commands?: CommandDef<any, any>[]; queries?: QueryDef<any, any>[] }): this {
    for (const c of defs.commands ?? []) {
      if (this.commands.has(c.name)) throw new Error(`duplicate command ${c.name}`);
      this.commands.set(c.name, c as CommandDef<unknown, unknown>);
    }
    for (const q of defs.queries ?? []) {
      if (this.queries.has(q.name)) throw new Error(`duplicate query ${q.name}`);
      this.queries.set(q.name, q as QueryDef<unknown, unknown>);
    }
    return this;
  }

  // The session status check, in the caller's transaction. Fails closed: a user actor without a session id is
  // refused whenever the runtime checks sessions.
  private async checkSession(trx: Transaction<Database>, actor: Actor, orgId: string | null): Promise<void> {
    if (actor.type !== 'user' || !this.sessions) return;
    const sessionId = actor.sessionId;
    if (!sessionId) throw new DomainError('UNAUTHENTICATED', 401, 'Phiên đăng nhập không hợp lệ');
    await this.sessions.check(trx, { ...actor, sessionId }, orgId);
  }

  private async enter(trx: Transaction<Database>, actor: Actor, orgId: string): Promise<MemberRole | null> {
    await this.checkSession(trx, actor, orgId);
    return this.enterContext(trx, actor, orgId);
  }

  private async enterContext(trx: Transaction<Database>, actor: Actor, orgId: string): Promise<MemberRole | null> {
    if (actor.type === 'system') {
      await sql`SELECT crove_kernel.enter_system_context(${orgId}::uuid)`.execute(trx);
      return null;
    }
    const { rows } = await sql<{ role: MemberRole }>`SELECT crove_kernel.enter_context(${actor.userId}::uuid, ${orgId}::uuid) AS role`.execute(trx);
    return rows[0]?.role ?? null;
  }

  private authorize(access: Access, actor: Actor, role: MemberRole | null, viaProposal: boolean): void {
    if (access === 'proposal') {
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

  private sessionDetail(actor: UserActor): Record<string, unknown> {
    return { aal: actor.aal, sessionId: actor.sessionId ?? null, mfaAt: actor.mfaAt ?? null };
  }

  private async writeAudit(
    trx: Transaction<Database>,
    row: {
      orgId: string;
      actor: Actor;
      command: string;
      commandId: string;
      outcome: 'ok' | 'denied' | 'failed';
      inputSha256: string;
      target: { type: string; id: string } | null;
      proposalId: string | null;
      detail?: Record<string, unknown>;
    },
  ): Promise<void> {
    await trx
      .insertInto('crove_kernel.audit_event')
      .values({
        org_id: row.orgId,
        actor_type: row.actor.type,
        actor_id: row.actor.type === 'user' ? row.actor.userId : null,
        command: row.command,
        command_id: row.commandId,
        outcome: row.outcome,
        target_type: row.target?.type ?? null,
        target_id: row.target?.id ?? null,
        input_sha256: row.inputSha256,
        proposal_id: row.proposalId,
        detail: JSON.stringify(row.detail ?? (row.actor.type === 'system' ? { component: row.actor.component } : {})),
      })
      .execute();
  }

  private async runInTx<O>(
    trx: Transaction<Database>,
    def: CommandDef<unknown, unknown>,
    input: unknown,
    base: { orgId: string; actor: Actor; role: MemberRole | null; proposalId: string | null },
  ): Promise<O> {
    const commandId = uuidv7();
    let auditDetail: Record<string, unknown> | undefined;
    const ctx: CommandContext = {
      trx,
      orgId: base.orgId,
      actor: base.actor,
      role: base.role,
      commandId,
      proposalId: base.proposalId,
      now: new Date(),
      emit: async (type, payload) => {
        if (!type.startsWith(`${def.name.split('.')[0]}.`)) throw new Error(`command ${def.name} cannot emit ${type}`);
        const { rows } = await sql<{ id: string }>`SELECT crove_kernel.emit(${type}, ${JSON.stringify(payload)}::jsonb, ${commandId}::uuid) AS id`.execute(trx);
        return rows[0]?.id ?? '';
      },
      activity: async (recordType, recordId, kind, summary) => {
        await trx
          .insertInto('crove_kernel.activity')
          .values({
            org_id: base.orgId,
            record_type: recordType,
            record_id: recordId,
            kind,
            summary,
            actor_id: base.actor.type === 'user' ? base.actor.userId : null,
          })
          .execute();
      },
      audit: (detail) => {
        auditDetail = { ...auditDetail, ...detail };
      },
      run: async <R>(name: string, nestedInput: unknown, options?: { proposalId?: string }): Promise<R> => {
        const nested = this.commands.get(name);
        if (!nested || nested.bootstrap) throw new DomainError('COMMAND_NOT_FOUND', 404, `Không có lệnh ${name}`);
        const parsed = parseInput(nested.input, nestedInput);
        const proposalId = options?.proposalId ?? base.proposalId;
        this.authorize(nested.access, base.actor, base.role, proposalId !== null);
        this.requireStepUp(nested, base.actor);
        return this.runInTx<R>(trx, nested, parsed, { ...base, proposalId });
      },
    };
    const output = (await def.handler(ctx, input)) as O;
    // R3 rows record the assurance used: aal, session_id and the MFA timestamp (ADR-0028 section 5).
    const assurance = def.risk === 'R3' && base.actor.type === 'user' ? this.sessionDetail(base.actor) : undefined;
    const detail =
      auditDetail || assurance
        ? { ...(base.actor.type === 'system' ? { component: base.actor.component } : {}), ...assurance, ...auditDetail }
        : undefined;
    await this.writeAudit(trx, {
      orgId: base.orgId,
      actor: base.actor,
      command: def.name,
      commandId,
      outcome: 'ok',
      inputSha256: sha256Hex(stableStringify(input)),
      target: def.target?.(input) ?? null,
      proposalId: base.proposalId,
      ...(detail ? { detail } : {}),
    });
    return output;
  }

  async execute<O = unknown>(name: string, rawInput: unknown, options: ExecuteOptions): Promise<O> {
    const def = this.commands.get(name);
    if (!def || def.bootstrap) throw new DomainError('COMMAND_NOT_FOUND', 404, `Không có lệnh ${name}`);
    const input = parseInput(def.input, rawInput);
    return this.executeIn<O>(name, def, input, options.actor, options.idempotencyKey, async () => options.orgId);
  }

  // Runs an org-less command (see CommandDef.bootstrap). Only users run them; the org comes from the definer.
  async executeOrgless<O = unknown>(name: string, rawInput: unknown, options: ExecuteOrglessOptions): Promise<O> {
    const def = this.commands.get(name);
    const bootstrap = def?.bootstrap;
    if (!def || !bootstrap) throw new DomainError('COMMAND_NOT_FOUND', 404, `Không có lệnh ${name}`);
    if (options.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Không có quyền thực hiện');
    const input = parseInput(def.input, rawInput);
    // The session is checked before the definer runs (no org yet), and again for the org when it is entered.
    return this.executeIn<O>(name, def, input, options.actor, options.idempotencyKey, async (trx) => {
      await this.checkSession(trx, options.actor, null);
      return bootstrap(trx, options.actor, input, options.idempotencyKey ?? null);
    });
  }

  private async executeIn<O>(
    name: string,
    def: CommandDef<unknown, unknown>,
    input: unknown,
    actor: Actor,
    idempotencyKey: string | undefined,
    resolveOrg: (trx: Transaction<Database>) => Promise<string>,
  ): Promise<O> {
    const inputSha256 = sha256Hex(stableStringify(input));
    let orgId = '';
    let role: MemberRole | null = null;
    let entered = false;
    try {
      return await this.db.transaction().execute(async (trx) => {
        orgId = await resolveOrg(trx);
        role = await this.enter(trx, actor, orgId);
        entered = true;
        this.authorize(def.access, actor, role, false);
        this.requireStepUp(def, actor);

        if (idempotencyKey) {
          const key = actorKey(actor);
          const claimed = await trx
            .insertInto('crove_kernel.idempotency_key')
            .values({ org_id: orgId, actor_key: key, key: idempotencyKey, command: name, request_sha256: inputSha256, response: null })
            .onConflict((oc) => oc.doNothing())
            .returning('key')
            .executeTakeFirst();
          if (!claimed) {
            const existing = await trx
              .selectFrom('crove_kernel.idempotency_key')
              .select(['command', 'request_sha256', 'response'])
              .where('org_id', '=', orgId)
              .where('actor_key', '=', key)
              .where('key', '=', idempotencyKey)
              .executeTakeFirst();
            if (!existing || existing.command !== name || existing.request_sha256 !== inputSha256) {
              throw new DomainError('IDEMPOTENCY_MISMATCH', 422, 'Khóa idempotency đã dùng cho yêu cầu khác');
            }
            const stored = existing.response as { value?: O } | null;
            if (stored !== null && typeof stored === 'object' && 'value' in stored) return stored.value as O;
            throw new DomainError('RETRY', 409, 'Yêu cầu đang được xử lý');
          }
          const output = await this.runInTx<O>(trx, def, input, { orgId, actor, role, proposalId: null });
          await trx
            .updateTable('crove_kernel.idempotency_key')
            .set({ response: JSON.stringify({ value: output ?? null }) })
            .where('org_id', '=', orgId)
            .where('actor_key', '=', key)
            .where('key', '=', idempotencyKey)
            .execute();
          return output;
        }
        return this.runInTx<O>(trx, def, input, { orgId, actor, role, proposalId: null });
      });
    } catch (error) {
      const domain = toDomainError(error);
      // An org-less command that failed after creating its org rolled the org back, so entering it fails and
      // no audit row is written; a refused replay into an org that already existed is audited there.
      if (entered && (domain.status === 403 || domain.status === 409 || domain.status === 422)) {
        await this.writeRefusalAudit(name, def, input, inputSha256, actor, orgId, domain);
      }
      if (domain.code === 'INTERNAL') console.error(`[execute ${name}]`, error);
      throw domain;
    }
  }

  // Writes the denied/failed audit row of a refused command in a new short transaction (plan §4.4 step 14,
  // §4.10). The command already rolled back, so a lost refusal row hides no change; the caller still gets the
  // original refusal, never a 500 that would mask it. The loss is never silent: it is logged with ids and
  // codes only (no input, no row content, no driver message, which can quote values).
  private async writeRefusalAudit(
    name: string,
    def: CommandDef<unknown, unknown>,
    input: unknown,
    inputSha256: string,
    actor: Actor,
    orgId: string,
    refusal: DomainError,
  ): Promise<void> {
    const commandId = uuidv7();
    const outcome = refusal.status === 403 ? 'denied' : 'failed';
    try {
      await this.db.transaction().execute(async (trx) => {
        await this.enter(trx, actor, orgId);
        await this.writeAudit(trx, {
          orgId,
          actor,
          command: name,
          commandId,
          outcome,
          inputSha256,
          target: def.target?.(input) ?? null,
          proposalId: null,
          // The policy rule that refused, when the error names one (for example P10 or P12), and the session.
          detail: {
            code: refusal.code,
            ...(typeof refusal.details?.rule === 'string' ? { rule: refusal.details.rule } : {}),
            ...(actor.type === 'user' ? this.sessionDetail(actor) : {}),
          },
        });
      });
    } catch (auditError) {
      const lost = toDomainError(auditError);
      // An org-less command whose org was created in the failed transaction: the org rolled back with it, so
      // there is no org to audit in (expected, see executeIn). A refused replay into an existing org is logged.
      if (def.bootstrap && lost.code === 'NOT_A_MEMBER') return;
      const sqlState = auditError instanceof DomainError ? null : (auditError as { code?: unknown } | null)?.code;
      console.error(`[execute ${name}] AUDIT_WRITE_FAILED`, {
        orgId,
        commandId,
        actorType: actor.type,
        actorId: actor.type === 'user' ? actor.userId : actor.component,
        outcome,
        refusal: refusal.code,
        error: lost.code,
        sqlState: typeof sqlState === 'string' ? sqlState : null,
      });
    }
  }

  async query<O = unknown>(name: string, rawInput: unknown, options: { actor: Actor; orgId: string }): Promise<O> {
    const def = this.queries.get(name);
    if (!def) throw new DomainError('QUERY_NOT_FOUND', 404, `Không có truy vấn ${name}`);
    const input = parseInput(def.input, rawInput);
    try {
      return await this.db.transaction().execute(async (trx) => {
        // The session check may record a first-seen session, so it runs before the transaction turns read-only.
        await this.checkSession(trx, options.actor, options.orgId);
        await sql`SET TRANSACTION READ ONLY`.execute(trx);
        const role = await this.enterContext(trx, options.actor, options.orgId);
        if (def.access === 'system') {
          if (options.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Không có quyền thực hiện');
        } else if (options.actor.type === 'user' && (!role || !def.access.includes(role))) {
          throw new DomainError('FORBIDDEN', 403, 'Không có quyền xem');
        }
        return (await def.handler({ trx, orgId: options.orgId, actor: options.actor, role }, input)) as O;
      });
    } catch (error) {
      const domain = toDomainError(error);
      if (domain.code === 'INTERNAL') console.error(`[query ${name}]`, error);
      throw domain;
    }
  }

  // Org-less reads for a signed-in user (listing orgs): one transaction that starts with the session status
  // check. Only definer functions are callable. Creating an org is a command: executeOrgless().
  async forUser<O>(actor: UserActor, fn: (db: Db) => Promise<O>): Promise<O> {
    try {
      return await this.db.transaction().execute(async (trx) => {
        await this.checkSession(trx, actor, null);
        return fn(trx);
      });
    } catch (error) {
      const domain = toDomainError(error);
      if (domain.code === 'INTERNAL') console.error('[forUser]', error);
      throw domain;
    }
  }

  // Org-less machinery work without a user (inbound email). User work goes through forUser().
  async orgless<O>(fn: (db: Db) => Promise<O>): Promise<O> {
    try {
      return await fn(this.db);
    } catch (error) {
      const domain = toDomainError(error);
      if (domain.code === 'INTERNAL') console.error('[orgless]', error);
      throw domain;
    }
  }
}
