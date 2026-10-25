// Inbound email: a mail worker (e.g. Cloudflare Email Routing) POSTs the raw MIME message to
// /api/inbound/email with a shared secret. The recipient <token>@INBOUND_DOMAIN selects the org.
//
// The API only verifies the secret, limits the size, stores the raw bytes and enqueues them
// (acceptInboundEmail). Resolving the org and kernel.inbound.receive run in the worker (processInboundEmail),
// the only role that may enter system context (External-tenant gate T5). The worker does not parse the MIME
// message itself: crove-extract does, and its answer is validated and treated as untrusted (gate T12).
import { timingSafeEqual } from 'node:crypto';
import { sql } from 'kysely';
import { EXTRACT_LIMIT_RETRIES, type ExtractClient } from '@crove/extract-contract';
import { ACCEPTED_ARCHIVE_TYPES, ACCEPTED_UPLOAD_TYPES, MAX_EMAIL_ARCHIVES, MAX_UPLOAD_BYTES } from '@crove/kernel-contract';
import type { UsageLimits, UsageOver } from '@crove/kernel';
import { DomainError, fileKey, inboundKey, newInboundBlobId, putFile, sha256Hex, type BlobStore, type Runtime } from '@crove/kernel-runtime';
import { safeFilename, sniffType } from './sniff.ts';

export const MAX_EMAIL_BYTES = 40 * 1024 * 1024;
const TOKEN = /^[0-9a-f]{24}$/;
const MAX_ADDRESS_LENGTH = 320;

