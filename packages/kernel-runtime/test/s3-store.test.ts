import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Socket } from 'node:net';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  GetObjectLockConfigurationCommand,
  GetObjectRetentionCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  PutObjectRetentionCommand,
} from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import {
  BlobConflictError,
  BlobIntegrityError,
  BlobNotFoundError,
  BlobStoreAccessError,
  BlobStoreVersioningError,
  BlobTooLargeError,
  DOWNLOAD_TTL_SECONDS,
  S3BlobStore,
  UPLOAD_TTL_SECONDS,
  archiveKey,
  createS3Client,
  fileKey,
  inboundKey,
  newInboundBlobId,
  newStagingKey,
  readVerified,
  sha256Hex,
  type S3BlobStoreOptions,
  type S3Sender,
} from '../src/index.ts';

type Command =
  | PutObjectCommand
  | GetObjectCommand
  | DeleteObjectCommand
  | ListObjectsV2Command
  | PutObjectRetentionCommand
  | GetObjectRetentionCommand
  | GetObjectLockConfigurationCommand;

// An S3 failure the way the SDK reports it: a named error with the HTTP status in $metadata.
function s3Error(name: string, status: number): Error {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
}

// A response body the way the SDK hands it out: whole, or as a web stream of the given chunks.
const body = (bytes: Uint8Array, chunks: Uint8Array[] = [bytes]) => ({
  transformToByteArray: async () => bytes,
  transformToWebStream: () =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
});

// A fake client: each command goes to `answer`, and every command is recorded.
function fakeStore(answer: (command: Command) => unknown, options: S3BlobStoreOptions = {}) {
  const sent: Command[] = [];
  const client = {
    send: async (command: Command) => {
      sent.push(command);
      return answer(command);
    },
  } as unknown as S3Sender;
  return { store: new S3BlobStore(client, 'crove-files', options), sent };
}

const orgId = randomUUID();
const bytes = new TextEncoder().encode('<HDon>evidence</HDon>');
const sha256 = sha256Hex(bytes);
const key = fileKey(orgId, sha256);
const checksum = createHash('sha256').update(bytes).digest('base64');

