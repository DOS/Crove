// The org's audit log for owners and admins (#672): the audit rows every command writes, filtered by who, what, on
// which object and when, newest first and paged; the commands the org's log holds, for the filter; and the filtered
// list as a CSV file, itself audited. Reads stay inside the org (audit_event's tenant RLS); the roles are the query's
// access list. A row's detail is shown as one line with any key that looks like a secret left out.
import { sql, type Kysely, type RawBuilder, type Transaction } from 'kysely';
import { z } from 'zod';
import {
  AUDIT_EXPORT_LIMIT,
  AUDIT_PAGE_SIZE,
  zAuditCursor,
  zAuditFilter,
  type AuditCursor,
  type AuditEntry,
  type AuditExport,
  type AuditFilter,
  type AuditOutcome,
  type AuditPage,
} from '@crove/kernel-contract';
import type { Database, MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery } from '@crove/kernel-runtime';

const ADMINS: readonly MemberRole[] = ['owner', 'admin'];
const TZ = 'Asia/Ho_Chi_Minh';
// How many distinct commands the filter offers.
const COMMAND_LIMIT = 500;

type Db = Kysely<Database> | Transaction<Database>;

interface AuditRow {
  id: string;
  occurred_at: Date;
  actor_type: string;
  actor_id: string | null;
  command: string;
  outcome: string;
  target_type: string | null;
  target_id: string | null;
  proposal_id: string | null;
  detail: unknown;
}

// Keys whose values are never shown, at any depth: secrets, keys, hashes, sessions and sealed material. A command
// should not audit any of these, but the viewer does not rely on it.
const HIDDEN_WORDS = new Set(['token', 'tokens', 'secret', 'secrets', 'password', 'passphrase', 'credential', 'credentials', 'key', 'keys', 'seal', 'sealed', 'envelope', 'cipher', 'ciphertext', 'hash', 'session', 'cookie', 'otp', 'verifier', 'signature', 'nonce', 'iv']);
// A key is hidden when one of its words (split at _, -, . and camelCase) is one of these, or is sha with a number (sha256).
export function hiddenKey(key: string): boolean {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[\s_.-]+/);
  return words.some((w) => HIDDEN_WORDS.has(w) || /^sha\d*$/.test(w));
}
const HIDDEN = '[ẩn]';
const DETAIL_MAX = 1000;
const VALUE_MAX = 200;

function flatten(value: unknown, prefix: string, out: string[], depth: number): void {
  if (out.length >= 60) return;
  if (value === null || value === undefined) {
    if (prefix) out.push(`${prefix}=null`);
    return;
  }
  if (Array.isArray(value)) {
    if (depth >= 3 || value.every((v) => v === null || typeof v !== 'object')) {
      const shown = value.slice(0, 10).map((v) => (v !== null && typeof v === 'object' ? '…' : String(v)));
      out.push(`${prefix}=[${shown.join(', ')}${value.length > 10 ? `, … (${value.length})` : ''}]`);
      return;
    }
    value.slice(0, 10).forEach((v, i) => flatten(v, `${prefix}[${i}]`, out, depth + 1));
    return;
  }
  if (typeof value === 'object') {
    if (depth >= 3) {
      out.push(`${prefix}={…}`);
      return;
    }
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (hiddenKey(k)) out.push(`${key}=${HIDDEN}`);
      else flatten(v, key, out, depth + 1);
    }
    return;
  }
  const text = String(value).replace(/\p{Cc}+/gu, ' ');
  out.push(`${prefix || 'value'}=${[...text].slice(0, VALUE_MAX).join('')}${[...text].length > VALUE_MAX ? '…' : ''}`);
}