export function secretMatches(header: string | undefined, secret: string): boolean {
  const presented = header?.startsWith('Bearer ') ? header.slice(7) : '';
  const a = Buffer.from(presented);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

// The org token of <token>[+tag]@domain, or null.
function tokenOf(address: string, domain: string): string | null {
  const suffix = `@${domain.toLowerCase()}`;
  const normalized = address.toLowerCase().trim();
  if (!normalized.endsWith(suffix)) return null;
  const token = normalized.slice(0, -suffix.length).split('+')[0] ?? '';
  return TOKEN.test(token) ? token : null;
}

// The bounce token of bounce+<token>@domain (#539: the Return-Path of a mail Crove sent over SMTP), or null.
const BOUNCE = /^bounce\+([0-9a-f]{48})$/;
export function bounceTokenOf(address: string, domain: string): string | null {
  const suffix = `@${domain.toLowerCase()}`;
  const normalized = address.toLowerCase().trim();
  if (!normalized.endsWith(suffix)) return null;
  return BOUNCE.exec(normalized.slice(0, -suffix.length))?.[1] ?? null;
}

const unknownRecipient = () => new DomainError('UNKNOWN_RECIPIENT', 404, 'Địa chỉ nhận không hợp lệ');

export interface InboundAcceptDeps {
  runtime: Runtime;
  store: BlobStore;
  domain: string;
}

// API side: no parsing and no tenant context. An envelope recipient on INBOUND_DOMAIN that cannot be a
// Crove address is refused before anything is stored; the token itself is resolved by the worker. A
// recipient on another domain is kept, and the worker falls back to the message headers, as before.
// Each delivery gets its own blob; when the same message to the same recipient is already pending, or the
// enqueue fails (503 past the backlog cap), the new blob is deleted again.
export async function acceptInboundEmail(
  deps: InboundAcceptDeps,
  raw: Uint8Array,
  envelopeRecipient: string | null,
): Promise<{ accepted: true; sha256: string }> {
  if (raw.byteLength === 0) throw new DomainError('EMPTY_MESSAGE', 400, 'Thư rỗng');
  if (raw.byteLength > MAX_EMAIL_BYTES) throw new DomainError('TOO_LARGE', 413, 'Thư vượt quá 40 MB');
  const recipient = envelopeRecipient?.trim().toLowerCase() || null;
  if (recipient !== null) {
    const onDomain = recipient.endsWith(`@${deps.domain.toLowerCase()}`);
    if (recipient.length > MAX_ADDRESS_LENGTH || (onDomain && !tokenOf(recipient, deps.domain) && !bounceTokenOf(recipient, deps.domain))) throw unknownRecipient();
  }
  const sha256 = sha256Hex(raw);
  const blobId = newInboundBlobId();
  const key = inboundKey(blobId);
  await deps.store.put(key, raw, 'message/rfc822');
  let queued = false;
  try {
    queued = await deps.runtime.orgless(async (db) => {
      const { rows } = await sql<{ queued: boolean }>`
        SELECT crove_kernel.inbound_enqueue(${blobId}, ${sha256}, ${raw.byteLength}::bigint, ${recipient}) AS queued`.execute(db);
      return rows[0]?.queued === true;
    });
  } finally {
    if (!queued) await deps.store.delete(key);
  }
  return { accepted: true, sha256 };
}

// Counts a message dropped for an unknown recipient against the org whose address it was, when the token is an
// address that org retired less than 30 days ago; any other token changes nothing (crove_kernel.inbound_drop_record).
// Best effort: the message is dropped either way, so a failure to count is logged and does not retry the job.
async function countDrop(runtime: Runtime, token: string): Promise<void> {
  try {
    await runtime.orgless((db) => sql`SELECT crove_kernel.inbound_drop_record(${token})`.execute(db));
  } catch (error) {
    console.error('[inbound] could not count a dropped message', error);
  }
}

export interface InboundJob {
  blobId: string;
  sha256: string;
  sizeBytes: number;
  recipient: string | null;
}

export interface InboundProcessDeps {
  runtime: Runtime;
  store: BlobStore;
  domain: string | null;
  // crove-extract parses the message.
  extract: ExtractClient;
  // The per-org abuse limits (#675); without them no limit is checked.
  limits?: UsageLimits | undefined;
}

// A message kept for later because its org is over a daily limit (#675): the worker queues it again for retryAt and
// keeps its raw blob.
export interface InboundDeferred {
  deferred: string;
}

// Worker side: has the stored message parsed, resolves the org by token and records it in system context.
// Idempotent: kernel.inbound.receive ignores a messageId the org has already received. The blob must match
// the hash and size the API enqueued; a mismatch is refused like any message no org can receive.
// `attempt` is the job's retry count (0 on the first run).
export async function processInboundEmail(deps: InboundProcessDeps, job: InboundJob, attempt = 0) {
  if (!deps.domain) throw new Error('INBOUND_DOMAIN is not set on the worker');
  const domain = deps.domain;
  const rawSha256 = job.sha256;
  const raw = await deps.store.get(inboundKey(job.blobId));
  if (raw.byteLength !== job.sizeBytes || sha256Hex(raw) !== rawSha256) {
    throw new DomainError('INBOUND_BLOB_MISMATCH', 422, 'Thư lưu không khớp với hàng đợi');
  }
  // A bounce report to a mail's Return-Path (#539): read as a DSN, never filed as an inbound message.
  const bounceToken = job.recipient ? bounceTokenOf(job.recipient, domain) : null;
  if (bounceToken) return processBounceReport(deps, raw, rawSha256, bounceToken, attempt);
  // A message the sandbox finds invalid or too large is dropped like any message no org can receive. A timeout or
  // memory limit can also come from load on the sandbox, so it is retried, but only EXTRACT_LIMIT_RETRIES times:
  // a hostile message must not hold the single parser slot, which every tenant shares, again and again. After
  // that it is dropped too. A sandbox that cannot answer throws ExtractServiceError and is retried as before.
  const parsed = await deps.extract.extract('mime', raw);
  if (!parsed.ok) {
    const limitHit = parsed.code === 'timeout' || parsed.code === 'memory';
    if (limitHit && attempt < EXTRACT_LIMIT_RETRIES) throw new Error(`crove-extract stopped at a limit: ${parsed.code}`);
    throw new DomainError('UNREADABLE_MESSAGE', 422, 'Không đọc được thư');
  }
  const email = parsed.email;
  const recipients = [job.recipient, email.deliveredTo, ...email.to].filter((r): r is string => typeof r === 'string' && r !== '');
  const token = recipients.map((r) => tokenOf(r, domain)).find((t) => t !== null);
  if (!token) throw unknownRecipient();

  // The org is resolved now, when the message is processed, not when the API accepted it. So mail queued for a token
  // that the org rotated away in between is dropped here like mail to a token that never existed (plan §7.6, #113):
  // right for a leaked address, but a supplier's legitimate mail in that window is lost without a bounce. So the drop
  // is counted for the org that owned a retired token (#139): only the count, nothing about the message.
  const orgId = await deps.runtime.orgless(async (db) => {
    const { rows } = await sql<{ org_id: string | null }>`SELECT crove_kernel.org_by_inbound_token(${token}) AS org_id`.execute(db);
    return rows[0]?.org_id ?? null;
  });
  if (!orgId) {
    await countDrop(deps.runtime, token);
    throw unknownRecipient();
  }

  // Over a daily limit of the org (#675) the message is kept, not filed: the worker tries it again once the org is back
  // under it. The check comes before anything is stored for the org.
  if (deps.limits) {
    const actor = { type: 'system' as const, component: 'inbound.email' };
    const { inbound_emails, attachment_bytes } = deps.limits;
    const over = await deps.runtime.query<UsageOver | null>(
      'kernel.usage.over',
      { metrics: ['inbound_emails', 'attachment_bytes'], limits: { inbound_emails, attachment_bytes } },
      { actor, orgId },
    );
    if (over) {
      await deps.runtime.execute('kernel.usage.defer', { metric: over.metric, subjectType: 'inbound_email', subjectId: rawSha256, retryAt: over.retryAt }, { actor, orgId });
      return { deferred: over.retryAt } satisfies InboundDeferred;
    }
  }

  const files = [];
  let archives = 0;
  for (const attachment of email.attachments.slice(0, 20)) {
    const decoded = Buffer.from(attachment.content, 'base64');
    const bytes = new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_UPLOAD_BYTES) continue;
    // Signatures, logos and other attachments that are not invoices are skipped by their content.
    const contentType = sniffType(bytes);
    if (!contentType) continue;
    // A ZIP (#432) is filed like an uploaded one and opened by the extraction job (archive.ts), which files at most
    // MAX_EMAIL_ARCHIVE_DOCUMENTS of its documents; past MAX_EMAIL_ARCHIVES ZIPs the message's others are skipped.
    if (ACCEPTED_ARCHIVE_TYPES.includes(contentType)) {
      if (archives >= MAX_EMAIL_ARCHIVES) continue;
      archives += 1;
    } else if (!ACCEPTED_UPLOAD_TYPES.includes(contentType)) {
      continue;
    }
    const filename = safeFilename(attachment.filename ?? 'tep-dinh-kem', contentType);
    const sha256 = sha256Hex(bytes);
    const storageKey = fileKey(orgId, sha256);
    const generation = await putFile(deps.store, storageKey, bytes, contentType, sha256);
    files.push({ filename, contentType, sizeBytes: bytes.byteLength, sha256, storageKey, generation, source: 'email' as const });
  }
  const messageId = email.messageId ?? `sha256:${rawSha256}`;
  return deps.runtime.execute<{ duplicate: boolean; fileIds: string[] }>(
    'kernel.inbound.receive',
    {
      messageId: messageId.slice(0, 500),
      from: email.from,
      subject: email.subject?.slice(0, 500) ?? null,
      // The mail's text (#779), for an AI draft of a Social post a member may start from it: kept only where the
      // deployment runs Social, so one without it keeps no more of a mail than before; absent from an older extract
      // container's answer.
      text: deps.runtime.modules().includes('social') ? (email.text ?? null) : null,
      files,
    },
    { actor: { type: 'system', component: 'inbound.email' }, orgId },
  );
}