describe('evidence holds with a mocked client (#1009)', () => {
  const until = new Date('2036-10-20T00:00:00Z');
  const ref = { key, generation: 's3:v1', sha256 };

  it('holds the recorded version in GOVERNANCE mode when it has no retention yet', async () => {
    const { store, sent } = fakeStore((c) => {
      if (c instanceof GetObjectRetentionCommand) throw s3Error('NoSuchObjectLockConfiguration', 404);
      return {};
    });
    await expect(store.holds.hold(ref, until)).resolves.toEqual(until);
    expect(sent.map((c) => c.constructor.name)).toEqual(['GetObjectRetentionCommand', 'PutObjectRetentionCommand']);
    expect(sent[0]?.input).toEqual({ Bucket: 'crove-files', Key: key, VersionId: 'v1' });
    expect(sent[1]?.input).toEqual({ Bucket: 'crove-files', Key: key, VersionId: 'v1', Retention: { Mode: 'GOVERNANCE', RetainUntilDate: until } });
  });

  it('keeps a retention at least as long, and lengthens a shorter one without weakening COMPLIANCE', async () => {
    const longer = new Date('2040-01-01T00:00:00Z');
    const kept = fakeStore(() => ({ Retention: { Mode: 'GOVERNANCE', RetainUntilDate: longer } }));
    await expect(kept.store.holds.hold(ref, until)).resolves.toEqual(longer);
    expect(kept.sent.map((c) => c.constructor.name)).toEqual(['GetObjectRetentionCommand']);
    const compliance = fakeStore((c) => (c instanceof GetObjectRetentionCommand ? { Retention: { Mode: 'COMPLIANCE', RetainUntilDate: new Date('2030-01-01T00:00:00Z') } } : {}));
    await expect(compliance.store.holds.hold(ref, until)).resolves.toEqual(until);
    expect(compliance.sent[1]?.input).toMatchObject({ VersionId: 'v1', Retention: { Mode: 'COMPLIANCE', RetainUntilDate: until } });
  });

  it('holds the current version of a reference without one only when its bytes match', async () => {
    const legacy = fakeStore((c) => {
      if (c instanceof GetObjectCommand) return { Body: body(bytes), VersionId: 'v-current' };
      if (c instanceof GetObjectRetentionCommand) throw s3Error('NoSuchObjectLockConfiguration', 404);
      return {};
    });
    await legacy.store.holds.hold({ key, generation: null, sha256 }, until);
    expect(legacy.sent.map((c) => c.constructor.name)).toEqual(['GetObjectCommand', 'GetObjectRetentionCommand', 'PutObjectRetentionCommand']);
    expect(legacy.sent[2]?.input).toMatchObject({ VersionId: 'v-current' });
    const swapped = fakeStore(() => ({ Body: body(new TextEncoder().encode('swapped')), VersionId: 'v-current' }));
    await expect(swapped.store.holds.hold({ key, generation: `content:${sha256}`, sha256 }, until)).rejects.toBeInstanceOf(BlobIntegrityError);
    expect(swapped.sent.map((c) => c.constructor.name)).toEqual(['GetObjectCommand']);
  });

  it('reports a missing version as a missing blob, and holds nothing but org/ keys', async () => {
    const gone = fakeStore((c) => {
      if (c instanceof GetObjectRetentionCommand) throw s3Error('NoSuchObjectLockConfiguration', 404);
      throw s3Error('NoSuchVersion', 404);
    });
    await expect(gone.store.holds.hold(ref, until)).rejects.toBeInstanceOf(BlobNotFoundError);
    const { store, sent } = fakeStore(() => ({}));
    await expect(store.holds.hold({ key: archiveKey(orgId, 2025, sha256), generation: 's3:v1', sha256 }, until)).rejects.toThrow(/only evidence files/);
    await expect(store.holds.hold({ key: 'org/../x', generation: 's3:v1', sha256 }, until)).rejects.toThrow(/invalid storage key/);
    expect(sent).toEqual([]);
  });

  it('is available only on a bucket with Object Lock, never on GCS', async () => {
    const on = fakeStore(() => ({ ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled' } }));
    await expect(on.store.holds.available()).resolves.toBe(true);
    expect(on.sent[0]).toBeInstanceOf(GetObjectLockConfigurationCommand);
    expect(on.sent[0]?.input).toEqual({ Bucket: 'crove-files' });
    await expect(fakeStore(() => ({ ObjectLockConfiguration: {} })).store.holds.available()).resolves.toBe(false);
    const off = fakeStore(() => {
      throw s3Error('ObjectLockConfigurationNotFoundError', 404);
    });
    await expect(off.store.holds.available()).resolves.toBe(false);
    // A missing bucket or a refused call is a configuration error, not "no Object Lock".
    const missing = fakeStore(() => {
      throw s3Error('NoSuchBucket', 404);
    });
    await expect(missing.store.holds.available()).rejects.toThrow(/NoSuchBucket/);
    const denied = fakeStore(() => {
      throw s3Error('AccessDenied', 403);
    });
    await expect(denied.store.holds.available()).rejects.toThrow(/AccessDenied/);
    const gcs = fakeStore(() => ({ ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled' } }), { flavor: 'gcs' });
    await expect(gcs.store.holds.available()).resolves.toBe(false);
    expect(gcs.sent).toEqual([]);
  });
});

describe('S3BlobStore with a mocked client', () => {
  it('writes create-only, with the content type and the sha256 the server verifies', async () => {
    const { store, sent } = fakeStore(() => ({ ChecksumSHA256: checksum, VersionId: 'v1' }));
    // The version the bucket created is the generation the file row records (ADR-0013).
    await expect(store.put(key, bytes, 'application/xml')).resolves.toBe('s3:v1');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBeInstanceOf(PutObjectCommand);
    expect(sent[0]?.input).toMatchObject({
      Bucket: 'crove-files',
      Key: key,
      Body: bytes,
      ContentType: 'application/xml',
      ContentLength: bytes.byteLength,
      ChecksumSHA256: checksum,
      IfNoneMatch: '*',
    });
  });

  it('refuses bad keys and org keys that do not name the sha256 of their bytes, before any request', async () => {
    const { store, sent } = fakeStore(() => ({}));
    await expect(store.put('inbound/../escape', bytes, 'text/plain')).rejects.toThrow(/invalid storage key/);
    await expect(store.put(`org/${orgId}/../../etc`, bytes, 'text/plain')).rejects.toThrow(/invalid storage key/);
    await expect(store.put(fileKey(orgId, sha256Hex('other')), bytes, 'application/xml')).rejects.toThrow(/does not match/);
    await expect(store.get('org/x/y')).rejects.toThrow(/invalid storage key/);
    await expect(store.delete('../x')).rejects.toThrow(/invalid storage key/);
    expect(sent).toEqual([]);
  });

  it('locks the parts of a year archive package until their retention ends, and nothing else (#922)', async () => {
    const now = new Date('2026-10-21T00:00:00Z');
    const { store, sent } = fakeStore(() => ({ ChecksumSHA256: checksum, VersionId: 'v1' }), {
      archiveLock: { mode: 'COMPLIANCE', retentionDays: 3653 },
      now: () => now,
    });
    await store.put(archiveKey(orgId, 2025, sha256), bytes, 'application/xml');
    expect(sent[0]?.input).toMatchObject({ ObjectLockMode: 'COMPLIANCE', ObjectLockRetainUntilDate: new Date('2036-10-21T00:00:00Z') });
    await store.put(key, bytes, 'application/xml');
    expect(sent[1]?.input).not.toHaveProperty('ObjectLockMode');
    expect(sent[1]?.input).not.toHaveProperty('ObjectLockRetainUntilDate');
    // Without archiveLock the bucket's default retention applies: no lock header.
    const plain = fakeStore(() => ({ ChecksumSHA256: checksum, VersionId: 'v1' }));
    await plain.store.put(archiveKey(orgId, 2025, sha256), bytes, 'application/xml');
    expect(plain.sent[0]?.input).not.toHaveProperty('ObjectLockMode');
  });

  it('locks an existing archive part that has a shorter retention, or none, and keeps a longer one', async () => {
    const now = new Date('2026-10-21T00:00:00Z');
    const until = new Date('2036-10-21T00:00:00Z');
    const existing = (retainUntil?: Date) =>
      fakeStore(
        (c) => {
          if (c instanceof PutObjectCommand) throw s3Error('PreconditionFailed', 412);
          if (c instanceof GetObjectCommand) return { Body: body(bytes), VersionId: 'v-old', ObjectLockRetainUntilDate: retainUntil };
          return {};
        },
        { archiveLock: { mode: 'COMPLIANCE', retentionDays: 3653 }, now: () => now },
      );
    const unlocked = existing();
    await expect(unlocked.store.put(archiveKey(orgId, 2025, sha256), bytes, 'application/xml')).resolves.toBe('s3:v-old');
    expect(unlocked.sent.map((c) => c.constructor.name)).toEqual(['PutObjectCommand', 'GetObjectCommand', 'PutObjectRetentionCommand']);
    expect(unlocked.sent[2]?.input).toMatchObject({ Key: archiveKey(orgId, 2025, sha256), VersionId: 'v-old', Retention: { Mode: 'COMPLIANCE', RetainUntilDate: until } });
    const longer = existing(new Date('2040-01-01T00:00:00Z'));
    await longer.store.put(archiveKey(orgId, 2025, sha256), bytes, 'application/xml');
    expect(longer.sent.map((c) => c.constructor.name)).toEqual(['PutObjectCommand', 'GetObjectCommand']);
  });

  it('accepts archive keys only for a year and the sha256 of their bytes', async () => {
    const { store, sent } = fakeStore(() => ({ ChecksumSHA256: checksum, VersionId: 'v1' }));
    await expect(store.put(archiveKey(orgId, 2025, sha256Hex('other')), bytes, 'application/xml')).rejects.toThrow(/does not match/);
    await expect(store.put(`archive/${orgId}/25/${sha256}`, bytes, 'application/xml')).rejects.toThrow(/invalid storage key/);
    await expect(store.put(`archive/${orgId}/${sha256}`, bytes, 'application/xml')).rejects.toThrow(/invalid storage key/);
    expect(sent).toEqual([]);
  });

  it('accepts an existing object with the same bytes (a re-upload dedupes) and refuses different bytes', async () => {
    const same = fakeStore((c) => {
      if (c instanceof PutObjectCommand) throw s3Error('PreconditionFailed', 412);
      return { Body: body(bytes), VersionId: 'v-existing' };
    });
    // The generation is the version that holds the bytes, read back with them.
    await expect(same.store.put(key, bytes, 'application/xml')).resolves.toBe('s3:v-existing');
    expect(same.sent.map((c) => c.constructor.name)).toEqual(['PutObjectCommand', 'GetObjectCommand']);

    const inbound = inboundKey(newInboundBlobId());
    const other = fakeStore((c) => {
      if (c instanceof PutObjectCommand) throw s3Error('PreconditionFailed', 412);
      return { Body: body(new TextEncoder().encode('someone else')) };
    });
    await expect(other.store.put(inbound, bytes, 'message/rfc822')).rejects.toBeInstanceOf(BlobConflictError);
    // Nothing is deleted or rewritten: the stored object stays as it was.
    expect(other.sent.map((c) => c.constructor.name)).toEqual(['PutObjectCommand', 'GetObjectCommand']);
  });

  it('writes once more when the existing object is deleted between the 412 and the read-back', async () => {
    let puts = 0;
    const raced = fakeStore((c) => {
      if (c instanceof PutObjectCommand && ++puts === 1) throw s3Error('PreconditionFailed', 412);
      if (c instanceof GetObjectCommand) throw s3Error('NoSuchKey', 404);
      return { ChecksumSHA256: checksum, VersionId: 'v2' };
    });
    await expect(raced.store.put(key, bytes, 'application/xml')).resolves.toBe('s3:v2');
    expect(raced.sent.map((c) => c.constructor.name)).toEqual(['PutObjectCommand', 'GetObjectCommand', 'PutObjectCommand']);

    // Only once: an object that keeps reappearing and vanishing is not retried forever.
    const flapping = fakeStore((c) => {
      if (c instanceof PutObjectCommand) throw s3Error('PreconditionFailed', 412);
      throw s3Error('NoSuchKey', 404);
    });
    const failure = await flapping.store.put(key, bytes, 'application/xml').catch((e: unknown) => e);
    expect(failure).not.toBeInstanceOf(BlobNotFoundError);
    expect(failure).toMatchObject({ message: expect.stringMatching(/changed concurrently/) });
    expect(flapping.sent.map((c) => c.constructor.name)).toEqual(['PutObjectCommand', 'GetObjectCommand', 'PutObjectCommand', 'GetObjectCommand']);
  });

  it('retries a write that raced another conditional write to the same key', async () => {
    let puts = 0;
    const { store } = fakeStore((c) => {
      if (c instanceof PutObjectCommand && ++puts === 1) throw s3Error('ConditionalRequestConflict', 409);
      return { ChecksumSHA256: checksum, VersionId: 'v3' };
    });
    await store.put(key, bytes, 'application/xml');
    expect(puts).toBe(2);
  });

  it('reads the object back when the server does not confirm the checksum, and removes a corrupt one', async () => {
    const verified = fakeStore((c) => (c instanceof GetObjectCommand ? { Body: body(bytes), VersionId: 'v4' } : { VersionId: 'v4' }));
    await expect(verified.store.put(key, bytes, 'application/xml')).resolves.toBe('s3:v4');
    expect(verified.sent.map((c) => c.constructor.name)).toEqual(['PutObjectCommand', 'GetObjectCommand']);
    // The read-back asks for the version the write created, not whatever is current.
    expect(verified.sent[1]?.input).toMatchObject({ Key: key, VersionId: 'v4' });

    const corrupt = fakeStore((c) => (c instanceof GetObjectCommand ? { Body: body(new Uint8Array([1, 2, 3])) } : {}));
    await expect(corrupt.store.put(key, bytes, 'application/xml')).rejects.toThrow(/sha256 check/);
    expect(corrupt.sent.map((c) => c.constructor.name)).toEqual(['PutObjectCommand', 'GetObjectCommand', 'DeleteObjectCommand']);

    const mismatch = fakeStore(() => ({ ChecksumSHA256: createHash('sha256').update('x').digest('base64') }));
    await expect(mismatch.store.put(key, bytes, 'application/xml')).rejects.toThrow(/sha256 check/);
  });

  it('maps a missing object to BlobNotFoundError, but not a missing bucket', async () => {
    for (const error of [s3Error('NoSuchKey', 404), s3Error('NotFound', 404)]) {
      const { store } = fakeStore(() => {
        throw error;
      });
      const failure = await store.get(key).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(BlobNotFoundError);
      expect(failure).toMatchObject({ code: 'ENOENT', key });
    }
    const { store } = fakeStore(() => {
      throw s3Error('NoSuchBucket', 404);
    });
    await expect(store.get(key)).rejects.toMatchObject({ name: 'NoSuchBucket' });
  });

  it('explains a 403 on read (missing s3:ListBucket hides a missing key) without exposing credentials', async () => {
    const denied = s3Error('AccessDenied', 403);
    const { store } = fakeStore(() => {
      throw denied;
    });
    const failure = await store.get(key).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(BlobStoreAccessError);
    expect(failure).not.toBeInstanceOf(BlobNotFoundError);
    expect(failure).toMatchObject({ key, cause: denied });
    expect((failure as Error).message).toMatch(/s3:ListBucket/);
    expect((failure as Error).message).toContain('crove-files');
  });

  it('deletes idempotently', async () => {
    const ok = fakeStore(() => ({}));
    await ok.store.delete(key);
    expect(ok.sent[0]).toBeInstanceOf(DeleteObjectCommand);
    const missing = fakeStore(() => {
      throw s3Error('NoSuchKey', 404);
    });
    await expect(missing.store.delete(key)).resolves.toBeUndefined();
    const denied = fakeStore(() => {
      throw s3Error('AccessDenied', 403);
    });
    await expect(denied.store.delete(key)).rejects.toMatchObject({ name: 'AccessDenied' });
  });
});

describe('S3 client requests', () => {
  // Builds the real request the SDK would send, captured before it leaves the process.
  async function capturedPut(endpoint: string) {
    const client = createS3Client({ bucket: 'b', region: 'auto', endpoint, accessKeyId: 'test-key', secretAccessKey: 'test-secret', forcePathStyle: true });
    let headers: Record<string, string> = {};
    client.middlewareStack.add(
      () => async (args) => {
        headers = { ...(args.request as { headers: Record<string, string> }).headers };
        throw new Error('captured');
      },
      { step: 'finalizeRequest', name: 'capture', priority: 'low' },
    );
    await expect(new S3BlobStore(client, 'b').put(key, bytes, 'application/xml')).rejects.toThrow('captured');
    return headers;
  }

  it('sends If-None-Match and the sha256 header, and no SDK default checksum trailer', async () => {
    const headers = await capturedPut('http://127.0.0.1:9000');
    expect(headers['if-none-match']).toBe('*');
    expect(headers['x-amz-checksum-sha256']).toBe(checksum);
    expect(headers['content-type']).toBe('application/xml');
    expect(headers['x-goog-if-generation-match']).toBeUndefined();
    expect(Object.keys(headers).filter((h) => h.includes('crc32') || h === 'x-amz-trailer')).toEqual([]);
  });

  it('states the precondition as x-goog-if-generation-match: 0 on GCS', async () => {
    const headers = await capturedPut('https://storage.googleapis.com');
    expect(headers['x-goog-if-generation-match']).toBe('0');
    expect(headers['if-none-match']).toBeUndefined();
  });
});

describe('S3 client timeouts (#2094)', () => {
  const credentials = { bucket: 'b', region: 'us-east-1', accessKeyId: 'k', secretAccessKey: 's', forcePathStyle: true };

  // A server that takes the connection and never answers.
  async function silentServer() {
    const sockets: Socket[] = [];
    const server = createServer((socket) => {
      sockets.push(socket);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    return {
      endpoint: `http://127.0.0.1:${address.port}`,
      close: async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  }

  it('fails a call to a store that never answers, instead of waiting for ever', async () => {
    const silent = await silentServer();
    try {
      const client = createS3Client({ ...credentials, endpoint: silent.endpoint }, undefined, { connectionTimeoutMs: 500, requestTimeoutMs: 200, maxAttempts: 1 });
      const started = Date.now();
      await expect(client.send(new ListObjectsV2Command({ Bucket: 'b' }))).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(4000);
    } finally {
      await silent.close();
    }
  });

  it('ends a call when its abort signal fires, with no timeout set', async () => {
    const silent = await silentServer();
    try {
      const client = createS3Client({ ...credentials, endpoint: silent.endpoint });
      const controller = new AbortController();
      const call = client.send(new ListObjectsV2Command({ Bucket: 'b' }), { abortSignal: controller.signal });
      setTimeout(() => controller.abort(), 100);
      await expect(call).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      await silent.close();
    }
  });

  it('takes the number of attempts asked for', async () => {
    expect(await createS3Client(credentials, undefined, { maxAttempts: 2 }).config.maxAttempts()).toBe(2);
  });
});

describe('generations (ADR-0013)', () => {
  it('fails closed when the bucket returns no version, unless versioning is explicitly off', async () => {
    for (const answer of [{ ChecksumSHA256: checksum }, { ChecksumSHA256: checksum, VersionId: 'null' }]) {
      const { store } = fakeStore(() => answer);
      await expect(store.put(key, bytes, 'application/xml')).rejects.toBeInstanceOf(BlobStoreVersioningError);
    }
    const existingUnversioned = fakeStore((c) => {
      if (c instanceof PutObjectCommand) throw s3Error('PreconditionFailed', 412);
      return { Body: body(bytes), VersionId: 'null' };
    });
    await expect(existingUnversioned.store.put(key, bytes, 'application/xml')).rejects.toThrow(/S3_VERSIONING=off/);

    const off = fakeStore(() => ({ ChecksumSHA256: checksum }), { versioning: 'off' });
    await expect(off.store.put(key, bytes, 'application/xml')).resolves.toBe(`content:${sha256}`);
  });

  it('records content: with versioning off even when the server returns a version id, and never pins one on reads', async () => {
    // Cloudflare R2: every write answers with a VersionId, but a read naming one is refused with NotImplemented.
    const { store, sent } = fakeStore(
      (c) => {
        if (c instanceof GetObjectCommand && (c.input as { VersionId?: string }).VersionId) throw s3Error('NotImplemented', 501);
        if (c instanceof GetObjectCommand) return { Body: body(bytes), VersionId: 'r2-version' };
        return { ChecksumSHA256: checksum, VersionId: 'r2-version' };
      },
      { versioning: 'off' },
    );
    await expect(store.put(key, bytes, 'application/xml')).resolves.toBe(`content:${sha256}`);
    // A row an earlier release recorded as s3:<id> on R2 reads the current object.
    await expect(readVerified(store, { key, generation: 's3:r2-version', sha256 })).resolves.toEqual(bytes);
    await expect(readVerified(store, { key, generation: `content:${sha256}`, sha256 })).resolves.toEqual(bytes);
    expect(sent.filter((c) => c instanceof GetObjectCommand).map((c) => (c.input as { VersionId?: string }).VersionId)).toEqual([undefined, undefined]);

    // A write the server does not confirm is read back without the version it returned.
    const unconfirmed = fakeStore(
      (c) => {
        if (c instanceof GetObjectCommand && (c.input as { VersionId?: string }).VersionId) throw s3Error('NotImplemented', 501);
        if (c instanceof GetObjectCommand) return { Body: body(bytes), VersionId: 'r2-version' };
        return { VersionId: 'r2-version' };
      },
      { versioning: 'off' },
    );
    await expect(unconfirmed.store.put(key, bytes, 'application/xml')).resolves.toBe(`content:${sha256}`);
    expect(unconfirmed.sent.map((c) => c.constructor.name)).toEqual(['PutObjectCommand', 'GetObjectCommand']);
  });

  it('tags GCS generations as gcs:', async () => {
    const { store } = fakeStore(() => ({ ChecksumSHA256: checksum, VersionId: '1729000000000001' }), { flavor: 'gcs' });
    await expect(store.put(key, bytes, 'application/xml')).resolves.toBe('gcs:1729000000000001');
  });

  it('reads the exact version a generation names, and the current object for content: and legacy rows', async () => {
    const { store, sent } = fakeStore(() => ({ Body: body(bytes) }));
    await store.get(key, 's3:v1');
    await store.get(key, `content:${sha256}`);
    await store.get(key, null);
    await store.get(key);
    expect(sent.map((c) => (c.input as { VersionId?: string }).VersionId)).toEqual(['v1', undefined, undefined, undefined]);
  });

  it('treats a missing version as a missing blob, never as the current object', async () => {
    const { store, sent } = fakeStore(() => {
      throw s3Error('NoSuchVersion', 404);
    });
    await expect(readVerified(store, { key, generation: 's3:gone', sha256 })).rejects.toBeInstanceOf(BlobNotFoundError);
    expect(sent).toHaveLength(1);
  });

  it('refuses bytes whose sha256 differs from the recorded one (red-team S25)', async () => {
    const swapped = fakeStore(() => ({ Body: body(new TextEncoder().encode('<HDon>swapped</HDon>')) }));
    const failure = await readVerified(swapped.store, { key, generation: 's3:v1', sha256 }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(BlobIntegrityError);
    expect((failure as Error).message).toContain(key);
    const original = fakeStore(() => ({ Body: body(bytes) }));
    await expect(readVerified(original.store, { key, generation: 's3:v1', sha256 })).resolves.toEqual(bytes);
  });

  it('caps a verified read at the recorded size, by the declared length or while streaming (#1126)', async () => {
    const ref = { key, generation: 's3:v1', sha256 };
    const larger = new Uint8Array(bytes.byteLength * 4);
    // A swapped, larger object that declares its length is refused before its body is read.
    let cancelled = false;
    const declared = fakeStore(() => ({
      Body: {
        transformToByteArray: async () => larger,
        transformToWebStream: () =>
          new ReadableStream<Uint8Array>({
            cancel() {
              cancelled = true;
            },
          }),
      },
      ContentLength: larger.byteLength,
    }));
    await expect(readVerified(declared.store, ref, bytes.byteLength)).rejects.toBeInstanceOf(BlobTooLargeError);
    expect(cancelled).toBe(true);
    // One that does not declare it (or lies) is cut off at the cap.
    const undeclared = fakeStore(() => ({ Body: body(larger, [larger.slice(0, 8), larger.slice(8)]) }));
    await expect(readVerified(undeclared.store, ref, bytes.byteLength)).rejects.toBeInstanceOf(BlobTooLargeError);
    const lying = fakeStore(() => ({ Body: body(larger, [larger]), ContentLength: 1 }));
    await expect(readVerified(lying.store, ref, bytes.byteLength)).rejects.toBeInstanceOf(BlobTooLargeError);
    // The original, streamed in chunks, reads back whole and verified.
    const half = bytes.byteLength >> 1;
    const original = fakeStore(() => ({ Body: body(bytes, [bytes.slice(0, half), bytes.slice(half)]), ContentLength: bytes.byteLength }));
    await expect(readVerified(original.store, ref, bytes.byteLength)).resolves.toEqual(bytes);
  });
});

// #1189: a NaN, negative, fractional or infinite cap compares false against every size, so a store that took it would
// read the object whole. The store refuses it before any request.
describe('read caps that are not a whole number of bytes (#1189)', () => {
  const BAD_CAPS = [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 2 ** 53];

  it('are refused by get before any request', async () => {
    const { store, sent } = fakeStore(() => ({ Body: body(bytes), ContentLength: bytes.byteLength }));
    for (const cap of BAD_CAPS) await expect(store.get(key, null, cap), String(cap)).rejects.toThrow(RangeError);
    await expect(store.get(key, 'v1', Number.NaN)).rejects.toThrow(/invalid read cap/);
    expect(sent).toEqual([]);
    // A whole cap still reads.
    expect(await store.get(key, null, bytes.byteLength)).toEqual(bytes);
  });

  it('are refused by a staged read before any request', async () => {
    const presigner = createS3Client({ bucket: 'crove-files', region: 'us-east-1', accessKeyId: 'k', secretAccessKey: 's' });
    const { store, sent } = fakeStore(() => ({ Body: body(bytes), ContentLength: bytes.byteLength }), { presigner });
    const staging = newStagingKey();
    for (const cap of BAD_CAPS) await expect(store.direct?.readStaged(staging, cap), String(cap)).rejects.toThrow(/invalid read cap/);
    expect(sent).toEqual([]);
  });
});

describe('staged reads (plan §7.6 step 2)', () => {
  const staging = newStagingKey();

  it('streams the staged object through sha256', async () => {
    const half = bytes.byteLength >> 1;
    const { store } = fakeStore(() => ({ Body: body(bytes, [bytes.slice(0, half), bytes.slice(half)]), ContentLength: bytes.byteLength }), {
      presigner: createS3Client({ bucket: 'crove-files', region: 'us-east-1', accessKeyId: 'k', secretAccessKey: 's' }),
    });
    const staged = await store.direct?.readStaged(staging, 1024);
    expect(staged).toEqual({ bytes, sha256 });
  });

  it('refuses more than the grant allows, by the declared length or while streaming', async () => {
    const presigner = createS3Client({ bucket: 'crove-files', region: 'us-east-1', accessKeyId: 'k', secretAccessKey: 's' });
    const declared = fakeStore(() => ({ Body: body(bytes), ContentLength: bytes.byteLength }), { presigner });
    await expect(declared.store.direct?.readStaged(staging, bytes.byteLength - 1)).rejects.toBeInstanceOf(BlobTooLargeError);
    // A server that does not declare the length (or lies) is cut off at the cap.
    const undeclared = fakeStore(() => ({ Body: body(bytes, [bytes.slice(0, 4), bytes.slice(4)]) }), { presigner });
    await expect(undeclared.store.direct?.readStaged(staging, 5)).rejects.toBeInstanceOf(BlobTooLargeError);
  });

  it('reads only staging keys', async () => {
    const presigner = createS3Client({ bucket: 'crove-files', region: 'us-east-1', accessKeyId: 'k', secretAccessKey: 's' });
    const { store, sent } = fakeStore(() => ({ Body: body(bytes) }), { presigner });
    await expect(store.direct?.readStaged(key, 1024)).rejects.toThrow(/invalid staging key/);
    await expect(store.direct?.readStaged(inboundKey(newInboundBlobId()), 1024)).rejects.toThrow(/invalid staging key/);
    expect(sent).toEqual([]);
  });
});

// Issue #223: abandoned staging objects on buckets without a lifecycle rule.
describe('staging sweep', () => {
  const now = Date.parse('2026-10-17T12:00:00Z');
  const before = new Date(now - 3600_000);
  const old = new Date(now - 2 * 3600_000);
  const fresh = new Date(now - 60_000);
  const page = (keys: Array<[string, Date | undefined]>, next?: string) => ({
    Contents: keys.map(([Key, LastModified]) => ({ Key, LastModified })),
    IsTruncated: next !== undefined,
    ...(next ? { NextContinuationToken: next } : {}),
  });

  it('deletes only staging keys older than the cutoff, page by page', async () => {
    const [a, b, c, d] = [newStagingKey(), newStagingKey(), newStagingKey(), newStagingKey()];
    const pages = [
      page([[a, old], [b, fresh], ['staging/not-a-staging-key', old], [c, undefined]], 'next-1'),
      page([[d, old]]),
    ];
    const { store, sent } = fakeStore((command) => (command instanceof ListObjectsV2Command ? pages.shift() : {}));
    await expect(store.sweepStaging(before, 100)).resolves.toEqual({ deleted: 2, more: false });
    const lists = sent.filter((c) => c instanceof ListObjectsV2Command);
    expect(lists.map((c) => c.input)).toEqual([
      { Bucket: 'crove-files', Prefix: 'staging/', MaxKeys: 100 },
      { Bucket: 'crove-files', Prefix: 'staging/', MaxKeys: 96, ContinuationToken: 'next-1' },
    ]);
    // Never a version delete: Crove holds no s3:DeleteObjectVersion and never removes a version of anything.
    expect(sent.filter((c) => c instanceof DeleteObjectCommand).map((c) => c.input)).toEqual([
      { Bucket: 'crove-files', Key: a },
      { Bucket: 'crove-files', Key: d },
    ]);
  });

  it('looks at no more than the limit per call and says when more may remain', async () => {
    const keys = Array.from({ length: 3 }, () => newStagingKey());
    const { store, sent } = fakeStore((command) => (command instanceof ListObjectsV2Command ? page(keys.map((k) => [k, old]), 'next') : {}));
    await expect(store.sweepStaging(before, 3)).resolves.toEqual({ deleted: 3, more: true });
    expect(sent.filter((c) => c instanceof ListObjectsV2Command)).toHaveLength(1);
    await expect(store.sweepStaging(before, 0)).rejects.toThrow(/invalid sweep limit/);
  });

  it('stops on an empty page that still claims more', async () => {
    const { store, sent } = fakeStore((command) => (command instanceof ListObjectsV2Command ? page([], 'again') : {}));
    await expect(store.sweepStaging(before, 5000)).resolves.toEqual({ deleted: 0, more: true });
    expect(sent).toHaveLength(1);
  });
});

describe('presigned transfers (plan §7.6), signed offline', () => {
  const options = {
    bucket: 'crove-files',
    region: 'us-east-1',
    endpoint: 'https://s3.example.test',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'example-secret',
    forcePathStyle: true,
  };

  it('has no presigned transfers when they are turned off', () => {
    expect(S3BlobStore.connect({ ...options, presign: false }).direct).toBeUndefined();
    expect(S3BlobStore.connect(options).direct).toBeDefined();
  });

  it('signs a POST for exactly one random staging key, 1 byte to the size limit, for 5 minutes', async () => {
    const store = S3BlobStore.connect({ ...options, publicEndpoint: 'https://files.example.test' });
    const before = Date.now();
    const a = newStagingKey();
    const b = newStagingKey();
    expect(a).toMatch(/^staging\/[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
    const form = await store.direct?.presignUpload(a, 25 * 1024 * 1024);
    if (!form) throw new Error('no presigned form');
    // Signed for the endpoint browsers reach, not the one the kernel uses.
    expect(new URL(form.url).origin).toBe('https://files.example.test');
    expect(form.fields.key).toBe(a);
    expect(form.fields['X-Amz-Algorithm']).toBe('AWS4-HMAC-SHA256');
    expect(form.fields['X-Amz-Credential']).toMatch(/^AKIDEXAMPLE\//);
    expect(form.fields['X-Amz-Signature']).toMatch(/^[0-9a-f]{64}$/);
    const policy = JSON.parse(Buffer.from(form.fields.Policy ?? '', 'base64').toString('utf8')) as { expiration: string; conditions: unknown[] };
    expect(policy.conditions).toContainEqual(['content-length-range', 1, 25 * 1024 * 1024]);
    expect(policy.conditions).toContainEqual({ key: a });
    expect(policy.conditions).toContainEqual({ bucket: 'crove-files' });
    // No starts-with condition: the form cannot write any other key.
    expect(policy.conditions.filter((c) => Array.isArray(c) && c[0] === 'starts-with')).toEqual([]);
    const expires = Date.parse(policy.expiration);
    expect(expires - before).toBeGreaterThanOrEqual(UPLOAD_TTL_SECONDS * 1000 - 2000);
    expect(expires - before).toBeLessThanOrEqual(UPLOAD_TTL_SECONDS * 1000 + 2000);
    expect(Math.abs(form.expiresAt.getTime() - expires)).toBeLessThan(2000);
    expect(form.maxBytes).toBe(25 * 1024 * 1024);
  });

  it('refuses to sign a form for anything but a staging key', async () => {
    const store = S3BlobStore.connect(options);
    await expect(store.direct?.presignUpload(key, 10)).rejects.toThrow(/invalid staging key/);
    await expect(store.direct?.presignUpload(newStagingKey(), 0)).rejects.toThrow(/size limit/);
  });

  it('signs a GET for the exact version, as an attachment, for 60 seconds', async () => {
    const store = S3BlobStore.connect(options);
    const url = await store.direct?.presignDownload({ key, generation: 's3:3HL4kqtJlcpXroDTDmJ+rmSpXd3dIbrHY', sha256 }, {
      filename: 'hóa đơn.pdf',
      contentType: 'application/pdf',
    });
    if (!url) throw new Error('no presigned url');
    const parsed = new URL(url);
    expect(parsed.pathname).toBe(`/crove-files/${key}`);
    expect(parsed.searchParams.get('versionId')).toBe('3HL4kqtJlcpXroDTDmJ+rmSpXd3dIbrHY');
    expect(parsed.searchParams.get('X-Amz-Expires')).toBe(String(DOWNLOAD_TTL_SECONDS));
    expect(parsed.searchParams.get('response-content-disposition')).toBe(`attachment; filename*=UTF-8''${encodeURIComponent('hóa đơn.pdf')}`);
    expect(parsed.searchParams.get('response-content-type')).toBe('application/pdf');
    expect(parsed.searchParams.get('response-cache-control')).toBe('private, no-store');
  });

  it('presigns no download it cannot pin to a version', async () => {
    const store = S3BlobStore.connect(options);
    const file = { filename: 'a.xml', contentType: 'application/xml' };
    await expect(store.direct?.presignDownload({ key, generation: `content:${sha256}`, sha256 }, file)).resolves.toBeNull();
    await expect(store.direct?.presignDownload({ key, generation: null, sha256 }, file)).resolves.toBeNull();
  });

  it('names the version `generation` on GCS, where presigned transfers stay off by default', async () => {
    const gcs = { ...options, endpoint: 'https://storage.googleapis.com' };
    expect(S3BlobStore.connect(gcs).direct).toBeUndefined();
    const store = new S3BlobStore(createS3Client(gcs), gcs.bucket, { presigner: createS3Client(gcs), flavor: 'gcs' });
    const url = await store.direct?.presignDownload({ key, generation: 'gcs:1729000000000001', sha256 }, { filename: 'a.xml', contentType: 'application/xml' });
    const parsed = new URL(url ?? '');
    expect(parsed.searchParams.get('generation')).toBe('1729000000000001');
    expect(parsed.searchParams.get('versionId')).toBeNull();
  });
});
