// Images the API fetches from outside and stores like an upload, for Social: Pexels' stock photos (#1106) and the CSV
// import's image URLs (#1258). The type is read from the bytes (JPEG, PNG or WEBP, what every channel takes), the bytes
// are stored create-only under org/<org_id>/<sha256> as uploads are, and the file row is described for
// kernel.file.ingest with the image's size as shown (#636). The caller fetches through the egress guard and records the
// row.
import { SOCIAL_PHOTO_TYPES } from '@crove/kernel-contract';
import { fileKey, putFile, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { imageSize } from './media-probe.ts';
import { safeFilename, sniffType } from './sniff.ts';

const mimeOf = (contentType: string | null) => (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';

// The photo type of the bytes, or null when a post does not take them. With strict, an answer that declares another
// type is refused too (Pexels' image host always declares the right one); otherwise the bytes alone decide, as for an
// upload, since many hosts declare application/octet-stream or nothing.
export function photoType(bytes: Uint8Array, declared: string | null, strict: boolean): string | null {
  const type = sniffType(bytes);
  if (!type || !SOCIAL_PHOTO_TYPES.includes(type)) return null;
  const said = mimeOf(declared);
  if (strict && said !== '' && said !== type) return null;
  return type;
}

// What kernel.file.ingest records for stored bytes (source 'social' is the caller's).
export interface StoredPhoto {
  filename: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  storageKey: string;
  generation: string;
  imageWidth?: number;
  imageHeight?: number;
}

// Stores a photo's bytes for the org and describes its file row; name is the file's name without its extension.
export async function storePhoto(store: BlobStore, orgId: string, bytes: Buffer, type: string, name: string): Promise<StoredPhoto> {
  const shown = imageSize(bytes, type);
  const sha256 = sha256Hex(bytes);
  const storageKey = fileKey(orgId, sha256);
  const generation = await putFile(store, storageKey, bytes, type, sha256);
  return { filename: safeFilename(name, type), contentType: type, sizeBytes: bytes.byteLength, sha256, storageKey, generation, ...(shown ? { imageWidth: shown.width, imageHeight: shown.height } : {}) };
}
