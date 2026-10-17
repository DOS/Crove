// RFC 6238 TOTP (SHA-1, 6 digits, 30 s), as authenticator apps compute it for Supabase Auth factors.
import { createHmac } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_MS = 30_000;

function base32(secret: string): Buffer {
  let bits = '';
  for (const char of secret.replace(/=+$/, '').toUpperCase()) {
    const value = ALPHABET.indexOf(char);
    if (value < 0) throw new Error(`not base32: ${char}`);
    bits += value.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function code(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', base32(secret)).update(counter).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  return ((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
}

// Returns a code from a time step after `usedStep` (waiting if needed), so a code is never submitted twice.
export async function nextTotp(secret: string, usedStep = -1): Promise<{ code: string; step: number }> {
  let step = Math.floor(Date.now() / STEP_MS);
  while (step <= usedStep) {
    await new Promise((resolve) => setTimeout(resolve, (step + 1) * STEP_MS - Date.now() + 50));
    step = Math.floor(Date.now() / STEP_MS);
  }
  return { code: code(secret, step), step };
}
