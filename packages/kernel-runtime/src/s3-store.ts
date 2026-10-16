import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  BlobConflictError,
  BlobNotFoundError,
  BlobTooLargeError,
  DOWNLOAD_TTL_SECONDS,
  UPLOAD_TTL_SECONDS,
  assertContentAddress,
  assertStorageKey,
  contentGeneration,
  isStagingKey,
  sha256Hex,
  versionOf,
  type BlobRef,
  type BlobStore,
  type DirectTransfers,
  type PresignedUpload,
  type StagingSweep,
} from './storage.ts';

// required: every write must come back with an object version (S3 VersionId, GCS generation), or the store fails
// closed; this is the default and what evidence buckets need (ADR-0013). off: the bucket has no versioning (for
// example Cloudflare R2), generations are content:<sha256> and integrity rests on the sha256 check alone.
export type S3Versioning = 'required' | 'off';

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
  versioning?: S3Versioning | undefined;
  // Presigned URLs for browsers (plan §7.6): on unless false.
  presign?: boolean | undefined;
  // The endpoint browsers reach, when it differs from `endpoint` (for example http://localhost:9000 for a MinIO the
  // kernel reaches as http://minio:9000). The host is part of the signature, so presigned URLs are signed for it.
  publicEndpoint?: string | undefined;
}

// The only client method the store uses; S3Client satisfies it and unit tests pass a fake.
export type S3Sender = Pick<S3Client, 'send'>;

const GOOGLE_HOST = 'storage.googleapis.com';
const CONFLICT_RETRIES = 3;
// ListObjectsV2 returns at most 1000 keys per page; the sweep deletes this many keys at a time.
const LIST_PAGE = 1000;
const SWEEP_DELETES_IN_FLIGHT = 10;

function isGoogle(endpoint: string | undefined): boolean {
  return Boolean(endpoint) && new URL(endpoint as string).hostname === GOOGLE_HOST;
}

