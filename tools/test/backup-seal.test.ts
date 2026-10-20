import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CHUNK, HEADER_BYTES, keyId, keysFromEnv, openFile, parseKey, readList, sealFile, sealedSize } from '../backup/seal.mjs';

const dir = mkdtempSync(join(tmpdir(), 'crove-seal-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const key = randomBytes(32);
const other = randomBytes(32);
let n = 0;
const path = (name: string) => join(dir, `${n++}-${name}`);

function roundTrip(plain: Buffer, label = 'run/db.dump') {
  const from = path('plain');
  const sealed = path('sealed');
  const back = path('back');
  writeFileSync(from, plain);
  sealFile(from, sealed, label, key);
  openFile(sealed, back, label, [key]);
  return { sealed, back };
}

describe('backup sealing (seal.mjs)', () => {
  it('round-trips empty, small, chunk-sized and multi-chunk files, and predicts the sealed size', () => {
    for (const size of [0, 1, CHUNK - 1, CHUNK, CHUNK + 1, 3 * CHUNK + 17]) {
      const plain = randomBytes(size);
      const { sealed, back } = roundTrip(plain);
      expect(readFileSync(back).equals(plain)).toBe(true);
      expect(statSync(sealed).size).toBe(sealedSize(size));
    }
  });

  it('starts with the magic and the key id, and never stores the plaintext', () => {
    const plain = Buffer.from('Công ty Diễn tập, sổ nhật ký 2026 '.repeat(100));
    const { sealed } = roundTrip(plain);
    const bytes = readFileSync(sealed);
    expect(bytes.subarray(0, 4).toString()).toBe('CRB1');
    expect(bytes.subarray(4, 12).equals(keyId(key))).toBe(true);
    expect(bytes.includes(Buffer.from('nhật ký'))).toBe(false);
  });

  it('refuses a flipped bit, a cut at a chunk boundary, an appended chunk, a swapped chunk and another label', () => {
    const plain = randomBytes(2 * CHUNK + 100);
    const { sealed } = roundTrip(plain, 'run/20261020T020000Z/db.dump');
    const bytes = readFileSync(sealed);
    const sealedChunk = CHUNK + 16;
    const variants: Record<string, Buffer> = {
      flipped: Buffer.from(bytes).fill(bytes[HEADER_BYTES + 5]! ^ 1, HEADER_BYTES + 5, HEADER_BYTES + 6),
      cut: bytes.subarray(0, HEADER_BYTES + 2 * sealedChunk),
      appended: Buffer.concat([bytes, bytes.subarray(HEADER_BYTES, HEADER_BYTES + sealedChunk)]),
      swapped: Buffer.concat([
        bytes.subarray(0, HEADER_BYTES),
        bytes.subarray(HEADER_BYTES + sealedChunk, HEADER_BYTES + 2 * sealedChunk),
        bytes.subarray(HEADER_BYTES, HEADER_BYTES + sealedChunk),
        bytes.subarray(HEADER_BYTES + 2 * sealedChunk),
      ]),
      'odd tail': bytes.subarray(0, bytes.byteLength - 10),
    };
    for (const [name, variant] of Object.entries(variants)) {
      const from = path(name);
      const to = path(`${name}-out`);
      writeFileSync(from, variant);
      expect(() => openFile(from, to, 'run/20261020T020000Z/db.dump', [key]), name).toThrow(/does not open|ended early/);
      expect(existsSync(to), `${name}: nothing written`).toBe(false);
      expect(existsSync(`${to}.part`), `${name}: no partial file left`).toBe(false);
    }
    const to = path('label-out');
    expect(() => openFile(sealed, to, 'run/20261021T020000Z/db.dump', [key])).toThrow(/does not open/);
    expect(existsSync(to)).toBe(false);
  });

  it('picks the key by its id, opens with a previous key, and names the ids when none fits', () => {
    const from = path('plain');
    const sealed = path('sealed');
    writeFileSync(from, 'books');
    sealFile(from, sealed, 'blobs/org/x/y', other);
    const back = path('back');
    openFile(sealed, back, 'blobs/org/x/y', [key, other]);
    expect(readFileSync(back, 'utf8')).toBe('books');
    expect(() => openFile(sealed, path('none'), 'blobs/org/x/y', [key])).toThrow(new RegExp(`sealed with key id ${keyId(other).toString('hex')}`));
  });

  it('refuses a file that is not sealed', () => {
    const from = path('plain');
    writeFileSync(from, randomBytes(100));
    expect(() => openFile(from, path('out'), 'x', [key])).toThrow(/not a sealed backup file/);
  });

  it('accepts a key as base64 or hex and refuses anything else', () => {
    expect(parseKey(key.toString('base64')).equals(key)).toBe(true);
    expect(parseKey(key.toString('hex')).equals(key)).toBe(true);
    expect(() => parseKey('change-me')).toThrow(/32 random bytes/);
    expect(() => parseKey(randomBytes(16).toString('base64'))).toThrow(/32 random bytes/);
    expect(() => keysFromEnv({}, { previous: false })).toThrow(/not set/);
    const env = { BACKUP_ENCRYPTION_KEY: key.toString('base64'), BACKUP_ENCRYPTION_KEY_PREVIOUS: other.toString('hex') };
    expect(keysFromEnv(env, { previous: false })).toHaveLength(1);
    expect(keysFromEnv(env, { previous: true })).toHaveLength(2);
  });

  it('reads a list of from, to and label', () => {
    const list = path('list');
    writeFileSync(list, 'a\tb\trun/x/a\nc\td\tblobs/org/o/s\n');
    expect(readList(list)).toEqual([
      { from: 'a', to: 'b', label: 'run/x/a' },
      { from: 'c', to: 'd', label: 'blobs/org/o/s' },
    ]);
    writeFileSync(list, 'a\tb\n');
    expect(() => readList(list)).toThrow(/line 1/);
    // Written on Windows: the \r ends the line, not the label.
    writeFileSync(list, 'a\tb\trun/x/a\r\nc\td\tblobs/org/o/s\r\n');
    expect(readList(list)).toEqual([
      { from: 'a', to: 'b', label: 'run/x/a' },
      { from: 'c', to: 'd', label: 'blobs/org/o/s' },
    ]);
  });
});
