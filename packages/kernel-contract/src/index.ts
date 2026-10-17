export * from './schemas.ts';
export * from './contract.ts';

export const ORG_HEADER = 'x-crove-org';
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const ACCEPTED_UPLOAD_TYPES = ['application/xml', 'text/xml', 'application/pdf', 'image/jpeg', 'image/png', 'image/webp'];

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
