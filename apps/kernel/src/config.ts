import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { EXTRACT_TIMING } from '@crove/extract-contract';
import type { UsageLimits } from '@crove/kernel';
import { SIGNUP_POLICIES, parseAllowedDomains } from './auth-signup-policy.ts';
import { WEBHOOK_ENV } from './alert.ts';
import { exportSealer } from './export-seal.ts';

// The product name when BRAND_NAME is unset (#1040).
export const DEFAULT_BRAND_NAME = 'Ludy';
const BRAND_NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{M}\p{N} .,&'+_!()-]*$/u;

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

// Modules this build ships (plan Decision 12, ADR-0031). kernel is always on; the others are on unless CROVE_MODULES
// leaves them out.
export const AVAILABLE_MODULES = ['kernel', 'finance', 'social', 'crm', 'notes'] as const;
export type ModuleId = (typeof AVAILABLE_MODULES)[number];

// CROVE_MODULES: a comma-separated list such as `finance`. Unset or empty enables every available module; kernel is
// added when missing. An unknown name stops the boot, so a typo never silently turns a module off. The prober reads it
// too, as the modules the deployment runs (#1894).
export const modulesSetting = optional.transform((value, ctx): readonly ModuleId[] => {
  if (value === undefined) return AVAILABLE_MODULES;
  const names = value
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  // Only separators (",", " , ") names no module: the same as empty, so every module.
  if (names.length === 0) return AVAILABLE_MODULES;
  const unknown = names.filter((name) => !(AVAILABLE_MODULES as readonly string[]).includes(name));
  if (unknown.length > 0) {
    ctx.addIssue({ code: 'custom', message: `unknown module(s) ${unknown.join(', ')}; available: ${AVAILABLE_MODULES.join(', ')}` });
    return z.NEVER;
  }
  return AVAILABLE_MODULES.filter((module) => module === 'kernel' || names.includes(module));
});