// An audit row's detail as one line of key=value pairs, at most DETAIL_MAX characters; null when it holds nothing.
export function auditDetailLine(detail: unknown): string | null {
  const parsed = typeof detail === 'string' ? safeParse(detail) : detail;
  if (parsed === null || parsed === undefined) return null;
  const out: string[] = [];
  flatten(parsed, '', out, 0);
  if (out.length === 0) return null;
  const line = out.join('; ');
  return [...line].length > DETAIL_MAX ? `${[...line].slice(0, DETAIL_MAX).join('')}…` : line;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function where(orgId: string, filter: AuditFilter, before: AuditCursor | undefined): RawBuilder<unknown> {
  const parts: RawBuilder<unknown>[] = [sql`org_id = ${orgId}::uuid`];
  if (filter.actor === 'system') parts.push(sql`actor_type = 'system'`);
  else if (filter.actor) parts.push(sql`actor_id = ${filter.actor}::uuid`);
  if (filter.command?.endsWith('.')) parts.push(sql`left(command, ${filter.command.length}) = ${filter.command}`);
  else if (filter.command) parts.push(sql`command = ${filter.command}`);
  if (filter.outcome) parts.push(sql`outcome = ${filter.outcome}`);
  if (filter.targetType) parts.push(sql`target_type = ${filter.targetType}`);
  if (filter.targetId) parts.push(sql`(target_id = ${filter.targetId}::uuid OR proposal_id = ${filter.targetId}::uuid)`);
  if (filter.from) parts.push(sql`occurred_at >= (${filter.from}::date::timestamp AT TIME ZONE ${TZ})`);
  if (filter.to) parts.push(sql`occurred_at < ((${filter.to}::date + 1)::timestamp AT TIME ZONE ${TZ})`);
  if (before) parts.push(sql`(occurred_at, id) < (${before.at}::timestamptz, ${before.id}::uuid)`);
  return sql.join(parts, sql` AND `);
}

async function readRows(db: Db, orgId: string, filter: AuditFilter, before: AuditCursor | undefined, limit: number): Promise<AuditRow[]> {
  const { rows } = await sql<AuditRow>`
    SELECT id, occurred_at, actor_type, actor_id, command, outcome, target_type, target_id, proposal_id, detail
    FROM crove_kernel.audit_event
    WHERE ${where(orgId, filter, before)}
    ORDER BY occurred_at DESC, id DESC
    LIMIT ${limit}`.execute(db);
  return rows;
}

// Names of the people (while they are members: member_profiles answers only for members of the org) and the agents.
async function actorNames(db: Db, orgId: string, rows: readonly AuditRow[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const users = [...new Set(rows.filter((r) => r.actor_type === 'user' && r.actor_id).map((r) => r.actor_id as string))];
  const agents = [...new Set(rows.filter((r) => r.actor_type === 'agent' && r.actor_id).map((r) => r.actor_id as string))];
  if (users.length > 0) {
    const { rows: people } = await sql<{ user_id: string; email: string; display_name: string | null }>`
      SELECT user_id, email, display_name FROM crove_kernel.member_profiles(${users}::uuid[])`.execute(db);
    for (const p of people) names.set(p.user_id, p.display_name ?? p.email);
  }
  if (agents.length > 0) {
    const found = await db.selectFrom('crove_kernel.agent').select(['id', 'display_name']).where('org_id', '=', orgId).where('id', 'in', agents).execute();
    for (const a of found) names.set(a.id, a.display_name);
  }
  return names;
}

function entry(r: AuditRow, names: ReadonlyMap<string, string>): AuditEntry {
  return {
    id: r.id,
    at: r.occurred_at.toISOString(),
    actorType: r.actor_type === 'user' || r.actor_type === 'agent' ? r.actor_type : 'system',
    actorId: r.actor_id,
    actorName: r.actor_id ? (names.get(r.actor_id) ?? null) : null,
    command: r.command,
    outcome: r.outcome as AuditOutcome,
    targetType: r.target_type,
    targetId: r.target_id,
    proposalId: r.proposal_id,
    detail: auditDetailLine(r.detail),
  };
}

function checkRange(filter: AuditFilter): void {
  if (filter.from && filter.to && filter.from > filter.to) throw new DomainError('AUDIT_RANGE', 422, 'Ngày bắt đầu phải trước ngày kết thúc');
}

export const auditList = defineQuery({
  name: 'kernel.audit.list',
  input: zAuditFilter.extend({ before: zAuditCursor.optional() }),
  access: ADMINS,
  handler: async (ctx, input): Promise<AuditPage> => {
    checkRange(input);
    const rows = await readRows(ctx.trx, ctx.orgId, input, input.before, AUDIT_PAGE_SIZE + 1);
    const page = rows.slice(0, AUDIT_PAGE_SIZE);
    const names = await actorNames(ctx.trx, ctx.orgId, page);
    return { items: page.map((r) => entry(r, names)), more: rows.length > AUDIT_PAGE_SIZE };
  },
});

// The commands the org's log holds, for the filter.
export const auditCommands = defineQuery({
  name: 'kernel.audit.commands',
  input: z.strictObject({}),
  access: ADMINS,
  handler: async (ctx): Promise<string[]> => {
    const { rows } = await sql<{ command: string }>`
      SELECT DISTINCT command FROM crove_kernel.audit_event WHERE org_id = ${ctx.orgId}::uuid ORDER BY command LIMIT ${COMMAND_LIMIT}`.execute(ctx.trx);
    return rows.map((r) => r.command);
  },
});

// A cell as a spreadsheet reads it: quoted when it holds a comma, quote or line break, and a leading =, +, - or @
// (which a spreadsheet would run as a formula) taken as text.
export function csvCell(value: string | null): string {
  if (value === null) return '';
  let s = value;
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const AUDIT_CSV_HEAD = ['occurred_at', 'actor_type', 'actor_id', 'actor_name', 'command', 'outcome', 'target_type', 'target_id', 'proposal_id', 'detail'];

export function auditCsv(entries: readonly AuditEntry[]): string {
  const lines = entries.map((e) => [e.at, e.actorType, e.actorId, e.actorName, e.command, e.outcome, e.targetType, e.targetId, e.proposalId, e.detail].map(csvCell).join(','));
  // A byte order mark, so a spreadsheet opens Vietnamese text as UTF-8.
  return `﻿${[AUDIT_CSV_HEAD.join(','), ...lines].join('\r\n')}\r\n`;
}

// The filtered list as a CSV file. A command, so every export leaves its own audit row (the filter and the count).
export const auditExport = defineCommand({
  name: 'kernel.audit.export',
  input: zAuditFilter,
  risk: 'R0',
  access: ADMINS,
  handler: async (ctx, input): Promise<AuditExport> => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
    checkRange(input);
    const rows = await readRows(ctx.trx, ctx.orgId, input, undefined, AUDIT_EXPORT_LIMIT + 1);
    if (rows.length > AUDIT_EXPORT_LIMIT) {
      throw new DomainError('AUDIT_EXPORT_TOO_LARGE', 422, `Danh sách có hơn ${AUDIT_EXPORT_LIMIT} dòng; hãy thu hẹp bộ lọc`, { limit: AUDIT_EXPORT_LIMIT });
    }
    const names = await actorNames(ctx.trx, ctx.orgId, rows);
    ctx.audit({ filter: input, rows: rows.length });
    return { filename: `audit-${ctx.now.toISOString().slice(0, 10)}.csv`, csv: auditCsv(rows.map((r) => entry(r, names))), rows: rows.length };
  },
});

export const auditLogQueries = [auditList, auditCommands];
export const auditLogCommands = [auditExport];
