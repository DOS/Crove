# Record of processing: what personal data Crove holds, where, and for how long

**Status: DRAFT, not reviewed by a lawyer (#1012, #62).** This is the fact base for the PDPL package. It describes what the code does on `main` today, each statement with the file that shows it. The Vietnamese documents ([impact-assessment.vi.md](impact-assessment.vi.md), [transfer-assessment.vi.md](transfer-assessment.vi.md), [dpa.vi.md](dpa.vi.md), [sub-processors.vi.md](sub-processors.vi.md)) take their facts from here. When the code changes, this file changes in the same PR.

Paths are relative to the repository root. Migrations are in `supabase/migrations/`.

## 1. Roles

- **The org** (an accounting firm, or a company using Crove for itself) is the controller of the personal data in its documents and books.
- **The operator** of the Crove instance processes that data on the org's instructions.
- For the account data of its users, the operator is the controller.

The terms and privacy drafts use the same split (`docs/legal/README.md`, "Roles").

## 2. Categories of personal data

### 2.1 In an org's books (the org is the controller)

The personal-data registry `PERSONAL_DATA_COLUMNS` (`packages/kernel/src/personal-data.ts`) lists every column of the tenant schemas that holds data about a person, with what an erasure does to it. An invariant test (`apps/kernel/test/invariant/personal-data.db.test.ts`) fails CI when a new column whose name looks like personal data is not classified. In short:

| Data | Where | On erasure |
|---|---|---|
| Name, tax code, email, phone and address of parties (suppliers, customers, people) | `crove_kernel.party` | contact fields erased; name and tax code kept while a recorded document names the party (Accounting Law 88/2015, Art. 41) |
| Payer or payee named on a cash voucher | `crove_finance.cash_voucher.person_name` | kept (accounting voucher) |
| The tax portal's invoice lists | `crove_finance.portal_invoice_list`, `portal_invoice_row` | kept, like the books |
| Invoice files, PDFs, photos and their extracted fields | object storage `org/<org_id>/<sha256>`, `crove_kernel.file`, `extraction.result` | kept with the books; see section 5 of the runbook below |
| Sender of a forwarded mail | `crove_kernel.inbound_message.from_address` | erased |
| Recipient of a mail Crove sent | `crove_kernel.mail_message.to_address` (a keyed hash stays) | erased |
| The org's contact email | `crove_kernel.tenant.contact_email` | erased |
| Social report recipients, a client reviewer's name, a connected social account's name | `crove_social.report_schedule`, `review_feedback`, `crove_kernel.channel_connection` | erased, or kept as an append-only record |

Free text (journal descriptions, comments, posts) and stored files are not searched by the tools yet (`docs/runbooks/personal-data-requests.md` §5).

### 2.2 About the users of the org (the operator is the controller)

| Data | Where | Kind of table |
|---|---|---|
| Email and display name | `crove_kernel.user_account` (`20261013120000_crove_kernel_bootstrap.sql`) | control plane: tenant code never reads it (`control-plane-reads.test.ts`) |
| Password hash, MFA factors, Supabase sessions | Supabase Auth's `auth` schema (not defined in this repository) | identity provider |
| Sessions | `auth_session` and `auth_session_org` (`20261015090000_crove_kernel_auth_sessions.sql`) | control plane, the revocation list |
| Membership and role | `crove_kernel.tenant_member` | tenant |
| Invited email | `crove_kernel.member_invite` | tenant |
| Who did what, when | `crove_kernel.audit_event.actor_id` (append-only, bootstrap migration) | tenant |
| Refused requests, counted per caller | `crove_kernel.refusal_tally` (`actor_key = user:<id>`, `20261017040000_crove_kernel_refusal_tally.sql`) | per-org machinery, no tenant grant |
| Security events, counted per caller | `crove_kernel.security_event` (`caller = user:<id>`, `20261027140000_crove_kernel_security_event.sql`) | machinery, no tenant grant |
| Sign-in email budget | `crove_kernel.auth_email_send`: SHA-256 of the client address and of the recipient, never the raw values (`20261017030000_crove_kernel_auth_email_limit.sql`) | machinery |
| Notifications | `notification.user_id` (`packages/kernel/src/notifications.ts`) | tenant |

No Crove table stores an IP address or a user agent. The user agent is read only to decide whether a short-link click is counted (`apps/kernel/src/short-link.ts`).

`refusal_tally` and `security_event` hold a user id and codes, never an email or a name. The personal-data erase does not clear them, because it identifies a person by email, phone or tax code, and tenant code may not map those to a user id. They are a kept security log, removed by the retention below (7 and 30 days). This settles #1008.

## 3. Retention

### 3.1 Automatic

Daily job `kernel-retention-purge`, 02:30 Asia/Ho_Chi_Minh (`apps/kernel/src/retention.ts`, `apps/kernel/src/worker.ts`):

| What | Kept for | Source |
|---|---|---|
| Idempotency keys | 7 days | `crove_kernel.retention_purge()`, `20261018060000_crove_kernel_file_upload_retention.sql` |
| Dropped inbound mail records | 30 days after the last drop | same |
| Member invites (the invited email) | 90 days after accepted, revoked or expired; pending ones until they expire | same |
| Browser upload grants | 7 days after creation, once used or expired | same |
| Address and subject of sent mail | 13 months; a keyed hash of the address stays | `mail_retention_purge()`, `20261022050000_crove_kernel_mail_queue.sql` |
| Merge data of sent mail | 30 days after its final status | same |
| Refusal tallies | 7 days (`REFUSAL_TALLY_RETENTION_DAYS`) | `apps/kernel/src/worker.ts` |
| Security events | 30 days | `apps/kernel/src/worker.ts` |
| Upload staging objects | 1 hour | `apps/kernel/src/retention.ts` |
| Raw inbound messages | deleted once filed or dropped; after the last failed attempt, 30 days | `apps/kernel/src/worker.ts`, `retention.ts` |
| Org export files | 1 day after the export expires (35 to 90 days, `EXPORT_RETENTION_DAYS`) | `docs/runbooks/org-offboarding.md` |
| Sign-in email budget rows | 1 hour | `20261017030000_crove_kernel_auth_email_limit.sql` |
| Notifications | read ones 30 days, all at most 90 days | `packages/kernel/src/notifications.ts` |
| Background job rows | 7 days after completion | `20261019034500_crove_jobs_pgboss_v46.sql` |
| Outbox events (business facts: ids and codes) | 30 days in the database, then 13 months in the WORM archive store | `20261028100000_crove_kernel_outbox_retention.sql`, `apps/kernel/src/outbox-retention.ts` |

### 3.2 Kept on purpose, with no automatic deletion

- The books (every `crove_finance` table), the files behind recorded entries, and `audit_event`: at least 10 years after the org leaves (`docs/runbooks/org-offboarding.md`, Accounting Law 88/2015 Art. 41). On S3 with Object Lock, the original file of every posted invoice is also held in the bucket for `EVIDENCE_LOCK_DAYS` (default 10 years) from its posting, in GOVERNANCE mode; erasure and offboarding leave held files in place and say so (#1009, `docs/runbooks/evidence-holds.md`).
- The WORM archive of the books and the audit log: `ARCHIVE_RETENTION_DAYS`, default 3650 days, under S3 Object Lock (`docs/runbooks/worm-archive.md`).
- Sessions (`auth_session`), inbound addresses and context keys.

### 3.3 Backups

- **Schedule and scope:** nightly. Each run copies the whole database (the Supabase `auth` schema included) and every file (`docs/runbooks/backup-and-restore.md`).
- **Where:** a bucket in another place than the server and the files bucket.
- **Retention:** 30 days (`BACKUP_KEEP_DAYS`).
- **Encryption:** AES-256-GCM when `BACKUP_ENCRYPTION_KEY` is set.
- **Recovery:** no point-in-time recovery in the pilot setup.

A restore brings erased data back. The runbook says to run the recorded erasures again after one (`docs/runbooks/personal-data-requests.md` §5).

### 3.4 When an org leaves

The owner runs `org.offboard` (R3) and gets a sealed export (`crove.org-export.v2`). Final deletion is run by staff after the export and any notice period. It is not automated.

| Kept | Deleted or anonymized |
|---|---|
| The books for at least 10 years | other files |
| | parties, mail and inbound records |
| | members and invites |
| | AI run records |

The tenant row stays, marked `closed` (`docs/runbooks/org-offboarding.md`).

## 4. Processing by other services

| Service | What it receives | Source |
|---|---|---|
| AI endpoint (`AI_BASE_URL`; D9: the DOS.AI gateway) | Finance: the text of PDFs (at most 60,000 characters) and the bytes of photos. Social: post briefs, drafts and images for alt text. CRM: a client's message a member pastes for booking suggestions (at most 4,000 characters, #1440), which may name the client. XML e-invoices never go to it. No redaction before sending. Prompts and raw answers are not stored: `ai_run` keeps status, cost and taint only. | `modules/finance/src/extract.ts`, `packages/agent/src/index.ts`, `packages/agent/src/social.ts`, `packages/agent/src/scheduling.ts`, `20261018050000_crove_kernel_agents_org_chart.sql` |
| SMTP or Resend | recipient address and content of sign-in mails, invites and reports | `.env.example` (`SMTP_*`) |
| S3-compatible storage | every file, export, archive and backup | `.env.example` (`S3_*`), `docs/runbooks/provision-pilot.md` |
| Cloudflare Email Routing and a mail worker | the raw message of every mail sent to an org's inbound address, attachments included, relayed to Crove | `tools/inbound-mail/worker.js`, `docs/runbooks/provision-pilot.md` |
| Alert webhook (Telegram, Slack or Discord) | operations alerts carry check names and counts. Security alerts carry ids and counts, with user and org ids but no email, name or token. A Social team-chat alert, set up per org, carries up to 400 characters of a post. | `apps/kernel/src/security-signals.ts`, `modules/social/src/chat-alerts.ts` |
| Uptime check and heartbeat monitor | a request to `/healthz`, or a ping; no data | `docs/runbooks/alerts.md` |
| Tax code lookup (`TAX_CODE_LOOKUP_URL`) | the tax codes users type | `.env.example` |
| Tax portal hoadondientu.gdt.gov.vn (`TAX_PORTAL_SYNC`, #325), when an accountant runs the assisted sync | the client's tax code, the portal password and CAPTCHA answer the accountant types (used for that one login, never stored); the client's purchase invoices come back, which may name individual sellers. The portal's answer is stored as the list's evidence file | `apps/kernel/src/portal-sync.ts`, `docs/integrations/tax-portal-sync.md` |
| The browsers' push services (Google, Mozilla, Apple, Microsoft), when the deployment sets the VAPID keys and a member turns push on for a device (#1238) | an encrypted message (RFC 8291) with the product name, a short line naming the kind of notice and the app path it opens, never the post's text; the push service sees the endpoint it issued, the time and the size | `apps/kernel/src/web-push.ts` |
| Pexels (`MEDIA_PEXELS_API_KEY`), when the deployment turns stock photos on | the search terms members type and the ids of the photos they save, sent by the API only (never from a browser); the photos and their credits come back | `apps/kernel/src/stock-photos.ts` |
| Google (Calendar API and OAuth, when a member connects their own calendar, #2123/#2144) | out: the OAuth code exchange, token renewals, a free/busy request for a time range (no personal data about others) and, on disconnect, a revoke of the grant; in: the account's verified email and busy ranges (start and end only, never titles or attendees). The member's own grant, with a consent screen naming the free/busy scope; the sealed token is opened only by the worker; on disconnect the busy ranges go at once and, within about 15 minutes, the worker revokes the grant at Google and deletes the address and the sealed token; no revoke is made when Google refuses for 3 days, when the token can no longer be opened, when the connection had already expired (its token is gone) or when the org is closed by the purge (an org being offboarded is not swept at all: its sealed tokens and addresses stay until the purge or a reopening, #2148), and the audit row of a finished disconnect says `revoked: false` with the reason | `packages/channel/src/calendar-google.ts`, `apps/kernel/src/calendar-sync.ts`, `20261109090000_crove_kernel_calendar_connection.sql`, `20261110090000_crove_kernel_calendar_disconnecting.sql` |
| The calendar app a member subscribes with (Google Calendar, Outlook, Apple Calendar and others), when the member makes a booking feed address (#1382) | the member's confirmed bookings from 30 days back to 90 ahead, fetched by that provider from `/cal/<token>.ics`: times, the event type and its location, and each visitor's name; never the visitor's email, phone or note. The member's own subscription; the address stops when it is revoked or replaced, the member leaves the org or becomes a viewer, or the account is disabled | `apps/kernel/src/booking-feed.ts`, `20261102040000_crove_crm_booking_feed.sql` |
| Social networks (Meta, Zalo, Threads, LinkedIn, YouTube, TikTok, X, Pinterest and others), when an org connects one | the posts and media the org publishes; the account's identity comes back | `.env.example`, `packages/channel/src/` |

## 5. Rights of the people concerned

| Right | How it is served |
|---|---|
| See, and get a copy | an owner or admin finds a person's data by email, phone or tax code and downloads it as JSON (`kernel.personal_data.find`, #975) |
| Erasure | an owner erases it, R3 with a fresh second factor; what the law keeps is kept and listed with its reason (`kernel.personal_data.erase`, #995) |
| Correction | ordinary edits; a wrong invoice is corrected by its issuer |

The procedure is `docs/runbooks/personal-data-requests.md`.

## 6. Security measures in code

| Measure | Source |
|---|---|
| Org isolation in the database (row-level security), with a generated cross-org test for every tenant table | `crove_kernel.apply_tenant_rls`; `apps/kernel/test/invariant/` (gate T8) |
| A second factor within 5 minutes for every R3 action (posting, erasure, role changes); refused on a public URL when switched off | `packages/kernel-runtime/src/runtime.ts`, `apps/kernel/src/config.ts` |
| A sealed request context that SQL cannot forge | `20261015170000_crove_kernel_sealed_context.sql` (gate T11) |
| Social channel tokens sealed with AES-256-GCM, under a key kept outside the database | `packages/kernel-runtime/src/vault.ts` |
| Sealed exports and backups (AES-256-GCM) | `apps/kernel/src/export-seal.ts`, `docs/runbooks/backup-and-restore.md` |
| TLS on a public URL; the API bound to loopback behind the TLS proxy | `apps/kernel/src/config.ts`, `docker-compose.yml` |
| Files parsed in a sandbox with no network route and no secrets | `docker-compose.yml`, `apps/extract/src/sandbox.ts` (gate T12) |
| Append-only audit log, chained into a WORM archive and verified nightly | bootstrap migration, `docs/runbooks/worm-archive.md` |
| Rate limits on the API, on sign-in mail and on org creation | `apps/kernel/src/config.ts`, `20261017030000_crove_kernel_auth_email_limit.sql` |
| Alerts on refusal spikes, one user in many orgs, and new owners or admins | `apps/kernel/src/security-signals.ts` (#996) |
| AI output never posts by itself: deterministic checks, then a person approves | `AGENTS.md` ("AI"), the proposal flow |

## 7. Known gaps

These are stated here and in the questions for the lawyer ([README.md](README.md)) rather than hidden:

- Free text and stored files are not covered by the find and erase tools.
- Final deletion after offboarding is run by hand.
- No crypto-shredding yet: data inside append-only records stays as long as the records do (ADR-0017).
- Document content goes to the AI endpoint without redaction.
- Retention holds on evidence files need an S3 bucket with Object Lock; on local disk, or a bucket without it, posted files are not held (#1009). Which files and from when awaits the accountant's confirmation; today the default is 10 years from the posting.
