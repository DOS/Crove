# Crove Email: module plan

> Plan for the Email module (`email`, product name "Crove Email"), 2026-10-19. Owner decision of 2026-10-19: add an Email module covering transactional email and email marketing (kernel plan, Decision 18). It replaces the earlier line "bulk email marketing: only on real customer demand" (kernel plan §13 "After the core modules", §15). It keeps the milestone order of the [backlog review](backlog-review-2026-10-17.md): steps E1 and E2 go to M2 at P2 and E3 to E9 wait until M3 is done (review decision D11, decision E-1 in §6). Architecture decision: [ADR-0034](../adr/0034-outbound-email.md) (proposed). The kernel plan's Email section in §13 stays the summary; this file is the detailed plan. Vietnamese page for the owner: [email.vi.html](email.vi.html).
>
> Design references (studied for behavior, no code copied, as for Social): listmonk, Mautic, Mailchimp and Brevo for campaigns and consent; Postmark, Amazon SES and Resend for sending, message streams, bounces and webhooks. Rules: RFC 8058 (one-click unsubscribe), the Gmail, Yahoo and Outlook.com sender requirements, Decree 91/2020/ND-CP (anti-spam) and the Personal Data Protection Law 91/2025/QH15 (§3.12).

## 1. Goal and scope

Crove Email lets an organization send the email its business needs, from its own domain, reliably and within the law: one-to-one transactional mail triggered by its work (an invoice to a customer, a payment reminder, a request for missing documents to a client company, a member invite, an approval waiting) and marketing mail to contacts who agreed to receive it (newsletters, announcements, promotions).

The two streams follow different rules, so they are kept apart from the queue to the provider:

| | Transactional | Marketing |
|---|---|---|
| Trigger | A command or a person; one recipient; the recipient expects it | A campaign sent to an audience |
| Consent | Not needed for a service message (a contract, an invoice, an account notice) | Prior consent for the campaign's topic, with evidence |
| Unsubscribe | Not required; a preference link where it makes sense | One-click (RFC 8058) plus a footer link in Vietnamese and English |
| Subject label (Vietnam) | None | `[QC]` or `[AD]` at the start of the subject |
| Approval | The template once; each send carries the risk of the command that sends it | Every campaign send is R2: a human approves its current revision |
| Suppression | Hard bounces, complaints | Hard bounces, complaints, unsubscribes |
| Pace | At once, priority queue | Throttled per org and per receiving domain; caps and warm-up |

**v1 (this plan):**
- Kernel mail pipeline: every send queued through the outbox, logged per recipient, sent once through the `external_call` ledger (or flagged when the outcome is unknown), and checked against the suppression list. Member invites get their log row and the suppression check, and stay sent by the request (their link holds a secret, §3.2).
- Delivery events: bounces and complaints from provider webhooks, and bounce reports (DSNs) through the inbound mail route for plain SMTP; hard bounces and complaints suppress the address.
- Sender domains: an org verifies its own domain (SPF, DKIM, DMARC), with a daily re-check.
- Templates: a block model rendered to HTML and plain text, in Vietnamese and English; built-in defaults for every mail Crove sends, and org overrides; preview in a sandboxed frame.
- Message log: status per mail (queued, sent, delivered, bounced, complained, suppressed), searchable by recipient for support.
- Contacts and consent: subscription topics, an append-only consent record, double opt-in, CSV import with a declared basis, a hosted signup form.
- Unsubscribe and preferences: signed links, one-click unsubscribe, a preference page, no sign-in.
- Campaigns: audiences (lists and segments), composer with preview and test send, review and approval, scheduled and throttled sending, pause and cancel.
- Analytics: delivered, bounced, complaints, unsubscribes per campaign; click counts only when the org turns them on.
- AI: drafts and rewrites of subjects and bodies, tainted, always landing as drafts.
- Local: in `docker compose`, every mail (campaigns included) lands in Mailpit; no provider account needed.