// The extract jobs a worker runs at once when EXTRACT_WORKER_CONCURRENCY is unset (#2119): the AI call, 10 to 20 s for a PDF
// that needs it, is what the parallelism hides.
export const DEFAULT_EXTRACT_WORKER_CONCURRENCY = 4;

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  // Loopback by default; the Docker image sets 0.0.0.0 and compose publishes the port on loopback.
  HOST: z.string().default('127.0.0.1'),
  // Number of reverse proxies in front of Crove whose X-Forwarded-For entries are trusted (0 = none).
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  PUBLIC_URL: z.string().default('http://localhost:8080'),
  // Which modules' commands, queries, jobs, routes and menus this deployment registers. Migrations still apply to
  // every schema (one linear ledger); per-org access is entitlements (Decision 10), not this setting.
  CROVE_MODULES: modulesSetting,
  DATABASE_URL: z.string().min(1),
  WORKER_DATABASE_URL: optional,
  // Reset each pooled connection's session before it goes back to the pool (#117, plan §3.3). Keep true for direct
  // connections (self-host); set false only behind a transaction-mode pooler (PgBouncer, Supavisor), where the reset
  // would reach another server connection and the pooler's own reset governs.
  DB_RESET_ON_RELEASE: z.enum(['true', 'false']).default('true'),
  ADMIN_DATABASE_URL: optional,
  MIGRATIONS_DIR: z.string().default(here('../../../supabase/migrations')),
  // How long `migrate` waits for another run's migration lock before it fails; unset waits as long as it takes (#1803).
  // Empty (a compose `${VAR:-}`) counts as unset; coerced, it would be 0 and fail every role's config.
  MIGRATE_LOCK_WAIT_SECONDS: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.coerce.number().int().positive().optional()),
  WEB_DIST: z.string().default(here('../../app/dist')),
  // Blob storage (External-tenant gate T7): local disk under STORAGE_DIR, or any S3-compatible store. The API
  // and the worker must point at the same store; with s3 they need no shared volume.
  STORAGE: z.enum(['local', 's3']).default('local'),
  STORAGE_DIR: z.string().default(here('../../../.data/files')),
  // Unset for AWS S3; the server's URL for MinIO, Cloudflare R2 or GCS interoperability.
  S3_ENDPOINT: optional.pipe(z.url({ protocol: /^https?$/ }).optional()),
  // R2 uses auto.
  S3_REGION: optional.transform((v) => v ?? 'us-east-1'),
  S3_BUCKET: optional.pipe(
    z
      .string()
      .regex(/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/)
      .optional(),
  ),
  // Both or neither: without them the SDK's default chain applies (environment, instance or workload identity).
  S3_ACCESS_KEY_ID: optional,
  S3_SECRET_ACCESS_KEY: optional,
  // Path-style URLs (endpoint/bucket/key), needed by MinIO and most self-hosted servers.
  S3_FORCE_PATH_STYLE: z.enum(['true', 'false']).default('false'),
  // Evidence integrity (ADR-0013): required (the default) refuses a write the bucket returns without an object
  // version, so the bucket must have versioning enabled; off accepts an unversioned bucket (for example Cloudflare
  // R2) and then relies on the sha256 check alone.
  S3_VERSIONING: z.enum(['required', 'off']).default('required'),
  // Browsers upload to a staging key and download through presigned URLs (plan §7.6). The bucket needs a CORS rule
  // for PUBLIC_URL (POST and GET). false keeps every transfer streaming through the kernel; Cloudflare R2 needs false
  // (it has no POST policy uploads, so Crove refuses to start with true on an R2 endpoint).
  S3_PRESIGNED_URLS: z.enum(['true', 'false']).default('true'),
  // The S3 endpoint browsers reach, when it differs from S3_ENDPOINT (presigned URLs are signed for this host). On a
  // public PUBLIC_URL it must be https: it is where browsers send files, and it lands in the CSP connect-src.
  S3_PUBLIC_ENDPOINT: optional.pipe(z.url({ protocol: /^https?$/ }).optional()),
  // The WORM fact stream (plan §4.10, issue #891, worm.ts): where the worker anchors audit events and journal entries.
  // s3: ARCHIVE_S3_BUCKET, a bucket with Object Lock, reached with the S3_ENDPOINT, S3_REGION, credentials and path
  // style above; objects are locked in ARCHIVE_LOCK_MODE for ARCHIVE_RETENTION_DAYS. local: read-only files under
  // ARCHIVE_DIR, which whoever controls the host can still rewrite (docs/runbooks/worm-archive.md).
  ARCHIVE_STORE: z.enum(['local', 's3']).default('local'),
  ARCHIVE_DIR: z.string().default(here('../../../.data/archive')),
  ARCHIVE_S3_BUCKET: optional,
  ARCHIVE_LOCK_MODE: z.enum(['GOVERNANCE', 'COMPLIANCE']).default('GOVERNANCE'),
  ARCHIVE_RETENTION_DAYS: z.coerce.number().int().min(1).max(36_500).default(3650),
  // How long after a row is written it is archived at the earliest, so a transaction still open is not cut off.
  ARCHIVE_LAG_SECONDS: z.coerce.number().int().min(60).max(86_400).default(600),
  // Days the nightly verifier alerts, on every run, about the restore acknowledgement in force after the store wrote it
  // (#2020, docs/runbooks/worm-archive.md).
  ARCHIVE_RESTORE_ALERT_DAYS: z.coerce.number().int().min(1).max(365).default(14),
  // Fiscal year archive packages (issue #922) in the STORAGE=s3 bucket: lock each part in ARCHIVE_LOCK_MODE for this
  // many days (the bucket needs Object Lock). 0: the bucket's default retention, if any. Local disk has no lock.
  S3_ARCHIVE_LOCK_DAYS: z.coerce.number().int().min(0).max(36_500).default(0),
  // Retention holds on evidence files (issue #1009): the original file of every posted invoice is held in the STORAGE=s3
  // bucket for this many days from its posting, in GOVERNANCE mode (the bucket needs Object Lock). 3650 (10 years,
  // Accounting Law 88/2015 Art. 41) until the accountant says otherwise; raising it lengthens existing holds, lowering
  // it never shortens one. 0: no holds. Local disk has no holds.
  EVIDENCE_LOCK_DAYS: z.coerce.number().int().min(0).max(36_500).default(3650),
  // Staged upload completions one API process runs at once (issue #223): each buffers the staged file (up to 25 MB)
  // while it hashes and writes it. Past it, and past half of it for one user, completions answer 503 UPLOAD_BUSY with
  // Retry-After and their grant stays unused. Uploads through POST /api/files (#432) get twice as many slots, on the
  // same terms (bulk intake sends its documents three at a time).
  UPLOAD_COMPLETE_CONCURRENCY: z.coerce.number().int().min(1).max(256).default(4),
  // Presigned upload grants (kernel.file.upload.begin) one user may open per org in any rolling minute, counted in the
  // database across API instances (issue #223). Bounds the staging objects an abandoned upload loop leaves behind.
  UPLOAD_BEGIN_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(1000).default(20),
  // Org exports (issue #212, plan §7.9): kept EXPORT_RETENTION_DAYS (35 to 90) after they are made, then deleted by the
  // worker's daily retention job.
  EXPORT_RETENTION_DAYS: z.coerce.number().int().min(35).max(90).default(35),
  // The operator's org-purge role (issue #1024) runs only this many days after the org's newest export. The database
  // refuses fewer than 30 whatever this says.
  ORG_PURGE_MIN_DAYS: z.coerce.number().int().min(30).max(3650).default(30),
  // The AES-256-GCM key that seals org exports at rest: 32 random bytes as base64 or hex (openssl rand -base64 32). The
  // API (downloads) and the worker (exports) need the same key. Required on a public PUBLIC_URL; without it (local URLs
  // only) exports are stored unencrypted.
  EXPORT_ENCRYPTION_KEY: optional,
  // Earlier keys, comma separated, kept only to read exports sealed before a rotation, until those expired.
  EXPORT_ENCRYPTION_KEY_PREVIOUS: optional,
  // Supabase Auth (GoTrue). Self-host: the kernel proxies /auth/v1 to AUTH_UPSTREAM_URL.
  AUTH_UPSTREAM_URL: optional,
  PUBLIC_AUTH_URL: optional,
  PUBLIC_AUTH_ANON_KEY: optional,
  AUTH_JWT_SECRET: optional,
  // The context token key (#1822, ADR-0028 section 9): base64 of 32 to 64 random bytes (`node dist/main.js
  // context-token-key` prints one). The same value goes to the migrate step, which installs it in the database, and to
  // the kernel, which signs a token with it for every user context it enters. Unset: today's enter_context.
  CROVE_CONTEXT_TOKEN_KEY: optional,
  AUTH_JWKS_URL: optional,
  // Required (ADR-0028): the `iss` every access token must carry. Bundled Supabase Auth: GOTRUE_JWT_ISSUER.
  AUTH_ISSUER: optional,
  AUTH_AUDIENCE: z.string().default('authenticated'),
  // Session status source (ADR-0028): db reads Supabase Auth's tables in the shared database (self-host); jwt
  // (Crove Cloud, or any remote Supabase Auth) trusts the verified token until its exp, plus Crove's own session
  // records, and confirms every R3 command live with Supabase Auth; off checks only Crove's own records and never
  // calls Auth (local URLs only). Unset: db when AUTH_UPSTREAM_URL is set (bundled Supabase Auth), jwt otherwise.
  AUTH_SESSION_CHECK: z.enum(['db', 'jwt', 'off']).optional(),
  // Policy P11: R3 needs MFA in the last 5 minutes. off is accepted on local URLs only.
  AUTH_STEP_UP: z.enum(['required', 'off']).default('required'),
  // Mirrors GOTRUE_MAILER_AUTOCONFIRM so the kernel can refuse unsafe public deployments.
  AUTH_AUTOCONFIRM: z.enum(['true', 'false']).default('false'),
  // Per-client budget for the emails the bundled Supabase Auth sends (sign-up confirmation, recovery, magic link and
  // OTP codes, resend, email change, reauthentication), enforced by the /auth/v1 proxy in the database across API
  // instances (#190): at most AUTH_EMAIL_CLIENT_LIMIT_PER_HOUR per client address (IPv6: per /64) in any rolling
  // hour, and one per recipient every AUTH_EMAIL_ADDRESS_INTERVAL_SECONDS. AUTH_RATE_LIMIT_EMAIL_SENT is Supabase
  // Auth's deployment-wide budget (GOTRUE_RATE_LIMIT_EMAIL_SENT, per hour); when set, a public deployment refuses to
  // start unless it takes at least EMAIL_BUDGET_MIN_CLIENTS client addresses to use it up.
  // Who may create an account (#350), enforced by the /auth/v1 proxy in front of the bundled Supabase Auth: open (the
  // default; AUTH_DISABLE_SIGNUP still closes sign-up), invite_only (an email with a valid member invite) or allowlist
  // (an email at one of AUTH_SIGNUP_ALLOWED_DOMAINS, comma separated, or with a valid invite). See auth-signup-policy.ts.
  AUTH_SIGNUP_POLICY: optional.pipe(z.enum(SIGNUP_POLICIES).optional()).transform((v) => v ?? 'open'),
  AUTH_SIGNUP_ALLOWED_DOMAINS: optional.transform((value, ctx): readonly string[] => {
    if (value === undefined) return [];
    const { domains, invalid } = parseAllowedDomains(value);
    if (invalid.length > 0) {
      ctx.addIssue({ code: 'custom', message: `not a domain: ${invalid.join(', ')}` });
      return z.NEVER;
    }
    return domains;
  }),
  // Under allowlist, a sign-up at an allowed domain is refused when the address holds an invite and the request lacks
  // its token, so a refusal tells that the address is invited (#564). At most AUTH_SIGNUP_REFUSAL_LIMIT_PER_HOUR such
  // refusals per client (an IPv4 address or an IPv6 /48) and AUTH_SIGNUP_REFUSAL_GLOBAL_LIMIT_PER_HOUR for the whole
  // deployment (0, the default: no deployment limit, since a member who may invite could fill it) in any rolling hour;
  // past either, those sign-ups get 429. Unset or blank takes the default.
  AUTH_SIGNUP_REFUSAL_LIMIT_PER_HOUR: optional
    .transform((v) => (v === undefined ? 5 : Number(v)))
    .pipe(z.number().int().min(1).max(100_000)),
  AUTH_SIGNUP_REFUSAL_GLOBAL_LIMIT_PER_HOUR: optional
    .transform((v) => (v === undefined ? 0 : Number(v)))
    .pipe(z.number().int().min(0).max(100_000)),
  AUTH_EMAIL_CLIENT_LIMIT_PER_HOUR: z.coerce.number().int().min(1).max(100_000).default(5),
  AUTH_EMAIL_ADDRESS_INTERVAL_SECONDS: z.coerce.number().int().min(0).max(3600).default(60),
  AUTH_RATE_LIMIT_EMAIL_SENT: optional
    .transform((v) => (v === undefined ? undefined : Number(v)))
    .pipe(z.number().int().min(1).max(1_000_000).optional()),
  // Per-user limits on creating orgs (External-tenant gate T4), enforced in the database across API instances:
  // at most ORG_CREATE_LIMIT_PER_DAY in any rolling 24 hours and ORG_CREATE_LIMIT_TOTAL ever (closed orgs count).
  ORG_CREATE_LIMIT_PER_DAY: z.coerce.number().int().min(1).max(999_999).default(5),
  ORG_CREATE_LIMIT_TOTAL: z.coerce.number().int().min(1).max(999_999).default(20),
  // Per-org limits on rotating the inbound email address (#113), enforced in the database across API instances:
  // at most INBOUND_ROTATE_LIMIT_PER_DAY in any rolling 24 hours and INBOUND_ROTATE_LIMIT_TOTAL ever. Every rotation
  // leaves a permanent tombstone, so the total bounds the ledger.
  INBOUND_ROTATE_LIMIT_PER_DAY: z.coerce.number().int().min(1).max(999_999).default(3),
  INBOUND_ROTATE_LIMIT_TOTAL: z.coerce.number().int().min(1).max(999_999).default(50),
  // Member invite mails one address may get in any 24 hours from all orgs together (#185), enforced in the database
  // across API instances, on top of the per-org limits (50 invites per org and 3 per email in any 24 hours). An
  // org's first invite of an address in the window always passes; only repeats are refused.
  INVITE_LIMIT_PER_RECIPIENT_PER_DAY: z.coerce.number().int().min(1).max(1000).default(5),
  // Per-org abuse limits (#675), counted in the database over any 24 hours and enforced by the worker: an inbound
  // message or a document over a limit is kept and handled once the org is back under it, and its owners get a mail.
  // ORG_LIMIT_AI_COST_PER_DAY is in the unit of AI_PRICE_INPUT_PER_MTOK and AI_PRICE_OUTPUT_PER_MTOK (the price of one
  // million input and output tokens, for example USD); with no prices AI cost counts as zero and only pages bound it.
  ORG_LIMIT_INBOUND_EMAILS_PER_DAY: z.coerce.number().int().min(1).max(999_999).default(300),
  ORG_LIMIT_ATTACHMENT_MB_PER_DAY: z.coerce.number().int().min(1).max(999_999).default(1000),
  ORG_LIMIT_EXTRACTION_PAGES_PER_DAY: z.coerce.number().int().min(1).max(999_999).default(1500),
  ORG_LIMIT_AI_COST_PER_DAY: z.string().regex(/^\d{1,9}(\.\d{1,6})?$/).default('20'),
  AI_PRICE_INPUT_PER_MTOK: z.string().regex(/^\d{1,6}(\.\d{1,6})?$/).default('0'),
  AI_PRICE_OUTPUT_PER_MTOK: z.string().regex(/^\d{1,6}(\.\d{1,6})?$/).default('0'),
  // Detective security alerts (#996): the worker alerts when one user acts in more than SECURITY_ALERT_ORG_THRESHOLD
  // orgs, or the deployment sees more than SECURITY_ALERT_REFUSAL_THRESHOLD refusals, within
  // SECURITY_ALERT_WINDOW_SECONDS, and on every owner or admin grant; a lasting signal repeats after
  // SECURITY_ALERT_REPEAT_MINUTES. Alerts go to the log, and to ALERT_WEBHOOK_URL when it is set (the prober's chat).
  // The same window holds the operational ALERT lines of each process (a failed export, a stopped sweep: #1993) to one
  // post per kind.
  SECURITY_ALERT_WINDOW_SECONDS: z.coerce.number().int().min(60).max(86_400).default(300),
  SECURITY_ALERT_ORG_THRESHOLD: z.coerce.number().int().min(1).max(1_000_000).default(20),
  SECURITY_ALERT_REFUSAL_THRESHOLD: z.coerce.number().int().min(1).max(1_000_000).default(500),
  SECURITY_ALERT_REPEAT_MINUTES: z.coerce.number().int().min(5).max(10_080).default(60),
  // Back-pressure (#894, plan §4.9): while the oldest unpublished outbox event is older than this, the worker stops
  // fetching agent, bulk mail, archive and retention jobs; interactive work keeps running.
  OUTBOX_LAG_PAUSE_SECONDS: z.coerce.number().int().min(5).max(3600).default(30),
  ALERT_WEBHOOK_URL: WEBHOOK_ENV.ALERT_WEBHOOK_URL,
  ALERT_WEBHOOK_FORMAT: WEBHOOK_ENV.ALERT_WEBHOOK_FORMAT,
  ALERT_TELEGRAM_CHAT_ID: WEBHOOK_ENV.ALERT_TELEGRAM_CHAT_ID,
  ALERT_INSTANCE: WEBHOOK_ENV.ALERT_INSTANCE,
  // Bound on denied/failed audit rows (issue #162), counted in the database across API instances: in each fixed
  // window of REFUSAL_AUDIT_WINDOW_SECONDS, an actor's refusals get an audit row until the actor has
  // REFUSAL_AUDIT_LIMIT_PER_ACTOR or the org REFUSAL_AUDIT_LIMIT_PER_ORG refusals in it; later ones are only counted
  // (crove_kernel.refusal_tally). The first refusal of each command and code of an actor in a window is always audited,
  // so are an actor's first REFUSAL_AUDIT_RESERVE_PER_ACTOR refusals whatever the org's count, and security-relevant
  // refusals (FORBIDDEN, STEP_UP_REQUIRED, 404s and the like) up to the actor's own limit. The worker deletes tally
  // windows older than REFUSAL_TALLY_RETENTION_DAYS.
  REFUSAL_AUDIT_LIMIT_PER_ACTOR: z.coerce.number().int().min(1).max(999_999).default(50),
  REFUSAL_AUDIT_LIMIT_PER_ORG: z.coerce.number().int().min(1).max(999_999).default(500),
  REFUSAL_AUDIT_RESERVE_PER_ACTOR: z.coerce.number().int().min(0).max(999_999).default(10),
  REFUSAL_AUDIT_WINDOW_SECONDS: z.coerce.number().int().min(60).max(86_400).default(3600),
  REFUSAL_TALLY_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(7),
  // The credential key seals channel tokens (ADR-0025): 32 bytes as base64 or 64 hex characters. It never goes in the
  // database. CREDENTIAL_KEY wins; else CREDENTIAL_KEY_FILE names a file holding it, created with a fresh key when
  // missing (the all-in-one container). CREDENTIAL_KEY_PREVIOUS still opens tokens sealed before a rotation
  // (docs/runbooks/credential-key.md). Without a key no channel can be connected.
  CREDENTIAL_KEY: optional,
  CREDENTIAL_KEY_FILE: optional,
  CREDENTIAL_KEY_PREVIOUS: optional,
  // The offline sandbox channel (Social plan §3.5): connect and publish without any platform account.
  CHANNEL_SANDBOX: z.enum(['true', 'false']).default('true'),
  // The offline sandbox bank feed (ADR-0039, #2044): off unless asked for, so a deployment shows no bank feed until it
  // has one.
  BANK_FEED_SANDBOX: z.enum(['true', 'false']).default('false'),
  // The secret the sandbox bank feed's signed notices are checked with (POST /api/bank-feed/bank_sandbox/webhook); unset:
  // the sandbox takes no notices. At least 32 characters.
  BANK_FEED_SANDBOX_WEBHOOK_SECRET: optional,
  // Bluesky (S9): accounts connect with an app password, no app of the deployment's own is needed. On unless false.
  CHANNEL_BLUESKY: z.enum(['true', 'false']).default('true'),
  // Telegram channels (#747): a bot the shop makes with @BotFather posts to its channel; no app of the deployment's own is
  // needed. On unless false.
  CHANNEL_TELEGRAM: z.enum(['true', 'false']).default('true'),
  // Mastodon (#748): an account on any instance connects with an access token made in its settings; every call to an
  // instance goes through the egress guard. On unless false.
  CHANNEL_MASTODON: z.enum(['true', 'false']).default('true'),
  // Discord channels (#832): a server admin makes a webhook in the channel's settings and pastes its URL; no app of the
  // deployment's own is needed. On by default, like Telegram.
  CHANNEL_DISCORD: z.enum(['true', 'false']).default('true'),
  // WordPress sites (#833): a user of a self-hosted or WordPress.com Business site connects with an application password;
  // every call to a site goes through the egress guard. On unless false.
  CHANNEL_WORDPRESS: z.enum(['true', 'false']).default('true'),
  // The deployment's Meta app (Facebook Pages, Social plan S6). Set both to offer Facebook Pages; neither hides them.
  // The app's valid OAuth redirect URI is PUBLIC_URL/channels/oauth/facebook_page/callback.
  CHANNEL_META_APP_ID: optional,
  CHANNEL_META_APP_SECRET: optional,
  CHANNEL_META_GRAPH_VERSION: z.string().regex(/^v\d{1,3}\.\d{1,2}$/).default('v24.0'),
  // The deployment's Zalo app, linked to the OAs it posts for (Social plan S6.4). Set both to offer Zalo OA. The app's
  // callback URL is PUBLIC_URL/channels/oauth/zalo_oa/callback.
  CHANNEL_ZALO_APP_ID: optional,
  CHANNEL_ZALO_APP_SECRET: optional,
  // The deployment's Threads app (the Threads use case of a Meta app has its own id), S9. Callback URL:
  // PUBLIC_URL/channels/oauth/threads/callback.
  CHANNEL_THREADS_APP_ID: optional,
  CHANNEL_THREADS_APP_SECRET: optional,
  // The deployment's LinkedIn app (Share on LinkedIn, Sign In with OpenID Connect), S9. Callback URL:
  // PUBLIC_URL/channels/oauth/linkedin/callback.
  CHANNEL_LINKEDIN_CLIENT_ID: optional,
  CHANNEL_LINKEDIN_CLIENT_SECRET: optional,
  // LinkedIn post counts (#797): true once the LinkedIn app has member post analytics (r_member_postAnalytics).
  CHANNEL_LINKEDIN_ANALYTICS: z.enum(['true', 'false']).default('false'),
  // LinkedIn Company Pages (#1077): true once the LinkedIn app has the Community Management API (w_organization_social,
  // r_organization_admin). Callback URL: PUBLIC_URL/channels/oauth/linkedin_page/callback.
  CHANNEL_LINKEDIN_ORGANIZATIONS: z.enum(['true', 'false']).default('false'),
  // A separate LinkedIn app for Company Pages: LinkedIn grants the Community Management API only to an app with no other
  // product, so a deployment that also posts as members sets these; without them pages use the member app above.
  CHANNEL_LINKEDIN_PAGE_CLIENT_ID: optional,
  CHANNEL_LINKEDIN_PAGE_CLIENT_SECRET: optional,
  // The deployment's Google Cloud project for YouTube uploads (YouTube Data API v3, an OAuth web client), S9. Callback
  // URL: PUBLIC_URL/channels/oauth/youtube/callback.
  CHANNEL_GOOGLE_CLIENT_ID: optional,
  CHANNEL_GOOGLE_CLIENT_SECRET: optional,
  // Google Business Profile posts (#709), with the same Google project once Google has approved it for the Business
  // Profile APIs (Basic API Access). Off by default: an unapproved project gets no answer from them. Callback URL:
  // PUBLIC_URL/channels/oauth/google_business/callback.
  CHANNEL_GOOGLE_BUSINESS: z.enum(['true', 'false']).default('false'),
  // Outside calendars members connect (#2123, #1374): the operator's own Google OAuth web client with the Calendar API
  // enabled (scope calendar.freebusy). Not the project above: it is a different app and consent screen. Callback URL:
  // PUBLIC_URL/calendar/oauth/google_calendar/callback. With neither set, the connect button is not offered.
  CALENDAR_GOOGLE_CLIENT_ID: optional,
  CALENDAR_GOOGLE_CLIENT_SECRET: optional,
  // The deployment's TikTok app (Login Kit and Content Posting API, Direct Post), S9. Callback URL:
  // PUBLIC_URL/channels/oauth/tiktok/callback.
  CHANNEL_TIKTOK_CLIENT_KEY: optional,
  CHANNEL_TIKTOK_CLIENT_SECRET: optional,
  // The TikTok app also has the Display API: connections ask for video.list, and posts' counts are read (#744).
  CHANNEL_TIKTOK_VIDEO_LIST: z.enum(['true', 'false']).default('false'),
  // The TikTok app is approved for video.upload (#903): connections ask for it, and the editor offers sending a video
  // to the creator's TikTok inbox as a draft. Off by default: TikTok refuses a sign-in that asks for a scope the app lacks.
  CHANNEL_TIKTOK_INBOX: z.enum(['true', 'false']).default('false'),
  // The deployment's X app (OAuth 2.0, a confidential client with PKCE), S9; X bills each post to its account.
  // Callback URL: PUBLIC_URL/channels/oauth/x/callback.
  CHANNEL_X_CLIENT_ID: optional,
  CHANNEL_X_CLIENT_SECRET: optional,
  // X post counts (#797): every read is billed by X, so the metrics sweep reads X posts only when this is true.
  CHANNEL_X_METRICS: z.enum(['true', 'false']).default('false'),
  // Pinterest (#798): the deployment's Pinterest app.
  CHANNEL_PINTEREST_APP_ID: optional,
  CHANNEL_PINTEREST_APP_SECRET: optional,
  // Requests per minute per signed-in user on /api (429 RATE_LIMITED with Retry-After past it), per API process; see
  // rate-limit.ts. 0 turns it off, for a deployment whose edge (proxy, CDN or WAF) limits per user instead.
  API_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(0).max(999_999).default(600),
  // Realtime invalidation (issue #69, plan §9): GET /api/stream sends ids of changed records over SSE. Each API process
  // LISTENs on one dedicated connection to DATABASE_LISTEN_URL, which must be a direct or session-mode connection
  // (LISTEN does not work through a transaction-mode pooler such as PgBouncer in transaction mode or Supavisor :6543);
  // unset, DATABASE_URL. STREAM_MAX_CONNECTIONS open streams per process (0 turns streams off and the app polls),
  // STREAM_MAX_PER_USER per user and process. Every STREAM_RECHECK_SECONDS, and after every 50 hints, each stream
  // re-runs the session check and membership of its org and closes when either fails. At most
  // STREAM_RECHECK_CONCURRENCY of those re-checks run at once per process (each takes a connection of the API pool of
  // 10); the others wait their turn, holding their hints.
  DATABASE_LISTEN_URL: optional,
  STREAM_MAX_CONNECTIONS: z.coerce.number().int().min(0).max(100_000).default(500),
  STREAM_MAX_PER_USER: z.coerce.number().int().min(1).max(100).default(5),
  STREAM_RECHECK_SECONDS: z.coerce.number().int().min(5).max(60).default(30),
  STREAM_RECHECK_CONCURRENCY: z.coerce.number().int().min(1).max(10).default(3),
  // Any OpenAI-compatible endpoint. Without it, e-invoice XML still works; PDF/images do not.
  AI_BASE_URL: optional,
  AI_API_KEY: optional,
  AI_MODEL: optional,
  // The model takes images (#817): the composer may ask it for an image's alt text.
  AI_VISION: z.enum(['true', 'false']).default('false'),
  AI_STRUCTURED_OUTPUTS: z.enum(['true', 'false']).default('true'),
  // crove-extract, the parsing sandbox (plan §7.6, External-tenant gate T12), e.g. http://crove-extract:8090.
  // Required for the worker role: the worker never parses PDF, XML or MIME itself. The API role does not use it.
  EXTRACT_URL: optional.pipe(z.url({ protocol: /^https?$/ }).optional()),
  // Extract jobs the worker runs at once (#2119), each one reading a file and, for a PDF or a photo, calling the AI. Unset:
  // 4, or the sandbox's slots when it has fewer. EXTRACT_CONCURRENCY is the sandbox's own setting of that name (its
  // parser slots, 1 to 8, the sandbox's own default being 1); give the worker the same value, since it cannot ask: docker
  // compose passes 4 to both. The worker never runs more extract jobs than the sandbox has slots, and keeps within the AI
  // provider's rate limit by this setting going down, not up.
  EXTRACT_WORKER_CONCURRENCY: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.coerce.number().int().min(1).max(8).optional()),
  EXTRACT_CONCURRENCY: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.coerce.number().int().min(1).max(8).default(EXTRACT_TIMING.concurrency)),
  // Times the AI SDK sends an invoice-reading call again after a 429, a 5xx or a network error, before the document's
  // job fails and pg-boss retries it (#2119). The whole call, retries included, stops at the 120 s timeout; this bounds
  // the provider calls one document costs to 1 + AI_MAX_RETRIES (2 by default, the SDK's own default being 3), and so
  // the cost and the rate-limit load of a document that keeps failing. 0 sends each call once.
  AI_MAX_RETRIES: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.coerce.number().int().min(0).max(5).default(1)),
  // Outbound mail (invites, issue #129), the same SMTP settings the bundled Supabase Auth uses. Unset SMTP_HOST: mail
  // is off, and the inviter passes the link on. Port 465 is implicit TLS; with SMTP_USER and SMTP_PASS on any other
  // port the server must offer STARTTLS.
  SMTP_HOST: optional,
  // An empty value (SMTP_PORT= in a .env) means the default.
  SMTP_PORT: optional.transform((v) => (v === undefined ? 587 : Number(v))).pipe(z.number().int().min(1).max(65_535)),
  SMTP_USER: optional,
  SMTP_PASS: optional,
  SMTP_FROM: optional,
  // The provider of Crove's own mails (#539, Email plan §3.9): smtp (the settings above; off without SMTP_HOST) or
  // resend (RESEND_API_KEY; SMTP_FROM, on a domain verified at Resend, stays the sender). RESEND_WEBHOOK_SECRET
  // (whsec_...) checks the signature of Resend's delivery webhooks.
  MAIL_PROVIDER: z.preprocess((v) => (v === '' ? undefined : v), z.enum(['smtp', 'resend']).default('smtp')),
  RESEND_API_KEY: optional,
  RESEND_WEBHOOK_SECRET: optional.pipe(z.string().regex(/^whsec_[A-Za-z0-9+/=]{24,}$/, 'RESEND_WEBHOOK_SECRET is the whsec_... signing secret of the webhook').optional()),
  // The build this image was made from (#892): the git SHA the release workflow passes as the image's CROVE_BUILD build
  // argument. GET /version reports it, so the deploy's smoke test can tell the new image from the old one. Unset (a
  // local build): "dev".
  CROVE_BUILD: optional.pipe(z.string().regex(/^[A-Za-z0-9._-]{1,64}$/, 'CROVE_BUILD is a build id: letters, digits, dot, dash, underscore').optional()),
  // When that commit was made (#1952): its committer date, ISO 8601, the image's CROVE_BUILD_TIME build argument. A
  // SHA has no order, so builds are compared by this date: the API's /readyz waits while a live worker runs an older
  // build (plan §3.5, worker build >= API build), and each worker records its own in its heartbeat. Unset (a local
  // build): no comparison.
  CROVE_BUILD_TIME: optional.pipe(z.iso.datetime({ offset: true, error: 'CROVE_BUILD_TIME is an ISO 8601 date and time with its offset' }).optional()),
  // Where the app's "Góp ý / Hỗ trợ" (feedback and support) link goes: an https: page (a chat group, a help desk) or
  // a mailto: address. Unset hides the link. Browsers see it through /api/config, so it must hold nothing secret.
  SUPPORT_URL: optional.pipe(
    z
      .url({ protocol: /^(https|mailto)$/ })
      .refine((value) => !value.toLowerCase().startsWith('mailto:') || new URL(value).pathname.trim() !== '', {
        message: 'a mailto: link needs an address',
      })
      .optional(),
  ),
  // The product name users see (#1040): in the app, the page title and the product's own mails (sender name and texts). Code,
  // schemas, logs and the AGPL source notice keep "Crove". Plain text of 1 to 40 characters (letters, digits, spaces
  // and . , & ' + _ ! ( ) -), so it needs no escaping in HTML, ICU messages or a mail's From header. Browsers read it
  // from /api/config.
  BRAND_NAME: optional.pipe(
    z
      .string()
      .transform((value) => value.normalize('NFC'))
      .pipe(z.string().max(40, 'BRAND_NAME is at most 40 characters').regex(BRAND_NAME_PATTERN, "BRAND_NAME is plain text: letters, digits, spaces and . , & ' + _ ! ( ) -"))
      .default(DEFAULT_BRAND_NAME),
  ),
  // The terms of service and the privacy notice that sign-up and invite acceptance link to (#688, plan M3-6): https:
  // pages the deployment publishes. Unset hides the line. Browsers read them from /api/config.
  TERMS_URL: optional.pipe(z.url({ protocol: /^https$/ }).optional()),
  PRIVACY_URL: optional.pipe(z.url({ protocol: /^https$/ }).optional()),
  // The prober's last result for the public status page PUBLIC_URL/status (#678, status-page.ts): the file the
  // prober writes as PROBER_STATUS_FILE, on a volume both share. Unset: no /status page and no link to it in the app.
  STATUS_FILE: optional.pipe(z.string().startsWith('/', 'STATUS_FILE is an absolute path').optional()),
  // Stock photos from Pexels in the Social media library and the composer (#1106): the API key of a Pexels account
  // (https://www.pexels.com/api/). Unset: nothing is offered and Crove never calls Pexels. The key stays on the server;
  // searches and image downloads go through the API, so browsers never reach Pexels.
  MEDIA_PEXELS_API_KEY: optional.pipe(z.string().regex(/^[A-Za-z0-9]{20,100}$/, 'MEDIA_PEXELS_API_KEY is the key Pexels shows under Your API key: letters and digits').optional()),
  // Browser push for the Social notifications someone must act on (#1238): the deployment's VAPID key pair (RFC 8292),
  // base64url (the `vapid-keys` role prints a new pair), and the contact push services may write to about it (a mailto:
  // address or an https: URL). All three or none: unset, the app offers no push and nothing is sent. Changing the pair
  // ends every subscription; members turn push on again.
  // The all-in-one role puts the HTTP edge on the worker's all-org database login and every secret, so on a public
  // PUBLIC_URL the kernel starts it only with this opt-in (assertSplitRoles); the pilot runs api and worker apart.
  CROVE_ALLOW_ALL_IN_ONE: optional.pipe(z.enum(['true', 'false']).optional()),
  VAPID_PUBLIC_KEY: optional.pipe(z.string().regex(/^[A-Za-z0-9_-]{87}$/, 'VAPID_PUBLIC_KEY is the base64url public key the vapid-keys role prints').optional()),
  VAPID_PRIVATE_KEY: optional.pipe(z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'VAPID_PRIVATE_KEY is the base64url private key the vapid-keys role prints').optional()),
  VAPID_SUBJECT: optional.pipe(z.string().max(200).optional()),
  // The public tax registry lookup that prefills a new org from its tax code (issue #324): an https URL template with
  // {taxCode}, answering in the VietQR business shape (https://api.vietqr.io/v2/business/{taxCode}). Unset turns the
  // lookup off: it sends the tax codes your users type to that provider.
  TAX_CODE_LOOKUP_URL: optional.pipe(
    z
      .string()
      .refine((value) => value.includes('{taxCode}') && URL.canParse(value.replace('{taxCode}', '0100109106')) && new URL(value.replace('{taxCode}', '0100109106')).protocol === 'https:', {
        message: 'an https URL with {taxCode} in it',
      })
      .optional(),
  ),
  // The assisted purchase-invoice sync from the tax portal (issue #325, ADR-0036): the accountant types the client's
  // portal password and solves the portal's CAPTCHA in Crove, and the API fetches the period's purchase list and invoice
  // XML from hoadondientu.gdt.gov.vn. Off unless true: it logs in to a government portal on a client's behalf, which
  // the deployment opts into (docs/integrations/tax-portal-sync.md). Needs the credential key (CREDENTIAL_KEY).
  TAX_PORTAL_SYNC: z.enum(['true', 'false']).default('false'),
  // Where the portal's API is; unset: https://hoadondientu.gdt.gov.vn/api. Only for pointing a test deployment at a
  // fake portal (the end-to-end tests do); the API refuses it unless PUBLIC_URL is local (localhost or a .test name),
  // since any other address would receive the client's portal password.
  // One deadline, in seconds, for each list or XML step of a sync, all its portal requests together; past it the step
  // stops and the screen offers to go on.
  TAX_PORTAL_STEP_SECONDS: z.coerce.number().int().min(30).max(300).default(90),
  TAX_PORTAL_URL: optional.pipe(z.url({ protocol: /^https?$/ }).optional()),
  // Inbound email: <token>@INBOUND_DOMAIN, delivered by a mail worker to POST /api/inbound/email.
  INBOUND_DOMAIN: optional,
  INBOUND_SECRET: optional,
  // During a rotation of INBOUND_SECRET (#1214): the value the mail worker may still send, accepted as well until the
  // worker sends the new one; then remove it (docs/runbooks/secret-rotation.md, section 2).
  INBOUND_SECRET_PREVIOUS: optional,
  // Cloudflare Turnstile on the public booking form (#1353, CAL-2, plan docs/plan/calendar.md §3.4): both or neither.
  // With them, the page shows the widget and the kernel checks its token with Cloudflare before recording a request.
  TURNSTILE_SITE_KEY: optional.pipe(z.string().regex(/^[0-9A-Za-z_-]{1,100}$/, 'TURNSTILE_SITE_KEY is a Turnstile site key').optional()),
  TURNSTILE_SECRET: optional,
  // Role passwords applied by `migrate` (self-host).
  CROVE_APP_DB_PASSWORD: optional,
  CROVE_WORKER_DB_PASSWORD: optional,
  // The prober's login (crove_prober); it may only execute crove_kernel.health().
  CROVE_PROBER_DB_PASSWORD: optional,
  // The usage report's login (crove_reporter); it may only execute crove_kernel.usage_weekly().
  CROVE_REPORTER_DB_PASSWORD: optional,
  AUTH_DB_PASSWORD: optional,
});

