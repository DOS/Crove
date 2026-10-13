// The single write path. Every state change is a typed command executed through Runtime.execute(),
// inside one transaction that enters the tenant context checked by RLS, and writes audit + outbox.
import { sql, type Transaction } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import type { z } from 'zod';
import type { Database, Db, MemberRole } from '@crove/db';
import { DomainError, toDomainError } from './errors.ts';
import { sha256Hex } from './storage.ts';

export type Risk = 'R0' | 'R1' | 'R2' | 'R3';

export type Actor =
  | { type: 'user'; userId: string }
  | { type: 'system'; component: string };

// 'members' = owner/admin/member; 'system' = system actor only; 'proposal' = only via an approved proposal.
export type Access = readonly MemberRole[] | 'system' | 'proposal';

export interface CommandDef<I = unknown, O = unknown> {
  name: string;
  input: z.ZodType<I>;
  risk: Risk;
  access: Access;
  target?: (input: I) => { type: string; id: string } | null;
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
  // Runs another registered command in the same transaction (audited on its own row).
  run<O>(name: string, input: unknown, options?: { proposalId?: string }): Promise<O>;
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

export class Runtime {
  private readonly commands = new Map<string, CommandDef<unknown, unknown>>();
  private readonly queries = new Map<string, QueryDef<unknown, unknown>>();
  readonly db: Db;

  constructor(db: Db) {
    this.db = db;
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

  private async enter(trx: Transaction<Database>, actor: Actor, orgId: string): Promise<MemberRole | null> {
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
      run: async <R>(name: string, nestedInput: unknown, options?: { proposalId?: string }): Promise<R> => {
        const nested = this.commands.get(name);
        if (!nested) throw new DomainError('COMMAND_NOT_FOUND', 404, `Không có lệnh ${name}`);
        const parsed = parseInput(nested.input, nestedInput);
        const proposalId = options?.proposalId ?? base.proposalId;
        this.authorize(nested.access, base.actor, base.role, proposalId !== null);
        return this.runInTx<R>(trx, nested, parsed, { ...base, proposalId });
      },
    };
    const output = (await def.handler(ctx, input)) as O;
    await this.writeAudit(trx, {
      orgId: base.orgId,
      actor: base.actor,
      command: def.name,
      commandId,
      outcome: 'ok',
      inputSha256: sha256Hex(stableStringify(input)),
      target: def.target?.(input) ?? null,
      proposalId: base.proposalId,
    });
    return output;
  }

  async execute<O = unknown>(name: string, rawInput: unknown, options: ExecuteOptions): Promise<O> {
    const def = this.commands.get(name);
    if (!def) throw new DomainError('COMMAND_NOT_FOUND', 404, `Không có lệnh ${name}`);
    const input = parseInput(def.input, rawInput);
    const inputSha256 = sha256Hex(stableStringify(input));
    let role: MemberRole | null = null;
    let entered = false;
    try {
      return await this.db.transaction().execute(async (trx) => {
        role = await this.enter(trx, options.actor, options.orgId);
        entered = true;
        this.authorize(def.access, options.actor, role, false);

        if (options.idempotencyKey) {
          const key = actorKey(options.actor);
          const claimed = await trx
            .insertInto('crove_kernel.idempotency_key')
            .values({ org_id: options.orgId, actor_key: key, key: options.idempotencyKey, command: name, request_sha256: inputSha256, response: null })
            .onConflict((oc) => oc.doNothing())
            .returning('key')
            .executeTakeFirst();
          if (!claimed) {
            const existing = await trx
              .selectFrom('crove_kernel.idempotency_key')
              .select(['command', 'request_sha256', 'response'])
              .where('org_id', '=', options.orgId)
              .where('actor_key', '=', key)
              .where('key', '=', options.idempotencyKey)
              .executeTakeFirst();
            if (!existing || existing.command !== name || existing.request_sha256 !== inputSha256) {
              throw new DomainError('IDEMPOTENCY_MISMATCH', 422, 'Khóa idempotency đã dùng cho yêu cầu khác');
            }
            if (existing.response !== null) return existing.response as O;
            throw new DomainError('RETRY', 409, 'Yêu cầu đang được xử lý');
          }
          const output = await this.runInTx<O>(trx, def, input, { orgId: options.orgId, actor: options.actor, role, proposalId: null });
          await trx
            .updateTable('crove_kernel.idempotency_key')
            .set({ response: JSON.stringify(output ?? null) })
            .where('org_id', '=', options.orgId)
            .where('actor_key', '=', key)
            .where('key', '=', options.idempotencyKey)
            .execute();
          return output;
        }
        return this.runInTx<O>(trx, def, input, { orgId: options.orgId, actor: options.actor, role, proposalId: null });
      });
    } catch (error) {
      const domain = toDomainError(error);
      if (entered && (domain.status === 403 || domain.status === 409 || domain.status === 422)) {
        await this.db
          .transaction()
          .execute(async (trx) => {
            await this.enter(trx, options.actor, options.orgId);
            await this.writeAudit(trx, {
              orgId: options.orgId,
              actor: options.actor,
              command: name,
              commandId: uuidv7(),
              outcome: domain.status === 403 ? 'denied' : 'failed',
              inputSha256,
              target: def.target?.(input) ?? null,
              proposalId: null,
              detail: { code: domain.code },
            });
          })
          .catch(() => {});
      }
      if (domain.code === 'INTERNAL') console.error(`[execute ${name}]`, error);
      throw domain;
    }
  }

  async query<O = unknown>(name: string, rawInput: unknown, options: { actor: Actor; orgId: string }): Promise<O> {
    const def = this.queries.get(name);
    if (!def) throw new DomainError('QUERY_NOT_FOUND', 404, `Không có truy vấn ${name}`);
    const input = parseInput(def.input, rawInput);
    try {
      return await this.db.transaction().execute(async (trx) => {
        await sql`SET TRANSACTION READ ONLY`.execute(trx);
        const role = await this.enter(trx, options.actor, options.orgId);
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

  // Org-less work (sign-in bookkeeping, listing orgs, creating an org). Only definer functions are callable.
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