**Later (v1.x, same plan):** automation sequences (welcome series, drip) on the kernel process engine; subject A/B tests; an org's own provider account (its ESP key through a channel connection and the credential store); a public `/v1` transactional send API with API keys (after Phase 3's `api_key`), so developers can use Crove as their transactional mail service; replies landing in Service's inbox (Phase 4); dedicated sending IPs; send-time suggestions; the `email.marketer` agent template (ADR-0029).

**Not in Email:** the shared inbox for replies (Service, Phase 4); SMS and Zalo messages (a channel concern, not email); bought, rented or scraped lists, ever; cold outreach automation.

## 2. Fit with what exists

| Email needs | In core today | Plan |
|---|---|---|
| Sending | `apps/kernel/src/mail.ts`: one SMTP adapter (nodemailer, `SMTP_*` settings, Mailpit locally) or a log-only mailer; the member invite is sent synchronously from the RPC right after `kernel.member.invite.create` | Keep the `Mailer` port; sends move behind the outbox and a worker queue (E1), except mail that carries a secret, such as the invite (§3.2) |
| One send per recipient | `crove_kernel.external_call` ledger (Social S4) | Reuse: one call per mail (E1) |
| Suppression | None | Kernel table checked in the transaction that queues every send (E1) |
| Bounces and complaints | None | Provider webhooks; DSNs through the inbound route (E2) |
| Provider adapters | SMTP only | `@crove/mail`: a provider interface, the SMTP adapter, a first HTTP adapter, each HTTP adapter with an FQDN allowlist (E2) |
| Provider keys | `crove_kernel.credential` (envelope-encrypted, ADR-0025) | Deployment-level keys in env for v1; per-org keys later through the credential store |
| Contacts | `crove_kernel.party.email` (one address per party); the plan's `contact_point` (§6, v0) is not built | Build `contact_point`, backfilled from `party.email` (E5) |
| Consent | None (the only "consent" on `main` is for member invites) | `crove_email.subscription` and an append-only `consent_event` (E5) |
| HTML mail | The invite's fixed text | Block templates rendered server side; HTML preview only in a sandboxed frame (kernel plan §7.6) (E4) |
| Module registration | `CROVE_MODULES` (ADR-0031) | Register `email`; it adds its case to the module enablement test (E3) |
| Public pages without sign-in | The inbound route; booking and signing pages are planned | Unsubscribe, preference, signup and click routes (E6, E8), each a protected `http.ts` change |
| Egress policy | ADR-0016 not written; adapters keep their own FQDN allowlists (kernel plan §7.7) | The same: each HTTP mail adapter has its allowlist |

**What this means:**
- Independent: `modules/email` (domain, schema, commands, queries, jobs), `packages/mail` (adapters), the Email screens in `apps/app`.
- Kernel work owned by this stream: the mail pipeline and suppression (E1), delivery events (E2), `contact_point` (E5), the public routes (E6, E8). These are protected paths (migrations, `http.ts`), so each PR gets an independent security review and runs the invariant suite from base. New tables with `org_id` land their RLS matrix row factory on `main` first (the `PENDING_TABLES` rule).
- Shared hot files touched additively: `kernel.ts`, `rpc.ts`, `contract.ts`, `schemas.ts`, `worker.ts`, `router.tsx`, i18n messages, `config.ts` (`AVAILABLE_MODULES`), `tools/db-types.mjs` and `check-unions.db.test.ts` (`SCHEMAS`). Rebase right before merge (AGENTS.md).

## 3. Architecture

### 3.1 Where each piece lives

Every module sends mail: the kernel sends invites, Finance will send invoices and reminders, Social alerts owners about expired channels. ADR-0031 requires modules to run when others are off. So the pipeline, and the rules no sender may skip (suppression, logging, one send per mail), live in the kernel; the Email module adds what an organization manages: domains, templates, contacts and consent, campaigns, analytics. With `email` off, every other module still sends from the deployment's default sender with the built-in templates.

