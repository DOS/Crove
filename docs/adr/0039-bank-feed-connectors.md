# 0039. Bank feed connectors: bank transactions from an API, through the same lines as statement files

- Status: Proposed (2026-10-30). Where the first adapter (Tingee) lives is an **owner** decision (last section). Nothing here is built.
- Date: 2026-10-30
- Deciders: owner (JOY), on the coordinator's review
- Builds on:
  - plan §13 Phase 2b ("bank API") and the job name `finance.bank_feed.sync` in §5.3 (naming rules);
  - ADR-0021 section 6 (bank line keys);
  - ADR-0025 (channel layer: connections, the credential broker, adapters with an egress allowlist);
  - ADR-0027 (the open-source core runs without any DOS service);
  - the statement import (#486) and bank matching (#326, #551);
  - the job egress invariant (#1653).
- Issues:
  - [#2044](https://github.com/DOS/Ludy/issues/2044): the port, the file source moved onto it, and the sandbox feed;
  - [#2045](https://github.com/DOS/Ludy/issues/2045): the Tingee adapter, `owner-action` until the owner decides where it lives.

## Context and problem statement

Today a firm brings bank transactions into Ludy one way: it exports an Excel or CSV statement from its bank and imports it.
- `finance.bank.import` stores the lines of one bank account in `crove_finance.bank_line`, deduplicated by the keys of ADR-0021 section 6 (#486).
- Matching proposes vouchers from them, and people approve those in the Inbox (#326, #551).

That works, but someone must download and upload a file every month for every account. Bank reconciliation is one of the pains the backlog review lists for accounting firms. Banks and Vietnamese open-banking platforms now offer the same transactions through an API, often with a webhook per transaction.

The plan puts "bank API" in Phase 2b and lists bank aggregators among the connectors that need a contract, in `crove-cloud/connectors/` (plan §3.1, repo tree; DOS-19, a bank broker). The owner asked on 2026-10-30 for direct bank feeds in the open-source core, with Tingee as the first adapter.

**Tingee**, as its public pages describe it (read 2026-10-30):
- **Operator:** HENO Technology JSC (Công ty Cổ phần Công nghệ HENO).
- **What it offers:**
  - bank account linking and virtual accounts;
  - VietQR;
  - transaction history;
  - webhooks for incoming transactions.

  Its own account webhooks cover only some banks (ACB, TPBank, VPBank, OCB, VietinBank, PGBank, Co-opBank, depending on the account type); other banks go through a virtual account.
- **Payments too:** it offers disbursement ("Chi hộ"), single or batch.
- **Authentication:** API requests carry a client id, a timestamp and an HMAC-SHA512 signature keyed by the client's secret, and requests older than 10 minutes are refused. A webhook is signed the same way, may be retried up to five times, and should be deduplicated by its transaction code.
- **Access:** the API documentation and sandbox are readable without an account. Credentials come from a BaaS portal account and are tested in UAT before production. No public page says whether production keys need a signed partner agreement.
- **SDKs:** the developer pages point to public SDKs on GitHub. Their licence was not checked.

Sources: [tingee.vn](https://tingee.vn), [open API](https://tingee.vn/open-api/), [developer docs](https://developers.tingee.vn/docs/), [webhooks](https://developers.tingee.vn/docs/webhook/), [terms](https://tingee.vn/dieu-kien-va-dieu-khoan-dich-vu/). This ADR uses nothing but these public pages.

The question is how API feeds fit Ludy. They must not:
- fork the bank line model;
- weaken the ledger's rules;
- make the core depend on a bank service;
- leave the door open to moving money.

## Decision drivers

- **One way into the books.** A transaction is stored once and matched once, whether it came from a file or an API, and it needs a person to become a voucher, as today.
- **ADR-0027.** `docker compose up` runs with no bank service, and the feature costs a self-hoster nothing until they configure a provider.
- **Read-only.** Ludy reads transactions; it never initiates a payment.
- **Secrets and egress** follow ADR-0025:
  - credentials sealed per org;
  - opened only in worker jobs;
  - each adapter bound to its own hosts.
- **Adapters are replaceable.** Tingee is the first of several (banks' own APIs, other aggregators), and where one adapter lives must not change the core.

## Decision (proposed)

### 1. A bank-feed port in `modules/finance`; files and feeds are two sources of the same lines

- **The source.** A source produces normalized lines for one bank account of one legal entity:
  - value date;
  - signed amount;
  - description;
  - the bank's transaction reference;
  - the running balance, when the source has one.

  The statement file is one source. An API feed is another.
- **One write path.** Both go through the same code that `finance.bank.import` uses today:
  - the per-account advisory lock;
  - the ADR-0021 section 6 keys: `ref:<bank_ref>` first, then the running-balance key, else an ambiguous line in the Inbox;
  - `UNIQUE (org, legal entity, account, dedupe_key)`.

  So a transaction that arrives by webhook and again in next month's file is stored once.
- **What a line records.** It records which source it came from: the import, or the feed connection and sync run.
- **What does not change:** matching, vouchers, the period lock and reconciliation. Lines are the bank's own figures and post nothing (R1, as the import is).
- **The first step** moves the file import onto the port, with no change in behaviour. The existing tests are the check.

### 2. Providers are adapters behind a small capability interface

- **Package.** Adapters live in a package of their own, `@crove/bank-feed`, built like `@crove/channel` (ADR-0025 point 3):
  - static capability data;
  - a declared FQDN allowlist that the adapter's fetch is bound to;
  - an offline `sandbox` adapter for development and tests.

  The capabilities:
  - **connect:** link an org's bank accounts, through the provider's own flow;
  - **list accounts**;
  - **pull transactions since a cursor**, returning lines and the next cursor;
  - **verify a webhook:** check its signature and timestamp, and name the provider's accounts it is about (the worker finds the connections that list them).

  There is **no payment capability** in the interface. An adapter for a provider that also offers payments (Tingee's "Chi hộ") implements none of it, and review refuses one that calls such an endpoint.
- **Connections and credentials** reuse the kernel's channel layer:
  - a connection in `crove_kernel.channel_connection` (provider `bank_<adapter>`, such as `bank_sandbox`: the channel layer's provider ids allow no colon);
  - its credential sealed in `crove_kernel.credential` with `CREDENTIAL_KEY`;
  - connected and disconnected by owners and admins (R2);
  - opened only by the worker;
  - refused once the connecting member leaves.

  A finance table maps each connected external account to a bank account under 112 and a legal entity, and keeps the sync cursor.
- **Sync.** A worker job `finance.bank_feed.sync` per connection opens the credential, pulls since the cursor, stores the lines through point 1, and advances the cursor in the same transaction.
  - Its queue declares the adapter's hosts, and the commands that feed it declare an external effect, as the job egress invariant requires (#1653).
  - A daily schedule pulls each connection, so a missed webhook costs at most a day.
- **Webhooks.** A public route `POST /api/bank-feed/<adapter>/webhook`:
  - is on the reasoned public list (ADR-0028 route enumeration);
  - verifies the signature through the adapter, with the deployment's secret, and refuses anything older than the adapter's window;
  - only asks the worker for a pull: it names the provider's accounts, never an org or a connection. The worker finds the
    active connections of active orgs whose last listing holds an account, and queues one sync of each, at most one a
    short time slot. The org comes from that stored listing, never from the notice, so a notice can only ask for a pull
    of a connection that already exists, and a pull takes what the provider reports.

  It never stores the transaction in its body. Lines come only from a pull, so a forged or replayed webhook can at most trigger a harmless sync.

### 3. Switched on at two levels

- **The deployment.** An adapter is available only when the deployment has its partner credentials in env (for Tingee its client id and secret; names fixed in #2045).
  - With none configured, the bank-feed screens and commands are hidden and the file import works as today.
  - `docker compose up` needs no bank service. The `sandbox` adapter is available in development only.
- **The org.** An owner or admin connects the org's accounts and maps each one to a bank account and legal entity. They can disconnect at any time; the stored lines stay, like imported ones.

### 4. Read-only, and the ledger's rules unchanged

A feed stores bank lines; it never posts.
- A line becomes a voucher only through the existing proposal, which a person approves (R3, four-eyes, as today).
- Feed lines are external data, which the plan treats as untrusted (`source_trust` external), as it does statement files.
- No feed sends money, and no adapter holds a credential that could.

### 5. Where the Tingee adapter lives: an owner decision

The port, the `sandbox` adapter and the interface are in the core in either case.

| Option | For | Against |
|---|---|---|
| **A. In the core** (`@crove/bank-feed/tingee`, AGPL) | <ul><li>Self-hosters connect their own Tingee accounts.</li><li>One code path, tested in the core's CI against recorded sandbox answers.</li><li>The documentation and SDKs are public, which suggests HENO allows open integrations.</li></ul> | <ul><li>HENO's terms for open-source redistribution are not public: the SDK licence and whether production keys need an agreement.</li><li>A change in Tingee's API ships as a core release.</li></ul> |
| **B. In Crove Cloud** (`crove-cloud/connectors/`, private) | <ul><li>Fits the plan's layout for contracted connectors.</li><li>Any partner terms stay private.</li><li>Ludy Cloud can ship it without waiting for HENO's word on open source.</li></ul> | <ul><li>Self-hosters get the port but no working bank adapter.</li><li>Testing needs the private repo.</li><li>"Bank feeds in the open-source core" is only half true.</li></ul> |

**Recommendation: A, once HENO confirms in writing that an open-source adapter built from its public documentation is allowed.** Until then build B's way: the adapter is a separate package that the core does not import. Moving it between the repositories is then a file move, not a redesign.

## Decisions for the owner

1. Where the Tingee adapter lives, A or B (point 5). Who acts: the owner. A needs HENO's written confirmation first.
2. Whether Ludy Cloud holds one Tingee partner account for all its orgs, or each org brings its own credentials. This changes what is in env and what is sealed per org (point 3).

Without an answer, #2044 goes ahead (the port, the file source and the sandbox feed), and #2045 waits with `owner-action`.

## Consequences

- Monthly statement uploads become optional for banks a provider covers. The file import stays for every other bank and for history.
- New protected surface:
  - a migration (the feed account mapping and cursor);
  - a public webhook route;
  - credential opening in a new job.

  Each PR gets the security review, a redaction test and the job egress invariant.
- `CREDENTIAL_KEY` becomes required once a feed adapter other than `sandbox` is enabled, as for social channels.
- Webhook coverage depends on the bank and the provider (Tingee: some banks only, others through a virtual account). The daily pull is the floor.

## Alternatives considered

- **Only a DOS bank broker (DOS-19).** This keeps all bank integrations out of the core, and self-hosters would get no feed at all (ADR-0027). The port does not exclude a broker: a broker is one more adapter.
- **A webhook that stores the transaction it carries.** This is faster by one request, but it makes the webhook body a write path whose only defence is a shared secret. Pulling after a verified webhook keeps one write path.
- **Feeds in `@crove/channel`.** That package is about social and messaging publishing (publishers, media, metrics). Bank feeds share its connection and credential layer, which is in the kernel, not its capabilities. A sibling package keeps each interface small.
- **Payment initiation** (Tingee "Chi hộ", Pay by Bank). Out of scope: moving money needs its own risk model, approvals and legal review, and nothing in the wedge asks for it.