export type SessionCheckMode = 'db' | 'jwt' | 'off';

export type Config = Omit<z.infer<typeof schema>, 'AUTH_ISSUER' | 'AUTH_SESSION_CHECK'> & {
  AUTH_ISSUER: string;
  AUTH_SESSION_CHECK: SessionCheckMode;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => (i.code === 'custom' ? `${i.path.join('.')} (${i.message})` : i.path.join('.'))).join(', ');
    throw new Error(`invalid configuration: ${fields}`);
  }
  const raw = parsed.data;
  if (!raw.AUTH_ISSUER) {
    throw new Error('set AUTH_ISSUER to the issuer of your Supabase Auth access tokens (bundled: GOTRUE_JWT_ISSUER)');
  }
  const config: Config = {
    ...raw,
    AUTH_ISSUER: raw.AUTH_ISSUER,
    AUTH_SESSION_CHECK: raw.AUTH_SESSION_CHECK ?? (raw.AUTH_UPSTREAM_URL ? 'db' : 'jwt'),
  };
  if (!config.AUTH_JWT_SECRET && !config.AUTH_JWKS_URL) {
    throw new Error('set AUTH_JWT_SECRET (self-hosted Supabase Auth) or AUTH_JWKS_URL (hosted Supabase Auth)');
  }
  if (config.AUTH_JWT_SECRET && config.AUTH_JWT_SECRET.length < 32) {
    throw new Error('AUTH_JWT_SECRET must be at least 32 characters');
  }
  if (config.INBOUND_SECRET && config.INBOUND_SECRET.length < 32) {
    throw new Error('INBOUND_SECRET must be at least 32 characters');
  }
  // The previous value follows the current one's rules, and is never the current one or a sample value (#1214). The
  // messages never carry either value.
  if (config.INBOUND_SECRET_PREVIOUS) {
    if (!config.INBOUND_SECRET) throw new Error('INBOUND_SECRET_PREVIOUS is set without INBOUND_SECRET');
    if (config.INBOUND_SECRET_PREVIOUS.length < 32) throw new Error('INBOUND_SECRET_PREVIOUS must be at least 32 characters');
    if (config.INBOUND_SECRET_PREVIOUS === config.INBOUND_SECRET) throw new Error('INBOUND_SECRET_PREVIOUS must differ from INBOUND_SECRET');
    if (/change-?me/i.test(config.INBOUND_SECRET_PREVIOUS)) throw new Error('INBOUND_SECRET_PREVIOUS still has a sample value');
  }
  // A widget without the secret could not be checked, and a secret without the widget would refuse every booking.
  if (Boolean(config.TURNSTILE_SITE_KEY) !== Boolean(config.TURNSTILE_SECRET)) {
    throw new Error('set both TURNSTILE_SITE_KEY and TURNSTILE_SECRET, or neither');
  }
  // A sign-up policy the deployment cannot enforce, or one set only halfway, stops the boot instead of leaving
  // sign-up more open than the operator meant (#350).
  if (config.AUTH_SIGNUP_POLICY === 'allowlist' && config.AUTH_SIGNUP_ALLOWED_DOMAINS.length === 0) {
    throw new Error('AUTH_SIGNUP_POLICY=allowlist needs AUTH_SIGNUP_ALLOWED_DOMAINS, the email domains that may sign up');
  }
  if (config.AUTH_SIGNUP_POLICY !== 'allowlist' && config.AUTH_SIGNUP_ALLOWED_DOMAINS.length > 0) {
    throw new Error(`AUTH_SIGNUP_ALLOWED_DOMAINS applies to AUTH_SIGNUP_POLICY=allowlist only (it is ${config.AUTH_SIGNUP_POLICY}); set the policy or remove the domains`);
  }
  if (config.AUTH_SIGNUP_POLICY !== 'open' && !config.AUTH_UPSTREAM_URL) {
    throw new Error(
      `AUTH_SIGNUP_POLICY=${config.AUTH_SIGNUP_POLICY} is enforced by the /auth/v1 proxy in front of the bundled Supabase Auth (AUTH_UPSTREAM_URL); ` +
        'with a remote Supabase Auth, restrict sign-up there and leave AUTH_SIGNUP_POLICY unset',
    );
  }
  // Only where the sandbox is used (the worker; the API resets EXTRACT_URL), so a stray value never stops another role.
  if (config.EXTRACT_URL && config.EXTRACT_WORKER_CONCURRENCY !== undefined && config.EXTRACT_WORKER_CONCURRENCY > config.EXTRACT_CONCURRENCY) {
    throw new Error('EXTRACT_WORKER_CONCURRENCY must not exceed EXTRACT_CONCURRENCY, the sandbox parser slots: more extract jobs than slots only wait, or are refused as busy');
  }
  if (config.STORAGE === 's3' && !config.S3_BUCKET) throw new Error('STORAGE=s3 needs S3_BUCKET');
  if (config.ARCHIVE_STORE === 's3' && !config.ARCHIVE_S3_BUCKET) throw new Error('ARCHIVE_STORE=s3 needs ARCHIVE_S3_BUCKET');
  // Fails the boot on a malformed key rather than at the first export or download.
  exportSealer(config);
  if (config.REFUSAL_AUDIT_RESERVE_PER_ACTOR > config.REFUSAL_AUDIT_LIMIT_PER_ACTOR) {
    throw new Error('REFUSAL_AUDIT_RESERVE_PER_ACTOR must not exceed REFUSAL_AUDIT_LIMIT_PER_ACTOR');
  }
  if (Boolean(config.S3_ACCESS_KEY_ID) !== Boolean(config.S3_SECRET_ACCESS_KEY)) {
    throw new Error('set both S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY, or neither to use the default credential chain');
  }
  if (config.SMTP_HOST && !config.SMTP_FROM) throw new Error('SMTP_HOST needs SMTP_FROM, the sender address of Crove mails');
  if (config.MAIL_PROVIDER === 'resend' && (!config.RESEND_API_KEY || !config.SMTP_FROM)) {
    throw new Error('MAIL_PROVIDER=resend needs RESEND_API_KEY and SMTP_FROM, the sender address on a domain verified at Resend');
  }
  const presigned = config.STORAGE === 's3' && config.S3_PRESIGNED_URLS === 'true';
  // Cloudflare R2 has no POST policy uploads: with presigned URLs on, every browser upload would fail at the bucket.
  if (presigned && [config.S3_ENDPOINT, config.S3_PUBLIC_ENDPOINT].some(isR2Endpoint)) {
    throw new Error('Cloudflare R2 does not accept presigned POST uploads; set S3_PRESIGNED_URLS=false (transfers then stream through the kernel)');
  }
  if (Boolean(config.SMTP_USER) !== Boolean(config.SMTP_PASS)) throw new Error('set both SMTP_USER and SMTP_PASS, or neither');
  if (Boolean(config.CHANNEL_META_APP_ID) !== Boolean(config.CHANNEL_META_APP_SECRET)) {
    throw new Error('set both CHANNEL_META_APP_ID and CHANNEL_META_APP_SECRET, or neither');
  }
  if (config.CHANNEL_META_APP_ID && !/^\d{1,32}$/.test(config.CHANNEL_META_APP_ID)) throw new Error('CHANNEL_META_APP_ID is the numeric id of the Meta app');
  if (Boolean(config.CHANNEL_THREADS_APP_ID) !== Boolean(config.CHANNEL_THREADS_APP_SECRET)) throw new Error('set both CHANNEL_THREADS_APP_ID and CHANNEL_THREADS_APP_SECRET, or neither');
  if (config.CHANNEL_THREADS_APP_ID && !/^\d{1,32}$/.test(config.CHANNEL_THREADS_APP_ID)) throw new Error('CHANNEL_THREADS_APP_ID is the numeric id of the Threads app');
  if (Boolean(config.CHANNEL_LINKEDIN_CLIENT_ID) !== Boolean(config.CHANNEL_LINKEDIN_CLIENT_SECRET)) throw new Error('set both CHANNEL_LINKEDIN_CLIENT_ID and CHANNEL_LINKEDIN_CLIENT_SECRET, or neither');
  if (config.CHANNEL_LINKEDIN_CLIENT_ID && !/^[A-Za-z0-9]{8,64}$/.test(config.CHANNEL_LINKEDIN_CLIENT_ID)) throw new Error('CHANNEL_LINKEDIN_CLIENT_ID is the client id of the LinkedIn app');
  if (Boolean(config.CHANNEL_LINKEDIN_PAGE_CLIENT_ID) !== Boolean(config.CHANNEL_LINKEDIN_PAGE_CLIENT_SECRET)) throw new Error('set both CHANNEL_LINKEDIN_PAGE_CLIENT_ID and CHANNEL_LINKEDIN_PAGE_CLIENT_SECRET, or neither');
  if (config.CHANNEL_LINKEDIN_PAGE_CLIENT_ID && !/^[A-Za-z0-9]{8,64}$/.test(config.CHANNEL_LINKEDIN_PAGE_CLIENT_ID)) throw new Error('CHANNEL_LINKEDIN_PAGE_CLIENT_ID is the client id of the LinkedIn Company Pages app');
  if (config.CHANNEL_LINKEDIN_ORGANIZATIONS === 'true' && !config.CHANNEL_LINKEDIN_PAGE_CLIENT_ID && !config.CHANNEL_LINKEDIN_CLIENT_ID) throw new Error('CHANNEL_LINKEDIN_ORGANIZATIONS needs CHANNEL_LINKEDIN_PAGE_CLIENT_ID and CHANNEL_LINKEDIN_PAGE_CLIENT_SECRET, or CHANNEL_LINKEDIN_CLIENT_ID and CHANNEL_LINKEDIN_CLIENT_SECRET');
  if (Boolean(config.CHANNEL_TIKTOK_CLIENT_KEY) !== Boolean(config.CHANNEL_TIKTOK_CLIENT_SECRET)) throw new Error('set both CHANNEL_TIKTOK_CLIENT_KEY and CHANNEL_TIKTOK_CLIENT_SECRET, or neither');
  if (config.CHANNEL_TIKTOK_CLIENT_KEY && !/^[A-Za-z0-9]{8,64}$/.test(config.CHANNEL_TIKTOK_CLIENT_KEY)) throw new Error('CHANNEL_TIKTOK_CLIENT_KEY is the client key of the TikTok app');
  if (Boolean(config.CHANNEL_GOOGLE_CLIENT_ID) !== Boolean(config.CHANNEL_GOOGLE_CLIENT_SECRET)) throw new Error('set both CHANNEL_GOOGLE_CLIENT_ID and CHANNEL_GOOGLE_CLIENT_SECRET, or neither');
  if (Boolean(config.CALENDAR_GOOGLE_CLIENT_ID) !== Boolean(config.CALENDAR_GOOGLE_CLIENT_SECRET)) throw new Error('set both CALENDAR_GOOGLE_CLIENT_ID and CALENDAR_GOOGLE_CLIENT_SECRET, or neither');
  if (config.CALENDAR_GOOGLE_CLIENT_ID && !/^[0-9]{6,32}-[A-Za-z0-9_-]{8,64}\.apps\.googleusercontent\.com$/.test(config.CALENDAR_GOOGLE_CLIENT_ID)) throw new Error('CALENDAR_GOOGLE_CLIENT_ID is the client id of a Google OAuth web client');
  if (config.CHANNEL_GOOGLE_BUSINESS === 'true' && !config.CHANNEL_GOOGLE_CLIENT_ID) throw new Error('CHANNEL_GOOGLE_BUSINESS needs CHANNEL_GOOGLE_CLIENT_ID and CHANNEL_GOOGLE_CLIENT_SECRET');
  if (config.CHANNEL_GOOGLE_CLIENT_ID && !/^[0-9]{6,32}-[A-Za-z0-9_-]{8,64}\.apps\.googleusercontent\.com$/.test(config.CHANNEL_GOOGLE_CLIENT_ID)) throw new Error('CHANNEL_GOOGLE_CLIENT_ID is the client id of a Google OAuth web client');
  if (Boolean(config.CHANNEL_X_CLIENT_ID) !== Boolean(config.CHANNEL_X_CLIENT_SECRET)) throw new Error('set both CHANNEL_X_CLIENT_ID and CHANNEL_X_CLIENT_SECRET, or neither');
  if (Boolean(config.CHANNEL_PINTEREST_APP_ID) !== Boolean(config.CHANNEL_PINTEREST_APP_SECRET)) throw new Error('set both CHANNEL_PINTEREST_APP_ID and CHANNEL_PINTEREST_APP_SECRET, or neither');
  if (config.CHANNEL_PINTEREST_APP_ID && !/^\d{4,32}$/.test(config.CHANNEL_PINTEREST_APP_ID)) throw new Error('CHANNEL_PINTEREST_APP_ID is the numeric id of the Pinterest app');
  if (config.CHANNEL_X_CLIENT_ID && !/^[A-Za-z0-9_-]{16,64}$/.test(config.CHANNEL_X_CLIENT_ID)) throw new Error('CHANNEL_X_CLIENT_ID is the OAuth 2.0 client id of the X app');
  if (config.BANK_FEED_SANDBOX_WEBHOOK_SECRET !== undefined) {
    if (config.BANK_FEED_SANDBOX !== 'true') throw new Error('BANK_FEED_SANDBOX_WEBHOOK_SECRET is set without BANK_FEED_SANDBOX=true');
    if (config.BANK_FEED_SANDBOX_WEBHOOK_SECRET.length < 32) throw new Error('BANK_FEED_SANDBOX_WEBHOOK_SECRET must be at least 32 characters');
  }
  if (Boolean(config.CHANNEL_ZALO_APP_ID) !== Boolean(config.CHANNEL_ZALO_APP_SECRET)) throw new Error('set both CHANNEL_ZALO_APP_ID and CHANNEL_ZALO_APP_SECRET, or neither');
  if (config.CHANNEL_ZALO_APP_ID && !/^\d{1,32}$/.test(config.CHANNEL_ZALO_APP_ID)) throw new Error('CHANNEL_ZALO_APP_ID is the numeric id of the Zalo app');
  if (config.CROVE_CONTEXT_TOKEN_KEY !== undefined) {
    const bytes = /^[A-Za-z0-9+/_-]+={0,2}$/.test(config.CROVE_CONTEXT_TOKEN_KEY.trim()) ? Buffer.from(config.CROVE_CONTEXT_TOKEN_KEY.trim(), 'base64') : Buffer.alloc(0);
    if (bytes.length < 32 || bytes.length > 64) throw new Error('CROVE_CONTEXT_TOKEN_KEY must be base64 of 32 to 64 random bytes');
  }
  if (!isLocalUrl(config.PUBLIC_URL)) {
    if (config.CROVE_CONTEXT_TOKEN_KEY !== undefined) {
      // Compared as bytes, so the unpadded or base64url spelling of the test key is the test key too.
      const bytes = Buffer.from(config.CROVE_CONTEXT_TOKEN_KEY.trim(), 'base64');
      if (SAMPLE_CONTEXT_TOKEN_KEYS.some((sample) => sample.equals(bytes))) {
        throw new Error('CROVE_CONTEXT_TOKEN_KEY is the test suite key; generate a random key before exposing Crove');
      }
      // A key that decodes to printable text is a passphrase, not random bytes (one in about 10^14 random keys is).
      if (bytes.every((byte) => byte >= 0x20 && byte <= 0x7e)) {
        throw new Error('CROVE_CONTEXT_TOKEN_KEY decodes to printable text; generate random bytes (openssl rand -base64 32) before exposing Crove');
      }
    }
    if (config.AUTH_JWT_SECRET && SAMPLE_SECRETS.has(config.AUTH_JWT_SECRET)) {
      throw new Error('AUTH_JWT_SECRET is a sample value; generate a random secret before exposing Crove');
    }
    // docker-compose.yml falls back to these passwords when a variable is unset, so a deployment that forgot one would
    // otherwise run its database logins on a value this public repository publishes. Only the setting is named.
    for (const name of ['DATABASE_URL', 'WORKER_DATABASE_URL', 'ADMIN_DATABASE_URL', 'DATABASE_LISTEN_URL'] as const) {
      if (hasSampleDbPassword(config[name])) {
        throw new Error(`${name} carries a database password shipped in .env.example or docker-compose.yml; set a random one (openssl rand -base64 24) before exposing Crove`);
      }
    }
    if ([config.TURNSTILE_SITE_KEY, config.TURNSTILE_SECRET].some((key) => key !== undefined && TURNSTILE_TEST_KEY.test(key))) {
      throw new Error("TURNSTILE_SITE_KEY or TURNSTILE_SECRET is one of Cloudflare's test keys; use the widget's real keys before exposing Crove");
    }
    if (config.AUTH_AUTOCONFIRM === 'true') {
      throw new Error('AUTH_AUTOCONFIRM=true lets anyone claim any email address; set it to false and configure SMTP');
    }
    // ADR-0039 point 3: the sandbox feed writes made-up bank lines, so it stays on development deployments.
    if (config.BANK_FEED_SANDBOX === 'true') {
      throw new Error('BANK_FEED_SANDBOX=true writes made-up bank lines into the books; it is for local development only');
    }
    if (config.AUTH_SESSION_CHECK === 'off') {
      throw new Error('AUTH_SESSION_CHECK=off keeps signed-out sessions working; use db (bundled Supabase Auth) or jwt');
    }
    if (config.AUTH_SESSION_CHECK === 'jwt' && !liveAuthUrl(config)) {
      throw new Error('AUTH_SESSION_CHECK=jwt confirms R3 actions with Supabase Auth; set PUBLIC_AUTH_URL (or AUTH_UPSTREAM_URL)');
    }
    if (config.AUTH_STEP_UP === 'off') {
      throw new Error('AUTH_STEP_UP=off lets a stolen session approve and change roles without MFA; set it to required');
    }
    // A provider sends the authorization code to PUBLIC_URL/channels/oauth/<provider>/callback (#375).
    const oauthApps = [config.CHANNEL_META_APP_ID, config.CHANNEL_ZALO_APP_ID, config.CHANNEL_THREADS_APP_ID, config.CHANNEL_LINKEDIN_CLIENT_ID, config.CHANNEL_LINKEDIN_PAGE_CLIENT_ID, config.CHANNEL_GOOGLE_CLIENT_ID, config.CHANNEL_TIKTOK_CLIENT_KEY, config.CHANNEL_X_CLIENT_ID, config.CHANNEL_PINTEREST_APP_ID, config.CALENDAR_GOOGLE_CLIENT_ID];
    if (oauthApps.some(Boolean) && !config.PUBLIC_URL.startsWith('https://')) {
      throw new Error('channel OAuth sends authorization codes back to PUBLIC_URL; a public PUBLIC_URL must be https when a CHANNEL_* or CALENDAR_* app is set');
    }
    // Browsers send files to, and fetch them from, this endpoint, and it is allowed in the app's CSP connect-src.
    const browserEndpoint = config.S3_PUBLIC_ENDPOINT ?? config.S3_ENDPOINT;
    if (presigned && browserEndpoint && new URL(browserEndpoint).protocol !== 'https:') {
      throw new Error(
        `presigned transfers would send files over plain http to ${new URL(browserEndpoint).origin}; set S3_PUBLIC_ENDPOINT to the https URL ` +
          'browsers reach the bucket at, or S3_PRESIGNED_URLS=false',
      );
    }
    const budget = config.AUTH_RATE_LIMIT_EMAIL_SENT;
    if (config.AUTH_UPSTREAM_URL && budget !== undefined && config.AUTH_EMAIL_CLIENT_LIMIT_PER_HOUR * EMAIL_BUDGET_MIN_CLIENTS > budget) {
      throw new Error(
        `AUTH_EMAIL_CLIENT_LIMIT_PER_HOUR=${config.AUTH_EMAIL_CLIENT_LIMIT_PER_HOUR} lets ${Math.ceil(budget / config.AUTH_EMAIL_CLIENT_LIMIT_PER_HOUR)} ` +
          `client addresses use up the email budget (AUTH_RATE_LIMIT_EMAIL_SENT=${budget}); keep it at most ` +
          `${Math.floor(budget / EMAIL_BUDGET_MIN_CLIENTS)}, or raise the budget`,
      );
    }
  }
  // Hosted Supabase refuses requests without the project's publishable key, which would turn every R3 into a 401.
  const live = config.AUTH_SESSION_CHECK === 'jwt' ? liveAuthUrl(config) : null;
  if (live && !config.PUBLIC_AUTH_ANON_KEY && isHostedSupabase(live)) {
    throw new Error('hosted Supabase Auth needs PUBLIC_AUTH_ANON_KEY (the publishable key) for the R3 live check');
  }
  return config;
}