| Path | Contents |
|---|---|
| `crove_kernel` (migrations) and `apps/kernel/src/mail*.ts` | `mail_message`, `mail_suppression`, `mail_event`; the send and bulk queues; the delivery webhook route; the `kernel.mail.*` commands |
| `packages/mail` (`@crove/mail`) | `MailProvider` interface; adapters `smtp`, `log` and HTTP providers; webhook and DSN parsers; MIME headers (Message-ID, List-Unsubscribe, Feedback-ID). Only jobs call adapters; command handlers never do network I/O |
| `modules/email` (`@crove/mod-email`) | `src/domain/` pure TS: template blocks and rendering, merge fields, audience filters, the campaign state machine, throttle and warm-up math, the consent rules, content lint. `src/` commands, queries, jobs (campaign fan-out, domain checks) |
| `packages/agent` | `EmailWriter` |
| `apps/app` | `/email` screens; the message log also shows on the members screen for invites |

### 3.2 Kernel: outbound mail

| Table | Key columns |
|---|---|
| `mail_message` | one row per mail to one recipient: `stream` (`system`, `transactional`, `marketing`), `source` (the sending command and record, for example `kernel.member.invite:<id>` or `email.campaign:<id>`), `template_key` and version, `to_address` (normalized, classified `pii`), `to_hash` (HMAC of the normalized address under a deployment key), `from_address`, `reply_to`, `subject`, `payload` (merge data, `pii`, dropped 30 days after the final status), `message_id_header` (generated once, kept across attempts), `status`, `provider`, `provider_message_id`, `attempt`, timestamps |
| `mail_suppression` | `to_hash`, `scope` (`all` or `marketing`), `reason` (`hard_bounce`, `complaint`, `unsubscribe_all`, `manual`, `provider`), `source_message_id`, `created_at`; lifted only by writing `lifted_at`, `lifted_by`, `lift_reason`; never deleted |
| `mail_event` | append-only provider events (`delivered`, `deferred`, `bounce_hard`, `bounce_soft`, `complaint`, `unsubscribe`, `click`), unique per `(provider, provider_event_id)` so a replayed webhook changes nothing |

**Message states:** `queued` -> `sending` -> `sent` -> `delivered`; `sent` can also end in `bounced` or `complained`; `suppressed` (refused before any provider call), `failed` (refused by the provider before acceptance), `ambiguous` (outcome unknown).

**Rules:**
- A command that sends mail inserts the `mail_message` row in its own transaction, after the suppression check for `(org, to_hash, stream)`. A suppressed transactional send is recorded as `suppressed` and the command learns it (`MAIL.SUPPRESSED`); a suppressed campaign recipient is skipped and counted. No handler calls a provider.
- Two worker queues: `kernel-mail-send` (system and transactional, sent at once) and `kernel-mail-bulk` (marketing, throttled). A marketing burst never delays an invite or an invoice.
- One send per mail: the job writes `external_call` with the key `mail:<message>:<attempt>` in state `started`, commits, then calls the provider. Plain SMTP and most provider APIs have no idempotency key, so a timeout after the provider may have accepted the mail leaves the call `ambiguous`. Marketing never retries an ambiguous send (a missed newsletter is better than a duplicate). Transactional mail retries only when the adapter declares the step `idempotent` (the provider dedupes) or can look the mail up by its Message-ID; otherwise the log shows "outcome unknown" with a "send again" action for a person.
- Mail whose body carries a secret is sent by the request that holds the secret, never queued. The member invite's accept link holds the raw invite token, and the database keeps only its hash (`invite-mail.db.test.ts` checks that the token is stored nowhere), so no worker could build the link. The invite command writes the invite's `mail_message` row in its own transaction: `suppressed` when the org stopped the address, `sending` otherwise. The API reads the row back (`kernel.mail.direct.get`), sends the mail only while it is `sending`, and records the outcome with `kernel.mail.record_direct` (only the member who created the row, once, within 10 minutes). The invite answer stays the one #35 defined, the same for every address (the invariant suite pins it); the members screen shows the delivery status from the row (E2).
- Supabase Auth's own mails (confirmation, recovery, magic link) stay with Supabase Auth and its SMTP settings; the pipeline does not see them.
- Logs never carry a body, an address or a provider error message (as `mail.ts` today): codes only.

### 3.3 Delivery events and suppression

