#!/usr/bin/env node
// Client-side encryption of backup runs (issue #351). backup.sh seals every file it copies to the backup bucket with
// BACKUP_ENCRYPTION_KEY, so whoever can read that bucket, and nothing else, cannot read the books; restore.sh opens
// them. Plain Node (22+), no dependencies: the scripts run it inside the stack's own image, so the host needs no Node.
//
//   node seal.mjs key-id                 prints the id of BACKUP_ENCRYPTION_KEY (16 hex characters)
//   node seal.mjs seal <list>            seals each file the list names
//   node seal.mjs open <list>            opens each one
// A list has one line per file, `<from>\t<to>\t<label>`, paths relative to the current directory. The label is bound
// into the sealed file (backup.sh uses `<run id>/<name>` for a run's files and `blobs/<key>` for a blob), so a sealed
// file put in another file's place does not open. `open` takes BACKUP_ENCRYPTION_KEY and, during a key rotation,
// BACKUP_ENCRYPTION_KEY_PREVIOUS; the key id in each file picks the key.
//
// Format, AES-256-GCM in the STREAM construction (Hoang, Reyhanitabar, Rogaway and Vizar, 2015; the one age uses):
//   "CRB1" | key id (8) | salt (16) | chunk 0 | chunk 1 | ... | chunk n-1
// Each chunk seals CHUNK plaintext bytes (the last one 0 to CHUNK) and carries its 16-byte tag. The chunk key is
// HKDF-SHA256(key, salt, "crove.backup.v1|" + label); chunk i's nonce is i as an 11-byte big-endian counter followed by
// 1 on the last chunk and 0 on every other, and the 28-byte header is each chunk's additional data. So a changed,
// reordered, dropped or appended chunk, a file cut short at a chunk boundary, another file's header and another
// label all fail to open, and no plaintext of a file that does not open is ever kept.
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MAGIC = Buffer.from('CRB1');
export const CHUNK = 64 * 1024;
const KEY_ID_BYTES = 8;
const SALT_BYTES = 16;
const TAG_BYTES = 16;
export const HEADER_BYTES = MAGIC.byteLength + KEY_ID_BYTES + SALT_BYTES;

// A 32-byte key as base64 (44 characters) or hex (64 characters), the form of EXPORT_ENCRYPTION_KEY.
export function parseKey(value) {
  const trimmed = value.trim();
  const hex = /^[0-9a-fA-F]{64}$/.test(trimmed);
  const key = hex ? Buffer.from(trimmed, 'hex') : Buffer.from(trimmed, 'base64');
  if (key.byteLength !== 32 || (!hex && key.toString('base64') !== trimmed)) {
    throw new Error('BACKUP_ENCRYPTION_KEY is 32 random bytes as base64 (44 characters) or hex (64 characters), for example `openssl rand -base64 32`');
  }
  return key;
}

export function keyId(key) {
  return createHash('sha256').update('crove.backup.key-id|').update(key).digest().subarray(0, KEY_ID_BYTES);
}

// The size of the sealed form of `plainBytes` bytes: backup.sh checks every sealed object in the bucket against it.
export function sealedSize(plainBytes) {
  const chunks = Math.max(1, Math.ceil(plainBytes / CHUNK));
  return HEADER_BYTES + plainBytes + chunks * TAG_BYTES;
}

function chunkKey(key, salt, label) {
  return Buffer.from(hkdfSync('sha256', key, salt, `crove.backup.v1|${label}`, 32));
}

function nonce(index, last) {
  const n = Buffer.alloc(12);
  n.writeBigUInt64BE(BigInt(index), 3);
  n[11] = last ? 1 : 0;
  return n;
}

function readExactly(fd, length, position) {
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const read = readSync(fd, buffer, done, length - done, position + done);
    if (read === 0) throw new Error('file ended early');
    done += read;
  }
  return buffer;
}

