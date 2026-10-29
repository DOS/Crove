// Seals third-party credentials (channel tokens) for crove_kernel.credential (ADR-0025 decision 2, plan §7.4).
// Envelope encryption: every secret gets its own random AES-256-GCM data key, and the data key is wrapped with the
// deployment's credential key, which never reaches the database. Both layers authenticate the binding (org,
// provider, account), so an envelope copied to another org's or another account's row does not open.
//
// Envelope v1 (bytes): 0x01 | wrap iv (12) | wrap tag (16) | wrapped data key (32) | iv (12) | tag (16) | ciphertext.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const VERSION = 0x01;
const IV = 12;
const TAG = 16;
const KEY = 32;
const HEADER = 1 + IV + TAG + KEY + IV + TAG;
// Tokens are short; the column allows 64 KiB.
export const MAX_SECRET_BYTES = 32 * 1024;

export interface VaultKey {
  id: string;
  key: Buffer;
}

// What a credential belongs to; authenticated, not encrypted.
export interface CredentialBinding {
  orgId: string;
  provider: string;
  externalAccountId: string;
}

export interface SealedCredential {
  keyId: string;
  envelope: Buffer;
}

export class CredentialError extends Error {
  override name = 'CredentialError';
}

// A key id from the key itself, so the same key always gets the same id and no id has to be configured.
export function vaultKeyId(key: Buffer): string {
  return `k1-${createHash('sha256').update('crove.credential.key-id').update(key).digest('hex').slice(0, 16)}`;
}

// A 32-byte key as 64 hex characters, or as base64 (43 characters plus optional padding, standard or URL alphabet).
export function parseVaultKey(text: string): VaultKey {
  const t = text.trim();
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(t)) key = Buffer.from(t, 'hex');
  else if (/^[A-Za-z0-9+/]{43}=?$/.test(t)) key = Buffer.from(t, 'base64');
  else if (/^[A-Za-z0-9_-]{43}=?$/.test(t)) key = Buffer.from(t, 'base64url');
  else throw new CredentialError('a credential key must be 32 bytes, as base64 or 64 hex characters');
  if (key.length !== KEY) throw new CredentialError('a credential key must be 32 bytes, as base64 or 64 hex characters');
  // A placeholder (all zeros, one repeated byte) is not a key.
  if (key.every((b) => b === key[0])) throw new CredentialError('a credential key must be random: generate one with `openssl rand -base64 32`');
  return { id: vaultKeyId(key), key };
}

export function generateVaultKey(): string {
  return randomBytes(KEY).toString('base64');
}

function aad(binding: CredentialBinding, keyId: string, layer: 'wrap' | 'data'): Buffer {
  for (const part of [binding.orgId, binding.provider, binding.externalAccountId, keyId]) {
    if (part.length === 0 || part.includes('\u0000')) throw new CredentialError('invalid credential binding');
  }
  return Buffer.from(['crove.credential.v1', layer, binding.orgId, binding.provider, binding.externalAccountId, keyId].join('\u0000'), 'utf8');
}

function encrypt(key: Buffer, plaintext: Buffer, additional: Buffer): { iv: Buffer; tag: Buffer; ciphertext: Buffer } {
  const iv = randomBytes(IV);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(additional);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), ciphertext };
}

function decrypt(key: Buffer, iv: Buffer, tag: Buffer, ciphertext: Buffer, additional: Buffer): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG });
  decipher.setAAD(additional);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// The composition root's credential port (ADR-0030, plan §7.4). The API seals tokens in; only provider jobs in the
// worker open them. crove-local is this vault; a Crove Cloud broker can keep the same shape.
export interface CredentialBroker {
  readonly id: string;
  seal(secret: string, binding: CredentialBinding): SealedCredential;
  open(sealed: SealedCredential, binding: CredentialBinding): string;
}

export class CredentialVault implements CredentialBroker {
  readonly id = 'crove-local';

  private readonly keys: ReadonlyMap<string, Buffer>;
  private readonly current: VaultKey;

  // The first key seals; every key opens (the others are previous keys kept during a rotation).
  constructor(keys: readonly VaultKey[]) {
    const [current] = keys;
    if (!current) throw new CredentialError('the credential vault needs a key');
    const map = new Map<string, Buffer>();
    for (const k of keys) {
      if (k.key.length !== KEY) throw new CredentialError('a credential key must be 32 bytes');
      map.set(k.id, k.key);
    }
    this.keys = map;
    this.current = current;
  }

  get keyId(): string {
    return this.current.id;
  }

  // The ids of every key this vault opens, the current one first: an envelope under any other id does not open (#1888).
  get keyIds(): readonly string[] {
    return [...this.keys.keys()];
  }

  seal(secret: string, binding: CredentialBinding): SealedCredential {
    const plaintext = Buffer.from(secret, 'utf8');
    if (plaintext.length === 0 || plaintext.length > MAX_SECRET_BYTES) throw new CredentialError('a credential must be 1 byte to 32 KiB');
    const keyId = this.current.id;
    const dataKey = randomBytes(KEY);
    try {
      const wrapped = encrypt(this.current.key, dataKey, aad(binding, keyId, 'wrap'));
      const sealed = encrypt(dataKey, plaintext, aad(binding, keyId, 'data'));
      const envelope = Buffer.concat([Buffer.from([VERSION]), wrapped.iv, wrapped.tag, wrapped.ciphertext, sealed.iv, sealed.tag, sealed.ciphertext]);
      return { keyId, envelope };
    } finally {
      dataKey.fill(0);
      plaintext.fill(0);
    }
  }

  // Throws CredentialError for an unknown key, a damaged envelope, or a binding the envelope was not sealed for;
  // the message never carries key or secret material.
  open(sealed: SealedCredential, binding: CredentialBinding): string {
    const key = this.keys.get(sealed.keyId);
    if (!key) throw new CredentialError(`credential sealed with an unknown key (${sealed.keyId})`);
    const e = sealed.envelope;
    if (e.length <= HEADER || e[0] !== VERSION) throw new CredentialError('credential envelope is damaged');
    let at = 1;
    const take = (n: number) => e.subarray(at, (at += n));
    const wrapIv = take(IV);
    const wrapTag = take(TAG);
    const wrappedKey = take(KEY);
    const iv = take(IV);
    const tag = take(TAG);
    const ciphertext = e.subarray(at);
    let dataKey: Buffer | null = null;
    try {
      dataKey = decrypt(key, wrapIv, wrapTag, wrappedKey, aad(binding, sealed.keyId, 'wrap'));
      return decrypt(dataKey, iv, tag, ciphertext, aad(binding, sealed.keyId, 'data')).toString('utf8');
    } catch (error) {
      if (error instanceof CredentialError) throw error;
      throw new CredentialError('credential does not open: damaged, or sealed for another org, provider or account');
    } finally {
      dataKey?.fill(0);
    }
  }

  // Whether an envelope was sealed with a key other than the current one (rotation: reseal it).
  needsReseal(sealed: SealedCredential): boolean {
    return sealed.keyId !== this.current.id;
  }
}