- **Provider webhooks:** `POST /webhooks/mail/<provider>`, verified with the provider's signature scheme (or a per-deployment secret where a provider has none), stored bounded, and processed by the worker as untrusted input (kernel plan §7.6). An event is matched to its `mail_message` by the provider's message id; the org comes from the stored message, never from the payload.
- **Plain SMTP:** the Return-Path is a per-message address `bounce+<token>@INBOUND_DOMAIN` (VERP). Bounce reports (DSN, RFC 3464) arrive through the existing inbound route and are parsed in the `crove-extract` sandbox like every inbound MIME message. Complaints need feedback loops (ARF, RFC 5965) that mailbox providers give only to large senders and ESPs, so a deployment on plain SMTP sees no complaints; the campaign screen says so, and the guard below works on bounces only.
- **What suppresses:** a hard bounce suppresses all mail to the address for the org (scope `all`); a complaint suppresses marketing (scope `marketing`) and flags the address on the transactional log; an unsubscribe changes the subscription (§3.6), and "unsubscribe from everything" adds scope `marketing`. Soft bounces are retried by the provider; three in 7 days suppress marketing for 30 days.
- **Lifting:** `kernel.mail.suppression.lift` is R2, owner or admin, with a reason (for example a mailbox that was full and is fixed). A complaint suppression is never lifted by command: only the recipient's own new opt-in (double opt-in) lifts it.
- **Guard:** in a rolling 7-day window, a marketing complaint rate above 0.3% or a hard bounce rate above 5% pauses the org's marketing sends and alerts the owner (and the operator on Crove Cloud). An owner resumes with an R2 command after looking at the cause.

### 3.4 Sender identity and domains (module)

- `sender_domain`: `domain`, `status` (`pending`, `verified`, `failing`), the DNS records to publish, `verified_at`, `checked_at`. The org publishes a verification TXT record, SPF (the provider's include), DKIM (the provider's records, or a Crove-generated key when Crove signs for plain SMTP), and a DMARC record; optionally a custom Return-Path domain. A job checks DNS (resolver lookups only, no HTTP) at add time and daily; a domain that starts failing stops marketing from it and alerts.
- One org per verified domain in a deployment: verifying a domain another org holds needs that org's record removed first, so one tenant cannot send as another's domain.
- **From rules:** marketing only from a verified org domain with SPF or DKIM aligned to the From domain and a DMARC record present (the bulk sender rules, §3.12). Transactional org mail from a verified org domain when there is one, else from the deployment's default sender with the org's name in the display name and the org's address as Reply-To. Crove never puts an unverified org domain in From.
- DKIM private keys that Crove holds (plain SMTP signing) are sealed in `crove_kernel.credential`. With an ESP, the ESP signs.

### 3.5 Templates and rendering (module)

- `template` and `template_version` (immutable once published): `kind` (`transactional`, with a `slot` such as `finance.invoice.sent` or `kernel.member.invite`; or `campaign`), `locale` (`vi`, `en`), `subject`, `preheader`, `blocks` (typed JSON: heading, text, button, image, divider, columns, footer), and the plain-text part generated from the blocks.
- Rendering in `modules/email/src/domain`, server side: blocks to table-based HTML with inline CSS, plus the text part. The renderer is chosen in E4 (MJML or React Email, both MIT, or a small own renderer); the block JSON is Crove's format either way, so the renderer can change. Merge fields such as `{{party.name}}` are escaped; a template with an unknown field cannot be published. No raw HTML block in v1.
- Every slot has a built-in default template in both languages, shipped with the code; an org override applies only when the module is on. Transactional templates may not contain promotional blocks (a lint), because mixing promotion into a service mail makes it advertising (§3.12).
- The marketing footer is fixed: the org's legal name and address, why the recipient gets the mail (the topic), the unsubscribe and preference links in Vietnamese and English.
- Preview: the rendered HTML only inside a sandboxed iframe on the user-content origin (no `allow-scripts`, no `allow-same-origin`), per kernel plan §7.6.
- Images: recipients' mail clients fetch remote images, so images need a public URL. They are served from the org's files through long-lived unguessable URLs on the user-content origin, only for files marked public by inserting them into a template. A deployment with no public URL (a laptop) embeds them inline instead.

