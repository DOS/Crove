// Credential vault (ADR-0025 decision 2): envelope sealing bound to org, provider and account; rotation; tampering.
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CredentialError, CredentialVault, generateVaultKey, parseVaultKey, vaultKeyId, type CredentialBinding } from '../src/index.ts';

const binding: CredentialBinding = { orgId: '0192e1a0-0000-7000-8000-000000000001', provider: 'facebook_page', externalAccountId: '1234567890' };
const key = () => parseVaultKey(randomBytes(32).toString('base64'));

describe('parseVaultKey', () => {
  it('reads base64, base64url and hex, and names the key by its content', () => {
    const raw = randomBytes(32);
    const ids = [raw.toString('base64'), raw.toString('base64url'), raw.toString('hex')].map((t) => parseVaultKey(t).id);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toBe(vaultKeyId(raw));
    expect(ids[0]).toMatch(/^k1-[0-9a-f]{16}$/);
    expect(parseVaultKey(generateVaultKey()).key).toHaveLength(32);
  });

  it('refuses a placeholder key', () => {
    for (const weak of [Buffer.alloc(32, 0), Buffer.alloc(32, 7)]) {
      expect(() => parseVaultKey(weak.toString('base64'))).toThrow(/random/);
      expect(() => parseVaultKey(weak.toString('hex'))).toThrow(/random/);
    }
  });

  it('refuses a key of the wrong size or format', () => {
    for (const bad of ['', 'short', randomBytes(16).toString('base64'), randomBytes(31).toString('hex'), `${randomBytes(32).toString('hex')}00`]) {
      expect(() => parseVaultKey(bad)).toThrow(CredentialError);
    }
  });
});

describe('CredentialVault', () => {
  it('opens what it sealed, and never stores the secret in clear', () => {
    const vault = new CredentialVault([key()]);
    const secret = JSON.stringify({ accessToken: 'EAAG-secret-token', refreshToken: 'r-secret' });
    const sealed = vault.seal(secret, binding);
    expect(sealed.keyId).toBe(vault.keyId);
    expect(sealed.envelope.includes(Buffer.from('secret'))).toBe(false);
    expect(vault.open(sealed, binding)).toBe(secret);
  });

  it('seals the same secret differently every time', () => {
    const vault = new CredentialVault([key()]);
    expect(vault.seal('same', binding).envelope.equals(vault.seal('same', binding).envelope)).toBe(false);
  });

  it('does not open for another org, provider or account', () => {
    const vault = new CredentialVault([key()]);
    const sealed = vault.seal('token', binding);
    for (const other of [{ orgId: '0192e1a0-0000-7000-8000-000000000002' }, { provider: 'instagram' }, { externalAccountId: '999' }]) {
      expect(() => vault.open(sealed, { ...binding, ...other })).toThrow(/does not open/);
    }
  });

  it('detects any changed byte', () => {
    const vault = new CredentialVault([key()]);
    const sealed = vault.seal('token', binding);
    for (let i = 1; i < sealed.envelope.length; i++) {
      const damaged = Buffer.from(sealed.envelope);
      damaged[i] = (damaged[i] ?? 0) ^ 0x01;
      expect(() => vault.open({ keyId: sealed.keyId, envelope: damaged }, binding), `byte ${i}`).toThrow(CredentialError);
    }
    expect(() => vault.open({ keyId: sealed.keyId, envelope: sealed.envelope.subarray(0, 60) }, binding)).toThrow(/damaged/);
    const wrongVersion = Buffer.from(sealed.envelope);
    wrongVersion[0] = 2;
    expect(() => vault.open({ keyId: sealed.keyId, envelope: wrongVersion }, binding)).toThrow(/damaged/);
  });

  it('opens with a previous key during a rotation, seals with the new one, and says what to reseal', () => {
    const oldKey = key();
    const newKey = key();
    const before = new CredentialVault([oldKey]);
    const sealed = before.seal('token', binding);
    const during = new CredentialVault([newKey, oldKey]);
    expect(during.open(sealed, binding)).toBe('token');
    expect(during.needsReseal(sealed)).toBe(true);
    const resealed = during.seal('token', binding);
    expect(resealed.keyId).toBe(newKey.id);
    expect(during.needsReseal(resealed)).toBe(false);
    const after = new CredentialVault([newKey]);
    expect(() => after.open(sealed, binding)).toThrow(/unknown key/);
    // The ids it opens, the current one first (#1888): an envelope under any other id does not open.
    expect(during.keyIds).toEqual([newKey.id, oldKey.id]);
    expect(after.keyIds).toEqual([newKey.id]);
    expect(new CredentialVault([newKey, newKey]).keyIds).toEqual([newKey.id]);
    // A key id that names a key but not this envelope's key does not open either.
    expect(() => during.open({ keyId: newKey.id, envelope: sealed.envelope }, binding)).toThrow(/does not open/);
  });

  it('refuses empty or oversized secrets and bindings with empty or NUL parts', () => {
    const vault = new CredentialVault([key()]);
    expect(() => vault.seal('', binding)).toThrow(CredentialError);
    expect(() => vault.seal('x'.repeat(32 * 1024 + 1), binding)).toThrow(CredentialError);
    expect(() => vault.seal('t', { ...binding, externalAccountId: '' })).toThrow(/binding/);
    expect(() => vault.seal('t', { ...binding, provider: 'a\u0000b' })).toThrow(/binding/);
    expect(() => new CredentialVault([])).toThrow(CredentialError);
  });

  it('keeps key and secret material out of error messages', () => {
    const k = key();
    const vault = new CredentialVault([k]);
    const sealed = vault.seal('super-secret-token', binding);
    try {
      vault.open(sealed, { ...binding, provider: 'x' });
    } catch (error) {
      const message = String((error as Error).message);
      expect(message).not.toContain('super-secret-token');
      expect(message).not.toContain(k.key.toString('base64'));
    }
  });
});
