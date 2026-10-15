import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import { BlobConflictError, BlobNotFoundError, assertContentAddress, assertStorageKey, sha256Hex, type BlobStore } from './storage.ts';

export interface S3StoreOptions {
  bucket: string;
  region: string;
  // Omit for AWS S3. Set it for MinIO, Cloudflare R2, GCS interoperability (https://storage.googleapis.com) and others.
  endpoint?: string | undefined;
  // Static credentials. Omit both to use the SDK's default chain (environment, instance or workload identity).
  accessKeyId?: string | undefined;
  secretAccessKey?: string | undefined;
  // Path-style URLs (endpoint/bucket/key). MinIO and most self-hosted servers need it.
  forcePathStyle?: boolean | undefined;
}

// The only client method the store uses; S3Client satisfies it and unit tests pass a fake.
export type S3Sender = Pick<S3Client, 'send'>;

const GOOGLE_HOST = 'storage.googleapis.com';
const CONFLICT_RETRIES = 3;

export function createS3Client(options: S3StoreOptions): S3Client {
  const config: S3ClientConfig = {
    region: options.region,
    forcePathStyle: options.forcePathStyle ?? false,
    // The store sends its own sha256 with every object. The SDK's default CRC32 trailers (aws-chunked bodies)
    // are refused by several S3-compatible servers, so they are only sent where an operation requires them.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  };
  if (options.endpoint) config.endpoint = options.endpoint;
  if (options.accessKeyId && options.secretAccessKey) {
    config.credentials = { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey };
  }
  const client = new S3Client(config);
  if (options.endpoint && new URL(options.endpoint).hostname === GOOGLE_HOST) {
    // GCS states the create-only precondition as a generation match (plan §7.6: x-goog-if-generation-match: 0).
    client.middlewareStack.add(
      (next, context) => async (args) => {
        const headers = (args.request as { headers?: Record<string, string> }).headers;
        if (context.commandName === 'PutObjectCommand' && headers?.['if-none-match'] === '*') {
          delete headers['if-none-match'];
          headers['x-goog-if-generation-match'] = '0';
        }
        return next(args);
      },
      { step: 'build', name: 'croveGoogleGenerationPrecondition' },
    );
  }
  return client;
}

// A read was refused with 403. Either the credentials lack s3:GetObject, or the key is missing and the bucket
// policy lacks s3:ListBucket (S3 then hides a missing key behind 403). The message names the bucket and key, never
// credentials.
export class BlobStoreAccessError extends Error {
  readonly key: string;
  constructor(bucket: string, key: string, cause: unknown) {
    super(
      `access denied reading ${key} from bucket ${bucket}: the credentials need s3:GetObject on the objects and ` +
        's3:ListBucket on the bucket (without ListBucket a missing key is reported as 403, not 404)',
      { cause },
    );
    this.name = 'BlobStoreAccessError';
    this.key = key;
  }
}

function httpStatus(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode;
}

function errorName(error: unknown): string | undefined {
  return (error as { name?: string } | null)?.name;
}

// A missing object, not a missing bucket (which is a configuration error and must surface as such).
function isMissingObject(error: unknown): boolean {
  const name = errorName(error);
  return name === 'NoSuchKey' || name === 'NotFound' || (httpStatus(error) === 404 && name !== 'NoSuchBucket');
}

// S3-compatible object storage (AWS S3, MinIO, Cloudflare R2, GCS interoperability). Shared by the API and the
// worker, so the roles can run as separate containers with no shared volume (External-tenant gate T7).
//
// Writes are create-only (If-None-Match: *, the S3 form of if-generation-match: 0): a key that already holds
// an object is never overwritten. Writing the same bytes again succeeds, which is how a re-uploaded file
// dedupes; different bytes raise BlobConflictError. Every write carries the sha256 of its bytes, which the
// server verifies; when a server does not confirm it, the store reads the object back and compares.
//
// The bucket policy must grant s3:ListBucket on the bucket as well as s3:GetObject, s3:PutObject and
// s3:DeleteObject on its objects. Without ListBucket, S3 answers a read of a missing key with 403 instead of 404,
// so the store cannot tell a missing blob from a permission problem; get then raises BlobStoreAccessError, not
// BlobNotFoundError.
export class S3BlobStore implements BlobStore {
  private readonly client: S3Sender;
  private readonly bucket: string;

  constructor(client: S3Sender, bucket: string) {
    this.client = client;
    this.bucket = bucket;
  }

  static connect(options: S3StoreOptions): S3BlobStore {
    return new S3BlobStore(createS3Client(options), options.bucket);
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    assertStorageKey(key);
    const digest = createHash('sha256').update(bytes).digest();
    const sha256 = digest.toString('hex');
    assertContentAddress(key, sha256);
    const checksum = digest.toString('base64');

    let retriedMissing = false;
    for (let attempt = 1; ; attempt++) {
      let confirmed: string | undefined;
      try {
        const out = await this.client.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: bytes,
            ContentType: contentType || 'application/octet-stream',
            ContentLength: bytes.byteLength,
            ChecksumSHA256: checksum,
            IfNoneMatch: '*',
          }),
        );
        confirmed = out.ChecksumSHA256;
      } catch (error) {
        const status = httpStatus(error);
        // The key already holds an object: accept it only if it has exactly these bytes. If it was deleted
        // between the 412 and the read-back, write it once more.
        if (status === 412) {
          try {
            return await this.assertHolds(key, sha256);
          } catch (readError) {
            if (!(readError instanceof BlobNotFoundError)) throw readError;
            // Vanished twice: the key is being written and deleted concurrently. That is not a missing blob.
            if (retriedMissing) throw new Error(`object changed concurrently while it was written: ${key}`, { cause: readError });
            retriedMissing = true;
            continue;
          }
        }
        // Another conditional write to the same key is in flight; retry so one of them wins.
        if (status === 409 && attempt < CONFLICT_RETRIES) {
          await sleep(100 * attempt);
          continue;
        }
        throw error;
      }
      if (confirmed === checksum) return;
      // The server did not confirm the checksum (or confirmed another one): verify what it stored.
      const stored = confirmed === undefined ? sha256Hex(await this.get(key)) : null;
      if (stored === sha256) return;
      await this.delete(key);
      throw new Error(`stored blob failed its sha256 check: ${key}`);
    }
  }

  private async assertHolds(key: string, sha256: string): Promise<void> {
    if (sha256Hex(await this.get(key)) !== sha256) throw new BlobConflictError(key);
  }

  async get(key: string): Promise<Uint8Array> {
    assertStorageKey(key);
    try {
      const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!out.Body) throw new BlobNotFoundError(key);
      return await out.Body.transformToByteArray();
    } catch (error) {
      if (isMissingObject(error)) throw new BlobNotFoundError(key);
      if (httpStatus(error) === 403) throw new BlobStoreAccessError(this.bucket, key, error);
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    assertStorageKey(key);
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (error) {
      if (!isMissingObject(error)) throw error;
    }
  }
}
