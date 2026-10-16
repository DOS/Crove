// Sealing of org export blobs at rest (issue #212, plan §7.9: exports are encrypted and expire after 35 to 90 days).
//
// Why in the application and not only bucket SSE: an export is the whole org in one place, and it lives on local disk
// too, where there is no SSE. AES-256-GCM with a deployment key (EXPORT_ENCRYPTION_KEY) protects it the same way on
// every store, against anyone who can read the bucket or the volume but not the kernel's configuration. Bucket SSE can
// still be on underneath. Deleting a key (after every export it sealed expired) makes leftover copies unreadable,
// including noncurrent object versions on a versioned bucket, which Crove cannot delete itself.
//
// Envelope, either form:
//   "CRX1" | key id (8) | IV (12) | AES-256-GCM ciphertext | tag (16)   with a key
//   "CRX0" | random (16) | plaintext                                   without a key (local deployments only)
// Both start with fresh random bytes, so two exports never store the same bytes under the same content address: a new
// export never dedupes onto an older blob that the retention job would delete first. The additional authenticated
// data binds a sealed blob to its org and its place in the export (table and chunk, or the manifest), so a blob cannot
// be swapped for another org's or another part's. The record pins every blob's sha256 as well.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const MAGIC_SEALED = Buffer.from('CRX1');
const MAGIC_PLAIN = Buffer.from('CRX0');
const KEY_ID_BYTES = 8;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const NONCE_BYTES = 16;

export class ExportSealError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportSealError';
  }
}

// A 32-byte key given as base64 (44 characters) or hex (64 characters).
export function parseExportKey(value: string): Buffer {
  const trimmed = value.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(trimmed) ? Buffer.from(trimmed, 'hex') : Buffer.from(trimmed, 'base64');
  if (key.byteLength !== 32 || (!/^[0-9a-fA-F]{64}$/.test(trimmed) && key.toString('base64') !== trimmed)) {
    throw new Error('an export key is 32 random bytes as base64 (44 characters) or hex (64 characters)');
  }
  return key;
}

function keyId(key: Buffer): Buffer {
  return createHash('sha256').update('crove.org-export.key-id|').update(key).digest().subarray(0, KEY_ID_BYTES);
}

// Where in an export a blob belongs: the additional authenticated data.
export function exportAad(orgId: string, part: { table: string; chunk: number } | 'manifest'): Buffer {
  return Buffer.from(`crove.org-export.v2|${orgId}|${part === 'manifest' ? 'manifest' : `${part.table}#${part.chunk}`}`);
}

export class ExportSealer {
  private readonly current: { id: Buffer; key: Buffer } | null;
  private readonly keys: Array<{ id: Buffer; key: Buffer }>;

  // current seals new exports (null: stored as plaintext, local deployments only); previous keys only open older
  // exports, for a rotation: keep the old key as previous until its last export expired.
  constructor(current: Buffer | null, previous: readonly Buffer[] = []) {
    this.current = current ? { id: keyId(current), key: current } : null;
    this.keys = [...(current ? [current] : []), ...previous].map((key) => ({ id: keyId(key), key }));
  }

  get encryption(): 'aes-256-gcm' | 'none' {
    return this.current ? 'aes-256-gcm' : 'none';
  }

  seal(plain: Uint8Array, aad: Buffer): Uint8Array {
    if (!this.current) return Buffer.concat([MAGIC_PLAIN, randomBytes(NONCE_BYTES), plain]);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.current.key, iv);
    cipher.setAAD(aad);
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([MAGIC_SEALED, this.current.id, iv, body, cipher.getAuthTag()]);
  }

  // `encryption` is what the export's record says: a record of a sealed export never accepts a plaintext envelope.
  open(sealed: Uint8Array, aad: Buffer, encryption: 'aes-256-gcm' | 'none'): Uint8Array {
    const bytes = Buffer.from(sealed.buffer, sealed.byteOffset, sealed.byteLength);
    const magic = bytes.subarray(0, 4);
    if (encryption === 'none') {
      if (!magic.equals(MAGIC_PLAIN) || bytes.byteLength < 4 + NONCE_BYTES) throw new ExportSealError('export blob is not a plaintext envelope');
      return bytes.subarray(4 + NONCE_BYTES);
    }
    if (!magic.equals(MAGIC_SEALED) || bytes.byteLength < 4 + KEY_ID_BYTES + IV_BYTES + TAG_BYTES) {
      throw new ExportSealError('export blob is not sealed');
    }
    const id = bytes.subarray(4, 4 + KEY_ID_BYTES);
    const entry = this.keys.find((k) => k.id.equals(id));
    if (!entry) throw new ExportSealError('export blob was sealed with a key this deployment does not have');
    const iv = bytes.subarray(4 + KEY_ID_BYTES, 4 + KEY_ID_BYTES + IV_BYTES);
    const tag = bytes.subarray(bytes.byteLength - TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', entry.key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([decipher.update(bytes.subarray(4 + KEY_ID_BYTES + IV_BYTES, bytes.byteLength - TAG_BYTES)), decipher.final()]);
    } catch {
      throw new ExportSealError('export blob failed authentication');
    }
  }
}

// The sealer a deployment's configuration describes.
export function exportSealer(config: { EXPORT_ENCRYPTION_KEY?: string | undefined; EXPORT_ENCRYPTION_KEY_PREVIOUS?: string | undefined }): ExportSealer {
  const current = config.EXPORT_ENCRYPTION_KEY ? parseExportKey(config.EXPORT_ENCRYPTION_KEY) : null;
  const previous = (config.EXPORT_ENCRYPTION_KEY_PREVIOUS ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
    .map(parseExportKey);
  return new ExportSealer(current, previous);
}
