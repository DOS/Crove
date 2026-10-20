// Delivery events from the mail provider (issue #539, Email plan §3.3).
//
// API side: POST /webhooks/mail/<provider> checks the provider's signature and hands the events to the worker
// through crove_kernel.mail_event_enqueue(), without parsing anything further and without a tenant context. A forged,
// stale or malformed delivery is refused and stored nowhere.
//
// Worker side: one job per event finds the mail by the provider's message id (the org comes from the stored mail,
// never from the payload) and records the event with kernel.mail.event.record in that org's system context. An event
// for a mail Crove does not know is dropped.
import { sql } from 'kysely';
import type { Db } from '@crove/db';
import type { MailEvent, MailProvider, WebhookRequest } from '@crove/mail';
import { WebhookRejected } from '@crove/mail';
import type { Runtime } from '@crove/kernel-runtime';

// A webhook delivery carries one event; this bounds what the API reads before checking its signature.
export const MAX_MAIL_WEBHOOK_BYTES = 256 * 1024;

export type MailWebhookOutcome =
  | { status: 202; queued: number }
  | { status: 200; queued: 0 }
  | { status: 401; code: 'WEBHOOK_SIGNATURE' }
  | { status: 400; code: 'WEBHOOK_MALFORMED' };

export async function acceptMailWebhook(runtime: Runtime, provider: MailProvider, request: WebhookRequest, now: number = Date.now()): Promise<MailWebhookOutcome> {
  if (!provider.parseWebhook) throw new Error('the provider has no webhooks');
  let events: MailEvent[];
  try {
    events = provider.parseWebhook(request, now);
  } catch (error) {
    if (!(error instanceof WebhookRejected)) throw error;
    return error.reason === 'malformed' ? { status: 400, code: 'WEBHOOK_MALFORMED' } : { status: 401, code: 'WEBHOOK_SIGNATURE' };
  }
  // An event type Crove does not record: acknowledged, so the provider stops retrying it.
  if (events.length === 0) return { status: 200, queued: 0 };
  const queued = await runtime.orgless(async (db) => {
    const { rows } = await sql<{ queued: number }>`
      SELECT crove_kernel.mail_event_enqueue(${provider.name}, ${JSON.stringify(events)}::jsonb) AS queued`.execute(db);
    return Number(rows[0]?.queued ?? 0);
  });
  return { status: 202, queued };
}

export interface MailEventJob {
  provider: string;
  providerEventId: string;
  providerMessageId: string;
  kind: MailEvent['kind'];
  occurredAt: string;
  detail: Record<string, string>;
}

export interface MailEventRow {
  seq: string;
  provider: string;
  provider_event_id: string;
  provider_message_id: string;
  kind: MailEvent['kind'];
  occurred_at: Date;
  detail: Record<string, string>;
}

export function mailEventJob(row: MailEventRow): MailEventJob {
  return {
    provider: row.provider,
    providerEventId: row.provider_event_id,
    providerMessageId: row.provider_message_id,
    kind: row.kind,
    occurredAt: row.occurred_at.toISOString(),
    detail: row.detail,
  };
}

export type MailEventResult = { recorded: boolean; status: string; suppressed: 'all' | 'marketing' | null } | { dropped: 'UNKNOWN_MESSAGE' };

export async function processMailEvent(deps: { runtime: Runtime; workerDb: Db }, job: MailEventJob): Promise<MailEventResult> {
  const { rows } = await sql<{ org_id: string; message_id: string }>`
    SELECT org_id, message_id FROM crove_kernel.mail_message_by_provider_id(${job.provider}, ${job.providerMessageId})`.execute(deps.workerDb);
  const mail = rows[0];
  if (!mail) return { dropped: 'UNKNOWN_MESSAGE' };
  return deps.runtime.execute(
    'kernel.mail.event.record',
    {
      messageId: mail.message_id,
      provider: job.provider,
      providerEventId: job.providerEventId,
      kind: job.kind,
      occurredAt: job.occurredAt,
      detail: job.detail,
    },
    { actor: { type: 'system', component: 'kernel.mail' }, orgId: mail.org_id },
  );
}
