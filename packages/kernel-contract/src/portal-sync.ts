// The assisted purchase-invoice sync from the tax portal (issue #325, ADR-0036). The accountant starts it for one client
// (the org) and one VAT period, solves the portal's CAPTCHA and types the portal password in Crove; the server logs in
// to the portal and fetches that period's purchase list (and the invoice XML the portal has) into the reconciliation and
// the Inbox. Crove never stores the password and never solves a CAPTCHA by software. These are the shapes the API and
// the SPA share; the steps run in order, each one a bounded request:
//   captcha   a CAPTCHA image from the portal and a sealed challenge bound to this user, org and period;
//   login     the portal login with the challenge, the answer and the password; answers a sealed portal session
//             (opaque to the browser, bound to this user, org and period, expiring) and nothing else;
//   fetchList the period's purchase list through the session, filed as a list of the period (the worker records it);
//   fetchXml  a few invoice XML files at a time, for invoices of that list Crove does not have yet.
import { z } from 'zod';
import { zId, zVatPeriod } from './schemas.ts';

// How long the sealed values stay usable. The portal's own CAPTCHA lasts about two minutes and its session token is
// short-lived (docs/research/tax-portal-invoice-sync.md section 2.1); Crove's envelopes never outlive these.
export const PORTAL_CHALLENGE_SECONDS = 120;
export const PORTAL_SESSION_SECONDS = 20 * 60;
// Invoice XML downloads per fetchXml request, and per sync in all (the rest waits for the next sync).
export const PORTAL_XML_PER_REQUEST = 5;
export const PORTAL_XML_PER_SYNC = 300;
// The longest password and CAPTCHA answer accepted (the portal's own fields are short).
export const PORTAL_PASSWORD_MAX = 128;
export const PORTAL_CAPTCHA_MAX = 16;

// A sealed value the server made and only the server can open: base64url, a key id and an envelope.
// Room for a portal token of up to 8 KB sealed and base64url-encoded.
const zSealed = z.string().min(16).max(16_384).regex(/^[A-Za-z0-9_.-]+$/);

export const zPortalCaptcha = z.object({
  challenge: zSealed,
  // The portal's CAPTCHA as a data: URL of an SVG image, shown in an <img> (scripts in an image never run).
  image: z.string().startsWith('data:image/svg+xml;base64,').max(300_000),
  // The portal user name: the org's tax code. The login uses it; the browser only shows it.
  username: z.string(),
  expiresInSeconds: z.number().int().positive(),
});
export type PortalCaptchaView = z.infer<typeof zPortalCaptcha>;

export const zPortalLoginInput = z.object({
  period: zVatPeriod,
  challenge: zSealed,
  captcha: z.string().trim().min(1).max(PORTAL_CAPTCHA_MAX),
  password: z.string().min(1).max(PORTAL_PASSWORD_MAX),
  // The accountant confirms the client agreed to this use of its portal account (recorded in the audit row).
  consent: z.literal(true),
});

export const zPortalSession = z.object({ session: zSealed, expiresInSeconds: z.number().int().positive() });

export const zPortalListResult = z.object({
  listId: zId,
  // The same answer as the last sync of the period: no new list was made.
  unchanged: z.boolean(),
  rows: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  ownSales: z.number().int().nonnegative(),
  otherBuyers: z.number().int().nonnegative(),
  // Invoices of the list the portal has an XML for (fetchXml downloads those Crove has no invoice for yet).
  withXml: z.number().int().nonnegative(),
});
export type PortalListResult = z.infer<typeof zPortalListResult>;

export const zPortalXmlResult = z.object({
  downloaded: z.number().int().nonnegative(),
  duplicates: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
  done: z.boolean(),
  // The worker is still recording the list: ask again in a moment.
  waiting: z.boolean(),
});
export type PortalXmlResult = z.infer<typeof zPortalXmlResult>;

// The error codes the steps answer with, each with a Vietnamese message the screen shows as it is.
export const PORTAL_SYNC_ERRORS = [
  'PORTAL_SYNC_DISABLED',
  'TAX_CODE_REQUIRED',
  'PORTAL_CHALLENGE_INVALID',
  'PORTAL_SESSION_INVALID',
  'PORTAL_SESSION_EXPIRED',
  'PORTAL_WRONG_CAPTCHA',
  'PORTAL_WRONG_PASSWORD',
  'PORTAL_ACCOUNT_LOCKED',
  'PORTAL_PASSWORD_GUARD',
  'PORTAL_RATE_LIMITED',
  'PORTAL_BLOCKED',
  'PORTAL_UNAVAILABLE',
  'PORTAL_BAD_ANSWER',
  'PORTAL_LIST_TOO_LARGE',
  'PORTAL_SYNC_BUSY',
  'RATE_LIMITED',
] as const;
export type PortalSyncError = (typeof PORTAL_SYNC_ERRORS)[number];
