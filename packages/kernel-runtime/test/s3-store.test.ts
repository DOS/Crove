import { createHash, randomUUID } from 'node:crypto';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import {
  BlobConflictError,
  BlobNotFoundError,
  BlobStoreAccessError,
  S3BlobStore,
  createS3Client,
  fileKey,
  inboundKey,
  newInboundBlobId,
  sha256Hex,
  type S3Sender,
} from '../src/index.ts';

type Command = PutObjectCommand | GetObjectCommand | DeleteObjectCommand;

// An S3 failure the way the SDK reports it: a named error with the HTTP status in $metadata.
function s3Error(name: string, status: number): Error {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
}

const body = (bytes: Uint8Array) => ({ transformToByteArray: async () => bytes });

// A fake client: each command goes to `answer`, and every command is recorded.
function fakeStore(answer: (command: Command) => unknown) {
  const sent: Command[] = [];
  const client = {
    send: async (command: Command) => {
      sent.push(command);
      return answer(command);
    },
  } as unknown as S3Sender;
  return { store: new S3BlobStore(client, 'crove-files'), sent };
}

const orgId = randomUUID();
const bytes = new TextEncoder().encode('<HDon>evidence</HDon>');
const sha256 = sha256Hex(bytes);
const key = fileKey(orgId, sha256);
const checksum = createHash('sha256').update(bytes).digest('base64');

describe('S3BlobStore with a mocked client', () => {
  it('writes create-only, with the content type and the sha256 the server verifies', async () => {
    const { store, sent } = fakeStore(() => ({ ChecksumSHA256: checksum }));
    await store.put(key, bytes, 'application/xml');
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

  it('accepts an existing object with the same bytes (a re-upload dedupes) and refuses different bytes', async () => {
    const same = fakeStore((c) => {
      if (c instanceof PutObjectCommand) throw s3Error('PreconditionFailed', 412);
      return { Body: body(bytes) };
    });
    await expect(same.store.put(key, bytes, 'application/xml')).resolves.toBeUndefined();
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
      return { ChecksumSHA256: checksum };
    });
    await expect(raced.store.put(key, bytes, 'application/xml')).resolves.toBeUndefined();
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
      return { ChecksumSHA256: checksum };
    });
    await store.put(key, bytes, 'application/xml');
    expect(puts).toBe(2);
  });

  it('reads the object back when the server does not confirm the checksum, and removes a corrupt one', async () => {
    const verified = fakeStore((c) => (c instanceof GetObjectCommand ? { Body: body(bytes) } : {}));
    await verified.store.put(key, bytes, 'application/xml');
    expect(verified.sent.map((c) => c.constructor.name)).toEqual(['PutObjectCommand', 'GetObjectCommand']);

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
