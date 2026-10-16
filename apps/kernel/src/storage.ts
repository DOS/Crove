import { LocalDiskStore, S3BlobStore, type BlobStore } from '@crove/kernel-runtime';
import type { Config } from './config.ts';

// The one place that turns configuration into a blob store. The API and the worker both call it, so split
// roles read and write the same objects.
export function createBlobStore(config: Config): BlobStore {
  if (config.STORAGE === 'local') return new LocalDiskStore(config.STORAGE_DIR);
  if (!config.S3_BUCKET) throw new Error('STORAGE=s3 needs S3_BUCKET');
  return S3BlobStore.connect({
    bucket: config.S3_BUCKET,
    region: config.S3_REGION,
    endpoint: config.S3_ENDPOINT,
    accessKeyId: config.S3_ACCESS_KEY_ID,
    secretAccessKey: config.S3_SECRET_ACCESS_KEY,
    forcePathStyle: config.S3_FORCE_PATH_STYLE === 'true',
    versioning: config.S3_VERSIONING,
    presign: config.S3_PRESIGNED_URLS === 'true',
    publicEndpoint: config.S3_PUBLIC_ENDPOINT,
  });
}

// The origin browsers reach for presigned transfers, for the app's Content-Security-Policy (connect-src). null when
// transfers stream through the kernel.
export function directTransferOrigin(config: Config): string | null {
  if (config.STORAGE !== 's3' || config.S3_PRESIGNED_URLS !== 'true') return null;
  const endpoint = config.S3_PUBLIC_ENDPOINT ?? config.S3_ENDPOINT;
  if (!endpoint) {
    const host = `s3.${config.S3_REGION}.amazonaws.com`;
    return config.S3_FORCE_PATH_STYLE === 'true' ? `https://${host}` : `https://${config.S3_BUCKET}.${host}`;
  }
  const url = new URL(endpoint);
  // Virtual-hosted style puts the bucket in the host name.
  return config.S3_FORCE_PATH_STYLE === 'true' ? url.origin : `${url.protocol}//${config.S3_BUCKET}.${url.host}`;
}

// For the startup log: where blobs go, never the credentials.
export function describeStorage(config: Config): string {
  if (config.STORAGE === 'local') return `local disk ${config.STORAGE_DIR}`;
  const where = config.S3_ENDPOINT ? new URL(config.S3_ENDPOINT).host : `AWS ${config.S3_REGION}`;
  const versioning = config.S3_VERSIONING === 'required' ? 'versions required' : 'versioning off (sha256 checks only)';
  const transfers = config.S3_PRESIGNED_URLS === 'true' ? 'presigned transfers' : 'transfers through the kernel';
  return `s3 bucket ${config.S3_BUCKET} at ${where}, ${versioning}, ${transfers}`;
}
