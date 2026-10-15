// Integration tests against a real S3-compatible server (CI: MinIO). Set CROVE_TEST_S3_URL to
// http://<access key>:<secret>@<host>:<port>/<bucket>; the bucket is created if missing.
import { createHash, randomUUID } from 'node:crypto';
import { ChecksumMode, CreateBucketCommand, HeadObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  BlobConflictError,
  BlobNotFoundError,
  S3BlobStore,
  createS3Client,
  fileKey,
  inboundKey,
  newInboundBlobId,
  sha256Hex,
  type S3Sender,
  type S3StoreOptions,
} from '../src/index.ts';

const URL_ENV = process.env.CROVE_TEST_S3_URL;

function optionsFrom(url: string): S3StoreOptions {
  const parsed = new URL(url);
  return {
    endpoint: parsed.origin,
    region: 'us-east-1',
    bucket: parsed.pathname.replace(/^\//, '') || 'crove-test',
    accessKeyId: decodeURIComponent(parsed.username),
    secretAccessKey: decodeURIComponent(parsed.password),
    forcePathStyle: true,
  };
}

describe.skipIf(!URL_ENV)('S3BlobStore against a real S3-compatible server', () => {
  const options = optionsFrom(URL_ENV ?? 'http://x:y@localhost/none');
  let client: S3Client;
  const orgId = randomUUID();
  const encode = (s: string) => new TextEncoder().encode(s);

  // Records which commands the store sends, so a test can see that no read-back was needed.
  function recording() {
    const sent: string[] = [];
    const sender = {
      send: (command: { constructor: { name: string } }) => {
        sent.push(command.constructor.name);
        return (client.send as (c: unknown) => Promise<unknown>)(command);
      },
    } as unknown as S3Sender;
    return { store: new S3BlobStore(sender, options.bucket), sent };
  }

  beforeAll(async () => {
    client = createS3Client(options);
    await client.send(new CreateBucketCommand({ Bucket: options.bucket })).catch((error: { name?: string }) => {
      if (error.name !== 'BucketAlreadyOwnedByYou' && error.name !== 'BucketAlreadyExists') throw error;
    });
  });

  it('stores bytes with their content type and sha256, and a new store instance reads them back', async () => {
    const bytes = encode(`<HDon>${randomUUID()}</HDon>`);
    const key = fileKey(orgId, sha256Hex(bytes));
    const { store, sent } = recording();
    await store.put(key, bytes, 'application/xml');
    // The server confirmed the sha256, so the store did not have to read the object back.
    expect(sent).toEqual(['PutObjectCommand']);

    const restarted = S3BlobStore.connect(options);
    expect(await restarted.get(key)).toEqual(bytes);
    const head = await client.send(new HeadObjectCommand({ Bucket: options.bucket, Key: key, ChecksumMode: ChecksumMode.ENABLED }));
    expect(head.ContentType).toBe('application/xml');
    expect(head.ContentLength).toBe(bytes.byteLength);
    expect(head.ChecksumSHA256).toBe(createHash('sha256').update(bytes).digest('base64'));
  });

  it('refuses a body that does not match the sha256 sent with it (the server verifies)', async () => {
    const bytes = encode('real bytes');
    await expect(
      client.send(
        new PutObjectCommand({
          Bucket: options.bucket,
          Key: inboundKey(newInboundBlobId()),
          Body: bytes,
          ChecksumSHA256: createHash('sha256').update('other bytes').digest('base64'),
        }),
      ),
    ).rejects.toMatchObject({ $metadata: { httpStatusCode: 400 } });
  });

  it('never overwrites: the same bytes dedupe, different bytes conflict and the original stays', async () => {
    const store = S3BlobStore.connect(options);
    const bytes = encode(`<HDon>${randomUUID()}</HDon>`);
    const key = fileKey(orgId, sha256Hex(bytes));
    await Promise.all([store.put(key, bytes, 'application/xml'), store.put(key, bytes, 'application/xml')]);
    await store.put(key, bytes, 'application/xml');
    expect(await store.get(key)).toEqual(bytes);

    const inbound = inboundKey(newInboundBlobId());
    const original = encode('first delivery');
    await store.put(inbound, original, 'message/rfc822');
    await expect(store.put(inbound, encode('a different message'), 'message/rfc822')).rejects.toBeInstanceOf(BlobConflictError);
    expect(await store.get(inbound)).toEqual(original);
  });

  it('maps a missing object to BlobNotFoundError and deletes idempotently', async () => {
    const store = S3BlobStore.connect(options);
    const key = inboundKey(newInboundBlobId());
    await expect(store.get(key)).rejects.toBeInstanceOf(BlobNotFoundError);
    await store.put(key, encode('raw'), 'message/rfc822');
    await store.delete(key);
    await expect(store.get(key)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(store.delete(key)).resolves.toBeUndefined();
  });

  it('fails loudly on a bucket that does not exist', async () => {
    const store = S3BlobStore.connect({ ...options, bucket: `missing-${randomUUID()}` });
    const error = await store.get(inboundKey(newInboundBlobId())).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(BlobNotFoundError);
  });
});