// Writes through a temporary file renamed into place at the end, so `to` holds a whole result or nothing. Creates the
// directories on the way.
function writeAtomically(to, body) {
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
  const temporary = `${to}.part`;
  const fd = openSync(temporary, 'w', 0o600);
  try {
    body((bytes) => writeSync(fd, bytes));
    closeSync(fd);
    renameSync(temporary, to);
  } catch (error) {
    closeSync(fd);
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function sealFile(from, to, label, key) {
  const fd = openSync(from, 'r');
  try {
    const size = fstatSync(fd).size;
    const chunks = Math.max(1, Math.ceil(size / CHUNK));
    const salt = randomBytes(SALT_BYTES);
    const header = Buffer.concat([MAGIC, keyId(key), salt]);
    const subkey = chunkKey(key, salt, label);
    writeAtomically(to, (write) => {
      write(header);
      for (let i = 0; i < chunks; i++) {
        const length = i === chunks - 1 ? size - i * CHUNK : CHUNK;
        const plain = readExactly(fd, length, i * CHUNK);
        const cipher = createCipheriv('aes-256-gcm', subkey, nonce(i, i === chunks - 1));
        cipher.setAAD(header);
        write(Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]));
      }
    });
  } finally {
    closeSync(fd);
  }
}

// `keys` are the keys that may open it (the current one, then previous ones); the file's key id picks one.
export function openFile(from, to, label, keys) {
  const fd = openSync(from, 'r');
  try {
    const size = fstatSync(fd).size;
    if (size < HEADER_BYTES + TAG_BYTES) throw new Error(`${from}: not a sealed backup file (too short)`);
    const header = readExactly(fd, HEADER_BYTES, 0);
    if (!header.subarray(0, MAGIC.byteLength).equals(MAGIC)) throw new Error(`${from}: not a sealed backup file`);
    const id = header.subarray(MAGIC.byteLength, MAGIC.byteLength + KEY_ID_BYTES);
    const key = keys.find((k) => keyId(k).equals(id));
    if (!key) {
      const known = keys.map((k) => keyId(k).toString('hex')).join(', ') || 'none';
      throw new Error(`${from}: sealed with key id ${id.toString('hex')}; the keys given have id ${known} (set BACKUP_ENCRYPTION_KEY or BACKUP_ENCRYPTION_KEY_PREVIOUS)`);
    }
    const subkey = chunkKey(key, header.subarray(MAGIC.byteLength + KEY_ID_BYTES), label);
    const body = size - HEADER_BYTES;
    const sealedChunk = CHUNK + TAG_BYTES;
    const chunks = Math.ceil(body / sealedChunk);
    writeAtomically(to, (write) => {
      for (let i = 0; i < chunks; i++) {
        const length = i === chunks - 1 ? body - i * sealedChunk : sealedChunk;
        if (length < TAG_BYTES) throw new Error(`${from}: does not open (cut short)`);
        const sealed = readExactly(fd, length, HEADER_BYTES + i * sealedChunk);
        const decipher = createDecipheriv('aes-256-gcm', subkey, nonce(i, i === chunks - 1));
        decipher.setAAD(header);
        decipher.setAuthTag(sealed.subarray(length - TAG_BYTES));
        let plain;
        try {
          plain = Buffer.concat([decipher.update(sealed.subarray(0, length - TAG_BYTES)), decipher.final()]);
        } catch {
          throw new Error(`${from}: does not open (altered, cut short, another label or another key)`);
        }
        write(plain);
      }
    });
  } finally {
    closeSync(fd);
  }
}

export function keysFromEnv(env, { previous }) {
  const current = env.BACKUP_ENCRYPTION_KEY ?? '';
  if (!current) throw new Error('BACKUP_ENCRYPTION_KEY is not set');
  const keys = [parseKey(current)];
  const old = env.BACKUP_ENCRYPTION_KEY_PREVIOUS ?? '';
  if (previous && old) keys.push(parseKey(old));
  return keys;
}

export function readList(file) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line, i) => {
      const fields = line.split('\t');
      if (fields.length !== 3 || fields.some((f) => f === '')) throw new Error(`${file} line ${i + 1}: expected <from>\\t<to>\\t<label>`);
      return { from: fields[0], to: fields[1], label: fields[2] };
    });
}

function main(argv, env) {
  const [command, list] = argv;
  if (command === 'key-id') {
    console.log(keyId(keysFromEnv(env, { previous: false })[0]).toString('hex'));
    return;
  }
  if ((command !== 'seal' && command !== 'open') || !list) throw new Error('usage: seal.mjs key-id | seal <list> | open <list>');
  const keys = keysFromEnv(env, { previous: command === 'open' });
  const entries = readList(list);
  for (const { from, to, label } of entries) {
    if (command === 'seal') sealFile(from, to, label, keys[0]);
    else openFile(from, to, label, keys);
  }
  console.log(`[seal] ${command === 'seal' ? 'sealed' : 'opened'} ${entries.length} file(s)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2), process.env);
  } catch (error) {
    console.error(`[seal] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
