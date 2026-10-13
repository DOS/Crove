// Inbound email: a mail worker (e.g. Cloudflare Email Routing) POSTs the raw MIME message to
// /api/inbound/email with a shared secret. The recipient <token>@INBOUND_DOMAIN selects the org.
import { timingSafeEqual } from 'node:crypto';
import PostalMime from 'postal-mime';
import { sql } from 'kysely';
import { ACCEPTED_UPLOAD_TYPES, MAX_UPLOAD_BYTES } from '@crove/kernel-contract';
import { DomainError, fileKey, sha256Hex, type BlobStore, type Runtime } from '@crove/kernel-runtime';
import { safeFilename, sniffType } from './sniff.ts';

export const MAX_EMAIL_BYTES = 40 * 1024 * 1024;

export function secretMatches(header: string | undefined, secret: string): boolean {
  const presented = header?.startsWith('Bearer ') ? header.slice(7) : '';
  const a = Buffer.from(presented);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}


export interface InboundDeps {
  runtime: Runtime;
  store: BlobStore;
  domain: string;
}

export async function handleInboundEmail(deps: InboundDeps, raw: Uint8Array, envelopeRecipient: string | null) {
  const email = await PostalMime.parse(raw);
  const recipients = [envelopeRecipient, email.deliveredTo, ...(email.to ?? []).map((a) => ('address' in a ? a.address : undefined))]
    .filter((r): r is string => typeof r === 'string')
    .map((r) => r.toLowerCase().trim());
  const suffix = `@${deps.domain.toLowerCase()}`;
  const token = recipients.find((r) => r.endsWith(suffix))?.slice(0, -suffix.length).split('+')[0];
  if (!token || !/^[0-9a-f]{24}$/.test(token)) throw new DomainError('UNKNOWN_RECIPIENT', 404, 'Địa chỉ nhận không hợp lệ');

  const orgId = await deps.runtime.orgless(async (db) => {
    const { rows } = await sql<{ org_id: string | null }>`SELECT crove_kernel.org_by_inbound_token(${token}) AS org_id`.execute(db);
    return rows[0]?.org_id ?? null;
  });
  if (!orgId) throw new DomainError('UNKNOWN_RECIPIENT', 404, 'Địa chỉ nhận không hợp lệ');

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
  const messageId = email.messageId ?? `sha256:${sha256Hex(raw)}`;
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
