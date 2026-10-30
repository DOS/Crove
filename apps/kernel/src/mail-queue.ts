// The worker's side of queued mail, step E1b of the Email plan (docs/plan/email.md §3.2, issue #548). A sweep finds
// the mail waiting to be sent (crove_kernel.mail_queued_due) and queues one job per mail: system and transactional
// mail on kernel-mail-send, marketing on kernel-mail-bulk, worked one at a time with a gap so a campaign never holds
// up an invoice. A job runs kernel.mail.queue.begin (the suppression check and the 'started' call, committed), renders
// the mail from its template and merge data, sends it once, and records the outcome with kernel.mail.queue.record.
// Logs carry codes only: never an address, a subject or a provider's message.
import { sql } from 'kysely';
import type { Db } from '@crove/db';
import type { QueuedMailBegin } from '@crove/kernel';
import type { Runtime } from '@crove/kernel-runtime';
import type { MailAttachment, MailErrorKind, MailProvider, OutboundMail, SendResult } from '@crove/mail';
import { bounceAddress } from './invite-mail.ts';
import { DEFAULT_BRAND_NAME } from './config.ts';
import { jobKey } from './job-keys.ts';
import { opsAlert } from './ops-alert.ts';

export const MAIL_SEND_QUEUE = 'kernel-mail-send';
export const MAIL_BULK_QUEUE = 'kernel-mail-bulk';
export const MAIL_SWEEP_MS = 10_000;
// A send still 'started' after this long lost its worker: it is recorded as ambiguous.
export const MAIL_STALE_SECONDS = 600;
// Between two marketing mails.
export const MAIL_BULK_GAP_MS = 200;
const SWEEP_LIMIT = 200;
const SEND_TIMEOUT_MS = 30_000;
// A refusal the provider may not repeat (a rate limit, a busy server) is tried again this many times in the job.
const RETRY_DELAYS_MS = [1_000, 5_000];
const ACTOR = { type: 'system' as const, component: 'kernel.mail' };

export interface MailJob {
  orgId: string;
  messageId: string;
}

// How a template turns a mail's merge data into its content; null when the data is not what the template needs (the
// mail fails with TEMPLATE_DATA). The subject the command stored comes first; a template may build its own. A mail
// whose link must carry a secret (a report link's token) gets it here, at send time, through a command of the mail's
// org (`execute`, as the worker): the secret is then only in the mail, never in the queue.
export interface MailTemplateInput {
  messageId: string;
  subject: string | null;
  payload: Readonly<Record<string, unknown>>;
  publicUrl: string;
  // The org's inbound address when this deployment receives mail (#669), else null. A template whose replies should
  // reach the org's Inbox returns it as replyTo.
  inboundAddress: string | null;
  // The product name users see (BRAND_NAME, #1040), for the template's own texts.
  brand: string;
  execute<T>(command: string, input: unknown): Promise<T>;
}
export interface MailTemplate {
  render(input: MailTemplateInput): Promise<{ subject: string; text: string; html: string; replyTo?: string; attachments?: readonly MailAttachment[] } | null>;
}
export type MailTemplates = Readonly<Record<string, MailTemplate>>;

export interface MailQueueDeps {
  runtime: Runtime;
  mailer: MailProvider;
  templates: MailTemplates;
  publicUrl: string;
  // INBOUND_DOMAIN when mail reaches this deployment (INBOUND_SECRET set): the Return-Path of each mail, and the domain
  // of the org's inbound address a template may name as the Reply-To.
  bounceDomain: string | null;
  // BRAND_NAME (#1040); "Ludy" when not given.
  brand?: string;
  sleep?: (ms: number) => Promise<void>;
  sendTimeoutMs?: number;
  // The worker's connection, to read the operator's mail switch (#886) before a send.
  workerDb?: Db;
}

interface Sender {
  send(queue: string, data: MailJob, options: Record<string, unknown>): Promise<unknown>;
}

// Whether the operator holds every org's mail (crove_kernel.global_kill_switch_on('mail'), #886).
export async function mailHeld(db: Db): Promise<boolean> {
  const { rows } = await sql<{ on: boolean }>`SELECT crove_kernel.global_kill_switch_on('mail') AS on`.execute(db);
  return rows[0]?.on === true;
}

