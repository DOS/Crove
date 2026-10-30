# 0018. Untrusted content: how Crove reads what strangers wrote

- Status: Accepted. It records the design the plan already decided (§7.6 untrusted input, §7.7 egress and SSRF, §4.7 policy and taint) and what is built on `main` as of 2026-10-30. It decides nothing new.
- Date: 2026-10-30
- Deciders: owner (JOY), through the plan; written down by the Claude Code session for issue #2047
- Builds on: plan §7.6, §7.7 and §4.7; ADR-0013 (evidence storage and uploads); ADR-0025 (channel layer); ADR-0029 (agents); ADR-0036 (assisted tax portal sync); External-tenant gate rows T5 and T12
- Issue: [#2047](https://github.com/DOS/Ludy/issues/2047)

## Context and problem statement

Crove reads things that strangers wrote: PDFs, e-invoice XML and photos that a member uploads or a supplier mails in, ZIP archives, forwarded emails, bounce reports, web pages and feeds behind a link, and the exports of the tax portal. It sends some of that text and imagery to an AI model. Every one of these is attacker-controlled input, and three things can go wrong:

1. A parser bug runs the attacker's code, or a decompression bomb or a slow file exhausts memory or time.
2. An instruction hidden in a document steers the AI model, or an agent, into an action nobody approved.
3. A URL a tenant supplies makes the server call something inside the deployment (SSRF).

The plan decided the controls in §7.6, §7.7 and §4.7. The external security review (#31) needs one record of what is built, where each control is enforced and which test holds it. This is that record.

## Decision drivers

- The code that opens untrusted files is the most exposed code in the system. It holds no secrets, has no route to the network and cannot reach the database.
- Whatever the sandbox or the model answers is data, never a command: it is validated by strict schemas, marked tainted, and a human approves the result.
- No code path reaches the network except through a list that is declared and tested.
- A new parser or a new URL fetch goes into a place that already has these controls, and does not get its own.

## Decision

### 1. Parsing runs only in `crove-extract`

[`apps/extract`](../../apps/extract) is the image `crove-extract`. It has one endpoint, `POST /extract?kind=`, that takes bytes and answers JSON. The kinds are `einvoice_xml`, `pdf_text`, `mime`, `zip`, `portal_invoice_list`, `dsn`, `html_meta` and `feed` (`EXTRACT_KINDS` in [`packages/extract-contract`](../../packages/extract-contract/src/index.ts)).

**The dependency rule.** No parser lives anywhere else.
- [`tools/test/parser-imports.test.ts`](../../tools/test/parser-imports.test.ts) fails when the API, the worker, a module or a package imports or depends on an XML, PDF or MIME parser, and it walks the kernel image's production dependency tree.
- The kernel image is installed with `--prod --filter-prod`, and its build removes the one XML reader that a workbook library pulls in (`saxes`, #1719; [`Dockerfile`](../../Dockerfile)). The CI job "Kernel image (boots, no parser packages)" runs [`image-check.mjs`](../../apps/kernel/test/container/image-check.mjs) against the built image.
- The worker needs `EXTRACT_URL` to boot, and `extractAndPropose` without the client throws, so nothing falls back to parsing in the worker ([`modules/finance/src/extract.ts`](../../modules/finance/src/extract.ts)).

**Limits.** Each kind has a body cap (`maxRequestBytes`): 40 MiB for a raw email or a bounce report, 25 MiB for an e-invoice XML, a PDF and a ZIP archive, 10 MiB for a tax-portal list, 1 MiB for a feed and 512 KiB for a web page. An answer over 64 MiB is refused. A ZIP archive may hold 500 entries and 40 MiB once opened.

**Slots and time** (`EXTRACT_TIMING`). One parse runs at a time and one request may wait; the next gets 503 `busy`, which the worker retries. A request's body is read only once its slot is free, and a body that sends nothing for 2 s, or is not complete after 3 s, ends with a failure of the call and frees the slot, so a slow sender cannot hold the single parser. A parse is killed after 25 s. The client's whole call, waiting included, is allowed 60 s. A timeout or memory answer is retried once at most (`EXTRACT_LIMIT_RETRIES`), so a hostile file cannot take the slot again and again. The codes `too_large`, `timeout`, `memory` and `invalid` mean the input is at fault; `bad_request`, `busy` and `internal` mean the call or the service is.

**One process per parse** ([`sandbox.ts`](../../apps/extract/src/sandbox.ts)). Each parse runs in a fresh `node` child under the Node permission model, with read access only to the parser code and the packages it loads: no network, no file writes, no child processes and no worker threads. The child also runs with no native addons, no code generation from strings, no debugger signal, a V8 heap of 512 MB and an empty environment. On Linux a watchdog reads the child's resident memory every 100 ms and kills it above 768 MB, because the heap limit does not cover Buffers or WebAssembly memory, where a decompression bomb lives. The child is also killed at the time limit and when the caller goes away, and its output is capped.

**The container** ([`docker-compose.yml`](../../docker-compose.yml)). The service has a read-only root filesystem, every capability dropped, `no-new-privileges`, 1 GiB of memory and swap, 1 CPU and 128 processes. Its only network, `extract`, is `internal: true`: containers on it reach each other and nothing else. No port is published, and only the API and worker container join that network. The service runs as the unprivileged `node` user, and its code is owned by root, so it cannot change itself ([`Dockerfile`](../../apps/extract/Dockerfile)).

**No credentials, by refusal.** The service refuses to start with any environment variable outside an allowlist (its own settings, `NODE_ENV`, and what the node image and the container runtime set), naming the variables and never their values. A marker file written into the image (`/etc/crove-extract-image`) makes the allowlist unconditional there, so overriding `NODE_ENV` cannot turn it off. Outside the image, an explicit development run only warns about credential-like names.

**Answers are untrusted too.** The contract is a set of strict zod objects: unknown keys and oversized strings and arrays are refused. The client refuses redirects, malformed answers and answers over 64 MiB (`createExtractClient`), and the finance module validates the reading again and runs the deterministic invoice checks before anything becomes a proposal.

### 2. Uploads and storage

A browser uploads to a random staging key through a single-use presigned POST. The server streams the object through SHA-256 with a size cap, writes it create-only under `org/<org_id>/<sha256>`, and every later read checks the hash and the recorded version. [ADR-0013](0013-evidence-storage-and-integrity.md) records this; the parsing above starts after it.

### 3. Inbound email

A mail relay posts each message as raw MIME to `POST /api/inbound/email`. The repository holds a reference relay for Cloudflare Email Workers ([`tools/inbound-mail/worker.js`](../../tools/inbound-mail/worker.js)); the endpoint is the contract.

**The API stores and queues, nothing else** (`acceptInboundEmail` in [`apps/kernel/src/inbound.ts`](../../apps/kernel/src/inbound.ts); T5).
- It checks the `Authorization: Bearer` secret against `INBOUND_SECRET` and, during a rotation, `INBOUND_SECRET_PREVIOUS`. Each candidate is compared as a SHA-256 digest with `timingSafeEqual`, and every candidate is compared whatever the earlier ones gave.
- It refuses an empty message (400) and one over 40 MiB (413), and a recipient on its own domain that cannot be an address (404). A well-formed address that is unknown or retired still gets 202, so a sender learns nothing about which tokens exist.
- It writes the raw bytes to a blob `inbound/<random id>` and enqueues them through the definer `crove_kernel.inbound_enqueue`, which only `crove_app` may execute ([`system_context_worker`](../../supabase/migrations/20261014130000_crove_kernel_system_context_worker.sql); pinned in the EXECUTE matrix of [`kernel-invariants.db.test.ts`](../../apps/kernel/test/invariant/kernel-invariants.db.test.ts)). It opens no tenant context and parses nothing.

**The worker does the rest.** It resolves the org from the recipient token when it processes the message, not when the API accepted it (`org_by_inbound_token`, executable by the worker login alone). It asks `crove-extract` to read the MIME (`kind=mime`) and runs the system command `kernel.inbound.receive` (R2), which files the message and each attachment through `kernel.file.ingest`. The blob is deleted after the message is filed or dropped.

**Addresses.** An org's address is an opaque 24-hex token in `inbound_address`. Rotation is the owner's command `kernel.inbound.rotate` (R3, so it needs fresh MFA). The old token is tombstoned for good and never reissued, mail to it is dropped exactly like mail to a token that never existed, and rotation is limited to 3 a day and 50 in total per org ([`inbound_rotation`](../../supabase/migrations/20261015150000_crove_kernel_inbound_rotation.sql), [`inbound_rotate_rate_limit`](../../supabase/migrations/20261015223000_crove_kernel_inbound_rotate_rate_limit.sql)). A message dropped for a token an org retired in the last 30 days is counted for that org ([`inbound_drop_count`](../../supabase/migrations/20261016200000_crove_kernel_inbound_drop_count.sql)).

**A resend creates no duplicate.** While a message waits, the same raw hash for the same recipient is not queued twice (`inbound_pending`). Once processed, a message is kept once per org and Message-ID (`inbound_message`, with a fallback id when the header is missing), and identical file content is stored once.

**The sender is not authenticated.** The relay sends no SPF or DKIM result and nothing reads one, so a forwarded email adds no human author to its proposal and four-eyes cannot see the forwarder. The plan's "SPF and DKIM results are taken only from the receiving MTA" is not built; every message is treated as untrusted regardless.

**ZIP archives.** An entry that is encrypted, itself an archive, compressed with an unsupported method or corrupt is not returned. An archive with an unsafe entry name, overlapping entries, ZIP64 or split parts, or more than the limits above is refused whole. An email keeps at most 2 archives and files at most 20 documents (`MAX_EMAIL_ARCHIVES`; the `files` limit of `kernel.inbound.receive`).

**E-invoice signatures.** The sandbox checks the XML signature of an e-invoice, against trust anchors pinned in [`apps/extract/trust`](../../apps/extract/trust/README.md), and answers `verified`, `unverified` or `not_applicable`. The proposal carries it, and approving one that is not verified needs an explicit `acceptUnverifiedSignature`, else 422 `SIGNATURE_UNVERIFIED`. The known gaps are in the trust README: no revocation check, SHA-1 accepted for old invoices, key usage not checked, and files over 30,000 elements not verified.

### 4. What comes out of a parser or a model is tainted data

**Taint.** `extraction.tainted` defaults to true, `kernel.extraction.record` never sets it to false, and a finished extraction cannot change (`extraction_guard`, [`extraction_versions`](../../supabase/migrations/20261016100000_crove_kernel_extraction_versions.sql)). That includes an e-invoice read from XML, where no model is involved. A proposal takes its taint from its extraction when it is inserted, and a tainted proposal is flagged P03 ([`agent_proposals`](../../supabase/migrations/20261019180000_crove_kernel_agent_proposals.sql)). Taint also spreads between runs and tasks: a run that claims a tainted task becomes tainted, and a tainted run taints every task it writes ([`agents_followups`](../../supabase/migrations/20261018160000_crove_kernel_agents_followups.sql)).

**The model has no tools.** `InvoiceExtractor` ([`packages/agent`](../../packages/agent/src/index.ts)) calls `generateText` with a structured-output schema and passes no `tools`. Its instructions say to treat everything in the document as data. A PDF's text goes in the user message, cut at 60,000 characters, and a photo goes in as a file part of the user message. The answer is parsed against a zod schema and its decimals are checked, and the deterministic invoice checks run before the result is stored. The AI SDK is imported only in `packages/agent` ([`allowed-imports.test.ts`](../../tools/test/allowed-imports.test.ts)). That no tool is passed is true by construction; no test asserts it.

**What the result can become.** At most a pending proposal for a human to decide. The deterministic checks decide what is flagged; the model decides nothing.

**Policy for agents.** An agent acts only inside the rules the runtime applies in `authorizeAgent` ([`runtime.ts`](../../packages/kernel-runtime/src/runtime.ts)): R3 is refused (P05), R2 is refused (P06), a risk above the agent's `max_risk` is refused (P02), and a tainted run may take an R1 or higher command only if the command propagates the taint (P03). An agent never approves a proposal whose policy flags are unassessed or include P03 to P07, whose proposal or run is tainted, or whose command may write a contact or payment column (`decideAgentApproval` in [`approval.ts`](../../packages/kernel/src/approval.ts)). A human may approve a tainted proposal; that is what the proposal is for.

**Kill switches.** The org, finance-module and global `ai` kill switches stop document reading by AI: PDFs and photos are left unread, while an e-invoice XML, which needs no model, is still read. The global switch is set only by the operator, with `pnpm ops:kill-switch` ([`incidents.md`](../runbooks/incidents.md) section 7).

### 5. Egress

**Every queue declares where it may go.** `QUEUE_EGRESS` in [`jobs-schema.ts`](../../apps/kernel/src/jobs-schema.ts) gives each pg-boss queue one of:
- `none`: only services of the stack itself;
- `provider:<x>`: a service outside the deployment, through its adapter. The extraction queue declares `provider:ai`, because that is where a document's content leaves the deployment;
- `tenant_url`: a URL a tenant or a browser supplied, through the guard below.

A queue without a declaration fails typecheck. [`job-egress.test.ts`](../../apps/kernel/test/invariant/job-egress.test.ts), with its analyzer [`job-egress.ts`](../../apps/kernel/test/invariant/job-egress.ts), follows each handler through the kernel's files and fails on:
- a queue without a declaration;
- a handler that reaches the guard, the AI endpoint, a provider adapter or a bare `fetch()` beyond its declaration, or a declaration its handler no longer needs;
- network use in the modules or in `packages/kernel`;
- the guard handed to an adapter whose host a tenant does not name;
- a command whose events feed a queue with egress but is not declared an external effect of at least R2.

**The guard for tenant-supplied URLs** ([`egress.ts`](../../packages/kernel-runtime/src/egress.ts): `guardedFetch`, `guardedRequest`, `egressFetch`).
- Only http and https, on the default ports, with no credentials in the URL.
- The host is resolved first and every address it resolves to must be public. Loopback, private, link-local (which holds the cloud metadata address), carrier-grade NAT, multicast, documentation, IPv4-mapped and IPv6 translation ranges are refused.
- The connection is pinned to the address that was checked, so a second DNS answer cannot move it.
- Redirects are followed by hand, at most three, and each hop is checked the same way. `guardedRequest` follows none, so a POST that carries a token cannot move to another host.
- One deadline covers the whole fetch, the body is cut at a byte limit, and no cookies, credentials or compression are sent.

It is a denylist of addresses. It holds no list of allowed origins.

**Where it is used.** Link previews, blog feeds, media and stock-photo URLs, browser push endpoints, the tenant-hosted channel adapters (Bluesky, Mastodon, WordPress) and the assisted tax-portal sync (ADR-0036). Adapters of providers with a fixed host use a list of allowed hosts instead (`allowlistedFetch` in [`packages/channel`](../../packages/channel/src/oauth.ts)).

**Not behind the guard, on purpose.** The AI endpoint and the operator's alert webhook are set by whoever runs the deployment, not by a tenant.

### 6. HTML from email

The sandbox reduces an HTML mail body to text and caps it (`mailText` in [`parse.ts`](../../apps/extract/src/parse.ts)), so mail HTML never reaches the app origin. The plan's sandboxed `usercontent` iframe for rendering HTML is not built, because nothing renders it.

## What is not covered

- **The Crove Cloud deployment of the sandbox** (its own service account, internal ingress, no egress by VPC and firewall) belongs to the private layer (A15) and is not in this repository. What this repository holds is the Compose isolation above, and the README note that a Kubernetes pod needs `enableServiceLinks: false`.
- **The Node permission model is not a boundary** against code that has already escaped JavaScript, and the child runs as the same user as the server. That is why the server holds no credentials, its answers are validated as untrusted, and the container adds the outer limits.
- **There is no OCR.** A scanned PDF is unsupported. A photo goes to the AI as bytes, and the kernel only sniffs its magic bytes. That is the widest untrusted path into the model, and it is held by taint and human approval, not by parsing.
- **The signature check** has the gaps listed in the trust README, and applies to XML purchase invoices only.
- **The sender of an email is not authenticated** (section 3).
- **Feed refreshes** run on a timer outside a queue, so the queue egress test does not cover them; they use the guard.
- **Stale text in the plan.** Plan §7.6 says per-org limits are checked "before any S3 or DB write" (the API stores the blob first and the worker applies the org's limits), that an e-invoice is "verified" only against an official source (what is built is the signature check above), and that SPF and DKIM are read.

## Evidence

The invariant suite runs these from the base branch on every protected-path PR:
- [`job-egress.test.ts`](../../apps/kernel/test/invariant/job-egress.test.ts): the queue egress declarations (section 5).
- [`extraction-redteam.db.test.ts`](../../apps/kernel/test/invariant/extraction-redteam.db.test.ts): the prompt-injection red team (#893). Its fixtures hold 34 synthetic documents, 25 PDFs and 9 photos, each hiding an instruction, and a fake model that obeys it. The test asserts at least 30 cases, that the instruction reaches the model as user data and not as a system message, that the result is only a pending, tainted proposal whose checks flag what the instruction changed, that nothing is booked, and that nothing of another org leaks.
- [`agents.db.test.ts`](../../apps/kernel/test/invariant/agents.db.test.ts) and [`proposal-approve-gate.db.test.ts`](../../apps/kernel/test/invariant/proposal-approve-gate.db.test.ts): the agent rules of section 4.
- [`inbound-rotation.db.test.ts`](../../apps/kernel/test/invariant/inbound-rotation.db.test.ts), [`inbound-rotate-limit.db.test.ts`](../../apps/kernel/test/invariant/inbound-rotate-limit.db.test.ts), [`inbound-drop.db.test.ts`](../../apps/kernel/test/invariant/inbound-drop.db.test.ts) and the EXECUTE matrix of [`kernel-invariants.db.test.ts`](../../apps/kernel/test/invariant/kernel-invariants.db.test.ts): the inbound address and the definers around it (section 3).

Other tests and jobs:
- [`apps/extract/test/extract.test.ts`](../../apps/extract/test/extract.test.ts): the size limits, the slots, the parser process that cannot open a connection, write a file, start a process, read outside its code or start a worker thread, the memory and time limits, and the environment allowlist. [`http.test.ts`](../../apps/extract/test/http.test.ts), [`zip.test.ts`](../../apps/extract/test/zip.test.ts), [`einvoice-signature.test.ts`](../../apps/extract/test/einvoice-signature.test.ts) and [`einvoice-trust.test.ts`](../../apps/extract/test/einvoice-trust.test.ts) cover the rest of the service.
- The CI job "crove-extract image (parse in the container, no egress)" runs [`smoke.mjs`](../../apps/extract/test/container/smoke.mjs) and [`egress.mjs`](../../apps/extract/test/container/egress.mjs) against the built image.
- [`packages/extract-contract/test/client.test.ts`](../../packages/extract-contract/test/client.test.ts): the client's refusals (section 1).
- [`tools/test/parser-imports.test.ts`](../../tools/test/parser-imports.test.ts) and the CI job "Kernel image (boots, no parser packages)": the dependency rule.
- [`apps/kernel/test/extract.test.ts`](../../apps/kernel/test/extract.test.ts) and [`kernel.db.test.ts`](../../apps/kernel/test/kernel.db.test.ts): an inbound email read through the sandbox, with one retry, and a forwarded e-invoice that becomes a proposal.
- [`extract-kill-switch.db.test.ts`](../../apps/kernel/test/extract-kill-switch.db.test.ts): the kill switches stop AI reading and leave XML alone.
- The CI job "Split api and worker on S3 (end to end)": the API and the worker as separate containers, reading an uploaded file and a posted email through the sandbox.

## Consequences

- Good: a hostile file can at worst burn one parser slot for 25 s. It cannot reach a secret, the database or the network.
- Good: what the model says cannot approve or book anything. A person decides, on a proposal whose checks are deterministic.
- Good: the list of places that reach the network is declared and tested, so a new one shows up in a diff.
- Cost: every parse starts a process, and one parse runs at a time per service. Raising throughput means more service instances, not more slots.
- A new kind of untrusted input goes into `apps/extract` and `packages/extract-contract` with its own cap and strict schema. A new queue declares its egress. A new URL a tenant supplies goes through the guard. A new AI call goes through `packages/agent`, and its output is tainted.

## Revisit when

- The Crove Cloud deployment of the sandbox is documented (A15, private layer).
- Inbound email authenticates its sender (SPF and DKIM mapped to a member).
- Scanned documents are supported (OCR), or a model is given tools. The second needs a new ADR first.