export function createS3Client(options: S3StoreOptions, endpoint: string | undefined = options.endpoint): S3Client {
  const config: S3ClientConfig = {
    region: options.region,
    forcePathStyle: options.forcePathStyle ?? false,
    // The store sends its own sha256 with every object. The SDK's default CRC32 trailers (aws-chunked bodies)
    // are refused by several S3-compatible servers, so they are only sent where an operation requires them.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  };
  if (endpoint) config.endpoint = endpoint;
  if (options.accessKeyId && options.secretAccessKey) {
    config.credentials = { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey };
  }
  const client = new S3Client(config);
  if (isGoogle(endpoint)) {
    // GCS states the create-only precondition as a generation match (plan §7.6: x-goog-if-generation-match: 0), names
    // an object version `generation` instead of `versionId`, and returns it in x-goog-generation. Not yet run
    // against GCS (T7).
    client.middlewareStack.add(
      (next, context) => async (args) => {
        const request = args.request as { headers?: Record<string, string>; query?: Record<string, string | string[] | null> };
        const headers = request.headers;
        if (context.commandName === 'PutObjectCommand' && headers?.['if-none-match'] === '*') {
          delete headers['if-none-match'];
          headers['x-goog-if-generation-match'] = '0';
        }
        const query = request.query;
        if (query && typeof query.versionId === 'string') {
          query.generation = query.versionId;
          delete query.versionId;
        }
        return next(args);
      },
      { step: 'build', name: 'croveGoogleGenerationPrecondition' },
    );
    client.middlewareStack.add(
      (next) => async (args) => {
        const result = await next(args);
        const generation = (result.response as { headers?: Record<string, string> } | undefined)?.headers?.['x-goog-generation'];
        const output = result.output as { VersionId?: string } | undefined;
        if (generation && output && typeof output === 'object') output.VersionId = generation;
        return result;
      },
      { step: 'initialize', name: 'croveGoogleGenerationResult' },
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

// The bucket returned no object version while S3_VERSIONING=required: it is unversioned or versioning is suspended.
export class BlobStoreVersioningError extends Error {
  readonly key: string;
  constructor(bucket: string, key: string) {
    super(
      `bucket ${bucket} returned no object version for ${key}: enable bucket versioning (required for evidence, ` +
        'ADR-0013) or, for a store without versioning, set S3_VERSIONING=off',
    );
    this.name = 'BlobStoreVersioningError';
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
  return name === 'NoSuchKey' || name === 'NotFound' || name === 'NoSuchVersion' || (httpStatus(error) === 404 && name !== 'NoSuchBucket');
}

// RFC 6266 attachment with the UTF-8 filename.
function attachment(filename: string): string {
  return `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

interface Fetched {
  bytes: Uint8Array;
  versionId: string | undefined;
}

export interface S3BlobStoreOptions {
  versioning?: S3Versioning | undefined;
  // The client that signs presigned URLs (for the public endpoint). Absent: no presigned transfers.
  presigner?: S3Client | undefined;
  // gcs when the endpoint is GCS interoperability: generations are tagged gcs: instead of s3:.
  flavor?: 's3' | 'gcs' | undefined;
}

// S3-compatible object storage (AWS S3, MinIO, Cloudflare R2, GCS interoperability). Shared by the API and the
// worker, so the roles can run as separate containers with no shared volume (External-tenant gate T7).
//
// Writes are create-only (If-None-Match: *, the S3 form of if-generation-match: 0): a key that already holds
// an object is never overwritten. Writing the same bytes again succeeds, which is how a re-uploaded file
// dedupes; different bytes raise BlobConflictError. Every write carries the sha256 of its bytes, which the
// server verifies; when a server does not confirm it, the store reads the object back and compares.
//
// Every write returns the object's version (ADR-0013): s3:<VersionId>, or gcs:<generation> on GCS. Evidence buckets
// must have versioning enabled; with S3_VERSIONING=required (the default) a write that comes back without a
// version fails, and with off the generation is content:<sha256>. Reads of a versioned generation request that
// exact version, so a later version written under the same key (by anyone with bucket access) is never read.
//
// The bucket policy must grant s3:ListBucket on the bucket as well as s3:GetObject, s3:GetObjectVersion,
// s3:PutObject and s3:DeleteObject on its objects. Without ListBucket, S3 answers a read of a missing key with 403
// instead of 404, so the store cannot tell a missing blob from a permission problem; get then raises
// BlobStoreAccessError, not BlobNotFoundError.
export class S3BlobStore implements BlobStore {
  private readonly client: S3Sender;
  private readonly bucket: string;
  private readonly versioning: S3Versioning;
  private readonly flavor: 's3' | 'gcs';
  readonly direct: DirectTransfers | undefined;

  constructor(client: S3Sender, bucket: string, options: S3BlobStoreOptions = {}) {
    this.client = client;
    this.bucket = bucket;
    this.versioning = options.versioning ?? 'required';
    this.flavor = options.flavor ?? 's3';
    const presigner = options.presigner;
    this.direct = presigner
      ? {
          presignUpload: (key, maxBytes) => this.presignUpload(presigner, key, maxBytes),
          presignDownload: (ref, file) => this.presignDownload(presigner, ref, file),
          readStaged: (key, maxBytes) => this.readStaged(key, maxBytes),
        }
      : undefined;
  }

  static connect(options: S3StoreOptions): S3BlobStore {
    const client = createS3Client(options);
    // Not on GCS: the SigV4 POST policy fields createPresignedPost signs have not been verified there, so transfers
    // stream through the kernel instead (ADR-0013).
    const presigner =
      options.presign === false || isGoogle(options.endpoint)
        ? undefined
        : options.publicEndpoint && options.publicEndpoint !== options.endpoint
          ? createS3Client(options, options.publicEndpoint)
          : client;
    return new S3BlobStore(client, options.bucket, {
      versioning: options.versioning,
      presigner,
      flavor: isGoogle(options.endpoint) ? 'gcs' : 's3',
    });
  }

  // The generation of the object a write created or found.
  private generation(key: string, versionId: string | undefined, sha256: string): string {
    // "null" is the version id of an object written while the bucket was unversioned or suspended.
    if (versionId && versionId !== 'null') return `${this.flavor}:${versionId}`;
    if (this.versioning === 'off') return contentGeneration(sha256);
    throw new BlobStoreVersioningError(this.bucket, key);
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<string> {
    assertStorageKey(key);
    const digest = createHash('sha256').update(bytes).digest();
    const sha256 = digest.toString('hex');
    assertContentAddress(key, sha256);
    const checksum = digest.toString('base64');

    let retriedMissing = false;
    for (let attempt = 1; ; attempt++) {
      let confirmed: string | undefined;
      let versionId: string | undefined;
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
        versionId = out.VersionId;
      } catch (error) {
        const status = httpStatus(error);
        // The key already holds an object: accept it only if it has exactly these bytes, and record the version
        // that holds them. If it was deleted between the 412 and the read-back, write it once more.
        if (status === 412) {
          try {
            const current = await this.fetch(key);
            if (sha256Hex(current.bytes) !== sha256) throw new BlobConflictError(key);
            return this.generation(key, current.versionId, sha256);
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
      if (confirmed === checksum) return this.generation(key, versionId, sha256);
      // The server did not confirm the checksum (or confirmed another one): verify what it stored.
      if (confirmed === undefined) {
        const stored = await this.fetch(key, versionId);
        if (sha256Hex(stored.bytes) === sha256) return this.generation(key, versionId ?? stored.versionId, sha256);
      }
      await this.delete(key);
      throw new Error(`stored blob failed its sha256 check: ${key}`);
    }
  }

  private async fetch(key: string, versionId?: string | null): Promise<Fetched> {
    assertStorageKey(key);
    try {
      const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, ...(versionId ? { VersionId: versionId } : {}) }));
      if (!out.Body) throw new BlobNotFoundError(key);
      return { bytes: await out.Body.transformToByteArray(), versionId: out.VersionId };
    } catch (error) {
      if (error instanceof BlobNotFoundError) throw error;
      if (isMissingObject(error)) throw new BlobNotFoundError(key);
      if (httpStatus(error) === 403) throw new BlobStoreAccessError(this.bucket, key, error);
      throw error;
    }
  }

  // A versioned generation reads exactly that version; a missing version is a missing blob, never the current one.
  async get(key: string, generation?: string | null): Promise<Uint8Array> {
    return (await this.fetch(key, versionOf(generation))).bytes;
  }

  async delete(key: string): Promise<void> {
    assertStorageKey(key);
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (error) {
      if (!isMissingObject(error)) throw error;
    }
  }

  // Deletes abandoned staging objects (a grant begun and never completed, or bytes posted to a form again after its
  // claim) for buckets without a lifecycle rule on staging/. Lists staging/ page by page and deletes every staging
  // key last modified before `before`, looking at no more than `limit` keys per call; a key without a modification
  // time or outside the staging pattern is left alone. Needs s3:ListBucket and s3:DeleteObject, which the store
  // already requires. On a versioned bucket a delete leaves the object as a noncurrent version behind a delete
  // marker, which only a lifecycle rule (or the operator) removes: Crove holds no s3:DeleteObjectVersion, so it can
  // never delete a version of evidence.
  async sweepStaging(before: Date, limit: number): Promise<StagingSweep> {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('invalid sweep limit');
    const cutoff = before.getTime();
    let listed = 0;
    let deleted = 0;
    let token: string | undefined;
    for (;;) {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: 'staging/',
          MaxKeys: Math.min(LIST_PAGE, limit - listed),
          ...(token ? { ContinuationToken: token } : {}),
        }),
      );
      const contents = page.Contents ?? [];
      listed += contents.length;
      const stale = contents
        .filter((o) => o.Key !== undefined && isStagingKey(o.Key) && o.LastModified !== undefined && o.LastModified.getTime() < cutoff)
        .map((o) => o.Key as string);
      for (let i = 0; i < stale.length; i += SWEEP_DELETES_IN_FLIGHT) {
        await Promise.all(stale.slice(i, i + SWEEP_DELETES_IN_FLIGHT).map((k) => this.delete(k)));
      }
      deleted += stale.length;
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
      if (!token) return { deleted, more: false };
      // An empty page that still claims more is not progress; stop rather than loop.
      if (listed >= limit || contents.length === 0) return { deleted, more: true };
    }
  }

  // Presigned POST (not PUT): only a POST policy can bound the size (content-length-range). The policy pins the
  // exact staging key and the bucket and expires after UPLOAD_TTL_SECONDS.
  private async presignUpload(presigner: S3Client, key: string, maxBytes: number): Promise<PresignedUpload> {
    if (!isStagingKey(key)) throw new Error('invalid staging key');
    if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error('invalid upload size limit');
    const issued = Date.now();
    const { url, fields } = await createPresignedPost(presigner, {
      Bucket: this.bucket,
      Key: key,
      Conditions: [['content-length-range', 1, maxBytes]],
      Expires: UPLOAD_TTL_SECONDS,
    });
    return { url, fields, expiresAt: new Date(issued + UPLOAD_TTL_SECONDS * 1000), maxBytes };
  }

  private async presignDownload(presigner: S3Client, ref: BlobRef, file: { filename: string; contentType: string }): Promise<string | null> {
    assertStorageKey(ref.key);
    const version = versionOf(ref.generation);
    if (!version) return null;
    return getSignedUrl(
      presigner,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: ref.key,
        VersionId: version,
        ResponseContentDisposition: attachment(file.filename),
        ResponseContentType: file.contentType,
        ResponseCacheControl: 'private, no-store',
      }),
      { expiresIn: DOWNLOAD_TTL_SECONDS },
    );
  }

  // Streams the staged object through sha256 and a byte count, and stops reading as soon as it passes maxBytes.
  private async readStaged(key: string, maxBytes: number): Promise<{ bytes: Uint8Array; sha256: string }> {
    if (!isStagingKey(key)) throw new Error('invalid staging key');
    let out;
    try {
      out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (error) {
      if (isMissingObject(error)) throw new BlobNotFoundError(key);
      if (httpStatus(error) === 403) throw new BlobStoreAccessError(this.bucket, key, error);
      throw error;
    }
    if (!out.Body) throw new BlobNotFoundError(key);
    const stream = out.Body.transformToWebStream();
    if (out.ContentLength !== undefined && out.ContentLength > maxBytes) {
      await stream.cancel().catch(() => undefined);
      throw new BlobTooLargeError(key, maxBytes);
    }
    const hash = createHash('sha256');
    // One buffer of the declared length (or of the cap when none is declared), filled in place, so the body is held
    // once; never more than maxBytes.
    let buffer = new Uint8Array(out.ContentLength ?? Math.min(maxBytes, 1024 * 1024));
    let size = 0;
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new BlobTooLargeError(key, maxBytes);
      }
      if (size + value.byteLength > buffer.byteLength) {
        const grown = new Uint8Array(Math.min(maxBytes, Math.max(buffer.byteLength * 2, size + value.byteLength)));
        grown.set(buffer.subarray(0, size));
        buffer = grown;
      }
      hash.update(value);
      buffer.set(value, size);
      size += value.byteLength;
    }
    return { bytes: size === buffer.byteLength ? buffer : buffer.slice(0, size), sha256: hash.digest('hex') };
  }
}