// One pass: queues the mail that is due and records the sends that lost their worker. Returns how many it queued.
export async function sweepMail(boss: Sender, workerDb: Db, runtime: Runtime, mailer: MailProvider): Promise<number> {
  // The operator's mail switch (#886): nothing is queued while it is on; the mail stays queued and goes out after.
  if (await mailHeld(workerDb)) return 0;
  const repeatable = mailer.enabled && (mailer.sendRetrySafety === 'idempotent' || mailer.sendRetrySafety === 'safe');
  const { rows } = await sql<{ org_id: string; message_id: string; stream: string; state: string; attempts: number }>`
    SELECT org_id, message_id, stream, state, attempts FROM crove_kernel.mail_queued_due(${SWEEP_LIMIT}::int, ${MAIL_STALE_SECONDS}::int, ${repeatable}::boolean)`.execute(workerDb);
  let queued = 0;
  for (const row of rows) {
    if (row.state === 'stale') {
      await runtime
        .execute('kernel.mail.queue.record', { messageId: row.message_id, attempt: row.attempts, outcome: 'ambiguous', errorCode: 'WORKER_LOST' }, { actor: ACTOR, orgId: row.org_id })
        .catch((error: unknown) => console.error(`[mail] lost send of ${row.message_id.slice(0, 8)} not recorded: ${mailErrorCode(error)}`));
      continue;
    }
    const queue = row.stream === 'marketing' ? MAIL_BULK_QUEUE : MAIL_SEND_QUEUE;
    // One mail that cannot be queued (a lost connection) leaves the others to this pass and itself to the next.
    try {
      await boss.send(queue, { orgId: row.org_id, messageId: row.message_id } satisfies MailJob, { singletonKey: jobKey(row.org_id, queue, row.message_id), retryLimit: 2, retryDelay: 30 });
      queued++;
    } catch (error) {
      console.error(`[mail] ${row.message_id.slice(0, 8)} not queued: ${mailErrorCode(error)}`);
    }
  }
  return queued;
}

export type MailJobOutcome = { action: 'none'; reason: string } | { action: 'suppressed' } | { action: 'recorded'; outcome: 'sent' | 'failed' | 'ambiguous'; code: string | null };

type Sent = { outcome: 'sent'; providerMessageId?: string } | { outcome: 'failed'; code: string; kind?: MailErrorKind } | { outcome: 'ambiguous'; code: string };

// One mail: begin, render, send once (a refusal the provider may lift is asked again a few times), record.
export async function runMailJob(deps: MailQueueDeps, job: MailJob): Promise<MailJobOutcome> {
  const ctx = { actor: ACTOR, orgId: job.orgId };
  // A job queued before the switch went on leaves its mail queued, untouched; the sweep queues it again once released.
  if (deps.workerDb && (await mailHeld(deps.workerDb))) return { action: 'none', reason: 'held' };
  const begun = await deps.runtime.execute<QueuedMailBegin>('kernel.mail.queue.begin', { messageId: job.messageId, provider: deps.mailer.name, safety: deps.mailer.sendRetrySafety }, ctx);
  if (begun.action !== 'send') return begun;
  const result = await sendOne(deps, job, begun);
  await deps.runtime.execute(
    'kernel.mail.queue.record',
    {
      messageId: job.messageId,
      attempt: begun.attempt,
      outcome: result.outcome,
      ...(result.outcome === 'sent' ? (result.providerMessageId ? { providerMessageId: result.providerMessageId } : {}) : { errorCode: result.code }),
      ...(result.outcome === 'failed' && result.kind ? { errorKind: result.kind } : {}),
    },
    ctx,
  );
  return { action: 'recorded', outcome: result.outcome, code: result.outcome === 'sent' ? null : result.code };
}

