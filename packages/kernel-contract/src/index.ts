export * from './schemas.ts';
export * from './contract.ts';
export * from './opening-balance.ts';
export * from './accounts.ts';
export * from './tax-code.ts';
export * from './portal-list.ts';

export const ORG_HEADER = 'x-crove-org';
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const ACCEPTED_UPLOAD_TYPES = ['application/xml', 'text/xml', 'application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
// Bulk intake (#314): a ZIP of documents, up to MAX_UPLOAD_BYTES like any document. It is stored as a file, opened in
// the parsing sandbox by the worker, and every entry the sandbox returns becomes a document of its own.
export const ACCEPTED_ARCHIVE_TYPES = ['application/zip'];
// Images for Social posts (#372): an upload with purpose=social takes these only.
export const SOCIAL_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
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
export const STREAM_HINT_TYPES = ['proposal', 'file', 'extraction', 'journal_entry', 'document', 'social_post'] as const;
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