// The extract jobs this worker runs at once: EXTRACT_WORKER_CONCURRENCY, else 4 or the sandbox's slots if fewer (#2119).
export function extractConcurrency(config: Pick<Config, 'EXTRACT_WORKER_CONCURRENCY' | 'EXTRACT_CONCURRENCY'>): number {
  return config.EXTRACT_WORKER_CONCURRENCY ?? Math.min(DEFAULT_EXTRACT_WORKER_CONCURRENCY, config.EXTRACT_CONCURRENCY);
}

// How many client addresses it must take, at least, to use up Supabase Auth's deployment-wide email budget.
export const EMAIL_BUDGET_MIN_CLIENTS = 10;

// Values shipped in docker-compose.yml and .env.example. Fine on localhost, never on a public URL.
const SAMPLE_SECRETS = new Set(['local-only-jwt-secret-change-me-0123456789', 'change-me-to-a-long-random-string-0123456789']);
// Database passwords shipped in docker-compose.yml (the fallbacks) and .env.example. The rule is checked on a public
// PUBLIC_URL when the kernel loads its settings; pilot-check keeps its own list in step (KNOWN_DEFAULTS).
export const SAMPLE_DB_PASSWORDS: ReadonlySet<string> = new Set([
  'local-postgres-password',
  'local-app-password',
  'local-worker-password',
  'local-prober-password',
  'local-reporter-password',
  'local-auth-password',
  'change-me-postgres',
  'change-me-app',
  'change-me-worker',
  'change-me-prober',
  'change-me-reporter',
  'change-me-auth',
]);