async function sendOne(deps: MailQueueDeps, job: MailJob, mail: Extract<QueuedMailBegin, { action: 'send' }>): Promise<Sent> {
  const template = Object.hasOwn(deps.templates, mail.templateKey) ? deps.templates[mail.templateKey] : undefined;
  if (!template) return { outcome: 'failed', code: 'TEMPLATE_UNKNOWN' };
  let content: Awaited<ReturnType<MailTemplate['render']>>;
  try {
    content = await template.render({
      messageId: job.messageId,
      subject: mail.subject,
      payload: mail.payload,
      publicUrl: deps.publicUrl,
      brand: deps.brand ?? DEFAULT_BRAND_NAME,
      inboundAddress: deps.bounceDomain ? `${mail.inboundToken}@${deps.bounceDomain.toLowerCase()}` : null,
      execute: <T>(command: string, input: unknown) => deps.runtime.execute<T>(command, input, { actor: ACTOR, orgId: job.orgId }),
    });
  } catch {
    content = null;
  }
  if (!content) return { outcome: 'failed', code: 'TEMPLATE_DATA' };
  const returnPath = mail.bounceToken ? bounceAddress(mail.bounceToken, deps.bounceDomain) : undefined;
  const outbound: OutboundMail = { to: mail.to, subject: content.subject, text: content.text, html: content.html, messageId: mail.messageIdHeader, ...(returnPath ? { returnPath } : {}), ...(content.replyTo ? { replyTo: content.replyTo } : {}), ...(content.attachments?.length ? { attachments: content.attachments } : {}) };
  if (!deps.mailer.enabled) {
    // The log provider shows the mail in the logs; nothing leaves the deployment.
    await Promise.resolve()
      .then(() => deps.mailer.send(outbound))
      .catch(() => undefined);
    return { outcome: 'failed', code: 'MAIL_OFF' };
  }
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt++) {
    let result: SendResult;
    try {
      result = await withTimeout(deps.mailer, outbound, deps.sendTimeoutMs ?? SEND_TIMEOUT_MS);
    } catch {
      // A timeout, or a provider that threw: it may have taken the mail.
      return { outcome: 'ambiguous', code: 'SEND_TIMEOUT' };
    }
    if (result.status === 'accepted') return { outcome: 'sent', ...(result.providerMessageId ? { providerMessageId: result.providerMessageId } : {}) };
    if (result.status === 'unknown') return { outcome: 'ambiguous', code: codeOf(result.code) };
    const delay = RETRY_DELAYS_MS[attempt];
    if ((result.error === 'transient' || result.error === 'rate_limited') && delay !== undefined) {
      await sleep(Math.max(delay, Math.min(result.retryAfterMs ?? 0, 30_000)));
      continue;
    }
    return { outcome: 'failed', code: codeOf(result.code), kind: result.error };
  }
}

// What an error is, for the logs: its code or name, never its message or detail (a database error's detail can quote
// the row, address and all).
export function mailErrorCode(error: unknown): string {
  if (error && typeof error === 'object') {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(code)) return code;
    const name = (error as { name?: unknown }).name;
    if (typeof name === 'string' && /^[A-Za-z]{1,64}$/.test(name)) return name;
  }
  return 'ERROR';
}

// A provider's code as the row keeps it (A-Z, digits, underscore).
function codeOf(code: string): string {
  const cleaned = code
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, '_')
    .replace(/^[^A-Z]+/, '')
    .slice(0, 64);
  return cleaned || 'SEND_FAILED';
}

async function withTimeout(mailer: MailProvider, mail: OutboundMail, ms: number): Promise<SendResult> {
  const send = Promise.resolve().then(() => mailer.send(mail));
  send.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  try {
    return await Promise.race([send, expired]);
  } finally {
    clearTimeout(timer);
  }
}

// Mail retention: the address and subject 13 months after a mail was written, its merge data 30 days after a final
// status (crove_kernel.mail_retention_purge), in batches until none is left or the run's budget is spent.
export async function purgeMail(workerDb: Db, batch = 10_000, maxBatches = 100): Promise<Record<string, number>> {
  const cleared: Record<string, number> = {};
  for (let i = 0; i < maxBatches; i++) {
    const { rows } = await sql<{ store: string; deleted: number; more: boolean }>`SELECT store, deleted, more FROM crove_kernel.mail_retention_purge(${batch}::int)`.execute(workerDb);
    for (const row of rows) cleared[row.store] = (cleared[row.store] ?? 0) + row.deleted;
    const stuck = rows.filter((r) => r.more && r.deleted === 0).map((r) => r.store);
    if (stuck.length > 0) {
      opsAlert(`[retention] ALERT mail purge cleared 0 rows while old ones remain: ${stuck.join(', ')}`);
      break;
    }
    if (!rows.some((r) => r.more)) break;
  }
  return cleared;
}
