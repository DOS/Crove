// Sealing of org export blobs (issue #212): AES-256-GCM with the deployment key, bound to the org and the part.
import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ExportSealer, exportAad, exportSealer, parseExportKey } from '../src/export-seal.ts';

const encode = (s: string) => new TextEncoder().encode(s);
const decode = (b: Uint8Array) => new TextDecoder().decode(b);

describe('export sealing', () => {
  const org = randomUUID();
  const aad = exportAad(org, { table: 'kernel.party', chunk: 0 });
  const plain = encode('{"name":"Công ty A"}\n');

  it('round-trips, and every seal of the same bytes differs', () => {
    const sealer = new ExportSealer(randomBytes(32));
    const one = sealer.seal(plain, aad);
    const two = sealer.seal(plain, aad);
    expect(Buffer.from(one).equals(Buffer.from(two))).toBe(false);
    expect(decode(one)).not.toContain('Công ty A');
    expect(decode(sealer.open(one, aad, 'aes-256-gcm'))).toBe(decode(plain));
    expect(sealer.encryption).toBe('aes-256-gcm');
  });

  it('refuses another part, another org, a flipped byte, a missing key and a plaintext envelope', () => {
    const sealer = new ExportSealer(randomBytes(32));
    const sealed = sealer.seal(plain, aad);
    expect(() => sealer.open(sealed, exportAad(org, { table: 'kernel.party', chunk: 1 }), 'aes-256-gcm')).toThrow(/authentication/);
    expect(() => sealer.open(sealed, exportAad(randomUUID(), { table: 'kernel.party', chunk: 0 }), 'aes-256-gcm')).toThrow(/authentication/);
    expect(() => sealer.open(sealed, exportAad(org, 'manifest'), 'aes-256-gcm')).toThrow(/authentication/);
    const flipped = new Uint8Array(sealed);
    flipped[30] = (flipped[30] as number) ^ 1;
    expect(() => sealer.open(flipped, aad, 'aes-256-gcm')).toThrow(/authentication/);
    expect(() => new ExportSealer(randomBytes(32)).open(sealed, aad, 'aes-256-gcm')).toThrow(/key this deployment does not have/);
    // A record that says sealed never accepts plaintext, even with valid-looking content.
    const plainEnvelope = new ExportSealer(null).seal(plain, aad);
    expect(() => sealer.open(plainEnvelope, aad, 'aes-256-gcm')).toThrow(/not sealed/);
    expect(() => sealer.open(sealed, aad, 'none')).toThrow(/not a plaintext envelope/);
  });

  it('opens exports sealed with a previous key after a rotation', () => {
    const old = randomBytes(32);
    const sealed = new ExportSealer(old).seal(plain, aad);
    const rotated = new ExportSealer(randomBytes(32), [old]);
    expect(decode(rotated.open(sealed, aad, 'aes-256-gcm'))).toBe(decode(plain));
  });

  it('stores plaintext with a random prefix when no key is set', () => {
    const sealer = new ExportSealer(null);
    const a = sealer.seal(plain, aad);
    expect(Buffer.from(a).equals(Buffer.from(sealer.seal(plain, aad)))).toBe(false);
    expect(decode(sealer.open(a, aad, 'none'))).toBe(decode(plain));
    expect(sealer.encryption).toBe('none');
  });

  it('parses base64 and hex keys and refuses anything else', () => {
    const key = randomBytes(32);
    expect(parseExportKey(key.toString('base64')).equals(key)).toBe(true);
    expect(parseExportKey(key.toString('hex')).equals(key)).toBe(true);
    expect(() => parseExportKey(randomBytes(16).toString('base64'))).toThrow(/32 random bytes/);
    expect(() => parseExportKey('not a key at all, not a key at all, not a k')).toThrow(/32 random bytes/);
    const sealer = exportSealer({ EXPORT_ENCRYPTION_KEY: key.toString('base64'), EXPORT_ENCRYPTION_KEY_PREVIOUS: ` ${randomBytes(32).toString('hex')} ,` });
    expect(sealer.encryption).toBe('aes-256-gcm');
    expect(exportSealer({}).encryption).toBe('none');
  });
});