### 3.6 Contacts, consent and audiences (module)

- Recipients are kernel `party` rows with `contact_point` rows (kind `email`, `value_norm`, `source_trust`, `verified_at`), the kernel table from plan §6 built in E5 with a backfill from `party.email`. Changing an existing party's contact point stays under policy P04 (review, not overridable): an import that would change one goes to review instead of overwriting.
- `topic`: what a contact can subscribe to, per org (for example "Bản tin hằng tháng", "Khuyến mãi"), each with the text shown on the preference page.
- `subscription`: `(contact_point, topic)` with `status` (`pending`, `subscribed`, `unsubscribed`), always derived from the latest `consent_event`.
- `consent_event`, append-only: `action` (`opt_in`, `confirm`, `opt_out`), `basis` (`double_opt_in`, `form`, `import_attested`, `in_person`, `api`), `source` (the form, import or member), `evidence` (the version of the consent text shown, and for forms a hash of the request metadata), `occurred_at`. This is the proof of consent Decree 91/2020 and the PDPL ask for.
- **Signup:** a hosted form `/-/f/<form>` (embeddable later), with Turnstile and rate limits; double opt-in by default: the subscription is `pending` until the contact clicks the confirmation mail.
- **Import:** CSV; the importer chooses the topics and attests the basis (the legal text is shown and its version recorded, per row). Rows without a basis import as contacts with no subscription and receive only transactional mail. An org may send a double opt-in mail to imported rows instead of attesting.
- `audience`: a list (members added by hand or import) or a segment (a saved filter on contact and party fields and tags, the Filter AST of Phase 3's `saved_view` when it exists; a small fixed filter set before that). An audience is resolved at send time and always narrowed to contacts `subscribed` to the campaign's topic, minus suppressions.
- **Erasure** (PDPL request): the contact's address and personal fields are removed and its consent events keep no personal data, but the suppression hash stays, so a person who asked to be forgotten never receives marketing again. This goes into the deletion map (ADR-0017).

### 3.7 Campaigns (module)

**States:** `draft` -> `in_review` -> `approved` -> `scheduled` -> `sending` -> `sent`; `paused` (by a person or by the guard), `cancelled` before sending finishes. An edit returns the campaign to `draft`: an approval covers one revision and its content hash (as Social's `post_approval`).

**Sending:**
1. `email.campaign.schedule` (R2) needs an approval of the current revision. At `send_at`, a sweep job snapshots the recipients into `campaign_recipient` (one row per contact point, unique per campaign), applying the topic subscription, suppressions and the frequency rule: at most 3 marketing mails from the org to one address in 24 hours unless the recipient agreed to more (Decree 91/2020).
2. Fan-out jobs send in batches through `kernel-mail-bulk`, paced per org (warm-up for a new domain: a low first-day cap that doubles while bounce and complaint rates stay healthy) and per receiving domain.
3. Each recipient gets a `mail_message` (stream `marketing`) and its `external_call`; ambiguous outcomes are counted, never retried. A pause stops new batches; a batch in flight finishes.
4. Headers: `List-Unsubscribe` with the HTTPS link (and a `mailto:` address when the deployment has an inbound domain) and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058); `List-Id`; a `Feedback-ID` with an opaque campaign id for Gmail's feedback loop.
5. The subject starts with `[QC]` while the org's Vietnam label setting is on (default on); the composer shows the label and cannot remove it while the setting is on.

**Who:** members draft and submit; `email.campaign.decide` (R2) is for owners and admins, never an agent. Four-eyes is an org setting, on by default above 500 recipients. A test send goes only to verified addresses of the org's own members, never to arbitrary addresses outside approval.

### 3.8 Unsubscribe, preferences and tracking

- **Links:** `/-/u/<token>`; the token is an HMAC (deployment key ring, separate from every other key) over the org, the contact point, the topic and the mail. It carries no address or name. A GET shows a page with one button and the preference page; a POST (the RFC 8058 one-click request, no cookie, no sign-in) unsubscribes at once and is idempotent. A forged, expired or revoked token gets the same generic page, so nothing can be enumerated.
- The unsubscribe runs `email.subscription.opt_out` as a system command in a context derived from the token through a definer (as the inbound resolver derives the org from its address), writes a `consent_event`, and takes effect before the next batch: Decree 91/2020 says stop at once; Gmail and Yahoo allow 2 days.
- With an inbound domain, `mailto:unsubscribe+<token>@INBOUND_DOMAIN` works too, through the inbound route.
- Old links keep working for 12 months after a key rotation (a key ring with overlap).
- **Tracking:** off by default. Tracking clicks or opens processes personal data (PDPL), and opens are unreliable since mail clients prefetch images. When an org turns click counts on, links are rewritten to `/-/c/<token>`, which redirects only to the URL recorded for that link in that campaign version (no open redirect), and the org's privacy notice must say so. No open pixel in v1.
- The public pages are plain server-rendered HTML with a strict CSP and no app session; they are protected `http.ts` changes.

### 3.9 Providers (`@crove/mail`)

- `MailProvider`: `send(message)` returns `accepted` (with the provider's id), `rejected` (with a typed error: `invalid_recipient`, `suppressed_by_provider`, `rate_limited` with a retry time, `auth`, `bad_request`, `transient`) or `unknown`; each adapter declares the retry safety of its send step (`safe`, `idempotent`, `reconcile_only`, `never`, as in ADR-0025); `parseWebhook(request)` checks the signature and returns events; static capability data (idempotency support, message streams, recipients per call, rate limits).
- Adapters: `smtp` (today's nodemailer adapter), `log` (no SMTP configured), and a first HTTP adapter in E2. Candidates are Amazon SES, Postmark and Resend; the E2 issue picks one by bounce and complaint webhooks, idempotency, delivery to Vietnamese mailboxes and price. Others come on demand.
- Configuration per deployment: `MAIL_PROVIDER` (default `smtp`) plus that provider's settings; an optional second set for the marketing stream (`MAIL_MARKETING_*`) so marketing can use its own provider account, message stream or IP pool, and its complaints never touch transactional reputation.
- Self-host: SMTP to any relay; `docker compose` sends everything to Mailpit, so the whole flow runs offline. Crove Cloud picks its provider in `crove-cloud`, with marketing on a separate stream.
- Each HTTP adapter has an FQDN allowlist (as `@crove/channel`) until the egress policy (ADR-0016) exists.

### 3.10 AI

- `EmailWriter` in `packages/agent`: `draft(brief, audience description, voice)` returns a subject, preheader and blocks; `rewrite(blocks, instruction)` shortens, changes tone or proposes subject variants. Structured output (zod), checked by the domain rules.
- AI output, and anything drafted from tainted input, is `tainted` and lands as a draft. Every campaign needs a human approval in v1, tainted or not.
- AI never chooses recipients in v1: audiences are filters a person defines. Agents (ADR-0029) may create drafts; they never schedule, decide or send.
- Content lint is deterministic, not AI: a missing text part, an image-only body, an all-caps subject, link shorteners, a missing `[QC]` label while the setting is on, promotional blocks in a transactional template.

### 3.11 Security, tenancy and abuse

- **Tenancy:** every table has `org_id`, `PRIMARY KEY (org_id, id)` and RLS through `apply_tenant_rls`; FKs are composite and point only into `crove_email` or `crove_kernel`. Webhooks, bounce reports and unsubscribe tokens resolve the org from stored rows, never from what the sender claims.
- **Abuse on a shared provider (Crove Cloud):** one org's spam hurts every org's delivery. Marketing for a new org is capped (for example 1,000 mails a day) until its domain is verified and its first campaigns show healthy rates; the operator raises caps; the guard pauses an org automatically; mail without a consent basis cannot be sent; the operator has a deployment-wide marketing kill switch. Whether every Cloud org gets marketing, or only operator-approved ones at first, is decision E-3.
- **Secrets:** provider keys in env (deployment) or the credential store (per org, later); DKIM keys sealed; the unsubscribe link key ring is separate from other keys and never logged.
- **Personal data:** addresses and subjects are `pii`; payloads are dropped 30 days after a mail's final status; addresses in `mail_message` are dropped after 13 months, keeping the hash for suppression and counts.
- **Policy:** campaign decisions are R2 and never made by an agent; P04 covers contact point changes (§3.6); P06's "only to verified contacts" for non-user actors covers agents asking for transactional sends.
- **Inbound:** bounce reports and `mailto:` unsubscribes are untrusted inbound mail, parsed only in the sandbox.

### 3.12 Legal and mailbox-provider rules

Vietnam first; the exact articles and any newer sanctions decree are to be confirmed with the lawyer (kernel plan §12) before marketing is offered to tenants.

- **Decree 91/2020/ND-CP** (spam messages, emails and calls), as summarized by Vietnamese legal sources: an advertising email needs the recipient's prior consent; its subject starts with a `[QC]` or `[AD]` label; it identifies the advertiser; it ends with a refusal (opt-out) function, clear and in Vietnamese and English; sending stops at once after a refusal; at most 3 advertising emails to one address in 24 hours unless the recipient agreed otherwise.
- **Personal Data Protection Law 91/2025/QH15** (in force since 2026-01-01) and **Decree 356/2025**: using personal data for advertising needs the data subject's consent, which the controller must be able to show, and the subject may withdraw it at any time. The org is the controller of its contacts; Crove (or the self-hoster) is its processor (the DPA in kernel plan §7.9).
- **Service mail is not advertising:** transactional templates carry no promotion (§3.5).
- **Outside Vietnam:** CAN-SPAM (US) and GDPR with ePrivacy (EU) are covered in practice by consent, sender identity and a working unsubscribe; there is no per-country engine in v1.
- **Mailbox providers** (Gmail and Yahoo since February 2024, Outlook.com since 2025, for senders of about 5,000 mails a day or more): SPF and DKIM, a DMARC record (at least `p=none`) aligned with the From domain, one-click unsubscribe (RFC 8058) honored within 2 days, and a user-reported spam rate below 0.3%. Crove applies them to every org regardless of volume, since a small org shares reputation with the rest of a deployment.

## 4. Steps (one PR each, end to end)

Epic: #537. E1 and E2 are in M2 at P2; E3 to E9 are in Icebox at P3 until M3 is done (backlog review D11).

| # | Step | Depends on | Touches protected paths |
|---|---|---|---|
| E0 (#535) | This plan, Decision 18, ADR-0034 (proposed) | - | No |
| E1 (#538) | Kernel mail pipeline: `mail_message`, `mail_suppression`, the send and bulk queues with `external_call`, the suppression check, the invite's log row; RLS matrix factories first. In two parts: E1a, the tables, the keyed address hash, the suppression commands and the invite's row (the invite is still sent by the request, §3.2); E1b, the queues and `external_call`, with the first queued sender (Finance's reminders to client companies) | - | Yes (migrations, kernel) |
| E2 (#539) | Delivery events: `mail_event`, `@crove/mail` with the provider interface, the first HTTP adapter, the signed webhook route, DSNs through the inbound route (VERP); hard bounces and complaints suppress; invite delivery status on the members screen | E1 | Yes (migrations, `http.ts`) |
| E3 (#540) | `modules/email` and the `crove_email` schema, registered under `CROVE_MODULES` with its menu; sender domains with the DNS check job and the From rules | E1 | Yes (migrations) |
| E4 (#541) | Templates: block model, renderer (HTML and text), sandboxed preview, built-in defaults for every slot, org overrides; the message log screen | E3 | Yes (migrations) |
| E5 (#542) | Contacts and consent: kernel `contact_point` with the backfill, topics, subscriptions, consent events, CSV import with attestation, double opt-in, the hosted signup form | E3 | Yes (migrations, `http.ts`) |
| E6 (#543) | Unsubscribe and preferences: the signed token key ring, `/-/u/` pages, one-click POST, `mailto:` unsubscribe | E2, E5 | Yes (`http.ts`) |
| E7 (#544) | Audiences and campaigns: lists and segments, composer, test send, review and approval, scheduled and throttled sending, pause and cancel, the 3-in-24-hours rule, the `[QC]` label, the guard | E4, E5, E6 | Yes (migrations) |
| E8 (#545) | Analytics: per-campaign delivered, bounced, complaints, unsubscribes; optional click counts with the safe redirect | E7 | Yes (`http.ts`) |
| E9 (#546) | AI drafting and rewrites (`EmailWriter`) and the deterministic content lint | E4 | No |
| E10 | Later items of §1, each its own issue | E7 | Some |

The first business senders beyond invites (Finance's invoice delivery and document requests to client companies, Social's channel alerts) are issues of those modules: each adds a template slot with a built-in default and sends through the kernel pipeline.

## 5. Exit criteria (v1)

1. No mail reaches a suppressed address for its stream: after a hard bounce or a complaint, the next send is `suppressed` with no provider call, for transactional and marketing mail and across a worker restart.
2. Each campaign recipient gets at most one copy: killing the worker in the middle of a batch and resuming gives 0 duplicates; ambiguous sends are counted and never retried.
3. Every marketing mail has a working one-click unsubscribe (RFC 8058) and footer links in Vietnamese and English; an unsubscribe takes effect before the next batch, without sign-in, and a forged or expired token reveals nothing.
4. Marketing goes out only from a verified org domain with SPF or DKIM aligned and a DMARC record, with the `[QC]` label while the setting is on, and only to contacts with a recorded consent for the campaign's topic.
5. A campaign is sent only after a human approval of its current revision (R2); agents and AI drafts never schedule or send.
6. The guard pauses an org's marketing when its complaint rate passes 0.3% or its hard bounce rate passes 5% over 7 days, and alerts.
7. With `CROVE_MODULES` excluding `email`, the kernel, Finance and Social run unchanged, and invites still go out with the built-in templates.
8. In `docker compose up`, every mail, campaigns included, lands in Mailpit with no provider account; a Playwright run covers compose, approve, send and unsubscribe.

## 6. Open decisions for the owner

| # | Question | Recommendation | Why |
|---|---|---|---|
| E-1 | When does each part start? | E1 and E2 (the kernel pipeline and bounces) in M2 at P2, since the pilot already depends on mail; E3 to E9 after M3, like Social under D5, unless a pilot customer asks earlier | Invites already go out by mail, and reminders to client companies are part of the monthly close loop; marketing has no pilot user yet. The backlog review's rule applies: a recommendation stands unless the owner objects (D11) |
| E-2 | Which provider for the pilot and for Crove Cloud? | One account with a transactional stream now (M1-5 already plans SMTP through a transactional provider); the E2 issue compares Amazon SES, Postmark and Resend on price and delivery | Any of them works over SMTP today; the HTTP adapter adds webhooks for bounces and complaints |
| E-3 | Marketing for every Crove Cloud org, or operator-approved orgs first? | Operator-approved first | Shared sending reputation (§3.11) |
| E-4 | `[QC]` label on by default for every org? | Yes; an org with no recipients in Vietnam may turn it off | Decree 91/2020 (§3.12) |

## 7. Risks

| Risk | Mitigation |
|---|---|
| One org's spam damages delivery for every org on a shared provider (Cloud) | Separate marketing stream; caps and warm-up for new orgs; the guard; consent required; operator approval (E-3) |
| Fines under Decree 91/2020 or the PDPL | Consent evidence per contact and topic, the `[QC]` label, opt-out in Vietnamese and English, the 3-in-24-hours rule enforced in code; lawyer review before marketing reaches tenants |
| Duplicate sends after a timeout | `external_call` per mail; ambiguous marketing sends never retried; transactional retries only where the provider dedupes or can be asked |
| HTML mail as an attack surface (XSS in the preview, leaking trackers) | Block model with no raw HTML in v1; preview only in a sandboxed frame; merge fields escaped; tracking off by default |
| Unsubscribe links break after a key rotation | Key ring with 12 months of overlap |
| Plain SMTP gives no complaint data | The campaign screen says so; an ESP is recommended for marketing; the guard uses bounces |
| Scope creep into a marketing automation suite | v1 stops at campaigns; sequences are a later item; bought lists never |
| Agent capacity taken from the pilot milestones | Decision E-1 keeps marketing after M3 unless the owner pulls it |