// What a recipient's report does (#539): a permanent failure (status 5.x.x) is a hard bounce; a temporary one, or a
// failure without a status, a soft bounce; a delay is deferred; a delivery report says delivered. "relayed" and
// "expanded" say nothing about the mailbox (RFC 3464 §2.3.3), so they record nothing.
const OUTCOMES: ReadonlySet<string> = new Set(['failed', 'delayed', 'delivered']);
function bounceKind(recipient: { action: string; status: string | null }): 'bounce_hard' | 'bounce_soft' | 'deferred' | 'delivered' {
  if (recipient.action === 'failed') return recipient.status?.startsWith('5.') ? 'bounce_hard' : 'bounce_soft';
  if (recipient.action === 'delayed') return 'deferred';
  return 'delivered';
}

export interface BounceResult {
  duplicate: boolean;
  fileIds: string[];
  bounce: 'bounce_hard' | 'bounce_soft' | 'deferred' | 'delivered';
}

// A DSN for one of Crove's SMTP mails (#539): parsed in the sandbox, matched to its mail by the token of the address
// it came to (a made-up or altered token finds nothing), and recorded as that mail's delivery event in the mail's org.
// A report that is not a DSN, names no mail of Crove, or quotes another Message-ID is dropped.
async function processBounceReport(deps: InboundProcessDeps, raw: Uint8Array, rawSha256: string, token: string, attempt: number): Promise<BounceResult> {
  const parsed = await deps.extract.extract('dsn', raw);
  if (!parsed.ok) {
    const limitHit = parsed.code === 'timeout' || parsed.code === 'memory';
    if (limitHit && attempt < EXTRACT_LIMIT_RETRIES) throw new Error(`crove-extract stopped at a limit: ${parsed.code}`);
    throw new DomainError('UNREADABLE_BOUNCE', 422, 'Không đọc được báo cáo trạng thái gửi thư');
  }
  const mail = await deps.runtime.orgless(async (db) => {
    const { rows } = await sql<{ org_id: string; message_id: string; message_id_header: string }>`
      SELECT org_id, message_id, message_id_header FROM crove_kernel.mail_message_by_bounce_token(${token})`.execute(db);
    return rows[0] ?? null;
  });
  if (!mail) throw new DomainError('UNKNOWN_BOUNCE', 404, 'Báo cáo trạng thái gửi không ứng với thư nào');
  const report = parsed.report;
  // Compared without case: a relay may change the case of the domain, and the token already names exactly one mail.
  if (report.originalMessageId !== null && report.originalMessageId.toLowerCase() !== mail.message_id_header.toLowerCase()) {
    throw new DomainError('BOUNCE_MISMATCH', 422, 'Báo cáo trạng thái gửi nói về một thư khác');
  }
  // The mail had one recipient, so the report's first outcome is about it.
  const recipient = report.recipients.find((r) => OUTCOMES.has(r.action));
  if (!recipient) throw new DomainError('UNREADABLE_BOUNCE', 422, 'Không đọc được báo cáo trạng thái gửi thư');
  const kind = bounceKind(recipient);
  await deps.runtime.execute(
    'kernel.mail.event.record',
    {
      messageId: mail.message_id,
      provider: 'smtp',
      // The report itself: a redelivered report is the same event.
      providerEventId: `dsn:${rawSha256}`,
      kind,
      occurredAt: new Date().toISOString(),
      detail: recipient.status ? { status: recipient.status } : {},
    },
    { actor: { type: 'system', component: 'inbound.bounce' }, orgId: mail.org_id },
  );
  return { duplicate: false, fileIds: [], bounce: kind };
}
