# Crove Social: module plan

> Plan for the Social module (`social`, product name "Crove Social"), 2026-10-16. Owner decision of 2026-10-16: Social starts now, in parallel with the Accounting work, as an exception to plan Decision 2 (kernel plan, Decision 17). References: Postiz (and the owner's archived fork DOS/Crove-Post), OpenPost, BrightBean Studio, TryPost, Mixpost, and the platforms' official docs; findings and sources in [social-research.md](social-research.md). We study designs, never copy code (research §1). The kernel plan's Phase 5 section stays the summary; this file is the detailed plan. Vietnamese page for the owner: [social.vi.html](social.vi.html).

## 1. Goal and scope

Crove Social lets a founder or a small marketing team write a post once, adapt it per channel, get it approved, and have it published on time to every connected page, with AI drafting and rewriting under human approval.

**v1 (this plan):**
- Connect channels: Facebook Page and Instagram professional account first, then Zalo OA; a `sandbox` channel for local use and tests (order and reasons in §6).
- Compose: one post with a variant per channel, live per-channel validation (length, media count and type, links) and preview.
- Review: draft, submit, approve or reject. Publishing is R2: every post needs a human approval in v1; there is no auto-publish.
- Schedule: an exact time, or the next free slot of a posting queue (weekly slots in the org's IANA time zone).
- Publish: exactly once per channel, through a job with an `external_call` ledger and reconciliation.
- Calendar and list views; post detail with per-channel status and links.
- AI: draft from a brief, rewrite per channel, shorten or change tone. Output is tainted and always lands as a draft.
- Metrics: likes, comments, shares, reach and impressions pulled by jobs; a simple analytics screen.

**Later (v1.x, same plan):** media library on the kernel upload pipeline, evergreen reposting, multi-step approval, a public preview link with comments for client review, more channels (TikTok, YouTube, Threads, LinkedIn, X, Bluesky), posting-time suggestions from history, post-publish actions (auto-repost, a reply at a likes threshold), the `social.content_manager` agent template (ADR-0029), public API and MCP tools (the same drafts, review queue and limits as people), auto-publish for untainted posts as an org setting.

**Not in Social:** comments and messages. They belong to Service's inbox (kernel plan §5.7). Until Service exists, Social shows comment counts only.

## 2. Can it be built independently of the kernel work in flight?

Mostly yes. The module lives in new paths that no other stream edits; a small set of kernel pieces is missing, and nobody is building them, so this stream builds them.

| Social needs | In core today | Plan |
|---|---|---|
| `execute()`, RLS, audit, outbox, idempotency, migration runner | Yes | Reuse as is |
| Module registration and per-deployment enablement | Registration is hard-wired in `apps/kernel/src/kernel.ts`; enablement is PR #198 (open) | Register `social` after #198 merges; until then the module is built and tested on its own |
| oRPC contract and router | One contract (`packages/kernel-contract`) and router (`apps/kernel/src/rpc.ts`) | Add a `social` namespace, additively, in small PRs rebased right before merge |
| Worker jobs | Queues are listed in `apps/kernel/src/worker.ts` | Add `social-*` queues additively |
| Files for media | Kernel file storage exists; staged uploads are PR #220 (open) | Media library waits for #220; text and link posts do not |
| AI | `packages/agent` (OpenAI-compatible) | New `SocialWriter` in `packages/agent`, a new file |
| Proposals and the Inbox | The proposal commands are finance-specific (`PROPOSAL_COMMANDS`) | v1 uses Social's own review states; joining the kernel proposal registry waits for it to become module-pluggable |
| Third-party credentials | `CredentialBroker` port exists with no implementation (ADR-0030) | Build `crove-local`: envelope-encrypted tokens in `crove_kernel.credential` (plan §7.4) |
| Channel connections, OAuth connect, token refresh | Missing (ADR-0025, planned "before Phase 4") | Build now, in the kernel, shared later with Service ([ADR-0025](../adr/0025-channel-layer.md)) |
| `external_call` ledger | Missing (plan §4.9) | Build now; Finance connectors reuse it |
| Egress allowlist for provider adapters | Missing (plan §7.7) | v1: per-provider FQDN allowlist in the channel package; the full egress policy (ADR-0016) later |
| Agents, org chart | ADR-0029 direction only | Not needed for v1 |

**What this means:**
- Independent: `modules/social` (domain, schema, commands, queries, jobs), `packages/channel` (provider adapters), the Social screens in `apps/app`.
- Kernel work owned by this stream: credential store, channel layer, `external_call`. These are protected paths (migrations, kernel), so each PR gets an independent security review and runs the invariant suite from base.
- Shared hot files touched additively: `kernel.ts`, `rpc.ts`, `contract.ts`, `schemas.ts`, `worker.ts`, `router.tsx`, i18n messages. Conflicts are line-level; rebase right before merge (AGENTS.md).
- Waits on: #198 for registration, #220 for the media library. Neither blocks the first steps.

## 3. Architecture

### 3.1 Packages

| Path | Contents |
|---|---|
| `modules/social` (`@crove/mod-social`) | `src/domain/` pure TS: post and variant types, per-channel rules, the post state machine, queue slot math, idempotency keys. `src/` commands, queries, publish and metrics jobs. Depends on `@crove/kernel-runtime`, `@crove/db`, `@crove/channel` types |
| `packages/channel` (`@crove/channel`) | `ChannelProvider` interface, provider adapters (`sandbox`, `meta`, `linkedin`, later others), each with its FQDN allowlist. Only jobs and the OAuth routes call adapters; command handlers never do network I/O |
| `crove_kernel` (migrations) | `credential`, `channel_connection`, `oauth_state`, `external_call` |
| `apps/app` | `/social` screens |

### 3.2 Data model (`crove_social`)

Every table has `org_id`, `PRIMARY KEY (org_id, id)` and RLS via `apply_tenant_rls`; FKs are composite and only point into `crove_social` or `crove_kernel`.

Revised on 2026-10-16 after reading Postiz, OpenPost and BrightBean schemas first-hand ([research §5](social-research.md)).

| Table | Key columns |
|---|---|
| `post` | base content: `body`, `title`, `link_url`; `origin` (`human` or `ai`), `actor_origin` (`ui`, `api`, `mcp`, `agent`), `tainted`, `author_user_id`, `time_zone`, `scheduled_at` (default for its variants), `revision`; `status` is a summary derived from the variants |
| `post_variant` | `post_id`, `channel_connection_id` -> `crove_kernel.channel_connection` (one per post), `position`; nullable overrides `body`, `title`, `link_url` (null inherits the post); `settings` (typed per provider, zod); `content_hash` of the effective content; `status`; `scheduled_at` override; `queue_slot_at`; `attempt`; `external_post_id`, `external_url`, `published_at`; `error_kind`, `error_code`, `error_http_status`, `error_retry_at`, `error_action`; `next_check_at` |
| `post_approval` | append-only, one row per variant decision: `variant_id`, `revision`, `content_hash`, `decision` (`approved`, `changes_requested`, `rejected`), `comment`, `decided_by`, `actor_origin`, `snapshot` (what the reviewer saw). A publish needs a latest decision `approved` whose revision and hash match the variant as it is |
| `queue` | one per channel connection: `time_zone`, `paused` |
| `queue_slot` | `queue_id`, `weekday`, `minute`, `label`, `active`; unique per (queue, weekday, minute) |
| `metric_snapshot` | `post_variant_id`, `captured_at`, `capture_key` (unique per variant), `metrics` (jsonb, normalized names), `raw_names` (jsonb, the platform's own) |

**Variant states:** `draft` -> `in_review` -> `approved` -> `scheduled` -> `publishing` -> `published`; review can answer `changes_requested` (back to `draft` for an edit) or `rejected`; publishing can end in `processing` (the platform accepted it and is still processing, for example an Instagram container), `failed`, `ambiguous` (outcome unknown, being reconciled), `needs_attention` (a human decides) or `paused` (its channel's token expired or its quota is spent); `cancelled` from any state before `publishing`. An edit of a variant, or of base content it inherits, returns it to `draft`: an approval covers a revision and its content hash. A variant in `publishing` cannot be edited or cancelled (Postiz's edit restarts an in-flight publish, a duplicate risk).

**Post status** (derived): `draft` while any variant is not yet approved, `scheduled`, `publishing`, `published`, `partially_published`, `failed` or `cancelled`, from the variants' states.

**Queue rules** (from TryPost's written rules): a queued post keeps its slot while the slot exists, and the queue is never repacked; "add to queue" takes the first free slot; posts waiting for approval hold their slots; after a time-zone change a post keeps the same local clock time when it can; every queue change locks the queue row (`SELECT … FOR UPDATE`).

### 3.3 Commands and queries

| Command | Risk | Who |
|---|---|---|
| `social.post.create_draft`, `social.post.update_draft` | R1 | members; an agent creates drafts with `origin = ai` |
| `social.post.submit` (all or some variants) | R1 | members |
| `social.variant.decide` (`approved`, `changes_requested`, `rejected`; one variant, or all variants of a post in one command) | R2 | owner, admin (v1 roles); never an agent; an author may approve their own post unless the org turns on four-eyes |
| `social.post.schedule` (time or queue), `social.post.cancel` | R2 / R1 | owner, admin |
| `social.queue.upsert`, `social.queue.pause` | R1 | owner, admin |
| `social.variant.record_result` | system | publish and reconcile jobs only |
| `kernel.channel.connect`, `kernel.channel.disconnect` | R2 | owner, admin (needs `kernel.connection.bind`, plan §7.4) |

Queries: `social.post.list` (calendar range, status), `social.post.get`, `social.queue.list`, `social.metrics.summary`, `kernel.channel.list`.

### 3.4 Publishing exactly once

No platform except Bluesky has an idempotency key (research §4), and duplicate posts are the incident Postiz hit hardest (#1321, #832). The design follows OpenPost's write fence and Postiz's "run the visible call at most once":

1. Scheduling enqueues one `social-publish` job per variant, `startAfter = scheduled_at`, singleton key `<org>:<variant>:<revision>:<attempt>` (the attempt starts at 1; a human retry of a failed or `needs_attention` variant bumps it). A sweep every 15 minutes re-enqueues due variants that have no job (Postiz's missed-post sweep, without its Temporal dependency).
2. The job re-reads the variant in a kernel transaction: still `scheduled`, a latest decision `approved` matching the variant's revision and content hash, channel `active`, quota left. Otherwise it stops.
3. It writes `crove_kernel.external_call` with the deterministic key `social.publish:<variant>:<revision>:<attempt>:<step>` in state `started` (a partial unique index allows one in-flight call per key), commits, then makes the visible provider call.
4. The adapter returns a typed result: submission `accepted` (with the external id), `pending` (accepted, still processing, for example an Instagram container or a Zalo article token), `rejected` (with an error kind), or `unknown`. Each step of each adapter declares its retry safety: `safe` (nothing visible happened, for example creating an Instagram container), `idempotent` (the provider dedupes, Bluesky's record key), `reconcile_only` or `never`.
5. `accepted`: `social.variant.record_result` stores the id and URL, the call becomes `succeeded`. `pending`: the variant becomes `processing` and a status job polls (`next_check_at`) until `published` or `failed`; a step that already went through is never repeated (an Instagram container in state `PUBLISHED` means the publish went through).
6. A timeout, crash or `unknown` leaves the call `started`: the next attempt does **not** call again unless the step is `safe` or `idempotent`. It marks the call `ambiguous` and runs `social-publish-reconcile`, which asks the provider (recent posts of the account matched on the content hash and time window, or the provider's own id such as TikTok's `publish_id`). Found: recorded as published. Not found, or the provider cannot be asked (a member-only LinkedIn app cannot list its posts): `needs_attention`, and a human chooses to retry or drop. Never a blind retry.
7. `rejected` with a known error kind: `bad_request` and `permission` fail the variant with the reason; `rate_limited` reschedules at `error_retry_at`; `token_expired` pauses the channel (§3.5). The post becomes `partially_published` or `failed` once every variant has an outcome.
8. Every return of a variant to `scheduled` starts a new attempt with fresh keys: a rate-limit retry, a resume after the channel is reconnected, a human retry. The earlier attempt's calls keep their outcome as history. Without the new attempt, the job would meet its own `failed` call in the ledger and never call again.

Built in S4 (#234), with these choices against the list above:

- Jobs come from a sweep, not from scheduling: every 15 seconds the worker reads `crove_social.publish_due` (a definer only `crove_worker` may run; ids only) and queues one job per variant with work to do: due `scheduled` variants, `processing` ones whose check is due, `ambiguous` ones after a minute, `publishing` ones left by a worker that died (10 minutes without a change), and `paused` ones whose channel is active again and changed since the pause (the connection's version is stamped on the variant when it pauses, so no clock comparison decides it). Each kind has its own share of the limit, and only active orgs and providers the worker can publish to are read, so rows nobody works on never crowd out the rest; `begin` also waits a minute before reconciling an `ambiguous` variant and leaves a variant in a paused queue alone. Rescheduling, unscheduling and queue edits then need no job bookkeeping, and a post goes out within 15 seconds of its time. Queues are `social-publish-<provider>`, policy `stately` with the singleton key `<org>:<variant>`, so a variant has at most one job queued and one running.
- One job, two system commands: `social.publish.begin` (lock the post, then its variants; check the approval and the channel; write the call row; commit) and `social.publish.record` (store the answer for the key the job was given; an answer for an older key changes nothing). The token is opened between them and dropped after the call. An adapter that throws or times out counts as `unknown`, never as a failure, and a run that stalled after `begin` for half the stale time records `unknown` without calling (another run may have taken over). A post still processing a day after its call is reconciled.
- `crove_kernel.external_call` is append-only for tenant roles: they insert a call as `started` and update only its outcome columns; a guard trigger refuses any change once the call has its outcome, and nothing deletes one.
- A refusal before anything was posted (`rate_limited`, `transient`) is a new attempt at the provider's retry time, at most 5 automatic attempts; `token_expired` pauses the variant and marks the connection `expired` (`kernel.channel.mark_expired`); the paused variant resumes as a new attempt once an owner reconnects the channel. If the reconnect lands while the call with the old token is out, the refusal starts a new attempt at once instead of pausing. A connector who left pauses without a call until the channel is reconnected; a disconnected channel never comes back (connecting the account again makes a new connection), so its variants say so and wait for a person to cancel them.
- People settle what the job cannot: `social.variant.retry` (failed or `needs_attention`, a new attempt now) and `social.variant.resolve` (`needs_attention` only: on the platform after all, or dropped).
- The sandbox keeps its posts in the worker's memory and can be asked by call key, so a lost result reconciles while the worker lives; after a restart it is `needs_attention`, as on a platform that cannot be asked.
- Every adapter has one `publish` step for now; multi-step adapters (Instagram containers) add steps under the same key scheme in S6.

### 3.5 Channel layer (kernel, ADR-0025)

- `channel_connection` per connected page or account: `provider`, `external_account_id`, `display_name`, `scopes`, `status` (`active`, `expired`, `revoked`, `error`), `credential_id`, `connected_by`, `expires_at`. Unique per `(org_id, provider, external_account_id)`.
- OAuth (built in S6.1, #370): the RPC `channels.oauthStart` records a single-use `crove_kernel.oauth_state` row (org, user, provider, the SHA-256 of the state, the PKCE verifier where the provider supports it, 10 minute expiry) through a definer and returns the provider's authorize URL. The provider sends the browser back to one fixed SPA address, `/channels/oauth/:provider/callback`, which takes the code and state out of the address bar and calls `channels.oauthFinish`: the same signed-in owner or admin, in the org the attempt started in, consumes the state once, the connector exchanges the code, and each account the grant covers is sealed and connected with `kernel.channel.connect`. The attempt is bound to the member by the session, not by a cookie, so a state started by someone else is refused. Facebook lets the user pick Pages in Meta's own dialog, so every granted Page the user may post to (`CREATE_CONTENT`) is connected; an unwanted one is disconnected afterwards.
- Tokens: envelope-encrypted (AES-256-GCM data key, wrapped by the deployment key `CREDENTIAL_KEY`; Cloud wraps with KMS) in `crove_kernel.credential`. Only provider jobs and the OAuth callback decrypt. Tokens never reach the SPA, logs, audit rows or events.
- Refresh: a `kernel-channel-refresh` schedule (hourly scan of `expires_at`) refreshes tokens ahead of expiry, per provider rules: Facebook Page tokens have no timer; Instagram and Threads tokens last 60 days and refresh only after 24 h; TikTok access tokens last 24 h and Zalo OA 25 h, both with refresh tokens that can rotate (Zalo's are single use); LinkedIn non-partner apps get no refresh token, so the owner is reminded to reconnect before day 60. A rotated refresh token is stored in the same transaction that records the refresh; losing it loses the connection. An expired or revoked token sets the connection `expired`, pauses its scheduled variants (`paused`, nothing lost) and alerts the owner (Social channels screen, email through the mail port; the Inbox when it takes module items).
- On every use: the connecting user must still be a member (plan §7.4); if not, the job stops and the connection needs reconnecting.
- Self-host: each provider is enabled by its own app credentials in env (for example `CHANNEL_META_APP_ID`, `CHANNEL_META_APP_SECRET`); a provider without them is hidden. `sandbox` is on by default in `docker compose`, so the whole flow runs offline. Crove Cloud uses the same adapters with platform-approved apps owned by DOS (configuration in `crove-cloud`).

### 3.6 Provider adapters (`@crove/channel`)

- Small capability interfaces instead of one large one (OpenPost, Mixpost): `Connector` (authorize, exchange, refresh, accounts; `selectAccount` after OAuth when one login covers several pages), `Publisher` (publish steps with declared retry safety, `status` for two-phase platforms), `Reconciler` (find a post after an unknown outcome), `MediaUploader`, `MetricsReader`.
- Static capability data per provider: text limit (counted the way the platform counts: UTF-16 runes for TikTok, graphemes for Bluesky), media count, types and sizes, links per post, post types, whether a link preview is scraped. The same data drives the composer's validation and preview, and the domain rules of S1.
- Typed errors: `token_expired`, `permission`, `bad_request`, `rate_limited` (with retry time), `transient`, `unknown`. Raw platform messages are mapped to Vietnamese and English text; Postiz still remaps dozens of "Unknown Error" cases, so every adapter has tests for its known error payloads.
- Rate limits and quotas tracked per app and per account (Mixpost); quota checked before the visible call where the platform exposes it (Instagram `content_publishing_limit`, Threads `threads_publishing_limit`, YouTube's 100 uploads a day).
- Concurrency per provider in the worker (Postiz: Reddit 1, LinkedIn 8): pg-boss queues `social-publish-<provider>` with their own team size; only providers the deployment configured get workers (Postiz idles 32 workers, #1570).
- Media: several platforms fetch media from a public URL (Instagram, TikTok photos). A laptop deployment has none, so adapters prefer upload endpoints (Instagram resumable upload, TikTok file upload); the media library adds signed, time-limited URLs when storage is public.
- Platform native scheduling (Facebook, YouTube) is not used in v1: Crove's worker publishes at the time, so every channel follows one model and approval stays in Crove until the last moment.

### 3.7 AI

- `SocialWriter` in `packages/agent`: `draft(brief, channels, voice)`, `rewrite(variant, channel, instruction)`. Structured output (zod), checked against the domain's channel rules; a variant that breaks a rule comes back flagged, never silently cut.
- AI output and anything drafted from tainted input (an inbound email, a web page) is `tainted`. Tainted posts always need a human approval, even after auto-publish exists.
- No AI in command handlers; the drafting endpoint calls the writer, then runs `social.post.create_draft` with `origin = ai`.

## 4. Steps (one PR each, end to end)

| # | Step | Depends on | Touches protected paths |
|---|---|---|---|
| S0 | This plan, ADR-0025 (proposed), Decision 17 | - | No |
| S1 | `modules/social` domain: types, channel rules, state machine, queue slots, idempotency keys; unit and property tests | - | `package.json`, lockfile |
| S2 | Credential store (`crove-local` broker) + `channel_connection` + `packages/channel` with the `sandbox` provider; RLS matrix rows | ADR-0025 accepted | Yes (migrations, kernel) |
| S3 | `crove_social` schema, commands, queries; registered in the kernel (RLS factories first, #291). The oRPC contract and router follow in their own PR, ahead of S5 | #198, S1, S2 | Yes (migration) |
| S4 | Publish pipeline: `external_call`, publish and reconcile jobs, pause on expired tokens | S3 | Yes (migration) |
| S5 | UI: channels, composer with per-channel preview, calendar, queue, post detail; Playwright run on `sandbox` | S3, S4 | No |
| S6 | OAuth connect flow + Meta adapter (Facebook Page, Instagram), then Zalo OA | S2 | Yes (`http.ts`) |
| S7 | AI drafting and rewrites | S3 | No |
| S8 | Metrics jobs and analytics screen | S4, S6 | No |
| S9 | Media library (after #220), evergreen reposting, multi-step approval, more channels | S4, #220 | Some |

### Status (2026-10-17)

Done and merged: S1 (#243), S2 (#262, #263), S3 (#297, contract and RPC #338), S5 (#346), S4 (#353, #355). On the offline `sandbox` channel the whole flow runs end to end: connect, queue, compose, review, schedule, and the worker publishes exactly once (the e2e spec waits for it).

Next, S6 (#236), in this order:

1. #361 put the `crove_kernel.oauth_state` row factory on main (definer-only machinery, two-step new-table rule).
2. Done in #370: the `oauth_state` table, the `OAuthConnector` interface in `@crove/channel`, the RPCs `channels.oauthStart` and `channels.oauthFinish`, the SPA callback screen and the Facebook Page connector (long-lived user token, `/me/accounts` Page tokens), tested against recorded Graph answers. #371 adds the Facebook Page publisher: `POST /{page}/feed` with the Page token, Graph errors mapped to the pipeline's kinds (a 5xx, Meta's unknown error or a duplicate are `unknown`), reconcile by listing the Page's posts in the window and matching the message. #372 adds images on posts: uploads with `purpose=social` become `crove_kernel.file` rows with source `social` (stored and hash-pinned like documents, never extracted or listed in the Inbox), `crove_social.post_media` keeps the post's images in order, `post_variant.media` keeps a variant's own list (history keeps the list it had), and the images are part of every variant's content hash, approval snapshot and channel checks. The Facebook publisher uploads them as unpublished photos and attaches them to the feed post. #373 adds Instagram professional accounts through the same Meta app: the connector lists the business account linked to each Page the user may post on (calls use the Page token); the publisher creates a container per image (a carousel for several), waits for `FINISHED`, then calls `media_publish` once, reports `pending` while Meta is still processing and finishes on the status check, and treats a `PUBLISHED` container as already posted. Meta fetches images from a public URL, so Instagram needs storage with presigned URLs (S3); on local disk a post is refused with `MEDIA_URL_UNAVAILABLE` before anything is created. #374 adds Zalo OA: OAuth v4 with PKCE (the OA admin grants the app; one grant is one OA), articles created asynchronously (`article/create` gives a token, `article/verify` the article id, pending until then), the post's title and text as the article and its first image as the cover (fetched by Zalo from a presigned URL, so S3 again), and the `kernel-channel-refresh` sweep in the worker: every 10 minutes it renews tokens that expire within 6 hours, one sweep at a time across workers (advisory lock), sealing the rotated pair and the new expiry in one transaction (`kernel.channel.refresh`) and marking the connection expired when Zalo refuses the refresh token. Zalo's endpoints were checked against its docs and a community SDK, not against a live OA yet. The S6 channels are done; next are S7 (#237, AI drafting), S8 (#238, metrics) and S9 (#239).
3. Done in #373 (see above): Instagram (container, status polling through `processing`, `media_publish`; a `PUBLISHED` container means the publish went through).
4. Done in #374 (see above): Zalo OA (OAuth v4 with PKCE, access token 25 h, single-use refresh token stored in the transaction that uses it) with the refresh schedule, which also settles the expired-connection lifecycle in #264.

S7 (#237): AI drafting. `SocialWriter` in `packages/agent` takes a brief and the chosen channels with their limits, and returns a shared text plus each channel's own text or title where needed, as structured output; it is told to use only facts from the brief and to treat the brief as data. The RPC `social.posts.draftWithAi` (members and above, checked before the model is called) saves it as a new post with `origin = ai` and `tainted`; the writer cuts only what a post cannot hold (100,000 characters of text, 500 of title); the channel rules check every variant as for any post and show what is too long for its channel, and every variant needs a person's approval. The compose screen has a *Draft with AI* box; an AI post carries a badge.

S8 (#238): metrics. `crove_social.metric_snapshot` keeps what a platform reported for a published variant, one append-only row per 6-hour capture, with normalized counts (impressions, reach, reactions, comments, shares, saves, clicks, views; absent when the platform does not report one) and the rest in `extra`. The worker sweeps every 15 minutes through `crove_social.metrics_due` (worker only) for variants published in the last 30 days whose last capture is older than 6 hours, and calls `Publisher.metrics`: the sandbox (counts that grow with age, for the demo) and Facebook Pages (reactions, comments, shares, which Meta's Page Insights changes do not touch). A post gone from the platform gets an empty snapshot marked gone. The Social home has a *Metrics* tab: totals over 7, 30 or 90 days and each published channel with its latest capture. Instagram and Zalo OA metrics come with their adapters once those are merged.

S9, Bluesky (#390): accounts connect with their handle and an app password (refused if it is not one), checked once by opening a session and sealed with the account's DID; each publish opens a fresh session, so no rotating refresh token is kept. Posts carry link facets (UTF-8 byte offsets) and up to four images uploaded as blobs first; reconcile lists the account's posts in the call's window. Only Bluesky-hosted accounts (PDS under `bsky.network`) are accepted, since the PDS address comes from the account's DID document. On by default (`CHANNEL_BLUESKY`).

S9, Threads (#391): the Threads use case of a Meta app has its own id (`CHANNEL_THREADS_APP_ID`, `CHANNEL_THREADS_APP_SECRET`). Connect through threads.net's dialog to a 60-day token, renewed a week ahead by the refresh sweep (each refresher now says how far ahead it renews). Publish like Instagram: a text, image or carousel container, a wait for `FINISHED`, `threads_publish` once, pending recognised later by the text's hash; text posts need no public image URL.

What only people can do: trying S6 against the real platforms needs a Meta developer app (development mode works for people with a role on the app) and the Crove callback URL added to a Zalo app linked to an OA. DOS already has a Zalo OA app (used by DOS.Me); Meta has none yet. Open follow-ups: #250, #264, #335, #352.

## 5. Exit criteria (v1)

1. On a fresh laptop with `docker compose up`: connect the `sandbox` channel, compose a post for two channels, approve, schedule, and both variants publish once; Playwright covers it.
2. Each post publishes exactly once per channel: killing the worker between the provider call and the result record produces no second post (reconciled, or `needs_attention`).
3. An expired channel token pauses that channel's queue and alerts; no post is lost; reconnecting resumes it.
4. AI-drafted or tainted posts never publish without a human approval of that revision.
5. Generated cross-org RLS tests cover every new table; tokens never appear in logs, audit rows, events or API output.
6. With `CROVE_MODULES` excluding `social`, the kernel and Finance run unchanged.

## 6. Channels: order and known constraints

Checked against the platforms' docs on 2026-10-16; details, limits and links in [social-research.md](social-research.md) §4.

| Order | Channel | Why here | Main constraint |
|---|---|---|---|
| 1 | Facebook Page | Largest reach for Vietnamese SMEs; a self-hoster's own app works in development mode for Pages they manage | Other users need App Review + Business Verification (Crove Cloud, owner action) |
| 2 | Instagram | Same Meta app and review | Container flow; JPEG only; 100 API posts per 24 h |
| 3 | Zalo OA | Vietnam-specific; none of the reference projects supports it | Refresh tokens are single use; OA tier requirements and article metrics unconfirmed |
| 4 | TikTok | Large in Vietnam | Unaudited apps post private only; audit requires TikTok's mandatory UX |
| 5 | YouTube | Video; native scheduling | 100 uploads a day per project; Google OAuth verification |
| 6 | Threads | Same Meta app | 500 characters, 5 links |
| 7 | LinkedIn | Founders and B2B | Organization pages need Community Management API approval; no refresh tokens for non-partners |
| 8 | X | Low use in Vietnam | Paid per post ($0.015, $0.20 with a URL) |
| - | Bluesky | No review, an idempotency key: a cheap second real adapter to test the pipeline against | Small Vietnamese audience |

Open questions, settled by testing when the adapter is built: Instagram's daily limit (the docs say 100 and, for carousels, 50); whether YouTube still forces uploads from unverified projects to private; Zalo OA eligibility and quotas.

## 7. Risks

| Risk | Mitigation |
|---|---|
| Focus moves away from the Accounting wedge | Owner decision; Social runs as its own stream and does not take kernel work Finance waits on |
| Conflicts in shared hot files | Small additive PRs, rebase right before merge |
| Platform rules change or block access | Adapters behind one interface; `sandbox` keeps the product testable; constraints rechecked per adapter |
| Duplicate posts | `external_call` + reconciliation, never a blind retry (§3.4) |
| Token leaks | Envelope encryption, decrypt only in jobs and the callback, redaction tests |
| Code provenance | Crove's CLA lets the owner relicense, and third-party code cannot be relicensed: Postiz (including the DOS/Crove-Post fork), OpenPost and the others are studied for design only, and adapters are written from the platforms' docs (research §1). ADR-0020 still governs any reuse of the forks' code |
| Heavy self-host (Postiz needs Temporal, Redis, Elasticsearch) | Postgres and pg-boss only, already in the stack; workers only for configured providers; the prober's worker heartbeat catches a stalled worker |
| Platform metrics renamed or removed (Meta Page Insights, 2026) | Snapshot common fields plus `extra`; metrics map per adapter with tests |