// Whether a database URL carries one of those passwords, or any `change-me` placeholder (broader than the shipped
// values on purpose: it is a sample whatever its tail). The password may sit in the userinfo or in a `?password=` query
// parameter, which node-postgres reads too. A value that is not a URL has no password to read here (the connection
// itself fails later). The prober's and the reporter's URLs are read by their own roles; pilot-check fails their
// sample *_PASSWORD settings.
export function hasSampleDbPassword(url: string | undefined): boolean {
  if (url === undefined || !URL.canParse(url)) return false;
  const parsed = new URL(url);
  return [parsed.password, parsed.searchParams.get('password') ?? ''].some((raw) => {
    let password = raw;
    try {
      password = decodeURIComponent(raw);
    } catch {
      // Keep the raw spelling.
    }
    return SAMPLE_DB_PASSWORDS.has(password) || /change-?me/i.test(password);
  });
}

// The context token key the test suites use (vitest.config.ts, vitest.invariant.config.ts): public, so never a
// deployment's.
const SAMPLE_CONTEXT_TOKEN_KEYS = [Buffer.from('test-only-context-token-key-0123456789')];

// Cloudflare's published Turnstile test site keys and secrets (1x00000000000000000000AA, 1x0000000000000000000000000000000AA
// and their 2x and 3x siblings): siteverify passes any token for the always-pass pair, so they are refused on a public URL.
const TURNSTILE_TEST_KEY = /^[123]x0+[A-F]{2}$/;

