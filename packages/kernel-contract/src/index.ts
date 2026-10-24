export * from './schemas.ts';
export * from './contract.ts';
export * from './opening-balance.ts';
export * from './accounts.ts';
export * from './tax-code.ts';
export * from './legal-entity.ts';
export * from './cash-voucher.ts';
export * from './journal-voucher.ts';
export * from './personal-data.ts';
export * from './portal-list.ts';
export * from './portal-sync.ts';
export * from './vat-deadline.ts';
export * from './tax-calendar.ts';
export * from './vietnam-time.ts';
export * from './bank-statement.ts';
export * from './timeline.ts';
export * from './audit.ts';

export const ORG_HEADER = 'x-crove-org';
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
// When the store takes presigned uploads, files of at most this size still go through the kernel (POST /api/files):
// bulk intake (#314) sends a batch of 200 e-invoice XML files that way instead of opening 200 upload grants. The
// kernel refuses larger files on that path (#432); they go through a staged upload (POST /api/files/uploads).
export const DIRECT_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;
export const ACCEPTED_UPLOAD_TYPES = ['application/xml', 'text/xml', 'application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
// Bulk intake (#314): a ZIP of documents, up to MAX_UPLOAD_BYTES like any document. It is stored as a file, opened in
// the parsing sandbox by the worker, and every entry the sandbox returns becomes a document of its own.
export const ACCEPTED_ARCHIVE_TYPES = ['application/zip'];
// Inbound email (#432): a ZIP attached to a message is opened like an uploaded one, but bounded, since anyone who knows
// the org's address can send mail: at most MAX_EMAIL_ARCHIVES ZIPs of a message are kept, and an emailed ZIP files at
// most MAX_EMAIL_ARCHIVE_DOCUMENTS documents (an e-invoice ZIP holds its XML and PDF; a month of invoices is uploaded).
export const MAX_EMAIL_ARCHIVES = 2;
export const MAX_EMAIL_ARCHIVE_DOCUMENTS = 20;
// Images for Social posts (#372).
export const SOCIAL_PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
// PDFs for LinkedIn document posts (#1119), read from the bytes (%PDF-) like any upload. Stored with source 'social',
// so never sent to extraction, and never given to the image steps (the size from its header, the watermark, AI alt
// text), which each take image types only.
export const SOCIAL_DOCUMENT_TYPES = ['application/pdf'];
// Every file but a video an upload with purpose=social takes: the HTTP edge (ingest in apps/kernel/src/http.ts) checks
// the type it reads from the bytes against this list, with the 25 MB cap of a document. It keeps the name it had when
// it held images only; SOCIAL_PHOTO_TYPES is the images alone.
export const SOCIAL_IMAGE_TYPES = [...SOCIAL_PHOTO_TYPES, ...SOCIAL_DOCUMENT_TYPES];
// Videos for Social posts (#409): MP4 and QuickTime, up to 100 MB (a staged upload grant allows at most that), at most
// 3 hours long. The server reads the type and the duration from the file itself.
export const SOCIAL_VIDEO_TYPES = ['video/mp4', 'video/quicktime'];
export const MAX_SOCIAL_VIDEO_BYTES = 100 * 1024 * 1024;
export const MAX_SOCIAL_VIDEO_MS = 3 * 3600 * 1000;
// import: a spreadsheet for a module's import (the tax portal's purchase list, #465). Stored with source 'import' and
// never read as a document; the module that imports it has it read in the parsing sandbox.
export const UPLOAD_PURPOSES = ['document', 'social', 'import'] as const;
// An import spreadsheet is an .xlsx workbook (a ZIP container) of at most this size.
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
export const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export type UploadPurpose = (typeof UPLOAD_PURPOSES)[number];

// Realtime invalidation (issue #69): GET /api/stream sends hints `{ type, id }` only, never row data; the SPA re-fetches
// through the normal authorized queries. extraction carries the id of the file whose reading changed, and document
// both a recorded and a voided purchase document.
export const STREAM_HINT_TYPES = ['proposal', 'file', 'extraction', 'journal_entry', 'document', 'social_post', 'social_notification', 'notification'] as const;
export type StreamHintType = (typeof STREAM_HINT_TYPES)[number];
export interface StreamHint {
  type: StreamHintType;
  id: string;
}
// Why the server ended a stream (event `close`): the session ended or MFA is now required (re-authenticate), the
// user is no longer a member of the org, the access token expired (reconnect with a fresh one), the server could not
// re-check the session (reconnect later), or the server is shutting down.
export const STREAM_CLOSE_REASONS = ['session', 'session_revoked_in_org', 'mfa', 'membership', 'expired', 'unavailable', 'shutdown'] as const;
export type StreamCloseReason = (typeof STREAM_CLOSE_REASONS)[number];
export * from './fixed-asset.ts';
export * from './statements-htkk.ts';
export * from './brand.ts';
