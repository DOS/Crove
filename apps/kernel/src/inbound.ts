// Inbound email: a mail worker (e.g. Cloudflare Email Routing) POSTs the raw MIME message to
// /api/inbound/email with a shared secret. The recipient <token>@INBOUND_DOMAIN selects the org.
//
// The API only verifies the secret, limits the size, stores the raw bytes and enqueues them
// (acceptInboundEmail). Parsing, resolving the org and kernel.inbound.receive run in the worker
// (processInboundEmail), the only role that may enter system context (External-tenant gate T5).
import { timingSafeEqual } from 'node:crypto';
import PostalMime from 'postal-mime';
import { sql } from 'kysely';
import { ACCEPTED_UPLOAD_TYPES, MAX_UPLOAD_BYTES } from '@crove/kernel-contract';
import { DomainError, fileKey, inboundKey, newInboundBlobId, sha256Hex, type BlobStore, type Runtime } from '@crove/kernel-runtime';
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
    if (recipient.length > MAX_ADDRESS_LENGTH || (onDomain && !tokenOf(recipient, deps.domain))) throw unknownRecipient();
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
}

// Worker side: parses the stored message, resolves the org by token and records it in system context.
// Idempotent: kernel.inbound.receive ignores a messageId the org has already received. The blob must match
// the hash and size the API enqueued; a mismatch is refused like any message no org can receive.
export async function processInboundEmail(deps: InboundProcessDeps, job: InboundJob) {
  if (!deps.domain) throw new Error('INBOUND_DOMAIN is not set on the worker');
  const domain = deps.domain;
  const rawSha256 = job.sha256;
  const raw = await deps.store.get(inboundKey(job.blobId));
  if (raw.byteLength !== job.sizeBytes || sha256Hex(raw) !== rawSha256) {
    throw new DomainError('INBOUND_BLOB_MISMATCH', 422, 'Thư lưu không khớp với hàng đợi');
  }
  const email = await PostalMime.parse(raw);
  const recipients = [job.recipient, email.deliveredTo, ...(email.to ?? []).map((a) => ('address' in a ? a.address : undefined))].filter(
    (r): r is string => typeof r === 'string' && r !== '',
  );
  const token = recipients.map((r) => tokenOf(r, domain)).find((t) => t !== null);
  if (!token) throw unknownRecipient();

  const orgId = await deps.runtime.orgless(async (db) => {
    const { rows } = await sql<{ org_id: string | null }>`SELECT crove_kernel.org_by_inbound_token(${token}) AS org_id`.execute(db);
    return rows[0]?.org_id ?? null;
  });
  if (!orgId) throw unknownRecipient();

  const files = [];
  for (const attachment of (email.attachments ?? []).slice(0, 20)) {
    const content = attachment.content;
    const bytes =
      typeof content === 'string' ? new TextEncoder().encode(content) : content instanceof Uint8Array ? content : new Uint8Array(content);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_UPLOAD_BYTES) continue;
    // Signatures, logos and other attachments that are not invoices are skipped by their content.
    const contentType = sniffType(bytes);
    if (!contentType || !ACCEPTED_UPLOAD_TYPES.includes(contentType)) continue;
    const filename = safeFilename(attachment.filename ?? 'tep-dinh-kem', contentType);
    const sha256 = sha256Hex(bytes);
    const storageKey = fileKey(orgId, sha256);
    await deps.store.put(storageKey, bytes, contentType);
    files.push({ filename, contentType, sizeBytes: bytes.byteLength, sha256, storageKey, source: 'email' as const });
  }
  const messageId = email.messageId ?? `sha256:${rawSha256}`;
  return deps.runtime.execute<{ duplicate: boolean; fileIds: string[] }>(
    'kernel.inbound.receive',
    {
      messageId: messageId.slice(0, 500),
      from: email.from && 'address' in email.from ? (email.from.address ?? null) : null,
      subject: email.subject?.slice(0, 500) ?? null,
      files,
    },
    { actor: { type: 'system', component: 'inbound.email' }, orgId },
  );
}