// Cloudflare R2's S3 API: https://<account>.r2.cloudflarestorage.com (and jurisdiction hosts such as <account>.eu.).
export function isR2Endpoint(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).hostname.replace(/\.$/, '').endsWith('.r2.cloudflarestorage.com');
  } catch {
    return false;
  }
}

export function isHostedSupabase(url: string): boolean {
  try {
    // The DNS root's trailing dot names the same host.
    return new URL(url).hostname.replace(/\.$/, '').endsWith('.supabase.co');
  } catch {
    return false;
  }
}

// The api, worker and all roles refuse to start on a public PUBLIC_URL without an export key (issue #212): an org
// export is the whole org in one place and is sealed at rest. Checked when a role starts (createKernel), not in loadConfig, so
// tools and tests that load a public configuration without serving exports keep working.
export function assertExportKey(config: Pick<Config, 'PUBLIC_URL' | 'EXPORT_ENCRYPTION_KEY'>): void {
  if (!isLocalUrl(config.PUBLIC_URL) && !config.EXPORT_ENCRYPTION_KEY) {
    throw new Error('set EXPORT_ENCRYPTION_KEY (32 random bytes, openssl rand -base64 32): org exports hold the whole org and are sealed at rest');
  }
}

// The all role refuses to start on a public PUBLIC_URL unless CROVE_ALLOW_ALL_IN_ONE=true (#2118): the API would run on
// the worker's database login, which enters the system context of every org, and on every secret. A missing
// compose.pilot.yml, or a stray profile, would otherwise do that silently. Run api and worker as two processes
// (docs/runbooks/deploy.md, "The pilot layout"). Checked when a role starts, like the export key above.
//
// The api role holds no worker login at all on a public PUBLIC_URL (#2133): it refuses to start when WORKER_DATABASE_URL is
// set. The pilot layout keeps it out with `!reset` under `extends`, which needs compose 2.24 or newer, and a host file or
// an `env_file` can put it back; the API is the process the internet reaches, and the worker's login enters the system
// context of every org, so the kernel checks it itself and does not rely on how the container was composed.
export function assertSplitRoles(config: Pick<Config, 'PUBLIC_URL' | 'CROVE_ALLOW_ALL_IN_ONE' | 'WORKER_DATABASE_URL'>, role: 'api' | 'worker' | 'all'): void {
  if (role === 'all' && !isLocalUrl(config.PUBLIC_URL) && config.CROVE_ALLOW_ALL_IN_ONE !== 'true') {
    throw new Error(
      'the all role runs the API on the worker database login and every secret; on a public PUBLIC_URL run api and worker as separate processes ' +
        '(docs/runbooks/deploy.md, "The pilot layout"), or set CROVE_ALLOW_ALL_IN_ONE=true to accept that',
    );
  }
  if (role === 'api' && !isLocalUrl(config.PUBLIC_URL) && config.WORKER_DATABASE_URL !== undefined) {
    throw new Error(
      'the api role must not hold WORKER_DATABASE_URL on a public PUBLIC_URL: that login enters the system context of every org, and only the worker needs it; ' +
        'remove it from the api container (docs/runbooks/deploy.md, "The pilot layout")',
    );
  }
}

export function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  } catch {
    return false;
  }
}

export function publicAuthUrl(config: Config): string {
  return config.PUBLIC_AUTH_URL ?? `${config.PUBLIC_URL.replace(/\/$/, '')}/auth/v1`;
}

// Where the kernel confirms a session live with Supabase Auth (GET /user, ADR-0028 section 5): the bundled Auth
// directly when it is proxied, otherwise the Auth URL the SPA signs in with. null: not configured.
export function liveAuthUrl(config: Config): string | null {
  return config.AUTH_UPSTREAM_URL ?? config.PUBLIC_AUTH_URL ?? null;
}

// The per-org abuse limits (#675) the worker checks, from ORG_LIMIT_*: attachment MB as bytes.
export function usageLimits(config: Config): UsageLimits {
  return {
    inbound_emails: String(config.ORG_LIMIT_INBOUND_EMAILS_PER_DAY),
    attachment_bytes: String(config.ORG_LIMIT_ATTACHMENT_MB_PER_DAY * 1024 * 1024),
    extraction_pages: String(config.ORG_LIMIT_EXTRACTION_PAGES_PER_DAY),
    ai_cost: config.ORG_LIMIT_AI_COST_PER_DAY,
  };
}
