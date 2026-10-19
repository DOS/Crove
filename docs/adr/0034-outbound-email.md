# 0034. Outbound email: one kernel pipeline, an optional Email module

- Status: proposed (plan Decision 18); the owner accepts it before step E1 of the [Email plan](../plan/email.md)
- Date: 2026-10-19
- Deciders: owner (JOY)
- Builds on: ADR-0025 (channel layer: `external_call`, credential store, retry safety per step), ADR-0030 (composition root), ADR-0031 (module enablement)
- Plan: [docs/plan/email.md](../plan/email.md)

## Context and problem statement

The owner decided on 2026-10-19 to add an Email module for transactional email and email marketing (plan Decision 18). On `main`, outbound mail is one SMTP adapter (`apps/kernel/src/mail.ts`) used for one mail, the member invite, sent synchronously from the RPC. There is no record of what was sent, no bounce or complaint handling, no suppression list, no consent record and no unsubscribe.

Several modules will send mail: the kernel (invites, approvals waiting), Finance (invoices to customers, requests for missing documents to client companies), Social (expired channel alerts). ADR-0031 requires each of them to run when the others are off. Marketing mail adds legal duties (Decree 91/2020/ND-CP on spam, the Personal Data Protection Law 91/2025/QH15) and the mailbox providers' bulk sender rules (SPF, DKIM, DMARC, one-click unsubscribe, a spam rate under 0.3%). On a shared deployment, one org's spam harms every org's delivery.

The questions: where the sending pipeline lives, which rules every sender must pass, how a send stays single when a provider times out, and where consent and campaigns live.

## Decision

1. **The sending pipeline is a kernel service; the Email module is optional.** The kernel owns `mail_message` (one row per mail to one recipient), `mail_suppression` and `mail_event`, two worker queues (`kernel-mail-send` for system and transactional mail, `kernel-mail-bulk` for marketing) and the delivery webhook route. The module `email` (`@crove/mod-email`, schema `crove_email`) owns sender domains, templates, contacts' topics, subscriptions and consent, audiences, campaigns and analytics. With `email` off, every module still sends from the deployment's default sender with built-in templates.
2. **Rules no sender can skip,** applied by the kernel in the transaction that queues a mail: the suppression check for `(org, address hash, stream)`; a `mail_message` row before any provider call; no network I/O in command handlers. Hard bounces suppress all of an org's mail to the address; complaints and unsubscribes suppress marketing. Suppression rows are never deleted; lifting one is an R2 command with a reason, and a complaint is lifted only by the recipient's own new double opt-in. The suppression key is an HMAC of the normalized address, so it survives erasure of the contact.
3. **One send per mail, or a visible unknown.** Each provider call goes through `crove_kernel.external_call` with the key `mail:<message>:<attempt>`, and each adapter declares the retry safety of its send step (ADR-0025). An unknown outcome is `ambiguous`: never retried for marketing; retried for transactional mail only when the provider dedupes or can be asked by Message-ID, otherwise shown to a person with a "send again" action.
4. **Two streams, kept apart** from the queue to the provider: marketing can use its own provider account, message stream or IP pool (`MAIL_MARKETING_*`), so its complaints never touch transactional delivery, and a marketing burst never delays an invite.
5. **Providers behind `@crove/mail`.** A `MailProvider` interface (send, typed errors, webhook parsing with signature checks, capability data); adapters `smtp` (today's), `log`, and HTTP providers chosen per deployment by `MAIL_PROVIDER`, each with an FQDN allowlist until ADR-0016 exists. Self-host needs only SMTP; `docker compose` delivers everything to Mailpit. Crove Cloud chooses its provider in `crove-cloud`.
6. **Marketing needs consent, a verified domain and an approval.** A campaign goes only to contacts with a recorded consent (append-only `consent_event` with basis and evidence) for its topic, only from an org domain verified with SPF or DKIM aligned and a DMARC record, with a one-click unsubscribe (RFC 8058) and footer links in Vietnamese and English, with the `[QC]` label while the org's setting is on (default on), at most 3 marketing mails per address in 24 hours, and only after a human's R2 approval of its current revision. Agents and AI drafts never schedule or send.
7. **Public endpoints without sign-in** (unsubscribe, preferences, signup forms, optional click redirects) use signed tokens from a dedicated key ring, resolve the org through a definer from stored rows, reveal nothing for a bad token, and keep working for 12 months after a key rotation. Tracking is off by default; there is no open pixel in v1.
8. **A guard per org:** a marketing complaint rate above 0.3% or a hard bounce rate above 5% over 7 days pauses the org's marketing and alerts; an owner resumes it with an R2 command.

## Consequences

- Every module gets reliable, logged mail with bounce handling without depending on the Email module.
- The kernel grows three tables, two queues and a webhook route; each is a protected-path change with its own security review, and each new table lands its RLS matrix row factory first.
- The invite RPC still sends synchronously: its link holds the raw invite token, which no table stores, so no worker could build it. The invite gets its `mail_message` row and the suppression check in the command, the API records the outcome on that row, and the members screen shows the delivery status (E2). The invite answer is unchanged. In general, mail whose body carries a secret is sent by the request that holds it.
- Marketing over plain SMTP sees no complaints (feedback loops go to ESPs); the product says so and the guard uses bounces only.
- Erasure keeps an address hash in `mail_suppression`; the deletion map (ADR-0017) records this.
- The plan's "bulk email marketing only on real customer demand" (§13, §15) is replaced by this module.

## Alternatives considered

- **Everything in the Email module.** Rejected: with `email` off, other modules could not send, or would send without suppression and logging; ADR-0031 forbids the first and the law forbids the second.
- **Leave lists, suppression and unsubscribe to the provider (ESP).** Rejected: locks every deployment to one vendor, and self-host on plain SMTP would have none of it. Provider-level suppression is still read (`suppressed_by_provider`).
- **Embed an existing tool such as listmonk.** Rejected: a second application stack with its own database and auth breaks the one write path through `execute()`, RLS and the audit trail; its license and upgrade path would bind the core. It stays a design reference.
- **Model sending as a `channel_connection` (ADR-0025).** Rejected for v1: the channel layer is shaped around OAuth accounts per org, while v1 sends through a deployment-level provider. A later per-org provider account (an org's own ESP key) can use the channel layer and the credential store.

## Acceptance tests (before E7 is done)

- A hard bounce, then a send to the same address: `suppressed`, no provider call (kernel database test).
- A worker killed after the provider call and before recording it: the campaign recipient is `ambiguous` and gets no second mail.
- A one-click POST to `/-/u/<token>` with no cookie unsubscribes; a tampered token returns the generic page and changes nothing.
- A campaign without an approval of its current revision is refused by `email.campaign.schedule`; an agent actor cannot decide one.
- With `CROVE_MODULES=kernel`, an invite is logged and delivered to Mailpit with the built-in template.
