# Crove OS Kernel: Architecture & Plan

> Final plan, 2026-10-12. Merges blueprint v1 (DOS.Me @ `15ad1d5`) with 3 red-team rounds: security; feasibility and agent developer experience; operations and cost.
> Every blocker and major finding was accepted, or rejected with a reason, in the Appendix. Paths are relative to the `Crove` repo root (separate repo; working name, settled 2026-10-13).
> Library versions checked against the npm registry on 2026-10-13. Version policy: always the latest stable.
> Update 2026-10-13: separate repo, own DB, federated identity (OIDC), provider-agnostic AI, AGPL-3.0 + CLA, always latest stable.
> Update 2026-10-14: consolidated. The body now describes the decided design (Decisions 1-15): Supabase Auth identity (ADR-0027; sessions and revocation per ADR-0028), one image serving the SPA, the built-in migration runner, the MVP in place of Phase 0, and the External-tenant gate. Where `main` differs from the decided design, the text says so.
> Update 2026-10-14 (later): ADR-0028 accepted with the hybrid revocation design C (Decision 16); §7.5, the External-tenant gate (T1) and §11 (DOS-28) describe it.
> Update 2026-10-15: ADR-0028 amended by the owner: Crove Cloud uses Supabase Auth's default session behavior (`AUTH_SESSION_CHECK=jwt`), keeps Crove's own revocation, per-request membership and a live Auth check for R3; DOS-28 becomes an optional later refinement (§7.5, T1, §11).
> Update 2026-10-19: the owner added an Email module for transactional email and email marketing (Decision 18); plan: [email.md](email.md), architecture: ADR-0034 (accepted 2026-10-24).
> Update 2026-10-21: the owner added an AI Meeting Notes module to the roadmap (Decision 19, §13 "Meeting Notes", epic #932); not started.
> Update 2026-10-23: Tracking, the gate rows (T and G), the phase statuses and the "on `main`" notes checked against `main` @ `d995e1c` (#1204); status text only, no decision changed.
> Vietnamese decision page (concise, not a full translation): [crove-os-kernel.vi.html](crove-os-kernel.vi.html). This English file is the full source of record.

## Tracking

| | |
|---|---|
| Backlog | Since 2026-10-17 the backlog and its order follow the [backlog review](backlog-review-2026-10-17.md): milestones M0 (decisions and discovery), M1 (pilot deploy), M2 (monthly close loop for an accounting firm), M3 (paid pilot), then the GA gate (the External-tenant gate below, renamed; required before public self-serve sign-up). A design partner under a signed pilot agreement needs the shorter pilot readiness checklist instead. Where this plan and the review disagree about what to build next, the review wins. |
| Current stage | **MVP step 1 done** (open source, local): merged on 2026-10-13 as #8, and every exit criterion is met since #877 (2026-10-21, #680) added the automated write-path check (`apps/kernel/test/invariant/write-path.test.ts`, `write-path.db.test.ts`) next to the generated cross-org RLS matrix (#114, T8) and the Playwright run on `docker compose up` (#18, T9). The backlog review put M1, a pilot deploy on one server, before MVP step 2: the spend and DNS approvals (#52, #53), the private pilot repo (#55), the deploy pipeline on release tags (#56) and the pilot instance (#306) are done; open in M1 are the pilot readiness checklist with the owner's sign-off (#308) and alerts to the owner's phone with an outside uptime check (#309). Crove Cloud on `app.crove.com` still waits on the DOS-side redirect URL change (#54). Work in progress (2026-10-23): Finance in M2 and M3, the GA gate, and Social (Decision 17). |
| Repo state | `main` @ `d995e1c` (2026-10-23). Contents: kernel (`apps/kernel`; `packages/agent`, `channel`, `db`, `extract-contract`, `kernel`, `kernel-contract`, `kernel-runtime`, `l10n-vn`, `mail`, `ui`), the `finance` and `social` modules, the `crove-extract` sandbox (`apps/extract`), the Vite + TanStack Router SPA (`apps/app`), `docker compose` with bundled Supabase Auth, and the Next.js landing page (`apps/web`). Required checks on `main`: `Lint, typecheck, test`, `Playwright on docker compose`, `Invariant suite (from base)`, `Secret scan` and `Docs check`. Other CI jobs: migrations and the hardening guard on the Supabase Postgres image, the kernel and `crove-extract` images, the split api and worker stack on S3, the backup and restore drill, the AI extraction eval, the migration order re-check, nightly Bun and `typescript@next` canaries, and the pilot deploy on release tags (`deploy.yml`). |
| Body status | Consolidated on 2026-10-14: the body describes the decided design, and "on `main`" notes mark what is not implemented yet (checked against `main` on 2026-10-23, #1204). The External-tenant gate below lists what must be true before Crove Cloud accepts an external tenant. ADR-0026, ADR-0027 and ADR-0028 (identity sessions and revocation, design C) are accepted; ADR-0028 was accepted on 2026-10-14 with conditions: its acceptance tests are the evidence for gate T1. |
| Redaction | `DOS/Ludy` is public. Security-sensitive details of DOS-side fixes (§11) live only in the private DOS.Me repo; those rows keep only IDs, priorities and gates. Integration contracts Crove builds against (DOS-27 events and API, DOS-7, DOS-17) stay here. |

| Phase | Time-box | Status |
|---|---|---|
| MVP step 1 (open source, local), see MVP below | 1 week | Done: merged 2026-10-13 (#8); every exit criterion met (criterion 2: RLS matrix #114 and write-path check #877; criterion 4: #18) |
| MVP step 2 (Crove Cloud) | - | Not started; the backlog review put M1, a pilot deploy on one server, before it: pipeline and pilot instance done (#56, #306); open: pilot readiness sign-off (#308, owner) and phone alerts (#309). `app.crove.com` waits on the DOS-side redirect URL change (#54) |
| 0b Finance spike | 2 weeks, parallel | Done except the accountant's check: ledger domain with fast-check and draft TT133 B01/B02 (#170), posting prototype in ADR-0021 (#58); B01/B02 matched against an accountant's hand calculation is open (#154, M2) |
| 1 Kernel v0 hardening (residual work after the MVP) | 8 weeks | In progress: exit criteria 1, 3, 4, 5 and 7 met; 2, 6, 8, 9, 10 and 11 open (§13 Phase 1 status) |
| 2a Finance A1 (scope set by interviews) | 10 weeks | In progress through M2 and M3 (backlog review): ledger reports, vouchers, VAT, opening balances, bank statements, period lock, year-end closing and the archive package merged; open items in §13 Phase 2a status |
| 2b Finance A2 | 8 weeks | Not started |
| 3 CRM + Calendar | 12 weeks | Waits for wedge-customer demand (Decision 2) |
| 4 Service | 10 weeks | Waits for wedge-customer demand (Decision 2) |
| 5 Social | 6 weeks | Started 2026-10-16 by owner decision, in parallel (Decision 17); plan: [social.md](social.md) |
| 6 Sign | 8 weeks | Waits for wedge-customer demand (Decision 2) |
| 7 HRM | 10 weeks | Waits for wedge-customer demand (Decision 2) |
| Email (transactional and marketing) | 8 weeks (estimate) | Added 2026-10-19 by owner decision (Decision 18); steps E1-E2 done in M2 (#538, #539: the kernel mail pipeline and delivery events), E3-E9 in the Icebox until M3 is done (backlog review D11, epic #537); plan: [email.md](email.md) |
| Meeting Notes (AI) | 6 weeks (estimate) | Added to the roadmap 2026-10-21 by owner decision (Decision 19); not started (epic #932 open); proposed after M3 unless the owner or a pilot customer pulls it forward |

Setup checklist: §12. Exit criteria per phase: §13; the MVP below replaces Phase 0.

### Decisions (2026-10-13)

The body of this plan was rewritten on 2026-10-14 to describe these decisions; if a conflict remains, the decisions win. Rationale: [ADR-0026](../adr/0026-wedge-scope-and-phase-0.md), [ADR-0027](../adr/0027-oss-core-and-crove-cloud.md); identity sessions and revocation: [ADR-0028](../adr/0028-identity-sessions-and-revocation.md); agents and the org chart: [ADR-0029](../adr/0029-agents-positions-and-org-chart.md).

1. **Wedge first.** Start with the Document Inbox: founders forward invoices and bank statements, AI proposes the bookkeeping, a human approves. First customers: startups and SMEs that use an outsourced accounting firm; test selling through accounting firms. The owner runs 10-15 interviews (founders + accounting firms) before Phase 2a scope is frozen; script below.
2. **Scope.** Committed: kernel + Accounting. CRM, Service, Social, Sign and HRM (Phases 3-7) start only when wedge customers pull for them.
3. **Rigor by stage.** Build now what is expensive to change later; defer the rest (table below).
4. **Two products, one codebase.** This repo is the open-source Business OS: it serves every developer, has no DOS-only features and must run on a laptop with one command (`docker compose up`), with no DOS service, no Supabase account and no cloud spend. Crove OS for DOS ("Crove Cloud") lives in a private `crove-cloud` repo: DOS configuration, DOS.AI defaults and credits, DOS org sync, managed Vietnamese connectors, infrastructure and the `app.crove.com` deployment. Both carry the Crove brand, endorsed by DOS (ADR-0027 decision 5). It starts with this repo's image plus DOS configuration, and builds its own Cloud image from this repo's code once it adds DOS-only adapters (Decision 12); this repo never depends on it. Body sections that are Cloud-only (§11, Cloud topology, costs) move there when that repo is created. Self-host is a hard requirement, not a deferral.
5. **Auth = Supabase Auth (GoTrue) + Postgres, not the full Supabase stack.** Self-host compose runs Postgres 17, Supabase Auth and Crove (plus Mailpit locally): email + password, magic link, Google/Microsoft/OIDC providers, MFA and password reset come from Supabase Auth. Crove Cloud uses the same code pointed at DOS's Supabase Auth (accounts shared with DOS ID). The kernel verifies Supabase access tokens (JWKS when asymmetric keys are on, otherwise the deployment's JWT secret), maps them to `user_account`, and keeps org membership in Crove. PostgREST, Realtime, Storage, Edge Functions and Studio are not used. Open spike: Supabase Auth on the plain `postgres:17` image vs Supabase's Postgres image.
6. **App shell = Vite + TanStack Router SPA, served by the kernel on the same origin** (owner decision, 2026-10-14). Chosen after the 2026-10-13 stack review, a Codex review and two blind reviews (Codex, Claude) that all ranked it first; TanStack Router has the strictest typed routes and search params, and its npm downloads grew about 19x year over year. Next.js stays for the landing page (`apps/web`). One container serves API, worker and UI for self-host. Fallback: React Router v8 (more widely known, looser search-param typing). Conditions: client route guards are UX only, the kernel checks token and membership on every request; verify the Supabase Auth flow in the SPA (PKCE callback, refresh, logout, MFA); spike A14 is retargeted to CSP + Trusted Types for the SPA; deep links fall back to `index.html`; runtime config carries no secrets.
7. **Protected-path review.** No manual owner approval label. Instead: invariant suite taken from base, a security reviewer agent on every protected-path PR, and an external security review before the first external tenant.
8. **Forks shut down.** No fork has real users (confirmed by the owner). The owner decided to shut the forks down, not just freeze them; on 2026-10-14 the owner archived the five fork repositories (Crove-CRM, Crove-Post, Crove-Desk, Crove-Cal, Crove-Sign), to be deleted later. Taking down their running deployments is a separate DOS-side step, tracked outside this repo. No one-way sync, parity checklists, `legacy_id_map` imports or rollback windows; drop the Phase 2a Twenty -> party sync and the fork import/parity exit criteria in Phases 3-6.
9. **Repo visibility.** Stay public. gitleaks runs in CI since 2026-10-13, plus a local pre-commit hook after `pnpm install` when gitleaks is installed. G1 runs in the same `Secret scan` job: generic Supabase identifier rules in `.gitleaks.toml`, plus literal refs from the `G1_BLOCKLIST` Actions secret (add Crove's own project refs once they exist). `Secret scan` is a required check on `main`.
10. **Pricing (Crove Cloud only).** Sold per app plus a "Full" bundle. One entitlement key per module (`finance`, `crm`, ...); `full` grants all. Self-host gets every module under AGPL; billing exists only in `crove-cloud`. Core keeps the entitlement check, and self-host defaults to `full`.
11. **Naming.** "Module" in code: `modules/<id>`, `@crove/mod-<id>`, schema `crove_<id>` (as in §5.3), because `apps/` already means deployables. "App" in product UI and marketing (Crove CRM, Crove Social...), with an app switcher in the shell.
12. **Adopted proposals.** Each gets an ADR before the matching MVP PR.
    - **Composition root.** Core exports a factory such as `createKernel({ identity, ai, broker, connectors, billing })`. Core `apps/kernel/main.ts` wires the open-source default adapters (identity: Supabase Auth by default; AI: any OpenAI-compatible endpoint); once it needs them, `crove-cloud` adds its own entrypoint that wires DOS-only adapters (DOS org sync, DOS.AI credits, billing) and commercial connectors and builds the Cloud image. Identity stays the Supabase Auth adapter, pointed at DOS's Supabase Auth (Decision 5). Until then (MVP step 2), Cloud runs the core image with DOS configuration. The Cloud diff is one entrypoint, private packages and config. Implemented in `apps/kernel/src/kernel.ts` ([ADR-0030](../adr/0030-composition-root.md)).
    - **Per-deployment module enablement**, e.g. `CROVE_MODULES=crm,finance`. Migrations still apply to every schema (one linear ledger); the setting only controls which commands, queries, jobs, routes and menu items are registered. Per-org access stays with entitlements (Decision 10). Implemented as `CROVE_MODULES` ([ADR-0031](../adr/0031-module-enablement.md)).
    - **Modules run when other modules are off.** UI slots and `ctx.query` return a typed `not_installed` result instead of failing; CI runs each module alone. Implemented as `ctx.query` returning `Lookup<O>` and the SPA's `slot()`; CI boots the kernel alone ([ADR-0031](../adr/0031-module-enablement.md)).
13. **TypeScript 7.0.2** (npm `latest`, released 2026-07-08). 7.1 exists only as nightly dev builds on the `next` tag, so it is not used (version policy, §2); Renovate moves to 7.1 when it is stable. Optional: a non-blocking nightly CI job that typechecks with `typescript@next`.
14. **Stack review proposals adopted (2026-10-14).** From the [2026-10-13 stack review](../recommendations/2026-10-13-architecture-stack-review.vi.html); §2 has the detail.
    - **Vite+ as the toolchain and task runner from day one** (`vp check`, `vp test`, `vp build`, `vp run`), instead of the review's Biome or Prettier formatter. Oxfmt is pre-1.0 inside Vite+ 1.x: an owner-approved exception to the version policy. Fallback task runner: Turborepo 2.x.
    - **Public `/v1` only on oRPC v2**, with a Crove-defined RFC 9457 error envelope; internal `/rpc` stays on oRPC 1.x.
    - **Cell-ready DB layer:** `@crove/db` resolves the pool from `org_id`; control-plane tables are kept apart from tenant data (§3.6).
    - **Integration platform roadmap:** an OAuth 2.1 authorization server for self-host (proposed in [ADR-0032](../adr/0032-oauth-authorization-server.md), 2026-10-16: `oidc-provider` embedded in the kernel, users still from Supabase Auth, Ory Hydra as fallback; accepted once its acceptance tests pass, before Phase 3), outbound webhooks per Standard Webhooks, TS/Python SDKs generated from OpenAPI.
    - **DBOS Transact spike** (1 week) before Phase 2a; fail means keeping the own process engine. Done 2026-10-16: fail, the own engine stays ([ADR-0033](../adr/0033-dbos-transact-spike.md)). Recovery without Conductor, committed SQL and per-org fairness pass (recovery only with a Crove-owned sweeper); a 7-day wait holds a queue slot or worker memory and polling, and breaks or strands across a deploy.
    - **Bun nightly canary** in CI, non-blocking.
    - **Client platforms:** PWA first, then Expo for mobile and Tauri 2 for desktop when their triggers are met (fallbacks Capacitor and Electron).
    - §2 has the final stack.
15. **Agents hold positions in an org chart shared with humans** (owner direction, 2026-10-14; [ADR-0029](../adr/0029-agents-positions-and-org-chart.md)). Each module ships one or more agent templates, for example `finance.chief_accountant` ("Kế toán trưởng (AI)"). A position is held by a human or an agent, and has a job description and tasks. Agents work with humans, and with each other where a module or an org has no humans: delegation only down their subtree, escalation to the supervisor position, communication only through tasks, comments and proposals. Only humans manage the chart, templates, limits and budgets. R3, and any proposal flagged P03-P07, always ends at a human (the nearest one up the chart holding the permission, else the org owner); agents never approve work from their own causal chain (External-tenant gate T18). Budgets, wake-up limits and kill switches per agent, module and org. Legal sign-off (kế toán trưởng, signed statements) stays with a qualified human. Ideas borrowed from Paperclip (MIT); Paperclip is not embedded, and external runtimes act through MCP grants.
16. **Identity and revocation per ADR-0028 (design C), 2026-10-14.** Chosen by the owner after two blind reviews (Codex, Claude) independently converged on it. Every request verifies the Supabase JWT locally and, in the same transaction, checks membership and a Crove-owned session status record (`auth_session`). Status source, one interface with two adapters: self-host reads `auth.sessions` and the user's ban or deletion in the shared database (next request); Crove Cloud (amended 2026-10-15) keeps Supabase Auth's default behavior: a sign-out elsewhere destroys the refresh tokens at once and access ends when the access token expires (SLA: the project's JWT expiry), with no per-request Auth call and no DOS-side change; DOS ID lifecycle events (DOS-28) are an optional later refinement. A revoke in Crove (self or owner) is immediate. R3 checks Supabase Auth live and needs `aal2` with MFA in the last 5 minutes. Rejected: a Supabase Auth call on every request with a 30 s cache (Auth load and outage coupling on Cloud), short-lived tokens only, pure push, Crove-issued sessions through token exchange. The ADR's acceptance tests are the evidence for gate T1.
17. **Social starts now, in parallel with Accounting (owner decision, 2026-10-16).** An exception to Decision 2 for Social only: CRM, Service, Sign and HRM still wait for wedge-customer demand. Social runs as its own stream and does not take kernel work Finance waits on. It builds the kernel pieces it needs and nobody else is building: the `crove-local` credential broker, the `channel` layer (ADR-0025, moved ahead of Phase 4) and the `external_call` ledger. Detailed plan: [social.md](social.md).
18. **Email module: transactional email and email marketing (owner decision, 2026-10-19).** Replaces the earlier "bulk email marketing only on real customer demand" (§13, §15). The sending pipeline and the rules no sender may skip (suppression, a log row per mail, one send per mail through `external_call`) are a kernel service every module uses; the optional `email` module adds sender domains, templates, contacts with consent, campaigns and analytics. Marketing goes only to contacts with recorded consent, from a verified org domain, with one-click unsubscribe and the Vietnamese `[QC]` label, after a human approval (R2). It keeps the milestone order of the backlog review: transactional steps E1-E2 in M2, marketing after M3 (backlog review D11). Detailed plan: [email.md](email.md); architecture: [ADR-0034](../adr/0034-outbound-email.md) (accepted 2026-10-24).
19. **AI Meeting Notes module on the roadmap (owner decision, 2026-10-21).** An optional `meetings` module: a meeting's recording or uploaded audio becomes a Vietnamese and English transcript, a summary, decisions and action items, linked to the org's parties, deals and tasks. Every action item and every follow-up mail is a proposal a human approves, and transcripts are tainted input. It is on the roadmap, not started: the default is after M3, the same reason as Email marketing (D11), unless the owner or a pilot customer pulls it forward. Scope and exit criteria: §13 "Meeting Notes".
20. **Calendar starts now, ahead of the rest of CRM (owner decision, 2026-10-24).** An exception to Decision 2 for Calendar only, like Social in Decision 17: deals, pipelines and the rest of CRM still wait for wedge-customer demand. Calendar keeps the structure of §13 ("Calendar lives in CRM"): the core (events, availability, free/busy) is the kernel `calendar` service, and the Calendly-style booking page is a feature of the `crm` module, not an app of its own. Cal.diy (MIT, Cal.com's community edition) is a reference for slots and booking flows, not a dependency; the archived Crove-Cal fork stays archived (Decision 8). Milestone "Calendar", P2. Detailed plan: [calendar.md](calendar.md).

### MVP

**Step 1, open source, local (no spend):** `docker compose up` gives a working flow: sign up -> create org -> upload or forward an invoice -> e-invoice XML parsed deterministically, PDF/image read by any OpenAI-compatible model -> proposal in the Inbox (vendor, purchase document, suggested TT133 entry) -> approve/edit/reject -> documents, vendors and entries lists -> Excel export for the accountant.

**Step 2, Crove Cloud:** the same image with DOS configuration (DOS Supabase Auth, DOS.AI), deployed to `app.crove.com`. Needs owner approval for spend, a Cloudflare token for DNS and email routing, and one DOS.Me change (add `app.crove.com` to the DOS Supabase Auth redirect URLs).

**Build in step 1:**
- Tenancy: shared tables with `org_id`, `PRIMARY KEY (org_id, id)`, composite FKs, RLS; `enter_context` derives org and actor from the DB and seals the context with an HMAC (T11); login roles do not own tables.
- One write path: `execute()` with auth, zod, RBAC, idempotency, handler, outbox, append-only audit; proposals + Inbox items.
- Money as NUMERIC, decimals as strings on the wire; committed idempotent SQL migrations applied by a built-in runner (no Supabase CLI needed).
- Party, file storage (local disk or S3-compatible), extraction, Inbox, purchase documents, suggested journal entries, Excel export.
- Worker + outbox relay on pg-boss; one image with roles `api | worker | all`.
- CI: lint, typecheck, unit tests, migration replay on plain Postgres.

**Exit criteria (step 1):**
1. On a fresh laptop: `docker compose up` -> sign up -> forward or upload an e-invoice -> proposal in the Inbox -> approve -> vendor, document and entry exist, with audit rows.
2. Generated cross-org RLS tests: 0 leaks. No write path outside `execute()`. (Met: the generated RLS matrix of T8, #114; the write-path check of #680, merged in #877: `apps/kernel/test/invariant/write-path.test.ts` scans the sources and `write-path.db.test.ts` the database, see the invariant suite in `AGENTS.md`.)
3. Audit rows cannot be updated or deleted; the same document resent creates no duplicates.
4. Playwright end-to-end run of exit criterion 1 is green.

**Follow-ups from #8 (Phase 1 residual work):** move `enter_system_context` out of the API role (T5, #24; done in #78); a re-extract command for files read by AI (#40; done in #143, see §8.4); pending invites with consent (#35; done in #123, #125 and #132); remove and update member (#36; done in #115); inbound token rotation (#37; done in #112); an end-to-end check of Supabase Auth rate limits (#34; it found the deployment-wide email budget, capped per client in #190); CSV/Excel formula prefixing and exact decimals in the Excel export (T13, #29; done in #93); audit retention and offboarding (#38; done in #211 and #267).

**Deferred, with the trigger to revisit:**

| Deferred | Revisit when |
|---|---|
| Sandboxed extraction container in Crove Cloud: `crove-extract` with no IAM permissions and no egress (the self-host container and compose isolation are done, #28) | Before the first external tenant (External-tenant gate T12, A15) |
| WORM fact stream, 10-year archive packages (built ahead of the trigger: the WORM archive with its nightly verifier, #924, voucher numbers and voids in it, #987, outbox events, #1035; the fiscal year archive package, #954, #970) | Before Finance GA |
| DOS org sync (DOS-1, DOS-26, DOS-27), in Crove Cloud | Per-org billing through DOS.AI (DOS-7, DOS-17) |
| MCP, public `/v1` API, outbound webhooks | A customer or partner needs them |
| SSE realtime on a separate `crove-stream` service (Cloud). The invalidation stream itself is built (#69) and runs in the API process (§9) | One API instance cannot hold the open streams, or stream re-checks crowd out request traffic in the API pool |
| Yearly partitions for `audit_event` | `audit_event` passes ~10M rows |
| NAT with a fixed IP | A provider requires an IP allowlist |
| `aal2` step-up for R3 approval (P11) and `session_id` in the approval audit row (done in #22, see T2) | Before the first external tenant (External-tenant gate T1, T2; #22) |
| P12 legal-entity scope (since #1279 eligibility is the `owner` or `admin` role or `finance.proposal.approve` from an org-wide `role_assignment`; an entity-scoped assignment grants no permission) | When proposals carry `legal_entity_id` (§4.6) |
| A forwarded email adds no human author to its proposal (the sender is not authenticated), so four-eyes does not see the forwarder | Inbound mail authenticates the sender (DKIM/SPF alignment) and maps it to a member |
| No re-snapshot or reassignment of a pending proposal: one whose eligible approvers have all left can only be rejected, and an approver added after creation neither approves it nor raises its four-eyes count (so a sole author-approver still self-approves, flagged `self_approved`). When every remaining eligible approver is an author, an owner among them may approve, flagged `owner_override` (#88); without an owner among them it can only be rejected. No delegation to a later admin | The first user report, or when `role_assignment` lands |
| P08 (escalate one level above 20 records or the org's money threshold): every ledger proposal is already R3, the top level, so nothing escalates, and no R1 or R2 command or agent-approvable proposal declares an amount or a record count yet (#1402) | A command declares policy facts (amount, records affected), or an R1/R2 proposal command gets agent approvers |
| Orgs that keep books default to the `accountant` preset (P09): every org starts on `founder` until the owner decides, because under `accountant` an owner or admin stops approving postings until a chief accountant is named (#1402) | Owner decision (#1402) |

### External-tenant gate

Crove Cloud accepts its first external tenant only when every row below is green and its evidence is linked here (PR, CI run or report). An external tenant is any org whose members are not the owner's own team. The "On `main`" column records the state on 2026-10-23 (#1204); issue numbers are the tracking issues in this repo. Since the backlog review (2026-10-17, decision D2) this table is the GA gate: the rule above applies to public self-serve sign-up, while a design partner under a signed pilot agreement may start once the pilot readiness checklist (#308) is signed off instead.

| # | Must be true | Evidence required | On `main` (2026-10-23) | Issue |
|---|---|---|---|---|
| T1 | Identity per ADR-0028 (accepted 2026-10-14, design C) implemented: issuer, audience and expiry required (boot fails without `AUTH_ISSUER`); `sub`, `session_id` and `role` required; anonymous tokens rejected; on every request the Crove session status record (`auth_session`) and membership checked in the request transaction, fail closed (self-host: `auth.sessions` and the user's ban or deletion read directly, read grant applied by the one-shot `auth-grants` step after Supabase Auth's first start; Cloud (`jwt`, amended 2026-10-15): the verified token plus Crove's records, Supabase Auth's default token lifetime for sign-outs outside Crove, no per-request Auth call); owner revoke immediate; R3 checked live against Supabase Auth (Cloud: `GET /user`; self-host: the per-request `db` read) with `aal2` and MFA in the last 5 minutes; a user with a verified MFA factor needs `aal2` for every request (#126); banned, deleted and disabled users rejected (Cloud: at once for R3, otherwise at token expiry) | The ADR-0028 acceptance tests, green in CI: unit tests for every missing or wrong claim; fresh install (`docker compose up` on empty volumes completes `auth-grants`, and the first sign-up, sign-in and API call succeed with the `db` check active); an old JWT after sign-out is rejected on the next request (self-host); on Cloud valid tokens pass with no Auth call and the R3 live check maps 200, 4xx and outages to pass, 401 and 503; owner revoke is immediate; a removed member gets 403; banned and deleted users are rejected; Auth outage behavior (no new logins, no R3, existing sessions per the ADR); R3 without fresh MFA is refused; an `aal1` token of a user with a verified factor gets 401 `MFA_REQUIRED` on reads and R1 commands while `aal2` and users without factors pass (#126). No DOS-side change needed, except that Cloud enforces #126 only once the identity provider states in the token that the user has a verified factor (ADR-0028 section 3) | Self-host done (#22): required claims, `auth_session` and `session_check` in the request transaction, `auth-grants`, revoke command with Supabase Auth sign-out, R3 needs fresh MFA. Cloud done (#22): `jwt` mode, the default without `AUTH_UPSTREAM_URL`, with the R3 live check. Self-host refuses `aal1` for users with a verified factor (#126, `auth.mfa_factors (user_id, status)` read after `auth-grants`; a missing table fails closed with 503, #180). Route enumeration test done (#693, `apps/kernel/test/invariant/route-coverage.test.ts`: every route off a reasoned public list answers 401 without a token and calls `authenticate()`). Open: job re-checks, #126 on Cloud (needs the factor fact from the identity provider; #180) | #22, #126, #180 |
| T2 | R3 approval restricted to authorized roles: today the roles that may post, `owner` and `admin`; once role assignments exist, the holders of the approval permission (§4.6, P12); `aal2` with MFA in the last 5 minutes and a direct Supabase Auth check (P11, ADR-0028); four-eyes when two eligible approvers exist (P10); the audit row records approver, `aal` and `session_id` | Database tests: `member` and `viewer` get 403 (in #71); an `aal1` token, or an `aal2` token whose MFA is older than 5 minutes, gets 403 `STEP_UP_REQUIRED`; an `aal2` token with fresh MFA executes; P10 and P12 cases; audit row content asserted | Done. #71 limits approval to `owner` and `admin` and carries the token's `aal` on the user actor. #75 enforces P12 (an eligible-approver snapshot taken when the proposal is created, plus a live role check with row locks at approval; `NOT_ELIGIBLE`) and P10 (four-eyes counting only humans: the uploader and every editor are authors, an author may not approve while 2 or more eligible approvers remain, `FOUR_EYES_REQUIRED`; a sole eligible approver may self-approve, flagged `self_approved` in the audit row; #88: when every eligible approver is an author, an owner may approve, flagged `owner_override`), with database tests; the audit row records approver, revision, `aal` and the P10 and P12 outcome; `kernel.inbox.get` returns `canApprove` and the SPA hides Approve from users the server would refuse. #22 requires `aal2` with MFA in the last 5 minutes (`STEP_UP_REQUIRED`) and the audit row records `aal`, `session_id` and the MFA time. #126 closes the path around it on self-host: an `aal1` token of a user with a verified factor cannot reach R1 or R2 work or any read either (401 `MFA_REQUIRED`). The direct Supabase Auth check at execution is done in #22 too: in `jwt` mode (Cloud) every R3 command first checks the access token live with Supabase Auth (`GET /user`, `createSupabaseLiveCheck` in `apps/kernel/src/sessions.ts`) and fails closed; self-host reads Supabase Auth's tables in the request transaction. The SPA has TOTP enrollment, the sign-in challenge and a step-up prompt that asks for a fresh code (or to enable two-factor) when R3 answers `STEP_UP_REQUIRED`, then retries (#32) | #20 (closed by #71), #22, #75, #32 |
| T3 | Ledger immutability: only the posting path (a definer) writes journal entries and lines; a posted entry cannot gain lines; every entry has at least 2 lines and balances at commit | Database tests as the module and login roles: direct INSERT into `journal_entry` or `journal_line` is denied; adding a line to an entry committed earlier fails; an entry with 0 or 1 line, or unbalanced, fails at commit; reversal nets to zero; a fast-check property test of the posting path | Done (#71, #76, #138). In #71, with database tests: `crove_finance.post_journal_entry`, owned by `crove_definer_tenant`, is the only writer (tenant roles lost INSERT on both tables); a `created_xact_id` stamp rejects lines added to an entry from any later transaction; entries with no lines and unbalanced entries are rejected at commit. Done in #76, with database tests (`apps/kernel/test/invariant/ledger-visibility.db.test.ts`, under a test-only RESTRICTIVE policy that hides some lines from every tenant role): the balance and line-count checks (`require_entry_balanced`, called by the commit trigger `check_entry_balanced` and by `assert_entry_balanced`) are definers owned by the migration runner, which owns `journal_line` and is not filtered by its row security (a migration guard fails otherwise), so they count every line of the one entry they check; no runtime role can call them, and `assert_entry_balanced` is callable only by `crove_definer_tenant` and only for the org in the sealed context; an entry that balances only over the visible lines is refused, a balanced entry with hidden lines is accepted, and an entry with exactly 1 line is refused; the refusal reports the difference over every line, which is safe only because a line can join an entry only in the transaction that created it, so the caller supplied every summed line (a future feature that appends lines to an existing entry must drop the amount from the error first); the posted-entry rule also compares `created_xact_start`, so an `xid8` repeated after a logical restore does not reopen an entry (§7.9). Done in #138, with database tests (`apps/kernel/test/invariant/ledger-reversal.db.test.ts`, `ledger-posting-property.db.test.ts`): a reversal is a new entry posted through `post_journal_entry` (an overload that takes `reverses_entry_id`; the original signature calls it), whose lines mirror the original's (same line number, account, party and memo, debit and credit swapped), linked by `reverses_entry_id` (composite FK `(org_id, reverses_entry_id)` and a unique index, so an entry is reversed at most once; of two concurrent reversals the second waits on the index and fails); it never adds lines to an existing entry, so the balance error above stays safe; a reversal cannot itself be reversed (to restore the original effect, post a new entry) and is never dated before the original; the commit trigger on `journal_entry` (once per entry) and `assert_entry_balanced` also run `require_entry_mirrors`, a definer owned by the migration runner that compares every line of both entries and reports no amounts, and each line's trigger checks that line against the original's line with the same number (so running the checks early with `SET CONSTRAINTS ... IMMEDIATE` and adding lines afterwards is refused too); the self-FK is `ON DELETE NO ACTION`, so deleting an original that has a reversal fails; so the rules hold for every writer, superusers included, and nobody can reverse an entry with lines they cannot see; the pair nets to zero per account. A reversal is a posting, so it runs only through an approved proposal under the same rules as a purchase (§4.7: R3, P10, P11, P12, approvers `owner` and `admin`): `kernel.proposal.request` (R1, `owner`, `admin` or `member`) runs `finance.journal.prepare_reversal`, which checks the entry and builds the proposal, and `kernel.proposal.approve` runs `finance.journal.reverse` (R3, proposal only). A fast-check property test (fixed seed, 100 runs) posts random line sets as `crove_app` and commits: a set is accepted exactly when it has at least 2 lines and balances. Since #165: the API route `inbox.request` (an idempotency key) and the screens: "Đảo bút toán" on the journal (date, required reason), a reversal card in the Inbox, the reversal link both ways in the journal, and a plain message when the database refuses a partial mirror; reversing a purchase entry voids Crove's record of its document (Phase 2a, Finance) | #19 (closed by #71), #76, #138, #165 |
| T4 | Org creation runs through `execute()` with an audit row | Database test: creating an org writes `tenant`, the owner `tenant_member` and an `audit_event` row in one transaction; login roles cannot execute the raw definer (EXECUTE matrix test); a per-user rate limit | Done in #96 and #107, with database tests (`apps/kernel/test/kernel.db.test.ts`, `apps/kernel/test/org-create-limit.db.test.ts`): `kernel.org.create` is an org-less command run by `Runtime.executeOrgless()`. The definer `create_or_replay_org`, executable by `crove_app` alone, creates the tenant and the owner membership (or returns the org an earlier request with the same idempotency key created, serialized by a per-user advisory lock); the runtime then enters that org as the caller and writes the audit row and the idempotency key in the same transaction, and a replay creates nothing. A deferred constraint trigger refuses to commit a tenant without its `kernel.org.create` audit row written by the tenant's creator (the creator check since #102), even for the database owner; the raw `create_org` definer is dropped; the EXECUTE matrix test covers both functions. Since #107 the definer also refuses a new org, under the same lock and so across API instances, when the caller created 5 in the last 24 hours or 20 in total, closed orgs included (`ORG_CREATE_LIMIT_PER_DAY`, `ORG_CREATE_LIMIT_TOTAL`): 429 `RATE_LIMITED`, nothing written; a replay of an existing key does not count; of concurrent requests at the boundary exactly one wins. A refusal has no org to be audited in, so it is noted in `security_event` instead (§4.4 step 3, #1006) | #23, #94 |
| T5 | Inbound email processing moved out of the API role's system context: the API verifies the shared secret, limits size and stores the raw message; parsing and `kernel.inbound.receive` run in the worker | EXECUTE matrix test: the API login role cannot call `enter_system_context`; integration test: a forwarded e-invoice still yields a proposal, processed by the worker | Done in #78, with database tests (`apps/kernel/test/kernel.db.test.ts`): the API verifies the secret, limits size, stores the raw MIME as `inbound/<random id>` and enqueues it through the narrow definer `inbound_enqueue` (202; 503 past 10000 pending messages); the worker checks the blob's size and hash, parses it, runs `kernel.inbound.receive` and deletes the blob once the message is filed or dropped. Only `crove_worker` may execute `enter_system_context`, which also requires `session_user` to be `crove_worker`; only `crove_app` may execute `enter_context`; startup guards refuse an API role that can enter system context and a worker role that cannot. The EXECUTE matrix test and the forwarded e-invoice test (HTTP app, then the real worker, then a proposal) are the evidence | #24 |
| T6 | The pg-boss schema is vendored into committed migrations; no code path runs pg-boss with `migrate: true` | Committed, version-guarded migration for `crove_jobs` (`pnpm db:vendor:pgboss`); CI check that the pinned pg-boss version matches the vendored schema version; migration replay creates `crove_jobs` with no runtime DDL | Done (#25): `pnpm db:vendor:pgboss` renders pg-boss's own plans into `supabase/migrations/*_crove_jobs_pgboss_v46.sql` (no transaction wrapper, every function pins `search_path`, version-guarded `DO` block that leaves an existing version-46 install alone and stops on any other version), which also creates the queues and grants only `crove_worker`. Nothing runs pg-boss with `migrate: true`; the worker starts with `migrate: false`, which refuses another version. `/readyz` reports `jobs_schema` until `crove_kernel.jobs_schema_version()` equals the version the pinned pg-boss expects; a unit test fails CI when a pg-boss upgrade changes the schema version without its migration; database tests cover the fresh install, the existing install, a wrong version and a job round trip as `crove_worker` | #25 |
| T7 | An S3-compatible storage adapter, shared by API and worker | `BlobStore` S3 implementation with integration tests against an S3-compatible server in CI; an end-to-end run with `api` and `worker` as separate containers and no shared volume; keys and references per §7.6 | Partly done in #110. `STORAGE=s3` selects `S3BlobStore` (`packages/kernel-runtime/src/s3-store.ts`, AWS SDK v3), built from config by `createBlobStore` in both the `api` and `worker` roles; `STORAGE=local` (the default) keeps `LocalDiskStore`. Both stores accept only `org/<org_id>/<sha256>` and `inbound/<id>` keys, refuse an org key that is not the sha256 of its bytes, and raise `BlobNotFoundError` for a missing blob. S3 writes are create-only (`If-None-Match: *`; on GCS `x-goog-if-generation-match: 0`) and carry `x-amz-checksum-sha256`, which the server verifies; the same bytes again dedupe, different bytes raise `BlobConflictError`, and the store reads an object back when a server does not confirm the checksum. Local disk writes are create-only too (#111: a temporary file is fsynced and hard linked to the key, so the same bytes dedupe and different bytes raise `BlobConflictError`; without hard links the store falls back to an exclusive create and warns; stale temporary files are swept at startup). The bucket policy must grant `s3:ListBucket`, or a missing key reads as 403 and `get` raises `BlobStoreAccessError`. Bodies are buffered in memory (at most 25 MB for a file). Since #109 (ADR-0013): every file row keeps the triple (key, `generation`, sha256), where `put` returns the generation (`s3:<VersionId>`, `gcs:<generation>`, or `content:<sha256>` on local disk and unversioned buckets); every read requests that version and checks the sha256 (`readVerified`), so a swapped object is never served or parsed (S25); `S3_VERSIONING=required` (default) refuses writes the bucket returns without a version; file rows never change (guard trigger). With `STORAGE=s3` browsers upload through a single-use presigned POST to a random `staging/` key (5 minutes, 1 byte to 25 MB, grant row in `crove_kernel.file_upload`) and download through a 60-second presigned GET of the recorded version; local disk keeps streaming through the kernel, and so does a GCS endpoint until presigned POST is verified there. Tests for #109: mocked-client and offline-signing unit tests, MinIO with versioning (presigned POST, size, key and expiry refused, overwrite still reads and downloads the original), PostgreSQL plus MinIO through the HTTP API (single use, expiry, other users), the invariant suite (`file-upload.db.test.ts`) and the RLS matrix; the split stack runs on a versioned bucket with presigned URLs off, so its downloads stream through `readVerified` with the version pinned. Tests: unit tests with a mocked client and on the real SDK request; integration tests against MinIO in the CI `check` job (`CROVE_TEST_S3_URL`); files written through the API upload and inbound paths read back from a new store instance in a new API app and a new worker call, on local disk and on MinIO (`apps/kernel/test/storage.test.ts`). End-to-end run with `api` and `worker` as separate containers (#108): `docker-compose.split.yml` runs both roles from the same image with `STORAGE=s3` against MinIO and no files volume (only the worker is on the `extract` network); the CI job `split-stack` brings it up and `tools/e2e/split-stack.mjs` uploads the e-invoice and posts an inbound email through the HTTP API, waits until the worker has read both into proposals, and checks that both files are objects in the bucket with their bytes, the raw message was deleted from it, and nothing is under `/data/files` in either container (job `split-stack` in [ci.yml](../../.github/workflows/ci.yml), [first green run](https://github.com/DOS/Ludy/actions/runs/38830847915/job/116749026299)). Per-object retention holds (#1009, ADR-0013 section 6): the original file of every posted invoice is held in GOVERNANCE mode for `EVIDENCE_LOCK_DAYS` (default 3650) from its posting, set by a worker job outside the posting transaction on the recorded version and recorded on the file row (`held_until`, retried with a backoff when refused); a bucket without Object Lock or local disk gets no hold and the worker says so; offboarding and erasure keep held files and say so (`docs/runbooks/evidence-holds.md`). Tested with a mocked client, against MinIO with an Object Lock bucket, through a real posting on PostgreSQL, and the guard in the invariant suite. The accountant's confirmation of which files and from when is a setting (#61). R2 runs in the pilot with `S3_VERSIONING=off` only, since R2 refuses a read that names a version (#1073, fixed in #1074), so there integrity rests on the sha256 check and evidence holds need a versioned bucket. Open: GCS not yet run against | #26, #108, #109, #1009, #1073 |
| T8 | Generated cross-org RLS matrix (MVP exit criterion 2) | The CI `db` job generates cases for every tenant table: cross-org read, insert, update and delete denied or 0 rows; no context gives 0 rows; a new tenant table without cases fails CI | Done in #114, in the invariant suite (`apps/kernel/test/invariant/rls-matrix.db.test.ts`, run by the CI `db` job and, from the base branch, by the protected-path job). The cases come from the catalog: every relation with `org_id` in any non-system schema (19 tables when it landed, `crove_kernel` and `crove_finance`; every later tenant table, `crove_social` included, gets its block or fails CI) gets its own block. Structural check: a table (not a view), RLS enabled, no runtime role owns it or acts as its owner, no role holds TRUNCATE, REFERENCES or TRIGGER or has BYPASSRLS, and either exactly the `tenant_isolation` policy of `apply_tenant_rls` or, for the listed definer-only machinery tables (`auth_session_org`, `outbox_pending`), no privilege for any role. Probes, each in its own rolled-back transaction, as `crove_app` in a member's context, `crove_worker` in system context, `crove_definer_tenant` in a context, and both login roles with no context: reading org B (0 rows, own rows visible as the control), inserting an org B row (42501 row-level security, or permission denied where the role has no INSERT; the same factory's own-org row is accepted as the control, so a denial is never a malformed row), updating org B rows or moving own rows to org B, updating and deleting with no WHERE clause (only rows the actor sees may change), deleting org B rows and TRUNCATE. A table with `org_id` and no row factory, RLS off, another permissive policy or an unlisted no-access table fails with a message naming it. The matrix found `outbox_pending` with RLS off (no role held a privilege on it, so not reachable); `20261015160000_crove_kernel_outbox_pending_rls.sql` enables it. Cross-legal-entity cases since #1281: every table with a NOT NULL `legal_entity_id`, and `legal_entity` itself, must carry the RESTRICTIVE `le_scope` policy in the expected shape, and a member of org A limited by its `external_accountant` assignment to one branch reads, inserts, updates and deletes none of the default entity's rows; a new entity-scoped table gets these cases from the catalog or fails. A nullable `legal_entity_id` (`role_assignment`) is a scope, not an owner. Forged contexts are refused by the seal (T11, `sealed-context.db.test.ts`). Since #1538 `proposal` is entity-scoped too (`legal_entity_id NOT NULL`, removed from the nullable exceptions) | #17, #1281 |
| T9 | Playwright end-to-end test (MVP exit criterion 4) | A required CI job runs `docker compose up` and Playwright through MVP exit criterion 1 (sign up, create org, upload an e-invoice, approve, lists, export) | Done (#18): the `e2e` workflow builds the image, starts `docker compose up` on fresh volumes and runs `e2e/tests/inbox.spec.ts` on every PR: sign up, create org, upload the sample e-invoice, approve, the vendor, document and entry lists, the Excel export, then the vendor, purchase document, balanced journal entry and audit rows read from the database. The job (`Playwright on docker compose`) is a required check on `main` | #18 |
| T10 | Context re-entry guard (§4.5, item 1) | The negative tests listed in §4.5 run in the CI `db` job | Done in #103, with database tests (`apps/kernel/test/context.db.test.ts`): `enter_context` and `enter_system_context` start with `crove_kernel.context_reentry_guard()`, which raises `CONTEXT_REENTRY` (42501) when `pg_locks` shows this backend already holding the context lock (namespace `0x43524F56`, key `pg_backend_pid()`, at any level) or when `crove.org_id` or `crove.user_id` is already set, then takes the lock with `pg_try_advisory_xact_lock`. Every negative test of §4.5 item 1 runs in the CI `db` job, plus the same cases for `enter_system_context` and the key held by another backend (refused at once, not waited for). The runtime enters once per transaction (`ctx.run` reuses the context); a re-entry maps to `INTERNAL` 500. Since T11 (#73) the guard also refuses when `crove.ctx` or `crove.ctx_seal` is already set. Since #105: the `pg_locks` read is measured and kept, since no cheaper marker holds (about 13 us per entry with an idle lock table plus about 0.27 us per lock held server-wide; entries top out near 50,000/s server-wide; §4.5 item 1); the guard works unchanged on a hot standby (§3.3); a session-level lock on the guard key left on a pooled connection is dropped by the pool reset, or with the reset off closes that connection through the taint path (both tested); the runtime logs every context error on its own `[alert] <code>` line with the request's ids. Re-checked by the Phase 1 load test (#998, #1010): with 100k parties and 8 commands in flight, 157 to 238 locks were held server-wide (p95 230), so the guard costs about 75 µs per entry against a command p95 of 15.8 ms (docs/runbooks/load-test.md) | #27, #105 |
| T11 | Sealed context (§4.5, item 5; deferred table above) | Database tests: context settings forged or reset with `set_config` give 0 rows and failing `WITH CHECK`; the seal covers the whole context | Done in #116, with database tests (`apps/kernel/test/invariant/sealed-context.db.test.ts`): `enter_context` and `enter_system_context` write the whole derived context (org, actor kind, user, role, legal-entity scope, flags) to `crove.ctx` and seal it in `crove.ctx_seal` with HMAC-SHA256 over the context text, `pg_backend_pid()` and the transaction start, keyed by a random key no Crove role can read (§4.5 item 5). Every `ctx_*` helper, and so every RLS policy and definer, reads the context only through `ctx_verified()`. Tests as `crove_app` and `crove_worker`: forged org, legal-entity scope, user, flags, actor and role after a valid entry, a context written without `enter_context`, an edited or removed seal, and a seal replayed into a later transaction or onto another connection all raise `CONTEXT_SEAL_INVALID` on every helper, on RLS reads and writes and in definers owned by the runner and by `crove_definer_tenant` (mapped to `INTERNAL` 500); the retired `crove.org_id` and `crove.user_id` grant nothing, and without a context reads give 0 rows and writes fail; the seal matches an HMAC recomputed outside the database. Accepted residuals: a replay needs two transactions of one backend starting in the same microsecond; `ROLLBACK TO SAVEPOINT` can restore a context `enter_context` derived earlier in the same transaction (as T10 accepts; since #117 a test pins that only such a context verifies afterwards). Since #117: `@crove/db` pools reset session state (`RESET ALL`, `RESET ROLE`, session advisory locks, cursors, `LISTEN`) before a connection goes back to the pool (`DB_RESET_ON_RELEASE`, default `true`), so a session-level `set_config` of the context settings no longer denies every later checkout of that backend, and a checkout that hits `CONTEXT_REENTRY` or `CONTEXT_SEAL_INVALID` has its connection closed instead of pooled (residual: behind a transaction-mode pooler only the pooler's reset applies, §3.3); `crove_kernel.context_key_rotate()` and the runbook `docs/runbooks/context-key-rotation.md` rotate the key, tested to stop old seals verifying. Open: `le_scope` is the explicit `'*'` and `flags` are empty until legal entities and sensitivity flags exist (§4.6); no per-call re-check of current access (measured in #117: about 4.4 us to 8.8 us per helper call, roughly 2x, one call per helper per statement; left out until the semantics for a membership change inside a running transaction are decided); `command_id`, `ai_run_id` and `trace_id` are not in the context yet; the Phase 1 load test measures the cost | #73, #117 |
| T12 | Sandboxed file parsing: PDF, XML and MIME parsing run in `crove-extract` (no secrets, no egress, CPU, memory and time limits) | Tests: the sandbox cannot open a network connection and has no secrets in its environment; a dependency rule stops the API and worker from importing parsers | Done in #28, #120 and #136, except the Crove Cloud deployment. `apps/extract` is the `crove-extract` image (`apps/extract/Dockerfile`: fast-xml-parser, unpdf, postal-mime, hono and zod; no database client, AI or storage SDK) and the only home of a parser, the e-invoice XML parser included (`apps/extract/src/einvoice-xml.ts`); `@crove/l10n-vn` keeps the invoice types, money helpers, checks and a first-bytes detector, with no parsing library. One endpoint, `POST /extract?kind=einvoice_xml\|pdf_text\|mime`, takes the raw bytes and answers JSON (`@crove/extract-contract`). Limits: request bodies over 25 MB (files) or 40 MB (email) are refused before they are read; each parse runs in a fresh Node process under the permission model (read access to the app code only: no network, no file writes, no child processes, no worker threads, no addons), with an empty environment, no code generation from strings, a 512 MB heap, 768 MB of resident memory (Linux watchdog; Buffers and wasm included) and a 25 s wall clock, then killed; a kill it did not send (the OOM killer) counts as memory; the body is read only once a parser slot is free, and a body that sends nothing for 2 s or is not complete after 3 s ends with a `bad_request` failure (the worker retries) and frees the slot; one parse at a time, 1 waiting, then 503, so a queued call ends within the worker's 60 s (`EXTRACT_TIMING` in the contract: every slot ahead and its own count a body read and a parse, then the answer; the service refuses settings that break this); inbound email retries a timeout or memory answer once, then drops it. It refuses to start with any variable outside an explicit allowlist (its own settings, `NODE_ENV`, and what the node image and the container runtime set), naming the variables and never their values, inside its image (a marker file written at build time, `/etc/crove-extract-image`, so overriding `NODE_ENV` cannot switch the guard off) and wherever `NODE_ENV` is not explicitly `development` or `test`; a development run (`pnpm dev`) only warns about credential-like names. On Kubernetes its pod needs `enableServiceLinks: false`. The worker requires `EXTRACT_URL`, and `extractAndPropose` without a client fails: nothing outside `crove-extract` parses, in tests too. The kernel image is installed with `--prod --filter-prod`, so no parser package is in it (`@crove/extract` is only a devDependency of the kernel, for its database tests). The worker sends the bytes and validates the answer with strict zod schemas (unknown keys, oversized fields, wrong kind or status and answers over 64 MB are refused; redirects are refused); file-caused failures are recorded on the file, service failures throw and the job retries. Compose runs it on an `internal: true` network with no published port, a read-only root file system, `cap_drop: ALL`, `no-new-privileges`, 1 GiB, 1 vCPU and 128 pids. Tests: `apps/extract/test/extract.test.ts` (limits, timeout, heap, billion laughs, deep nesting, malformed input, no network connection, no file write or process, empty environment, environment allowlist), `apps/extract/test/einvoice-xml.test.ts` (the e-invoice parser), `apps/extract/test/http.test.ts` (through `@hono/node-server`: a caller that disconnects aborts its parse or leaves the queue, a caller that holds the single slot with a body it never finishes frees it when it disconnects, and one that stays connected frees it after the body idle limit, or at the body deadline when it trickles bytes), `packages/extract-contract/test/client.test.ts`, `modules/finance/test/extract.test.ts`, the dependency rule `tools/test/parser-imports.test.ts` (sources, manifests and the kernel's whole production dependency tree), and the database tests run e-invoice upload and inbound email end to end through the service on a random port. The CI job `extract-image` builds the image, runs it as compose does on an internal network, parses real files inside the container, checks that an extra variable refuses the start under any `NODE_ENV`, and asserts that nothing in the container's network reaches the outside (IPv4 and IPv6 TCP, a raw UDP DNS query, DNS, HTTPS; IPv6 unavailable inside the namespace counts as blocked), with a control run on an ordinary network (its IPv6 probe is skipped only when that network has no IPv6 route, as on GitHub runners). The CI job `kernel-image` builds the root `Dockerfile`, loads every kernel module and the entry point inside it, writes a journal and a MISA workbook through the finance exports inside it, and fails if any parser package is in its `node_modules` (the store, every link in it and pnpm's hidden hoisting included), with a control run that plants `saxes` and must fail. `exceljs` depends on `saxes`, an XML reader it needs only to read a workbook: `patches/exceljs.patch` loads it only then, and the image build removes `saxes`, `xmlchars` and exceljs's `dist` (browser and ES5 builds that bundle or load it), so the kernel, which only writes workbooks, cannot read one (the image check asserts the read fails for want of `saxes`; #1719). The workspace keeps `saxes` for the tests that read exports back. The one XML reader left in the image is the AWS SDK's own, in `@aws-sdk/xml-builder`, which reads only the answers of the configured S3 endpoint, never a tenant's file. Open: Crove Cloud deployment (deferred table above, A15) | #28, #120, #136 |
| T13 | Excel export keeps money exact and escapes formulas | Unit test: amounts with more than 15 significant digits and 4 decimals round-trip exactly from the exported file (never through JavaScript `Number`); text cells starting with `=`, `+`, `-` or `@` cannot run as formulas | Done in #93, with unit tests (`modules/finance/test/export.test.ts`): an amount is a numeric cell only when it has at most 15 significant digits and the double converts back to the identical decimal (number format per its decimal places), otherwise a text cell holding the exact decimal; amounts of 16 to 20 significant digits and 4 decimals round-trip exactly through exceljs. Text is written as string cells with the Text format, so a value such as `=HYPERLINK(...)` stays inert; no apostrophe is added, since in xlsx it would become part of the data (`-ABC`, `+84...`). Negative amounts stay numbers. There is no CSV export; a future one must use `csvSafeText`, which prefixes `=`, `+`, `-`, `@`, tab, CR and LF (OWASP) | #29 |
| T14 | External security review (Decision 7) and `SECURITY.md` | A written report from an independent reviewer covering auth, context and RLS, the sandbox, inbound email and webhooks; every high or critical finding fixed or accepted in writing by the owner; `SECURITY.md` with a private reporting channel | Partly done. `SECURITY.md` added in #144 (#33): private reporting through GitHub Security Advisories, acknowledgement within 3 business days, assessment within 10, coordinated disclosure. Open: the external security review (#31, owner action: engage the reviewer) | #31, #33 |
| T15 | Decision 7 review flow in CI | A required workflow on `main` that runs, for PRs touching protected paths (§10, G6), the invariant suite taken from the base branch and a security reviewer agent; a test PR shows it blocking | Workflow `protected` built (#30): the invariant suite (`test/invariant/`) runs from the base branch on protected-path PRs, and the security reviewer agent job waits for the `ANTHROPIC_API_KEY` secret (#95). `Invariant suite (from base)` is a required check on `main`. Open: the security reviewer agent (#95, owner action; until then the session runs its own security review on protected-path PRs, per `AGENTS.md`), and making `Security review (agent)` required once it runs | #30, #95 |
| T16 | PDPL package (§7.9) | DPIA, cross-border transfer dossier, DPA template, 72 h breach runbook and sub-processor list, reviewed by a lawyer | Drafted, awaiting the lawyer: [docs/legal/pdpl/](../legal/pdpl/README.md) has the record of processing, the impact and transfer assessments, the processing agreement annex, the sub-processor list and the breach notices, written from the code, with the questions for the lawyer (#1012); the internal breach steps are [incidents.md §9](../runbooks/incidents.md). The owner fills the providers and engages the lawyer | #62, #1012 |
| T17 | Definer hardening: every `crove_*` function pins `search_path = pg_catalog, pg_temp`, and login roles have no TEMP privilege | A CI catalog test over `pg_proc` fails on any `crove_*` function without the pinned path, and checks that login roles cannot create temporary objects | Done in #97. The guard is `hardeningViolations` in `packages/db/src/migrate.ts`. The migration runner runs it after every run and fails the run if any of these hold:<ul><li>A function or procedure in a `crove_*` schema does not have exactly `search_path=pg_catalog, pg_temp` as its settings. SECURITY INVOKER functions count too, because a definer calling them lends its rights. Extension members and pg-boss's invoker functions in `crove_jobs` are skipped; a definer in `crove_jobs` still fails.</li><li>A `crove_*` role has TEMPORARY.</li><li>(#100) A function outside the `crove_*` schemas that a `crove_*` object reaches without naming it sets a search_path other than the pinned one, or is SECURITY DEFINER without one. Reached means a function, or an operator's function, bound by OID in `pg_depend` to a `crove_*` object or one of its parts (triggers and their WHEN clauses, defaults, constraints, index expressions, policies, views, SQL-standard bodies), to a type a `crove_*` object uses (followed through domains, arrays, ranges, multiranges and composites: I/O and range functions, domain defaults and CHECK constraints), or to an aggregate reached that way; plus the function of any cast to or from such a type. A SECURITY INVOKER function with no search_path is accepted, since it runs with its caller's path, which inside a definer is the pinned one. Not covered: a schema-qualified call inside a PL/pgSQL body (the catalog does not record it), functions an outside function calls in turn, and triggers or defaults of tables outside `crove_*` that a definer writes (none today).</li><li>(#100) A role that can act as a `crove_*` role (use its privileges, SET ROLE to it, or hold ADMIN OPTION on it; also through other roles, per `pg_auth_members`) has TEMPORARY, unless it can already act as every owner of a `crove_*` SECURITY DEFINER function.</li></ul>The guard has no bypass (no environment flag, no warn-only mode): a deploy that fails it is fixed with a forward migration or by the database owner, never skipped, because a skipped check leaves a privilege escalation open and a warning nobody acts on is no check. `20261015120000_crove_kernel_revoke_temp` revokes TEMPORARY from PUBLIC and from the Crove roles. Before that, it grants TEMPORARY directly to every other role that held it, so Supabase Auth keeps it. Database tests: planted unpinned functions are reported in a rolled-back transaction, and `migrate()` fails on a committed one. Login roles get `permission denied to create temporary tables`. The pg_temp hijack test still fails with TEMP granted back. A `docker compose` run (sign-up, org, e-invoice upload, proposal) shows that Supabase Auth works without TEMP for Crove roles. (#179) On the Supabase Postgres image (the image line hosted Supabase runs: `supabase/postgres` 17.11.0.002, through Supabase CLI 2.119.0 and on its own), with migrations run as `postgres` (not a superuser there) and pg_graphql, pg_net, pgsodium, supabase_vault, pg_cron, pgmq, pgaudit, vector, postgis, citext, hstore, ltree, pg_trgm, btree_gist, http, pg_jsonschema, pg_hashids and wrappers enabled, the guard reports nothing, before and after pg-boss creates `crove_jobs`, so no Supabase-specific rule was needed. The `Migrations and hardening guard on the Supabase Postgres image` CI job repeats this on every PR (`packages/db/test/supabase.db.test.ts`, image pinned by digest); it also shows the guard still reports a planted unpinned function and an extension's definer function reached from a `crove_*` default. The guard turns JIT off while it runs (0.8-0.9 s per call on `postgres:17`, 30-45 ms without) | #74 |
| T18 | Agents cannot raise their own power or launder approvals (ADR-0029) | Negative database tests: an agent actor cannot run any position, holder, template, `max_risk`, budget or kill-switch command; an agent cannot approve R3, a proposal flagged P03-P07, or work from its own causal chain; P10 counts only humans; a run that lost its checkout lease cannot write; removing a member vacates the position; a `reports_to` cycle is rejected under concurrency | Done in #79, with database tests (`apps/kernel/test/invariant/agents.db.test.ts`): an agent actor is refused every position, holder, template, `max_risk`, budget and kill-switch command, and `kernel.proposal.approve`, by the runtime (no command declares agent access except the five task commands) and audited as denied; any write to `position`, `agent`, `ai_run`, `budget_policy` or `kill_switch` in an agent context is refused by a trigger; the runtime refuses agents R3 (P05), R2 (P06), risk above `max_risk` (P02) and tainted R1 writes that do not propagate taint (P03); `eligibleApprovers` and `decideApproval` count only members, so an agent never approves nor counts for four-eyes (P10, P12); a run past its expiry cannot enter, a stale fencing token is refused, and an agent context cannot write a task or comment it does not hold, extend its lease or change task fields; removing a member vacates the position (`ON DELETE SET NULL (holder_user_id)`); a `reports_to` cycle is refused directly and between two concurrent transactions (per-org advisory lock); `enter_agent_context` is worker only and derives the org from the run; an org kill switch stops running runs and refuses later entries. Agents approve nothing in Phase 1 (ADR-0029, Phase 1 as built) | ADR-0029, #79 |

### Customer interview script (owner)

Ask about what already happened, not "would you use this". Founders / SMEs:
1. Who keeps your books today (yourself, in-house, an accounting firm)? What does it cost per month?
2. How many purchase invoices and bank statements a month? How do they arrive (email, Zalo, paper)?
3. Tell me about the last time paperwork cost you time or caused trouble.
4. What software do you use (MISA, Excel...)? What do you like and hate about it?
5. If AI read every invoice and proposed the entries so you only approved, what would stop you from trusting it?
6. What would you pay per month if it saved you X hours or part of the accounting fee?

Accounting firms:
7. How many companies do you keep books for? Hours per company per month?
8. How do clients send documents? What costs the most effort (data entry, bank reconciliation, chasing documents)?
9. What software do you use, and what keeps you on it?
10. If a tool collected each client's documents and proposed entries, would you pay per client or per month? How much?

## Why Crove OS

**Product goal:** an AI-first Business OS for startups, solo founders and SMEs (Vietnam first), deeply integrated with the DOS ecosystem (DOS ID, DOS.AI). The experience is "AI Financial Operator + exception handling" (AI Inbox), not "ERP + chatbot". Founder Mode and Accountant Mode run on the same data.

**Main reason: rebuild business software on AI-native principles.** CRM, helpdesk, scheduling, e-signature, social posting, accounting, HR... redesigned from the ground up for AI to do the work, instead of bolting AI onto designs built for people clicking menus.

| | Traditional software / forks (AI bolted on) | Crove OS (AI-native) |
|---|---|---|
| Who does the work | People click menus; AI is a side chatbot | AI acts first; people approve exceptions in the AI Inbox |
| Actions | Forms, buttons, hand-written APIs per feature | Every operation is a typed command shared by UI, API, agent and automation |
| Safety when AI acts | AI uses the user's permissions | R0-R3 policy, proposals, taint, AI-specific audit |
| Data | Records with unclear provenance | Every number traces back to source documents and evidence |
| Agents | One bot per app | Agents per module hold positions in one org chart with humans, and work together through tasks |
| How it's built | Humans write code | 100% AI agents; codebase designed for AI to read and modify correctly |

**Tried: stitching together the best open-source fork per module** (Twenty for CRM, Documenso for Sign, Cal.com for Cal, a Go-based Desk, Postiz for Post). What happened in practice:
- One UI per app; users open each app instead of one hub.
- User and data sync is hard: HMAC-signed JIT provisioning + 60-second login tickets + per-app OAuth consent; Desk keeps a copy of CRM companies/customers via two-way webhooks; creating a team means setting it up again in Desk, CRM and Sign.
- One agent per app. No accounting, finance or HR yet.
- 5 codebases with at least 3 stack types, hard for AI coding.
- Potential sync paths grow as n(n-1)/2: 5 modules = 10 pairs; adding Finance and HR = 21.

**Considered forking an ERP or existing platform, rejected:**

| Candidate | Reason rejected |
|---|---|
| Odoo CE | Python/Owl, one DB per tenant; CE lacks Helpdesk, Sign, Payroll and full accounting reports; menu-first UX |
| ERPNext | Production runs on MariaDB only |
| Twenty as the core | Own auth and workspaces, per-workspace schema, hard to enforce ledger constraints |
| NocoBase | Multi-tenancy is an Enterprise feature; admin-builder UI |
| Bigcapital | MariaDB, one DB per organization |
| Midday | License forbids commercial use without purchase |

**Why building now makes sense:**
- Accounting and HR have to be built in-house anyway.
- Once the kernel exists, lean CRM and Desk are the cheapest part.
- AI coding works best on one codebase with one convention.
- Solo-founder customers mean very many small tenants, so shared tables + `org_id` + RLS, not one DB per tenant.
- The truly hard parts (e-invoices, banks, CAs, Vietnamese compliance) are integration and operations, not CRUD.

**What success looks like:** one UI hub, one identity, one data model (party), one agent for every module, native Finance to Vietnamese standards, self-hostable with a Cloud edition, open source under AGPL-3.0. Not "MISA rewritten in new tech", and not a bloated ERP.

The architecture and plan TL;DR follows.

## 0. TL;DR

1. **Don't rebuild existing infrastructure.** Identity comes from Supabase Auth (Decision 5), AI via an OpenAI-compatible endpoint. The only new code is a thin business core that runs fully with no DOS services (self-host).
2. **Reuse from DOS for Crove Cloud** (each is an adapter that can be turned off):
   - DOS ID accounts through DOS's Supabase Auth (Decision 5).
   - Later, when per-org billing needs it: DOS org sync through the DOS-Me API and org/team change webhooks, enabled only after gate DOS-1 passes.
   - DOS.AI: models, metering, credits.
   - DOS-Me credential broker (`provider_connections` + Vault): optional connector.
3. **Reuse the designs of patterns running in DOS prod** (design only, no shared tables): `team_webhook_outbox` -> outbox; `collaboration_write_ledger` -> proposals and `external_call`; `agent_action_audit` -> append-only audit.
4. **New code:**
   - Kernel runtime: `execute()`, sealed context + RLS, R0-R3 policy, proposals and AI Inbox, relay, audit, `user_account` mapping and org membership (`tenant`, `tenant_member`).
   - Kernel module: party, file, activity, task.
   - Business modules and the shell.
5. **Libraries:** Hono, oRPC 1.x (contract-first), Kysely + Kanel, pg-boss, zod 4, AI SDK 7, `jose` + Supabase Auth, the Vite+ toolchain, a Vite + React + TanStack Router SPA, shadcn/Base UI, TanStack Query, `use-intl`. Details in §2.
6. **Locked architecture:**
   - Repo: separate repo (`DOS/Ludy`), TypeScript modular monolith, AGPL-3.0 + CLA. Private repo `crove-cloud` holds infrastructure, environment config and commercial connectors.
   - Runtime: one image with roles `migrate | api | worker | all`; the `api` role also serves the SPA. Self-host: `docker compose up` (PostgreSQL 17, Supabase Auth, Crove, Mailpit). Crove Cloud: the same image on Cloud Run (API service, worker pool, migrate job) in separate GCP projects for prod and beta. File parsing moves to its own sandbox before the first external tenant.
   - Data: Crove owns its DB. Crove Cloud uses a dedicated Supabase project (prod + beta, ap-southeast-1, 7-day PITR); self-host uses any PostgreSQL 17. Schemas `crove_*`; migrations live in the Crove repo and the built-in runner (`migrate` role) applies them.
   - Identity: Supabase Auth (Decision 5). The kernel verifies the access token locally and checks a Crove session status record and membership on every request (ADR-0028, design C), maps `(issuer, subject)` to `user_account` and owns org membership. No FKs to, or reads from, DOS's DB; business data never syncs with DOS.
   - Write path: every write goes through `kernel.execute()`, in a transaction carrying a sealed context that RLS checks.
   - Async: everything runs through outbox -> pg-boss; the DB decides the fan-out.
   - AI: agents hold positions in the org chart next to humans (one or more per module, ADR-0029) and call an OpenAI-compatible endpoint (Cloud: DOS.AI). R2/R3 actions always become proposals and run deterministically only after approval.
   - The SPA, served by the kernel, holds no secrets and never touches the DB; Next.js is used only for the landing page.
7. **Roadmap:** MVP step 1 (merged) -> step 2, Crove Cloud -> Finance spike -> Phase 1 hardening, including the External-tenant gate -> Finance 2a/2b. CRM (incl. Calendar), Service (incl. social inbox), Social, Sign and HRM start only when wedge customers pull for them (Decision 2); Projects later. The forks are shut down, not migrated (Decision 8). The core repo is public (Decision 9).
8. **Hard gates:**
   - Crove Cloud does not enable DOS membership sync until gate DOS-1 passes; self-host is unaffected.
   - Agents have no tools that touch prod/beta DBs, Crove's or DOS's.
   - The public repo never contains project refs, internal URLs or secrets (gitleaks and project-ref scanning in the required `Secret scan` check).
   - Crove Cloud accepts no external tenant until the External-tenant gate (Tracking) is green.

## 1. Architecture principles

1. **One write path.** Every state change is a typed command run through `kernel.execute()`, whether it comes from UI, REST, MCP, agent, job, import or an approval step. Nothing else may write.
2. **The DB holds invariants, TypeScript holds policy.**
   - Postgres enforces: tenancy (RLS + composite FKs), a ledger that always balances and cannot be edited, gapless document numbers, idempotency, append-only logs.
   - RBAC, business rules and AI policy live in one TypeScript pipeline.
3. **Trust comes only from sealed context.** Org, actor, legal-entity scope and sensitivity flags are derived by `enter_context` and HMAC-signed. No definer, job or tool accepts these values as trusted parameters.
4. **Committed SQL is the only schema.** Idempotent migrations live in `supabase/migrations` of the Crove repo and are applied by the built-in runner (`migrate` role); prod and beta receive schema only through the pipeline. No ORM push, no runtime DDL, no vendor self-migration (one accepted exception: Supabase Auth migrates its own `auth` schema, ADR-0027), no out-of-band DDL. Since #25 `crove_jobs` is a vendored migration too (External-tenant gate T6).
5. **Shared tables in Crove's DB, `org_id` everywhere, default-deny roles.** Login roles are NOINHERIT and own nothing. `service_role` and BYPASSRLS never run user, agent or job code.
6. **Modules are packages with contracts, arranged as a DAG `kernel-runtime < kernel < modules`.**
   - Each module has one schema and one role.
   - Cross-module reads go through public queries; cross-module writes go through events or the other module's commands.
   - FKs point only into `crove_kernel`.
7. **The outbox is the only async door.** Subscriptions and queues are data created by migrations. The worker version is always >= the API version.
8. **Policy decides, prompts don't.** The minimum risk level is derived mechanically; taint follows data; review -> proposal -> deterministic execution.
9. **No evidence, no count.** Linked chain run -> step -> evidence -> proposal -> command -> audit. Legally significant facts stream to a WORM bucket within <=5 minutes.
10. **Money and dates must be exact.** NUMERIC; decimals travel as strings on every wire; accounting dates are `YYYY-MM-DD`.
11. **Isolate untrusted content.** Files and emails are parsed in a sandbox with no secrets and no egress. External content is always marked tainted.
12. **Designed so AI coders get it right by construction.**
    - One way to do each thing, a generator for every artifact, mechanical naming rules.
    - Local DB loop; CI failures print the fix command.
    - A PR cannot loosen its own security controls.
13. **Lean.** Only Postgres and containers (Vercel only for the landing page). No Kafka, Redis, k8s or search cluster. A capability enters the kernel only when it has 2 consumers, or when it is a security or integrity invariant.
14. **Expand/contract; public names frozen.** Migrations must be compatible with the running app. Breaking changes go in a separate contract PR.
15. **Self-host first: every DOS integration is an adapter.** Identity (`IdentityProvider`, Supabase Auth by default; Decision 12), AI (OpenAI-compatible endpoint), credential broker and billing sit behind interfaces. The core runs fully with no DOS services; Crove Cloud is just a configuration.

## 2. Stack choices

| Layer | Choice | Why | Fallback | Revisit when |
|---|---|---|---|---|
| Version policy | <ul><li>Always the **latest stable**: the npm `latest` dist-tag; Node uses the newest release line. No alpha/beta/rc/canary/next.</li><li>Renovate runs daily: patch/minor auto-merge when CI + evals are green; majors open a PR immediately, the agent runs codemods and merges when green, no waiting.</li><li>`minimumReleaseAge: 1440` (1 day) only to block hijacked publishes (supply chain), not to wait for releases to "mature"; security patches are exempt.</li><li>Exact pins + `catalogMode: strict`: every agent uses the same version.</li><li>Each library is imported by only 1-2 packages, so a major upgrade touches one place.</li><li>Libraries newer than the model's knowledge cutoff: vendor version-matched docs into `docs/vendor/` before coding.</li><li>Exception (owner-approved, 2026-10-14): Vite+ 1.x is stable but bundles pre-1.0 Oxfmt, and pins its own Oxlint, Oxfmt and Vitest versions (Vite+ 1.1.0: Oxlint 1.87.0, Oxfmt 0.72.0, Vitest 5.0.3), so those tools follow Vite+ releases rather than their own `latest`.</li></ul> | Cutting edge is a product stance (2026-10-13); facades, vendor docs and CI/eval gates keep continuous upgrades from breaking things | - | Every new stable release |
| Runtime | Node 26 (newest release line, LTS from 2026-10-28), image `node:26-slim`, non-root. Bun: non-blocking nightly CI canary; switch only when the test suite passes on Bun and OTel instrumentation of `pg` works | Latest stable; Bun is not yet fully Node-compatible | Node 24 LTS | Node 27/28; Bun canary green |
| Workspace, toolchain | <ul><li>Latest `pnpm` 12.x workspaces (12.11 at time of writing), lockfile at repo root, `catalogMode: strict` for package versions.</li><li>Vite+ (`vite-plus` 1.x, MIT, by VoidZero) from day one, one `vp` command: `vp dev`, `vp check` (format + lint + typecheck), `vp test`, `vp build` (Rolldown), `vp pack` (tsdown, for library packages if needed), and `vp run` as the monorepo task runner with caching and dependency-aware scheduling.</li></ul> | A strict catalog stops agents adding stray versions; one toolchain instead of separate tools and a separate task runner | Turborepo 2.x if Vite Task falls short (for example remote caching in CI; whether Vite+ has remote caching is unverified) | Vite Task misses a CI need |
| Typecheck | TypeScript 7.0.2 native (Decision 13) for `tsc --noEmit`, plus a TS 6.0 alias for tools that need the compiler API (same layout as DOS.Me). `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax` on. Optional: a non-blocking nightly typecheck with `typescript@next`. Runs inside `vp check` once Vite+ is adopted (to verify: it uses the pinned TypeScript 7.0.2) | Fast; already used at DOS | TS 6.0 | TS 7.1 stable |
| Lint/format | Through `vp check`: Oxlint 1.x (type-aware only in CI) + Oxfmt; `@ast-grep/cli` for domain rules; every rule at **error**. Oxfmt is still pre-1.0 inside the stable Vite+ 1.x: an explicit, owner-approved exception to the version policy (2026-10-14) | Agents ignore warnings; one command formats, lints and typechecks, so agents needn't know the rules | Standalone `oxlint`/`oxfmt`; Prettier 3 if Oxfmt breaks; ESLint 10 for rules Oxlint lacks | Oxfmt 1.0 (the exception ends) |
| Boundaries | `dependency-cruiser` 18.x (rules generated from manifests), `knip` 6.x | DAG checked by machine | - | - |
| Validation | `zod` 4.x, the only one | oRPC, AI SDK and MCP SDK use it directly | - | zod 5 stable |
| HTTP | `hono` 4.x + `@hono/node-server`; Hono 5 at GA. Never Hono's JWT middleware (tokens are verified with `jose`) | Thin; Hono's JWT middleware had two high-severity advisories in 2026-01 | Fastify 5 | Hono 5 GA (in RC) |
| RPC | oRPC 1.x (1.15 at time of writing), contract-first: <ul><li>`@orpc/contract` lives in `@crove/kernel-contract`, generated from the registry;</li><li>`@orpc/server` only in `@crove/kernel-http`;</li><li>the shell imports only the contract;</li><li>internal `/rpc` stays on oRPC 1.x; the public `/v1` API opens only on oRPC v2, with a Crove-defined error envelope (RFC 9457), so third parties never see the v1 to v2 error-format break.</li></ul> | Typed RPC and OpenAPI from one source; the shell doesn't pull in the server graph | Hono + `@hono/zod-openapi` for `/v1` | oRPC 2 stable (in beta); 90 days without a release |
| Integration platform (REST/MCP/webhooks) | Roadmap: <ul><li>an OAuth 2.1 authorization server for third-party apps and MCP clients, self-host and Cloud alike: proposed in [ADR-0032](../adr/0032-oauth-authorization-server.md) (2026-10-16) as `oidc-provider` embedded in the kernel's `api` role, with no user store of its own (login and consent through the SPA's Supabase Auth session), RFC 8707 audience-bound JWT access tokens per surface and grants in `agent_grant`; Zitadel, Keycloak and Supabase Auth's beta OAuth 2.1 server rejected for now, Ory Hydra the fallback; client registration via CIMD per MCP spec 2026-07-28 (DCR off by default, deprecated there);</li><li>outbound webhooks signed per Standard Webhooks (`standardwebhooks`), sent from the outbox (Svix OSS optional);</li><li>TS/Python SDKs generated from OpenAPI (itself generated from oRPC);</li><li>`@modelcontextprotocol/server` 2.x, MCP tools built from the contract.</li></ul> | Latest stable, takes zod 4 schemas directly; third parties get one auth model, signed webhooks and SDKs | - | ADR-0032 accepted (its acceptance tests) before Phase 3; Supabase Auth's OAuth server ships CIMD, resource-bound `aud` and RFC 7009; a customer or partner needs it |
| Auth (kernel) | Supabase Auth (GoTrue), per ADR-0027: the kernel verifies access tokens with `jose` 6 (JWKS when asymmetric keys are on, otherwise the deployment's JWT secret), maps them to `user_account` and keeps org membership in Crove. R3 step-up uses Supabase Auth MFA (`aal2`) | Email + password, magic link, social/OIDC providers, MFA and password reset come from Supabase Auth instead of custom code; Cloud points the same code at DOS's Supabase Auth | A new identity adapter (`user_account` keeps `(issuer, subject)`) | Supabase Auth changes token signing; spike: Supabase Auth on plain `postgres:17` |
| DB | <ul><li>`pg` 8 Pool (unnamed statements), `kysely` 0.29 exact pin (no migrator, no `CamelCasePlugin`), `kanel` 4 + `kanel-kysely`.</li><li>Migrations: committed idempotent SQL applied by the built-in runner (no Supabase CLI needed).</li><li>Cell-ready: `@crove/db` resolves the connection pool from `org_id` (one pool today); control-plane tables (identity, tenant directory, staff, sessions) are kept separate from tenant data so tenants can later move to another database. The seam, the table split and the join rule are in §3.6.</li></ul> | Close to SQL; holds no schema; cell routing is cheap now, later it touches every place that opens a transaction | `kysely-codegen` (per spike A3) | Kysely 0.30/1.0; one database nears its write ceiling |
| Money, IDs | `decimal.js` 10; `uuid` (v7 for ids, v5 for derived keys) + SQL function `crove_kernel.uuid_v7()` | PG17 has no uuidv7 | - | Supabase moves to PG18 |
| Jobs | <ul><li>`pg-boss` 12.x exact pin; `crove_jobs` schema vendored into migrations; `migrate:false`.</li><li>Durable processes use the plan's own process engine for now (`process_instance`, timers as jobs, human waits as proposals). The 1-week DBOS Transact spike (issue #59) failed on the 7-day approval wait, so the own engine stays ([ADR-0033](../adr/0033-dbos-transact-spike.md)).</li></ul> | DLQ, per-key FIFO, throttling, timezone-aware cron | `graphile-worker` behind the `defineJob` layer | An upgrade needs runtime DDL; upgrade quarterly; a DBOS release that parks waits in the database and recovers old versions without replay (ADR-0033) |
| Housekeeping | `pg_cron` + definer purge functions (DML only, batched) | No runtime DDL | Schedules inside the worker (default for self-host without `pg_cron`) | - |
| Storage | <ul><li>S3 API (`@aws-sdk/client-s3` v3, checksum `WHEN_REQUIRED`) pointed at GCS `asia-southeast1`.</li><li>Buckets per project and environment.</li><li>Archive is WORM.</li><li>Self-host: any S3-compatible store; archive needs Object Lock.</li></ul> | Same region as compute | AWS S3 `ap-southeast-1` with Object Lock | A lawyer requires storage in Vietnam |
| Parsing (sandbox) | `unpdf`/`pdfjs-dist` (`isEvalSupported:false`) and an XML-DSig library patched for CVE-2025-29775, in the `crove-extract` image | Moves parsers out of privileged processes | - | New CVE |
| AI | `ai` 7.0.x + `@ai-sdk/openai-compatible` -> the OpenAI-compatible endpoint configured per deployment (Cloud: `api.dos.ai/v1`); only `@crove/agent` may import them | Thin, provider-agnostic | Thin HTTP adapter | Gateway fails conformance; at most 1 major per 6 months |
| Evals | Vitest + `promptfoo` (pinned) | Evals run like tests | - | - |
| Web | Product app: Vite 8 + React 19 + TanStack Router SPA (`apps/app`), served by the kernel on the same origin (Decision 6). Landing page: Next.js 16 (`apps/web`) | Strictest typed routes and search params; static build, so self-host needs one container; Next.js only where SEO matters | React Router v8 | SSR needed (TanStack Start on the same router) |
| UI | <ul><li>`shadcn` CLI on `@base-ui/react` 1.x, `tailwindcss` 4.x, OKLCH tokens in `@crove/ui`.</li><li>`@tanstack/react-table` 9.x (`useTable` API), only inside `DataView`.</li><li>`@tanstack/react-virtual` 3, `react-hook-form` 7.</li></ul> | A single base | Radix base per component | - |
| Client data | `@tanstack/react-query` 5 + `@orpc/tanstack-query` | The pattern agents write most correctly | - | p75 interaction misses target |
| Realtime | Invalidation over SSE (#69, §9): `GET /api/stream` sends `{type, id}` hints from a Postgres `NOTIFY` per changed row, one `LISTEN` connection per API process; the SPA re-fetches through its normal queries and polls only while the stream is down. Before #69: refetch on focus and Inbox polling. Later (2b, Cloud): the same stream on a separate `crove-stream` service. Zero is the candidate for a Linear-like instant UI from Phase 3 (it does not enforce RLS on reads, so it waits) | No extra replication slot; still runs on plain Postgres for self-host | Batched Realtime REST broadcast | Phase 3 (Zero) |
| Shell auth | Supabase Auth client (`@supabase/auth-js`) in the SPA (PKCE, refresh, logout, MFA); client route guards are UX only; the kernel checks token and membership on every request | One auth client for self-host and Cloud; security stays in the kernel | - | Supabase Auth flow check in the SPA (Decision 6) |
| i18n, URL state | `use-intl` (the framework-agnostic core of next-intl, ICU messages, vi/en) and TanStack Router `validateSearch` with zod instead of `nuqs` | Same message format as next-intl without the Next.js dependency; typed search params come with the router | `nuqs` with its TanStack Router adapter | When per-locale SEO is needed (landing page) |
| PWA (direction, not MVP) | The SPA as an installable PWA with Web Push (iOS supports Web Push for installed PWAs). First client step, near zero cost; §15 already lists "PWA + Web Push later" | Phone approvals without an app store build | Mobile row below | Approvals on the phone are needed |
| Mobile (direction, not MVP) | Expo (SDK 57, React Native 0.87, Expo Router). Shares the TypeScript contracts, zod schemas, oRPC client, TanStack Query and i18n messages with the web app; the UI is native and separate from shadcn. Use cases: approve Inbox proposals, push notifications, scan invoices and receipts with the camera into the Document Inbox, biometric step-up for R3 approvals. Scope like HubSpot's free iOS/Android app: an extension of the web app, not a copy | Native camera, push and biometrics with one TypeScript codebase for logic | Capacitor 8 wrapping the same SPA (reuses 100% of the UI, webview feel) | Wedge customers ask for mobile approvals or camera capture |
| Desktop (direction, not MVP) | Tauri 2 (2.12) wrapping the same SPA static files: Rust shell, OS webview, small binaries, tray, native notifications, auto-update | Reuses the SPA as is; small binaries and low RAM | Electron 44 (bundled Chromium gives consistent rendering, at the cost of size and RAM; Slack and VS Code use it) | A real-time chat or other always-open module needs tray and native notifications (such a chat also needs WebSocket or SSE realtime, already planned in the Realtime row) |
| Tests | `vitest` 5.x (unit/db/browser) via `vp test`, `msw` 3.x, `fast-check` 4, latest `@playwright/test` (CI only). The Playwright end-to-end test (MVP exit criterion 4) runs in the `e2e` workflow | Latest stable; one toolchain | Vitest 4.1 if plugins lag | - |
| DB tests & lint | Today: a Vitest `db` project that applies the committed migrations to plain PostgreSQL 17 with the built-in runner (a CI service container; no Supabase CLI) and tests RLS, append-only audit and ledger invariants. The generated cross-org RLS matrix (T8) runs in the invariant suite. pgTAP files under `supabase/tests/database` run in the same project (#1627). Later, as migrations grow: splinter, `plpgsql_check`, `libpg-query` 17 (including the plpgsql parser) for migration lint | Real migrations on real Postgres from day one; catalog meta-tests come next | - | - |
| Observability | <ul><li>OTel SDK + `pino` -> Cloud Logging/Trace/Error Reporting.</li><li>Alerts via Cloud Monitoring, data from the prober.</li><li>10% sampling, 100% of errors kept.</li><li>No Sentry in v0.</li><li>Self-host: OTLP export or stdout.</li></ul> | No dependency on the DOS collector (not deployed yet) | Datadog via the DOS collector | When the DOS collector is actually running |
| Infrastructure | <ul><li>Self-host: `docker compose up` (PostgreSQL 17, Supabase Auth, Crove api + worker + UI in one image, Mailpit); in production, the same images + any PostgreSQL 17 + S3-compatible storage.</li><li>Crove Cloud: GCP `crove-prod`, `crove-beta` (`asia-southeast1`): Cloud Run services, worker pool, Jobs, Artifact Registry, Secret Manager; a dedicated Supabase project per environment (ap-southeast-1, PG17; 7-day PITR on prod), not shared with DOS.</li><li>Vercel only for the landing page; the SPA is served by the kernel.</li><li>OpenTofu 1.x in the private `crove-cloud` repo, run by CI via WIF.</li></ul> | One command for self-host; Cloud environments separated by IAM boundaries; own DB means no noisy neighbours and usable PITR | Worker as a service with min=max=1 | A data residency requirement |
| CI security | `gitleaks` (from the first commit), project-ref scanning (G1), `zizmor`, dependency-review (with license checks), Opengrep | Supply chain; the repo will be public | CodeQL | - |
| License | <ul><li>AGPL-3.0 for the core repo (`LICENSE` at the root; SPDX headers optional).</li><li>License-grant CLA (contributors keep copyright and grant the project owner the rights to use, sublicense and relicense), individual + corporate, enforced with CLA Assistant.</li><li>"Crove" trademark + brand policy.</li></ul> | Open source while keeping the right to sell commercial licenses and move to a more permissive license later; DCO does not allow relicensing | - | Before accepting outside contributions; when a large corporate contributor appears |

**Client platforms.** Because the app shell is a static SPA and every write goes through the kernel API, desktop and mobile clients need no new backend. PWA, Mobile and Desktop above are direction only, built when their trigger is met.

**State on `main` (2026-10-14, checked 2026-10-23).** The MVP already uses pnpm 12 (`packageManager: pnpm@12.11.2`, `catalogMode: strict`), Node 26, TypeScript 7.0.2, oxlint 1.88, Vitest 5, Hono 4, oRPC 1.15, Kysely 0.29, pg-boss 12, Vite 8, TanStack Router and Query, `@supabase/auth-js`, `jose`, `use-intl` (#206), Tailwind 4, shadcn on `@base-ui/react` 1.8 in `@crove/ui` (#46; `pnpm lint` rejects raw colors in the SPA) and Playwright 1.64 (`e2e/`, the `e2e` workflow). Kanel 4 + `kanel-kysely` generate the Kysely table types from the migrated database (`pnpm db:types`, #48; CI fails when `packages/db/src/generated/database.ts` is out of date): only the tables `crove_tenant` may read, so control-plane tables have no type, with hand-written refinements in `packages/db/src/schema.ts` that typecheck against the generated columns. Not adopted yet (checked 2026-10-23): Vite+ (scripts still call `oxlint`, `vitest` and `pnpm -r` directly) and a formatter. The S3 storage adapter is on `main` since #110 (T7). Since #15 the landing page (`apps/web`) uses catalog versions (Next.js 16.4, React 19.3, Tailwind 4, TypeScript 7.0.2); its Dockerfile now starts from `node:26-slim`, pinned by digest.

## 3. Topology

One image, `crove-kernel` (root `Dockerfile`), runs every deployment. Its entrypoint (`apps/kernel/src/main.ts`) takes a role:

- `migrate`: apply the committed migrations with the built-in runner, and set login-role passwords from the environment (the pg-boss schema is a vendored migration since #25);
- `api`: the HTTP API plus the SPA's static files, on one origin;
- `worker`: the outbox relay and pg-boss jobs;
- `all`: `api` and `worker` in one process, the self-host default;
- `auth-grants` (ADR-0028, on `main` since #22): a one-shot step after Supabase Auth's first start that grants `crove_auth_reader` SELECT on `auth.sessions` and `auth.users` for the self-host revocation check; it connects with the admin database URL, like `migrate`, because only the `auth` table owner or a superuser can grant on them.

Self-host and Crove Cloud differ only in configuration (Decision 4). The Cloud-only parts of this section (Cloud diagram, environments, deploy workflows) move to `crove-cloud` when that repo is created.

### 3.1 Repo tree

**Core repo** (`DOS/Ludy`, AGPL-3.0; public since 2026-10-13, Decision 9). This is the target layout. `main` today (2026-10-23) differs: a root `vitest.config.ts`; extra packages `l10n-vn`, `mail`, `channel` and `extract-contract`; `modules/social` besides `modules/finance`; no `kernel-http` or `testing` packages (the HTTP server lives in `apps/kernel`); the workflows are `ci`, `e2e`, `protected`, `gitleaks`, `docs-check` (which runs the migration order check and the migration lint), `migration-recheck`, `ai-eval`, `nightly-canaries` and `deploy` (the pilot deploy on release tags, #56); `apps/extract` (T12), `packages/ui`, `LICENSE`, `CLA.md` (draft), `CONTRIBUTING.md`, `TRADEMARKS.md` and `SECURITY.md` exist (§12-C).

```
Crove/
├── AGENTS.md · CLAUDE.md(@AGENTS.md) · README.md · LICENSE (AGPL-3.0) · CLA.md · CONTRIBUTING.md · TRADEMARKS.md
├── SECURITY.md                      before the first external tenant (External-tenant gate T14)
├── Dockerfile · docker-compose.yml · .env.example      one image; self-host stack
├── package.json · pnpm-workspace.yaml · pnpm-lock.yaml · vite.config.ts (Vite+)
├── .claude/
│   ├── rules/*.md                   rules with `paths:` (§10)
│   ├── skills/*/SKILL.md            skills that call generators
│   └── settings.json                hook dispatcher (every change needs owner approval)
├── .github/workflows/               scope, migration-lint, db-replay, ci, protected, e2e, evals, security, cla (§10); no deploy workflows
├── apps/
│   ├── app/                         product SPA (Vite + TanStack Router), static files served by the kernel; routes from manifests
│   ├── web/                         landing page (Next.js) -> Vercel
│   ├── kernel/                      image `crove-kernel`: main.ts -> migrate | api | worker | all (later: stream in 2b)
│   └── extract/                     image `crove-extract`: sandbox, parsing libraries only (External-tenant gate T12)
├── packages/
│   ├── kernel-contract/             zod + @orpc/contract: codecs, define*-contract, errors, Filter AST, contract.generated.ts
│   ├── kernel-runtime/              execute, context, RBAC, policy, idempotency, outbox/relay, audit, proposal, numbering,
│   │                                egress guard, storage adapters, identity (Supabase Auth token verification and session status, ADR-0028);
│   │                                './async' is the ONLY pg-boss importer
│   ├── kernel/                      KERNEL MODULE (id `kernel`, golden module): party, file, extraction, activity, task, tag,
│   │                                notification, inbound
│   ├── kernel-http/                 Hono + oRPC server (/api/rpc; later /v1, /mcp), /auth/v1 proxy, /api/inbound, /webhooks
│   ├── db/                          Kysely factory, withTenantTx | withTenantReadTx | withSystemTx, type parsers,
│   │                                built-in migration runner, generated/
│   ├── agent/                       the ONLY ai/@ai-sdk importer
│   ├── ui/                          shadcn/Base UI, tokens, DataView
│   └── testing/                     command-driven factories, one tenant per test, TestClock, test-signed Supabase Auth tokens,
│                                    synthetic fixtures (the only source of ai.examples)
├── modules/<id>/                    @crove/mod-<id>, added per phase
├── supabase/
│   ├── migrations/<ts>_crove_<token>_<desc>.sql   the ONLY place for DDL (the folder name is historical; no Supabase CLI)
│   └── tests/database/{_conformance,_rls_matrix,_invariants}.test.sql · <token>/*.test.sql
├── evals/ · docs/{adr,vendor,specs,generated,self-host}/
└── tools/{cli,generators,arch,agent}/   `crove` CLI, templates, migration-lint, hook dispatcher, SessionStart
```

**Private repo `crove-cloud`** (never public; created with MVP step 2, issue #55):

```
crove-cloud/
├── infra/               OpenTofu: GCP projects, SAs, WIF, secrets, buckets, budgets, Supabase projects, Vercel (landing), DNS
├── .github/workflows/   deploy-beta, deploy-prod, release-gate, infra
├── env/{beta,prod}/     project refs, the Supabase Auth URL and public key, domains, AI endpoints (no secrets)
├── connectors/          connectors needing contracts/certification: e-invoice issuing, bank aggregators, CA signing, MISA broker
└── billing/             entitlements and billing link to DOS (DOS-7, DOS-17)
```

**Boundary rules:**
- The core repo does not import, submodule or read files from DOS.Me or `crove-cloud`. `crove-cloud` depends one-way on core: it checks out the exact SHA, builds images and injects config at deploy time.
- Crove touches DOS only through HTTP adapters (principle 15): DOS's Supabase Auth (JWKS, `/auth/v1`, the R3 live check per ADR-0028), optionally session and user lifecycle events from DOS ID (DOS-28, deferred), the AI endpoint (`api.dos.ai`), `dos-broker` (`api.dos.me`, optional) and, later, DOS org sync (DOS-27). No DB connection to DOS.
- The core repo contains no project refs, client ids, internal domains or secrets; those live in `crove-cloud` and Secret Manager.
- Connectors in `crove-cloud` are built into the Cloud image. This is valid because the project owner holds full rights to the core via the CLA (ADR-0022). Third parties extend via API/MCP, not in-process.
- Agents start at the core repo root; implementation sessions don't need `crove-cloud`.
- **Business model (open-core):** self-host is free; Crove Cloud is paid (DOS ID login, DOS.AI credits, managed Vietnamese connectors, backup and 10-year retention, regulatory updates); a commercial license for parties that cannot comply with AGPL.

### 3.2 Runtime diagram

**Self-host, `docker compose up` (implemented on `main`):**

```
 Browser ── http://localhost:8080 (a TLS reverse proxy in front for other machines; PUBLIC_URL) ──►
 ┌─ crove: image crove-kernel, role `all` ─────────────────────────────────────────────────────────┐
 │ /                    SPA static files (apps/app/dist); unknown paths fall back to index.html     │
 │ /api/config          public runtime config (auth URL, flags); no secrets                         │
 │ /api/rpc/*           oRPC commands and queries -> execute() / query()                            │
 │ /api/files · /api/export/journal.xlsx · /api/inbound/email (shared secret)                       │
 │ /auth/v1/*           allowlisted proxy to Supabase Auth                                          │
 │ /healthz · /readyz   liveness; readiness = every committed migration applied                     │
 │ worker               outbox relay (LISTEN crove_outbox + 1 s poll) -> pg-boss -> jobs             │
 └──────┬────────────────────────────────────┬──────────────────────────┬──────────────────────────┘
        │ crove_app (API) · crove_worker      │ volume `files`           │ HTTPS (optional): any OpenAI-compatible endpoint
        ▼                                     ▼
 db (postgres:17): crove_kernel · crove_finance · crove_jobs · crove_meta (migration ledger) · auth (Supabase Auth)
 auth (supabase/gotrue, pinned): owns schema `auth`; email through SMTP (Mailpit locally)
 migrate (same image, role `migrate`): runs to completion before `auth` and `crove` start
 auth-grants (same image; ADR-0028, #22): after `auth` has created auth.sessions and
             auth.users, grants SELECT on them to crove_auth_reader and exits; `crove` then starts after it
```

**Crove Cloud (decided; built with MVP step 2, not deployed yet):**

```
 Browser (app.crove.com) ──► Cloud Run service crove-api (role api): SPA + /api/*; Bearer = access token from DOS's Supabase Auth
    │ @supabase/auth-js (PKCE) ──► DOS's Supabase Auth (accounts shared with DOS ID); the kernel verifies via JWKS
    │                               and checks a Crove session record fed by DOS ID lifecycle events (ADR-0028)
 Cloud Run worker pool crove-worker (role worker) · Cloud Run Job crove-migrate (role migrate)
 later: crove-extract sandbox (bytes in, JSON out; no secrets, no egress) · prober job · crove-stream (2b)
    ▼
 Dedicated Supabase project per environment (PG17, Singapore; prod with 7-day PITR): used as Postgres only
 GCS through the S3 API (files; archive WORM) · api.dos.ai (OpenAI-compatible) · later: DOS org sync (DOS-27)
```

**Other self-host shapes:** the same image on any container platform; any PostgreSQL 17 (PgBouncer in transaction mode, or direct connections at low load); `api` and `worker` as separate containers with `STORAGE=s3` (T7, `docker-compose.split.yml`); an external Supabase Auth through `AUTH_JWKS_URL` and `PUBLIC_AUTH_URL`; any OpenAI-compatible endpoint. By default it calls no DOS service.

**Hard rules:**
- The SPA is static files served by the kernel on the same origin. It holds no secrets, never touches the DB, and imports only `@crove/kernel-contract` and the oRPC client. Runtime config carries no secrets.
- Every write is an oRPC command through `execute()`; client route guards are UX only. The product app has no server-side code.
- Same origin, so CORS stays closed for `/api`.
- Next.js serves only the landing page (`apps/web`, on Vercel).

### 3.3 Connection budget and egress

The login roles below are the decided design. On `main` the API uses `crove_app` and the worker and pg-boss share `crove_worker` (§7.1). Ports are Supavisor's (Crove Cloud); self-host connects directly or through PgBouncer.

| Login role | Port | Used by | Client pool | `CONNECTION LIMIT` (incl. rollout headroom) | Timeouts |
|---|---|---|---|---|---|
| `crove_api` | :6543 tx | crove-api | 4 per instance × up to 4 | 24 | statement 5 s, lock 2 s, idle-in-tx 10 s |
| `crove_worker` | :6543 tx | worker kernel tx, relay, Jobs | 4, plus 1 per Job (<=2 Jobs) | 14 | statement 60 s, lock 2 s, idle-in-tx 10 s |
| `crove_queue` | :5432 session | pg-boss (pool 2 + LISTEN 1) and relay LISTEN | 4 | 8 | - |
| `crove_prober` | :6543 tx | prober | 1 | 2 | statement 5 s |
| `crove_stream` (2b) | :6543 tx | SSE polling, AI | 2 per instance | 10 | statement 5 s |
| `crove_api` LISTEN (#69) | :5432 session | the invalidation stream's `LISTEN crove_stream`, `DATABASE_LISTEN_URL` | 1 per API instance | counted in `crove_api` | - |

- **The stream's LISTEN connection (#69):** `LISTEN` needs a session connection; behind a transaction-mode pooler (PgBouncer in transaction mode, Supavisor :6543) the registration lands on a server connection the pooler hands to someone else, and notifications are lost. So `DATABASE_LISTEN_URL` must be a direct connection or a session-mode port (Supavisor :5432); unset, the API uses `DATABASE_URL`, which is right for self-host with direct connections. `NOTIFY` itself is transactional and works through any pooler. The stream's re-checks (one read transaction per open stream every `STREAM_RECHECK_SECONDS`, default 30) run in the API's ordinary pool, at most `STREAM_RECHECK_CONCURRENCY` (default 3) at once per process, so hint-triggered re-checks of many streams never take the pool from request traffic; the others wait their turn. The listener sends itself a `NOTIFY` every 30 s (and once before it reports ready) and drops the connection, closing every stream with `unavailable`, when it does not come back within 10 s; this catches a connection that is up but no longer delivers, such as one through a transaction-mode pooler (#281). The prober alerts when `pg_notification_queue_usage()` passes `PROBER_MAX_NOTIFY_QUEUE_PERCENT` (default 50).

- **Transaction-mode roles:** set LIMIT >= the `pool_size` Supavisor gives that role.
- **Session-mode roles:** count the full pool plus LISTEN connections, then double it for rollouts.
- **Total limit:** must stay below the Crove project's `max_connections`, minus Supabase's reserved share and an operations share (`migrate`, ops). Real numbers are fixed by the baseline after MVP step 2 (§12-E). Need more: scale compute, not limits.
- **Self-host:** no Supavisor; PgBouncer transaction mode (or direct connections at low load) with the same role and limit table. `main` opens pools of 10 per role.
- **Session state across checkouts (#117):** `@crove/db` resets each connection's session (`RESET ALL`, `RESET ROLE`, session advisory locks, cursors, `LISTEN`) before it goes back to its pool, so state one transaction leaves at session level (for example `set_config('crove.ctx', ..., false)`, which makes every later `enter_context` on that backend fail) never reaches the next checkout. That covers direct connections, so `DB_RESET_ON_RELEASE` defaults to `true` (self-host). Behind a transaction-mode pooler the reset reaches whichever server backend the pooler picks, so it buys nothing there: Crove Cloud behind Supavisor :6543 sets `DB_RESET_ON_RELEASE=false`, and the pooler's own reset governs. PgBouncer runs `server_reset_query` only in session mode unless `server_reset_query_always = 1`; what Supavisor resets in transaction mode is not verified yet (A5). Independently of the flag, a checkout whose query fails with `CONTEXT_REENTRY` or `CONTEXT_SEAL_INVALID` is tainted: its connection is closed instead of pooled and `[db] closing a pooled connection after <code>` is logged (alert on it); the runtime also logs `[alert] <code>` with the command or query name and the org and actor ids of the request that hit it (#105). On a direct connection that replaces a poisoned backend at no cost to clean checkouts; behind a transaction-mode pooler it closes only the client connection, not the pooler's server connection. Until A5 is answered, a compromised login role can deny service on the server backends it lands on, not read or write another org. Cost of the reset, measured in #117 on Docker Desktop for Windows (round trip about 0.6 ms): one round trip per checkout, off the caller's path; with a pool of 4, 8 callers and a 4-round-trip transaction, throughput fell by 15% to 21%. That is a worst case (tiny transactions, slow local round trips); real commands run more statements per checkout.
- **Read replicas (#105):** none are used. On a hot standby (PostgreSQL 17, probed in #105 against a streaming standby) advisory locks and `pg_locks` work during recovery, so `enter_context`, the re-entry guard (T10) and the sealed context (T11) behave as on the primary and `Runtime.query()` serves reads. Every write fails with SQLSTATE 25006, mapped to `INTERNAL` 500: commands, a session check that records a first-seen session (ADR-0028) and refusal audits. Sending reads to a replica later needs no guard change, only a read path that never writes. `apps/kernel/test/standby.db.test.ts` pins this; it runs only with `CROVE_TEST_STANDBY_URL` set, so CI skips it.
- **Egress:**
  - No NAT at first: DOS's Supabase Auth, DOS.AI, the DOS-Me broker (if used) and GCS all use default egress. The API never goes through NAT.
  - When a directly called provider requires an IP allowlist, set up `crove-nat-provider`: prod-only IP, FQDN allowlist, used only by the worker and Jobs.
  - Tenant-supplied URLs (Phase 3+) take the default path through the SSRF guard (§7.7), never the allowlisted IP.
  - Private Google Access enabled on the subnet.
- **Secrets:**
  - Each secret has exactly one source of truth; cross-project reads go through IAM.
  - Per deployment: login-role passwords (set by `migrate` from the environment), `AUTH_JWT_SECRET` (self-host, HS256; Cloud uses JWKS and holds no Auth secret), `INBOUND_SECRET`, the AI key, S3 credentials, and later `context_key` (in the DB, readable only by `crove_ctx`).
  - Cloud: Secret Manager of `crove-prod`/`crove-beta`. Self-host: environment variables or its own secret store. `config.ts` refuses the sample secrets and `AUTH_AUTOCONFIRM=true` on a non-local `PUBLIC_URL` (implemented).
  - When DOS org sync is enabled (later): the prod internal key for DOS-27 reconcile is readable only by the `crove-prod` worker SA; beta uses its own beta key.

### 3.4 Environments

| | Local / agent sandbox | CI | Self-host | Crove Cloud beta | Crove Cloud prod |
|---|---|---|---|---|---|
| Git ref | worktree | PR, `main` | a release tag | `dev` (created with Cloud beta) | `main` |
| DB | `docker compose up` (postgres:17), or a local PG17 for `pnpm dev`; `pnpm db:migrate` | PG17 service container; the `db` test project applies migrations with the built-in runner | any PostgreSQL 17 (bundled in compose) | dedicated Supabase project (beta) | dedicated Supabase project (prod, 7-day PITR) |
| Kernel | `pnpm dev` (kernel + Vite dev server proxying `/api` and `/auth`), or compose role `all` | hermetic tests | compose role `all`, or `api` + `worker` containers on S3 (`docker-compose.split.yml`, T7) | Cloud Run `api` service + `worker` pool + `migrate` job | same |
| SPA | Vite dev server | `vite build` | served by the kernel | served by the kernel (`beta-app.crove.com`) | served by the kernel (`app.crove.com`) |
| Auth | bundled Supabase Auth + Mailpit | test-signed tokens from `@crove/testing` (planned; `main` tests the config guards and the `/auth/v1` proxy) | bundled Supabase Auth with real SMTP and `AUTH_AUTOCONFIRM=false`, or any Supabase Auth via `AUTH_JWKS_URL` | DOS's Supabase Auth (beta) | DOS's Supabase Auth (prod) |
| AI / files | optional AI endpoint; local disk | no AI (XML path); local disk | any OpenAI-compatible endpoint; local disk or S3-compatible | beta gateway; `crove-*-beta` | `api.dos.ai`; `crove-*-prod` |

- No per-PR preview environment before Phase 3.
- Crove Cloud project refs, keys and domains live only in `crove-cloud`.
- **Self-host** is configured through environment variables (`.env.example`: `PUBLIC_URL`, database passwords, Supabase Auth secret and SMTP, AI endpoint, inbound email). By default it calls no DOS service.
- Domains: `crove.com` for the landing page, `app.crove.com` for Crove Cloud (ADR-0027 decision 5); the API shares the app's origin, so there is no `api.crove.com`.

### 3.5 Deploy order and upgrades

**Self-host (implemented):**
1. Pull or build the new image.
2. `migrate` runs first. The built-in runner takes an advisory lock, applies each new file in its own transaction, records version and sha256 in `crove_meta.schema_migrations`, and refuses a file that was edited after it was applied. It then sets role passwords. Compose starts `auth` and `crove` only after `migrate` completes.
3. Per ADR-0028 (on `main` since #22): after `auth` starts, the one-shot `auth-grants` role waits until Supabase Auth has created `auth.sessions` and `auth.users`, grants SELECT on them to `crove_auth_reader` and exits; it connects with `ADMIN_DATABASE_URL`, like `migrate`, because only the `auth` table owner or a superuser can grant on them. Compose starts `crove` only after it completes. It reruns on every `docker compose up`. Installs without compose run `auth-grants` after Supabase Auth's first start and after each Supabase Auth upgrade; until then requests get 503 and `/readyz` reports `auth_grants`.
4. `crove` starts; `/readyz` returns 503 until every committed migration is in the ledger.
5. With split roles: `migrate`, Supabase Auth, `auth-grants`, then `worker`, then `api`.

**Crove Cloud (decided; built with MVP step 2, issue #56).** CI gates run in the core repo. Deploy workflows live in `crove-cloud`; they trigger on a new core commit and always check out that exact SHA.

1. **PR -> `dev`.** Today PRs merge to `main`; the `dev` branch is created when Cloud beta exists. The agent squash-merges when the required checks are green. PRs touching protected paths also need the invariant suite from base and a security reviewer agent (Decision 7, §10); there is no owner approval label.
2. **`dev` -> beta** (`deploy-beta`, WIF can only reach `crove-beta`):
   1. Run the `crove-migrate` Job against the beta DB.
   2. Build `crove-kernel:<sha>`; the image carries every migration file, which is the schema manifest.
   3. **Deploy the worker first** (`--no-promote`, then split). The worker waits until no committed migration is missing, up to 30 minutes, before consuming. The startup probe calls only `/healthz`.
   4. Deploy the API with `--no-traffic --tag candidate`. Poll the tag's `/readyz`: schema complete and worker build >= API build. When it passes, shift 100% of traffic.
   5. CI runs the Playwright smoke tests.
3. **`dev` -> `main`** (scheduled promote PR, e.g. Tuesday and Thursday, merge commit):
   1. Pre-merge check: no pending migration has a version <= the max in the prod ledger (read via prod `/version`). Hotfix PRs to `main` contain no migrations; migrations always go through `dev`.
   2. If there is DDL on a hot table or a pg-boss upgrade: open a **promote window**. Scale the worker to 0, pause exports. The API doesn't touch pg-boss, so it keeps serving.
   3. Run the `crove-migrate` Job against prod.
   4. `deploy-prod` (WIF only from `main` and the `crove-prod` environment; owner 1-click approval recommended): worker -> API candidate -> `/readyz` -> tag smoke -> traffic shift.
   5. `release-gate` waits for `/version` to contain the last commit touching **the same glob set as the trigger** (`apps/**`, `packages/**`, `modules/**`, `supabase/**`), then writes a commit status on the core repo.
4. **Rollback:** API first, worker second, so the worker is always >= the API. Schema never rolls back; fix forward only.
5. **Contract changes (DROP/RENAME/type change):** a separate PR, starting with `-- crove:contract adr=<id>`. Merge only once the commit removing every reference is already on `main`.
6. **Migration ordering (Crove's own ledger):**
   - Never edit or rename a migration that has reached the default branch; the runner refuses an edited file.
   - A new version must be greater than the max on the default branch (G2). If parallel sessions overtake a file's timestamp: `pnpm db:retime`.

On `main` today (2026-10-23), `/readyz` checks the schema, the pg-boss schema version (T6) and, with `AUTH_SESSION_CHECK=db`, that `auth-grants` ran; `GET /version` (#898, #892) reports the build (`CROVE_BUILD`) and the committed migrations missing from the ledger, and the pilot deploy's smoke test checks it. The worker-build check (worker build >= API build) is not implemented.

### 3.6 Cells: control plane and tenant data (Decision 14)

Crove runs on one PostgreSQL database. Decision 14 keeps it cheap to move tenants to another database (a cell) later, so the split is drawn now and enforced at one seam.

**The seam (#45).** `@crove/db` exports a `CellResolver`: `resolveTenant(orgId)` returns the database that holds that org's tenant data, `controlPlane()` the control-plane database. `Runtime` opens every tenant transaction on `resolveTenant(orgId)`: `execute()`, `query()` and the refusal audit's own transaction. Every org-less path opens on `controlPlane()`: `executeOrgless()` (creating an org), `forUser()` (a signed-in user's org-less reads such as `my_orgs` and the invite preview) and `orgless()` (inbound mail routing). No other code opens a tenant transaction (one write path, §4.4). Today `singleCell(db)` returns the same database for both, so nothing changes at runtime. A multi-cell resolver looks the org's cell up in the tenant directory (cached) without changing any caller; `resolveTenant` is async for that reason. `packages/kernel-runtime/test/cells.test.ts` checks that each path calls the resolver it should.

**Control plane** (one per deployment):
- Identity: `user_account`.
- Sessions: `auth_session` (a user's own sessions, across orgs).
- The per-client email budget in front of Supabase Auth: `auth_email_send` (#190).
- Tenant directory: which orgs exist, their status and, with more than one cell, their cell. Today `tenant` plays two roles: it is the directory entry and also the org's profile and the foreign-key anchor of every tenant table, which stay with the org's cell. A split keeps `tenant` in the cell and adds a directory row (org id, cell, status) to the control plane. Inbound mail routing belongs here too: `inbound_address` (every token ever issued, unique across orgs; it has `org_id` and tenant RLS, but routing needs it in one place) and `inbound_pending` (mail received before its org is known).
- Staff (§4.12, not built yet): `staff`, `kill_switch`.

**Tenant data** (lives in the org's cell and moves with it): every table with `org_id` except `inbound_address` and `outbox_pending`: `tenant_member`, `member_invite`, `auth_session_org`, `idempotency_key`, `outbox_event`, `audit_event`, `party`, `file`, `inbound_message`, `extraction`, `proposal`, `activity`, and every module table (`crove_finance.purchase_document`, `purchase_line`, `journal_entry`, `journal_line`, `vendor_account_rule`). New tenant tables follow §6.

**Per database** (each cell has its own copy): the migration ledger, `context_key`, `outbox_pending` (its rows carry `org_id` and move with the org), `worker_heartbeat` and global reference tables such as `crove_finance.account`, seeded by migrations.

**Membership (decision).** `tenant_member` is tenant data: the authoritative membership lives in the org's cell, where `enter_context`, approval eligibility and the member commands read it inside the tenant transaction. The control plane gets a projection, user to orgs, for org-less reads (`my_orgs`, the invite preview) and for routing a request to its cell. The projection is built when the second cell is: until then `my_orgs` reads `tenant_member` directly, which is correct on one database. Once built, the commands that change membership (create org, accept invite, remove member) update it through the outbox.

**The join rule.** A tenant transaction reads and writes only its org's tenant data and the per-database tables. It reaches control-plane tables only through `SECURITY DEFINER` functions (`enter_context`, `session_check`, `create_or_replay_org`, `invite_accept`, `member_profiles` and the like), which a multi-cell setup can reimplement as a call to the control plane or a read of a cell-local copy without changing their callers. Org-less paths reach tenant data only through definers too (`my_orgs`, `org_by_inbound_token`). New code follows the rule; a reviewer refuses a direct join, and the invariant test `apps/kernel/test/invariant/control-plane-reads.test.ts` fails when a source under `apps/*/src`, `modules` or `packages` names a control-plane table (`user_account`, `auth_session`, `inbound_address`, `inbound_pending`, `auth_email_send`) in Kysely or raw SQL. `user_account` also has no Kysely type, so a direct `selectFrom` does not compile.

**Member names and emails (#169).** Tenant code reads `user_account` only through `crove_kernel.member_profiles(user_ids uuid[])`: id, email and display name of those users who are members of the org in the sealed context (`ctx_org_id()`), nobody else; no context returns nothing, a forged one is refused, and only `crove_app` may call it. `kernel.org.get`, the pending invite list, the already-a-member check of `kernel.member.invite.create` and the member commands use it (`packages/kernel/src/profiles.ts`). Since step 2 (#222) the database enforces the rule too: no Crove role holds any privilege on `user_account` and the table has RLS enabled with no policy, so a direct read is `permission denied` with or without a context (`kernel-invariants.db.test.ts`, `sealed-context.db.test.ts`). Every function that reads it is a definer owned by the migration runner, or runs only inside one. With a second cell, `member_profiles` becomes a call to the control plane; its callers do not change.

**Identity foreign keys (decision, #169).** Tenant tables reference `user_account`: `tenant.created_by`, `tenant_member.user_id`, `member_invite.invited_by`, `accepted_by` and `revoked_by`, `auth_session_org.user_id` and `revoked_by`, `mail_message.created_by`, `mail_suppression.created_by` and `lifted_by` (#538). On one database these keys are correct and stay. When the second cell is built, each cell gets an id-only anchor, `crove_kernel.user_ref (id uuid PRIMARY KEY)` with no email, name or subject, and the same migration moves these keys to it. The definers that bring a user into a cell (`create_or_replay_org`, `invite_accept`) insert the user's id there before the row that references it, and `member_profiles` keeps serving names and emails from the control plane. Rejected: dropping the keys (a membership or invite could name a user id that never existed, and nothing in the cell would notice); a full cell-local copy of `user_account` (personal data in every cell, a sync for every email or name change, and erasure under PDPL in more than one place).

**Known exception on `main`** (fix before a second cell): inbound routing is coupled the other way: the active token lives on `tenant.inbound_token` in the cell, triggers on `tenant` (`tenant_pick_inbound_token`, `tenant_register_inbound_token`) write `inbound_address` directly, `inbound_address.org_id` references `tenant`, and `org_by_inbound_token` joins the two; a split moves the active token to the control plane or writes `inbound_address` through the control plane.

**Org creation** opens on the control plane, because there is no org to resolve yet, and creates the org's tenant rows in the same transaction, so a new org starts in the control plane's cell. Moving it to another cell is a separate operation, designed with the second cell. A refused replay of org creation into an org that already exists writes its refusal audit through `resolveTenant(orgId)`, which on one database is the same connection target.

**Worker machinery** (outbox and inbound claims, the heartbeat) uses the worker's own connection to today's single database. With more cells it runs once per cell, and inbound claims run on the control plane.

## 4. Kernel

### 4.1 Layers

```
Supabase Auth (self-host: bundled in compose; Crove Cloud: DOS's Supabase Auth)
   ▼ access token verified locally on every request, session status checked in the request transaction (ADR-0028); (issuer, subject) -> user_account; no FKs (§7.3)
@crove/kernel-runtime  machinery in crove_kernel, including user_account and org membership (tenant, tenant_member)
   ▲ only through the public API: define*, implement, ctx (enforced by dependency-cruiser, including for @crove/kernel)
@crove/kernel          kernel MODULE (schema crove_kernel, role crove_m_kernel)
   ▲
@crove/mod-<id>        schema crove_<id>, role crove_m_<id>
```

Later, Crove Cloud only: a DOS org sync adapter in `crove-cloud` projects DOS org membership into `tenant_member` (§7.3, deferred).

### 4.2 define* functions

```ts
// modules/finance/contract/commands.ts: isomorphic (zod + @crove/kernel-contract only)
export const postJournalEntry = defineCommand({
  name: 'finance.journal_entry.post', version: 1,
  input:  z.strictObject({ draft_id: zId('finance.journal_draft'), posting_date: zLocalDate }),
  output: z.strictObject({ entry_id: zId('finance.journal_entry'), entry_no: z.string() }),
  permission: 'finance.journal_entry.post', entitlement: 'finance.ledger',
  sideEffect: 'financial', risk: 'R3',         // declared risk < derived risk => boot/CI fails
  scope: 'legal_entity', idempotency: 'required',
  target: { kind: 'update', ref: (i) => ({ type: 'finance.journal_draft', id: i.draft_id }) },
  emits: [JournalEntryPosted], enqueues: [],
  ai: { expose: true, description: '…', examples: fixtures.finance.postJournalEntry }, // synthetic fixtures only
});
// modules/finance/commands/journal_entry.post.ts: server, the ONLY place this handler lives
export default implement(postJournalEntry, {
  policyFacts: (input, ctx) => ({ amount, currency: 'VND', counterparty_verified, payee_changed: false }),
  handler: async (ctx, input) => { /* DB work only, via ctx */ },
});
```

| API | Key points |
|---|---|
| `defineQuery` | `permission`; `sensitive` (audit before read); `pagination:'cursor'`; `ai.expose` |
| `defineEvent` | Name `<id>.<entity>.<past tense>` + `version`; `visibility: internal\|integration`; `upcastFrom`; JSON Schema snapshot |
| `defineSubscriber` | `on: 'hr.payroll_run.approved@1'`; `ordering: per_subject\|none`; idempotent by event id |
| `defineJob` | `retry`, `timeout`, `fairness:'org'`, `orderingKey` (the kernel adds the org prefix), `egress: none\|provider:<x>\|tenant_url`; runs as the actor that enqueued it |
| `defineSchedule` | cron + `tz:'Asia/Ho_Chi_Minh'`; `perOrg` with per-org jitter |
| `defineProcess` | State transitions are pure functions; timers are job intents; waiting on a human is a proposal |
| `defineModule` | Manifest (§5.2) |

**Handler context:**

| Member | Purpose |
|---|---|
| `ctx.actor`, `ctx.org`, `ctx.legalEntityId` | Who is acting, in which org and legal entity |
| `ctx.commandId`, `ctx.correlationId`, `ctx.causationId`, `ctx.via` | Command identity and provenance |
| `ctx.db` | Kysely, narrowed with `$pickTables` |
| `ctx.clock`, `ctx.ids` | Injected clock; id generation |
| `ctx.emit`, `ctx.enqueue` | Write to the outbox via a definer |
| `ctx.records`, `ctx.timeline`, `ctx.files`, `ctx.numbering` | Kernel services |
| `ctx.query` | Another module's public queries; RBAC re-checked |
| `ctx.inbox.raise`, `ctx.authorize` | Raise an Inbox item; record-level permission check |

**Rules:**
- One command per file.
- Handlers do no network I/O; lint bans `fetch` and SDK clients in `commands/**`.
- Input is always `z.strictObject`; contracts are plain JSON, no transforms.
- The registry is `modules.generated.ts`, statically imported.
- Boot fails on any of:
  - duplicate names;
  - a key missing from the catalog;
  - `ai.expose` without a description or examples;
  - an R2/R3 command sharing a permission with an R0/R1 command;
  - declared risk lower than derived risk;
  - incomplete schema.

### 4.3 Actors

| Kind | Identity | Source | Effective permissions | Constraints |
|---|---|---|---|---|
| `user` | user_id, session_id, aal | Supabase Auth access token, verified by the kernel on every request (issuer, audience and expiry required; session status checked per ADR-0028) | Membership gate (`tenant_member`) + Crove `role_assignment` | Enters via `crove_api`; in the worker only via an approved proposal |
| `agent` | agent_id, run_id, position (read from `position` at entry), on_behalf_of, grant_id, kind | In-process; MCP via OAuth (Phase 3) | Position-holding agent: position role ∩ template ceiling ∩ `max_risk` ∩ trigger class ∩ scope ∩ taint (ADR-0029). Chat-invoked: user ∩ grant ∩ trigger class ∩ scope ∩ taint | Chat/MCP enter via api; background runs enter via the worker with a run ref |
| `api_key` (Phase 3) | key id, created_by | Bearer, stored as sha256 | Key role ∩ the creator's **current** permissions | Expires in <=90 days; never R3; auto-disabled when the creator leaves the org |
| `automation` (Phase 4) | id, version, owner | Scheduler / subscriber | Grant within the owner's permissions, re-checked on every run | Causal depth <=5 |
| `system` | component | Worker only | `allowSystem` commands; kernel-enqueued jobs | R3 only with an approval verified in the DB (P13) |
| `staff` | staff user id (allowlist `crove_kernel.staff`), aal2 | `crove-ops` job via a protected workflow | `staff.*`: flags, entitlement overrides, kill switches, diagnostics | Touches tenant data only with an unexpired owner-issued `support_grant`; no impersonation |

### 4.4 The `execute()` pipeline (identical on every surface)

| # | Step | Error |
|---|---|---|
| 0 | <ul><li>Verify the Supabase access token locally (`iss`, `aud`, `exp`, `sub`, `session_id` required). The session status is checked inside the step 3 transaction (ADR-0028, design C: the Crove `auth_session` record, plus `auth.sessions` in self-host; on Crove Cloud the verified token until its `exp`, with R3 confirmed live; fail closed).</li><li>Rate limit by IP and actor **before** any DB write. On `main` since #162: per signed-in user, after the token is verified and before any command or query runs, an in-process token bucket per API instance (`API_RATE_LIMIT_PER_MINUTE`, default 600, `0` off) answers 429 `RATE_LIMITED` with `Retry-After`; the only earlier write is the identity mapping on a cache miss (once per user and process every 5 minutes). Memory is bounded: only buckets that are full again are dropped, and while every tracked key is still spending a new key gets 429 rather than resetting anyone's bucket. It holds per instance, so a multi-instance deployment adds a shared limit at its edge (proxy, CDN or WAF) or a shared store; per-IP limits are left to that edge and, for `/auth/v1`, to Supabase Auth.</li><li>Org comes from `X-Crove-Org` (the org slug) or the binding, never from claims or tool parameters.</li></ul> | 401/429/503 |
| 1 | Look up the command; check surface and kill switch | 404/503 |
| 2 | Strict zod parse | 422 |
| 3 | <ul><li>`BEGIN`; `enter_context(...)`; `SET LOCAL ROLE crove_m_<id>`.</li><li>A rejection before membership is established writes a `security_event` (per caller, sampled, with TTL), not the target org's audit. Built in #1006: `crove_kernel.security_event_note()` counts each refusal before the context is entered (commands, org-less commands whose new org rolled back, queries and streams) in one-hour windows, at most 20 rows naming a target org per caller per window and one overflow row per (command, code) past that; the worker prunes windows older than 30 days; no role reads the table.</li></ul> | 403 |
| 4 | Entitlement + abuse limits | 402/429 |
| 5 | <ul><li>RBAC within scope.</li><li>Agents: intersect with grant, trigger class and taint.</li></ul> | 403 |
| 6 | <ul><li>Claim idempotency, or replay if already claimed.</li><li>This step comes **before** the version check, so a retry never gets a 409.</li></ul> | replay/422/409 |
| 7 | Lock `record`; record-level permission check; check `expected_version` | 404/409 |
| 8 | <ul><li>Policy returns allow, review or deny.</li><li>Review: write `proposal` + `inbox_item` + a `pending_approval` audit, COMMIT, return 202.</li></ul> | 403 |
| 9 | Handler (DB only) | `DomainError` |
| 10 | Kernel inline projections | rollback |
| 11 | Quota (once `usage_counter` exists) | 402/429 |
| 12 | Outbox, audit and idempotency result, all via definers that stamp from the context | - |
| 13 | COMMIT; trigger `NOTIFY crove_outbox` | 409 (retryable) |
| 14 | <ul><li>ROLLBACK.</li><li>Write the denied/failed audit in a new short transaction, only if membership was established.</li><li>Map the error.</li></ul> | - |

**Modes:**
- **Dry-run:** run steps 0-12, then ROLLBACK and return the diff.
- **Post-approval execution:** runs as the approver (actor), carrying `requested_by` and `proposal_id`.
- **Query:** run steps 0-7 in `READ ONLY`. With `sensitive:true`, the audit is committed first in its own transaction; if the audit write fails, nothing is read.
- **`ctx.query`:** re-runs step 5 with the callee's permission; returns a typed `not_permitted` result.

### 4.5 Context and RLS

`@crove/db` has 3 wrappers: `withTenantTx`, `withTenantReadTx` (`BEGIN READ ONLY`) and `withSystemTx`. Only `@crove/kernel-runtime` calls them. Login roles have no table grants, so a query outside a wrapper fails with `permission denied`.

On `main`: `crove_kernel.enter_context(user_id, org_id)` checks that the user is a member of an active tenant and sets `crove.org_id` and `crove.user_id` as transaction-local settings; `enter_system_context(org_id)` does the same for system work. Since #103 (T10) both start with the re-entry guard of item 1 and raise `CONTEXT_REENTRY` on a second entry in the same transaction. Since T11 (#73) they no longer set `crove.org_id` and `crove.user_id`: they write the whole context as JSON to `crove.ctx` and its HMAC to `crove.ctx_seal` (item 5), and every `ctx_*` helper reads the context only through the single check `ctx_verified()`. There is no actor-to-`session_user` binding for user actors yet, and the login roles are members of `crove_tenant` with table grants. Since #78 (T5) only `crove_worker` may execute `enter_system_context`, which also checks `session_user`, and only `crove_app` may execute `enter_context`. The rest of this section is the decided design, including the ADR-0028 checks in item 3; External-tenant gate rows T1, T5, T10 and T11 track the gaps.

```sql
BEGIN;                                          -- BEGIN READ ONLY for queries
SELECT crove_kernel.enter_context($1::jsonb);   -- login crove_api | crove_worker
SET LOCAL ROLE crove_m_finance;                 -- member of crove_tenant
-- handler (ctx.db = $pickTables)
COMMIT;
```

**`crove_kernel.enter_context`** (owner `crove_ctx`, `SET search_path = pg_catalog, pg_temp`, EXECUTE granted only to `crove_api` and `crove_worker`):
1. **Block re-entry within the same transaction.** PostgreSQL advisory locks are re-entrant: "If a session already holds a given advisory lock, additional requests by it will always succeed, even if other sessions are awaiting the lock; this statement is true regardless of whether the existing lock hold and new request are at session level or transaction level" ([PostgreSQL 17, §13.3.5](https://www.postgresql.org/docs/17/explicit-locking.html#ADVISORY-LOCKS)). Taking a lock alone therefore never blocks a second `enter_context`. The definer does two steps, in this order:
   1. **Check:** if `pg_catalog.pg_locks` shows the context lock already held by this backend (`locktype = 'advisory'`, `classid` = Crove's context namespace constant, `objid = pg_backend_pid()`, `objsubid = 2`, `pid = pg_backend_pid()`, `granted`), raise `CONTEXT_REENTRY` (SQLSTATE 42501).
   2. **Take:** `pg_try_advisory_xact_lock(<namespace>, pg_backend_pid())`, raising `CONTEXT_REENTRY` when it returns false. The key includes the backend pid, so sessions never contend; a key held by another backend fails closed at once instead of waiting.

   Why this holds: a transaction-level advisory lock has no unlock call (`pg_advisory_unlock` and `pg_advisory_unlock_all` release only session-level locks) and lasts until the transaction ends; it works in READ ONLY transactions. A marker in a setting would not hold on its own, because a login role can reset any custom setting with `set_config`; the definer still refuses when a valid `crove.ctx_seal` for the current transaction is present, as defense in depth (on `main` since T11 it refuses when `crove.ctx` or `crove.ctx_seal` is set at all, valid or not, and still when the retired `crove.org_id` or `crove.user_id` is set). A session-level lock taken earlier on the same key makes `enter_context` fail closed; `@crove/db` drops session-level advisory locks before a connection goes back to its pool, and with that reset off closes a connection whose checkout hit `CONTEXT_REENTRY` (#117, §3.3; tested for this lock in #105). Advisory locks and `pg_locks` work during recovery, so the guard behaves the same on a hot standby (#105, §3.3). `ROLLBACK TO SAVEPOINT` that undoes the first `enter_context` also releases its lock and reverts its settings, so the next call is a clean first entry. Reading `pg_locks` calls `pg_lock_status()`, which takes every lock-manager partition lock and every backend's fast-path lock in shared mode and copies the whole lock table.

   **Cost (measured in #105** with `apps/kernel/test/context-cost.db.test.ts`, PostgreSQL 17.11 in Docker with 48 vCPUs, against the same guard without the read):
   - The read adds about 13 us per entry with an idle lock table, plus about 0.27 us per lock held server-wide: about 0.3 ms at 1,000 held locks and 1.1 ms at 4,000.
   - It serializes: in a server-side loop without round trips, entries top out near 50,000/s server-wide at 8 or 32 connections (650,000/s without the read at 32), 17,000/s at 1,000 held locks and 8,000/s at 4,000.
   - A request-shaped transaction over a 0.8 ms round trip barely moves with an idle lock table (p95 at 32 connections 9.1 ms against 8.0 ms) and gains about 1.7 ms at p50 with 4,000 held locks.

   That is far inside the Phase 1 budget (p95 R1 command < 150 ms) at the planned request rates, so the read stays; the Phase 1 load test re-checked it with real lock counts (#1010: 230 locks at p95, about 75 µs per entry against a command p95 of 15.8 ms). No cheaper marker holds (evaluated in #105):
   - the sealed context alone: the caller can empty `crove.ctx` and `crove.ctx_seal` with `set_config` before a second entry;
   - a row in a definer-owned (also UNLOGGED) table: not writable in a READ ONLY transaction or on a standby;
   - a definer-owned temporary table: needs DDL at runtime and TEMP (revoked, T17), cannot be created in a READ ONLY transaction, and the caller's `DISCARD TEMP` drops it in the middle of the transaction;
   - a sequence: cannot advance in a READ ONLY transaction;
   - no SQL function says whether this session already holds a lock: the advisory lock functions return true for a re-entrant hold.

   If the load test shows contention, the options are an owner decision: a C extension that exposes the lock manager's already-held result (not available on managed PostgreSQL), or relaxing T10 to the seal check.

   **Negative tests** (CI `db` project; External-tenant gate T10):
   - `enter_context` twice in one read-write transaction: the second call raises `CONTEXT_REENTRY`, with the same or a different org or actor.
   - The same inside `BEGIN READ ONLY`.
   - `enter_context`, `SAVEPOINT`, `enter_context`: raises. `SAVEPOINT`, `enter_context`, `RELEASE SAVEPOINT`, `enter_context`: raises.
   - `enter_context`, then `pg_advisory_unlock(...)`, `pg_advisory_unlock_all()` and resetting `crove.ctx`/`crove.ctx_seal` with `set_config`, then `enter_context`: still raises.
   - `SAVEPOINT`, `enter_context`, `ROLLBACK TO SAVEPOINT`: the context settings are empty and the helpers return NULL; a new `enter_context` succeeds.
   - A session-level `pg_advisory_lock` on the same key taken before `enter_context`: raises (fail closed).
   - The next transaction on the same pooled connection enters normally; two sessions entering at the same moment do not block each other.

   The single-session cases above were checked on PostgreSQL 17 with a prototype of this function on 2026-10-14. Since #103 all of them run in the CI `db` job (`apps/kernel/test/context.db.test.ts`), the concurrency case with two clients.
2. **Bind the actor kind to `session_user`:**
   - `crove_api` may only use `user`, `agent` (chat/MCP) and `api_key`.
   - `crove_worker` may use `system`, `automation` and background `agent`.
   - Any other actor in the worker enters only via a job ref (`outbox_event.id`), an approved proposal, or, for a position-holding agent, a live `ai_run` ref (ADR-0029). The function re-reads these references from the DB and does not trust parameters.
3. **Check tenant and actor:** the tenant must be `active`. Actors are checked directly against the DB, never against cached data:
   - user: not disabled in Crove (`user_account.disabled_at`, ADR-0028); the Crove session record (`auth_session`) is not revoked and its upstream status is valid (self-host: the `auth.sessions` row exists, `not_after` is in the future, and the user is not banned or deleted; Crove Cloud: the token is within its `exp`, and R3 is confirmed live with Supabase Auth); a `tenant_member` row exists (with DOS org sync, later: within its confirmation TTL, §7.3);
   - grant: unexpired, and the grantor is still a member;
   - key: still valid, and the creator is still a member.
   - position-holding agent (ADR-0029): `active`, still the holder of an `active` position, the run is live, and no budget hard stop or kill switch applies; permissions come from `position.role_key`, not from `tenant_member`.
4. **Derive:** org role, legal-entity scope (an explicit list or the explicit value `'*'`), sensitivity flags, and the membership fingerprint.
5. **Write the context and seal it:**
   - `crove.ctx` is the canonical JSON of the **entire** context: org, actor, user, le_scope, flags, command_id, ai_run_id, trace_id.
   - `crove.ctx_seal = extensions.hmac(ctx ‖ pg_backend_pid() ‖ transaction_timestamp(), context_key)`.
   - On `main` (T11, #73): `crove.ctx` holds `v`, `org`, `actor` (`user` or `system`), `user`, `role`, `le_scope` (the explicit `['*']` until legal entities exist, §4.6) and `flags` (empty until sensitivity flags exist). The seal is HMAC-SHA256 built from the core `sha256()` (no pgcrypto, so the schema runs on any PostgreSQL 17) over `'crove.ctx.v1'`, `pg_backend_pid()`, the transaction start in microseconds and the exact stored text of `crove.ctx`. The key is 32 random bytes in `crove_kernel.context_key`, generated by the migration, owned by the migration runner (the owner of the definers), with no grant to any role and RLS on without a policy; it is stored as the HMAC inner and outer padded keys. Only `ctx_write()` and `ctx_mac()`, which no role may execute, produce a seal; they run inside `enter_context` and `enter_system_context` as their owner. A context table was rejected: a READ ONLY transaction cannot write it, even from a definer. Not in the context yet: `command_id`, `ai_run_id`, `trace_id`.
   - Set per-role timeouts.
6. Return the derived context to TypeScript.

**Helpers `ctx_org_id()`, `ctx_user_id()`, `ctx_le_scope()`, `ctx_has_flag()`:**
- STABLE SECURITY DEFINER, called as `(SELECT …)` so they run once per statement.
- Every call checks both the seal and current access. Wrong or missing means NULL, i.e. 0 rows and `WITH CHECK` fails.
- On `main` (T11, #73): the helpers are `ctx_org_id()`, `ctx_user_id()`, `ctx_actor_type()`, `ctx_le_scope()`, `ctx_le_allowed(uuid)` and `ctx_has_flag(text)`, all STABLE and all reading through `ctx_verified()`, the one STABLE SECURITY DEFINER function that reads the key and checks the seal. No context at all (both settings empty) gives NULL: 0 rows, `WITH CHECK` fails, definers raise `NO_CONTEXT`. A context or seal that is present but does not verify (edited, forged without `enter_context`, replayed from another transaction or connection, half reset) raises `CONTEXT_SEAL_INVALID` (42501) instead of returning NULL, so the statement fails closed and loudly; the runtime maps it to `INTERNAL` 500. The verified result is not cached, since a cache would itself be a writable setting: a check is one lookup in a one-row table and two `sha256()` calls per helper per statement. Not done yet: the per-call check of current access (membership is checked at `enter_context` only).
- A missing `le_scope` means deny, not "everything".

**Other rules:**
- The `search_path` of every login role is `pg_catalog, pg_temp`. Every function call is schema-qualified, extensions included (`extensions.unaccent(...)`, `OPERATOR(extensions.%)`).
- Lint bans `set_config`, `SET`, `RESET ROLE` and `sql.raw` outside `packages/db/src/context/**`.
- Repositories still write `WHERE org_id = $ctx` explicitly.
- **Per-pool type parsers:** numeric, int8 and date -> string; timestamptz -> `Date`; json -> parsed. Round-trip test against Kanel.
- **Org-less commands:** `kernel.me.orgs` uses `my_orgs()`, taking the user from the verified access token. `kernel.org.create` runs through `execute()` in an org-less mode: a definer creates the tenant and the owner membership, and the audit row is written in the same transaction (External-tenant gate T4, on `main` since #96: `Runtime.executeOrgless()` lets the definer `create_or_replay_org` create the org, then enters it as the caller like any command, so no way to enter an arbitrary org is added; a deferred trigger refuses a tenant without its audit row). With DOS org sync (later), linking a tenant to a DOS org requires the user to be that org's owner, checked against the DOS-Me API, not claims.

### 4.6 Authorization

- **Membership gate:** `crove_kernel.tenant_member`, managed in Crove through audited commands (§7.3), read directly in `enter_context`. With DOS org sync (later), DOS roles map only to Crove's base role (`member`).
- **Privileged Crove permissions come only from a `role_assignment` granted by a Crove owner:** finance/hr admin, R3 approval, policy editing, role and key management. The one exception is R3 approval, which the `owner` and `admin` base roles also hold (current policy below). The user who creates the org gets the Crove `owner` role (with DOS org sync, later: the DOS org owner who links the tenant). On `main` (current policy, since #1279): the base roles of `tenant_member.role` (`owner`, `admin`, `member`, `viewer`) plus role assignments; R3 approval is open to `owner` and `admin` and to a member holding `finance.proposal.approve` through an org-wide assignment (`finance.chief_accountant`), who may also unlock a period (ADR-0021). Per proposal, the eligible approvers are the holders of those roles or that permission when the proposal is created, re-checked live at approval (P12, #75; the check lives in `packages/kernel/src/approval.ts`); an entity-scoped assignment grants no permission until proposals carry `legal_entity_id`. Historical: before #1279 the base role was the only role model and R3 approval was limited to `owner` and `admin`, the roles that may post (#71; External-tenant gate T2). Also since #1279: `enter_context` derives `le_scope` from the assignments (owners and admins `*`; a member or viewer whose every assignment names a legal entity gets exactly those entities, anyone else `*`), and a revoke or grant that would widen it is refused; a role that grants a permission is never given to a `viewer`, and a viewer holds none; every check reads the assignments in the command's transaction, so a revoke applies from the next command (no permission cache is built).
- **Built-in roles:** `owner`, `admin`, `member`, `viewer`, `finance.chief_accountant`, `finance.accountant`, `finance.viewer`, `crm.sales`, `desk.agent`, `hr.manager`, `external_accountant` (scoped to legal entities), `team_lead` (when teams exist; DOS teams in Cloud need DOS-5). Custom roles are permission sets drawn from the registry.
- **Revocation through membership:** `role_assignment` has FK `(org_id, user_id)` -> `crove_kernel.tenant_member ON DELETE CASCADE`; removing a member (or, with DOS org sync, a leave-org event or reconcile) deletes the `tenant_member` row.
- **Permission cache (planned, not built):**
  - Today there is none: every check reads `tenant_member` and `role_assignment` in the command's transaction (#1279), so a downgrade takes effect from the very next command (tested).
  - If one is added later: keyed on `(org, actor, membership_fingerprint, authz_version)`, TTL <=60 s, with `authz_version` bumped by every membership or assignment change so a downgrade still applies from the next command.
- **Record-level permissions:**
  - Default sharing per entity; `record_share` from Phase 3.
  - `authorize()` (TS) and `visibleRecords()` (SQL) have golden tests proving both return the same result.
  - A record you cannot see returns 404.
- **RLS:**
  - Tenant isolation on every table.
  - A RESTRICTIVE legal-entity-scope policy on **every** table with `legal_entity_id`: finance, hr, and kernel projections too (`record`, `activity`, `file_link`, `extraction`, `proposal`, `inbox_item`, `notification`).
    - On `main` (#1280 part 1, `20261102140000_crove_finance_legal_entity_scope.sql`): the finance books carry `legal_entity_id NOT NULL` (foreign key to the org's entity, a `le_scope` RESTRICTIVE policy): `journal_entry`, `journal_line`, `period_balance_delta` (balance key `(org, legal_entity, account, month)`), `cash_voucher`, `journal_voucher`, `purchase_document` and its lines, tax rates, voids and input VAT marks, `bank_line`, `fixed_asset`, `depreciation_line`, `portal_invoice_list` and its rows, `categorization_rule` (unique per entity). The chart (`account`, `org_account`) and `vendor_account_rule` stay org-wide. A new row takes its parent's entity (an entry's lines, a document's lines, a reversal the reversed entry's), else the one the writer names, else the org's default entity, and never changes (trigger `b_legal_entity`); existing rows were moved to the default entity by a table rewrite, not an UPDATE. Voucher numbering, `period_lock` and the posting definer per entity are part 2; the kernel projections and `record_le` part 3.
    - On `main` (#1280 part 2a, `20261102150000_crove_finance_legal_entity_books.sql`): cash and journal vouchers are numbered per entity; sales invoice numbers and bank statement dedupe keys are unique per entity (a purchase invoice stays unique per org); `period_lock` has one row per entity, and the posting guard and the opening entry rule hold per entity; every parent a row names must be of its entity (`b_legal_entity` takes several parents). `post_journal_entry` takes the entity as its 8th parameter (named, else the reversed entry's, else the default; `LEGAL_ENTITY_NOT_ALLOWED` for one the caller may not see), compares it on replay as a column outside `payload_sha256` (ADR-0021 section 7 notes the deviation), and keeps every revision of a source in one entity. Finance calls take an optional `legalEntityId` (`finance.legal_entities.list` lists the entities the caller may see; omitted: the default entity if visible, else the only visible one, else `LEGAL_ENTITY_REQUIRED`); the period lock and bank import take it in 2a, the other commands and reports in 2b.
    - On `main` (#1716, `20261103120000_crove_kernel_activity_legal_entity.sql`): `activity` carries a nullable `legal_entity_id` and `le_scope` with org-level rows (NULL) visible to every member. Trigger `b_legal_entity` gives a row about a voucher, journal entry, purchase document, fixed asset, portal invoice list, bank statement import or legal entity its record's entity (read as the writer; a record the writer cannot read gives a writer limited to one entity that entity), and existing rows were backfilled from their records. Since #1538 a proposal's rows take the proposal's entity; a file's, a party's, a member's and the org's own are org-level.
  - An actor scoped to legal entities sees an org-wide record (such as a party) only if the record is linked in `record_le`.
    - On `main` (#1280 part 3b, `20261103010000_crove_kernel_record_le.sql`): `crove_kernel.record_le` links a party to legal entities. A party a scoped member creates is linked to its entities (trigger `party_link_new`); only writers with every entity in scope add or remove links (`kernel.party.link_entity`, `unlink_entity`, owners and admins). A scoped member recording a document of a company the org already knows gets that company linked into its own scope through the user-only definer `party_link_for_tax_code` (audited command `kernel.party.link_for_tax_code`, run by finance's `upsertParty`); a person's party is never linked that way (coordinator decision, option (b)). `proposal` carries `legal_entity_id` (its extraction's). The RESTRICTIVE policy on `party` still waits (the issue thread of #1538: the party policy and `party_link_for_tax_code`'s answer for a person's party).
    - On `main` (#1538, owner decision 2026-10-29, option (b), `20261104010000_crove_kernel_proposal_legal_entity.sql`): agents' positions have a real scope. `position.le_scope` was backfilled from `'{}'` to `'{*}'`; a new position gets the org's default entity unless the owner names `'{*}'` or entities of the org in `kernel.position.create`, `kernel.position.update` or `kernel.agent.template.install` (`leScope`); the trigger `position_le_scope` refuses anything else (`POSITION_SCOPE_INVALID`). `proposal.legal_entity_id` is NOT NULL under the RESTRICTIVE `le_scope` policy, so a member limited to some entities sees, asks for and decides only their proposals, and an agent only those of its position's entities. A proposal's entity: its extraction's for a file, else the one its preparer names (a reversal: the entry's) or its payload's `legalEntityId`, else the default entity; a resubmission keeps it. Agents get review tasks only for proposals in their scope (`kernel.agent.dispatch_event`), the worker re-checks the scope when it executes an agent's approval (P12) and creates an agent's proposal only in its position's entities (`out_of_scope`). The proposal's stream hints, its activity rows and its approval notice carry its entity. Open: approval eligibility per entity (P12 with entity-scoped assignments).
    - On `main` (#1764, coordinator decisions 2026-10-29): a proposal never moves to another entity, as its `legal_entity_id` never changes (ADR-0021's control for leaving the entity out of `payload_sha256`; re-stamping on a move was not taken for that reason). `kernel.proposal.edit` refuses a revision naming another entity (`LEGAL_ENTITY_MOVE_REFUSED`) and the trigger `proposal_entity_payload` refuses a payload whose `legalEntityId` is not the proposal's own (staff aside). Instead an upload names its entity: `kernel.file.ingest` takes an optional `legalEntityId` the uploader sees (the SPA sends the shell's choice), kept as `file.upload_entity_id` (the file stays org-wide; it never changes, trigger `file_upload_entity`), and the first reading takes it before the uploader's own entity; a ZIP's entries take the archive's. The Inbox shows the proposal's own entity, with no picker. Mailed invoices still go to the default entity.
    - On `main` (#1762, `20261104060000_crove_kernel_task_legal_entity.sql`): `task` carries a nullable `legal_entity_id` and `le_scope` with org-level tasks (NULL) visible to every member; `task_comment` follows its task (RESTRICTIVE policy `task_scope`). Trigger `task_legal_entity` gives a delegated or escalated task its parent's entity and a task whose `source_ref` names a proposal or a finance record that record's (read as the writer); a person's own task stays org-level, and the entity never changes. Existing tasks were backfilled, and review and escalation titles written before #1756 lost the proposal's title.
    - On `main` (#1788, `20261104110000_crove_kernel_task_handoff_entity.sql`): an agent delegates a task of an entity only to a position whose holder reads it (`OUTSIDE_LEGAL_ENTITY`; the task trigger refuses it too): an agent or a vacant position by its `le_scope`, a person by the scope `enter_context` seals for them, which the worker-only definer `member_covers_legal_entity` answers for an entity the caller reads (an agent limited to some entities does not see every role assignment). An escalation goes to the nearest active person up the chart who reads the task's entity, else the owner, and the trigger requires that target (`task_escalation_target` with the entity). Org-level tasks are unchanged. Open: a later change of a position's holder or of a person's assignments can still leave an existing task with someone who cannot read it.
    - On `main` (#1799, `20261104230000_crove_kernel_task_stranded.sql`): a chart or role change never leaves an open task with a holder who cannot read its entity. `kernel.position.assign`, `kernel.position.update` (a seat's `le_scope`), `kernel.member.role.assign` and `.revoke`, `kernel.member.change_role` and `kernel.member.remove` move each such task to the entity-aware escalation target, else to the owners (`crove_kernel.task_reroute`, owners only: the targets locked first, the move and an activity row per task set-based in two statements whatever the count, a deadlock retried once), with the activity row taking the task's entity, one `kernel.task_rerouted` notice per new holder and entity, and the moves counted in the audit row. Chosen over refusing the change: narrowing someone's access is a security action that must never wait on their open tasks. A seat left vacant (`position.assign` to nobody, `member.remove`) reads its `le_scope` as #1788 defines it, so it keeps the tasks of the entities its scope names, for an agent placed there later, and the rest go up. Left open: an agent's hand-off checked just before a concurrent narrowing commits can still land on the narrowed seat (the hand-off does not lock the holder's membership), and the chart and role commands take their locks in different orders, so two concurrent ones can still deadlock twice in a row, and then one answers RETRY.
  - A RESTRICTIVE per-user policy on `ai_thread`, `ai_message`, `notification`, `follower`.
  - Salaries and national ID numbers require a sensitivity flag.

### 4.7 Policy and risk levels

**Risk levels:**
- **R0:** read.
- **R1:** internal, reversible write; `reversibleBy` must be declared.
- **R2:** external effect, or visible to customers.
- **R3:** financial, legal, or irreversible.

**Derived risk:**
- `sideEffect: financial|legal|irreversible` -> R3.
- Enqueuing a job with `egress ≠ none` -> at least R2. A command whose outbox events the worker relays to such a queue declares `sideEffect: 'external'` (#1653, checked by `apps/kernel/test/invariant/job-egress.test.ts` from the relay's routing and the commands that emit each event). Since #1662 every command whose own handler emits such an event is R2 `external` and the test's list of exemptions is empty: the thirteen that were R1 (a file read by the AI endpoint, a link preview, a composer list, a planned takedown, and the posts that alert the org's team chat) were raised. A line to the org's own team chat on Telegram or Discord counts as egress: it sends tenant content to a third-party provider. The check counts an emit in a helper for every command that calls it, whatever the condition: `social.post.repost` and `social.post.duplicate` make a draft copy that sends nothing, and are R2 with the copies that do. Since #1698 it also follows nested commands: a command that runs one of these through its context's `run` or `tryRun` (whatever the context is called), directly or through another nested command, through a helper or a factory, emits what it emits, so `kernel.inbound.receive` and `social.media.save_stock` (which run `kernel.file.ingest`) and `social.post_comment.accept` (which may run `social.post.submit`) are R2 `external` too. Like an emit in a helper, a nested run counts whatever its input: `social.media.save_stock` ingests a photo with source `social`, which queues no extraction, and is R2 with the inbound mail that does. A run taken off its context, or a command name the test cannot read (a parameter of an exported function, a table written after its declaration), fails the test. A nested run whose command is not in its source is followed through the registered definitions: `kernel.task.propose` runs an R0 preparer (it refuses any other), the approvals (`kernel.proposal.approve`, `kernel.agent.proposal.approve`) run the approved proposal's command, and `kernel.proposal.edit` runs its command's reviser; any other such run fails the test until it is named there. The raise changes no flow today: the system commands among them are gated by access, not risk, for a user the runtime treats R2 as R1 (step-up and the live session check are for R3), and no agent has access to any of them (an agent is refused: no agent access, and R2 is P06). An exemption is recorded here with the product flow the plans require that needs it; there is none.
- Writing a field classified `contact` or `payment` -> P04 applies. On `main` (#1697): a command declares the tables and columns it writes (`writes`, one `tableWrite()` per table from its module's manifest, so the classes are the manifest's), and the runtime checks each column against those classes when the command registers and, since #1710, the classes against the manifests themselves (the server builds its one runtime with every enabled module's manifest, deep-frozen when defined, so a hand-built `classes` map or a `'*'` column is refused). A command an agent may run must declare its writes, an empty list when it writes no table. An agent's proposal of a command whose declared writes name a `contact` or `payment` column is flagged P04, and so is one of a command that declares no writes, since nothing says it writes none (until #1697, every proposal command without agent approvers). Registration refuses such a write on a command an agent may run, or whose proposals an agent may approve; an agent approval is refused (P04) when the command as registered may write one; and a proposal command declared free of them may not run a nested command that is not (the runtime fails it). The invariant suite (`apps/kernel/test/invariant/command-writes.test.ts`, #1710) holds the registry to it: every command the server registers declares writes that match the manifests, every command an agent may run declares its writes, the proposal commands not flagged P04 are listed there (none yet: no proposal command declares its writes, so P04 flags every agent proposal as before), and no contact or payment column of the manifests is reclassified away. A declaration is not compared with the SQL its handler runs, so a column left out is caught by review only (#1710).
- CI generates `docs/generated/agent-autonomy.md` in plain language: the list of commands the agent may run without approval. A PR that changes this table becomes a protected PR.

| Actor | R0 | R1 | R2 | R3 |
|---|---|---|---|---|
| user (passed RBAC) | allow | allow | allow (UI confirmation) | allow; review if the org enables four-eyes or a threshold is exceeded |
| agent in a user-opened chat, untainted | allow | allow + 24 h undo | review | review |
| agent tainted, or triggered by email/event/webhook | allow (triggering thread only) | review | send tools hidden | review |
| MCP / DOS.AI agent (Phase 3) | allow | allow | review | review |
| agent holding a position, woken by assignment or schedule, untainted (ADR-0029) | allow | allow + 24 h undo | review | review by a human |
| automation | allow | allow | review, except bounded admin-approved rules | review |
| api_key | allow | allow | allow within scope | deny |
| system | `allowSystem` commands | allow | via job | P13 |

| Rule | Effect |
|---|---|
| P01 | Deny: grant expired or revoked, budget exhausted, rate exceeded, kill switch on |
| P02 | Deny: risk > the grant's or key's `max_risk`; for a position-holding agent, the lower of `agent.max_risk` and its external-runtime grant's `max_risk` (ADR-0029) |
| P03 | Review, not overridable: run or input tainted and risk >= R1 |
| P04 | Review, not overridable: changing a payee, bank account, or contact point |
| P05 | Review: R3 by a non-user actor. Founder exception only when all hold: class is allowlisted, <= limit, counterparty **verified by a human**, matches a learned rule, and untainted |
| P06 | Review: R2 by a non-user actor. Founder exception: delayed send, cancellable, only to verified contacts, untainted |
| P07 | Review: untrusted trigger and risk >= R1 |
| P08 | Escalate one level: impact > 20 records, or above the org's money threshold |
| P09 | Accountant preset: posting needs approval by a **human** holding `finance.chief_accountant` |
| P10 | Four-eyes for R3 when >=2 eligible **human** approvers exist; agents are never counted (ADR-0029). The approver **must not be an author** of any part of the final input, and the creator chain of a task counts as authors. An org whose only human is the owner may self-approve, flagged in the audit. Liveness: when every eligible approver is an author, four-eyes can never be met, so an **owner** among them may approve, flagged `owner_override` in the audit; an admin may not. The owner is the trust root and could reach the same result by demoting the others (audited), so this adds no power, and it spares the org a demotion done only to approve |
| P11 | R3 approval requires `aal2` or WebAuthn, with the second factor used in the last 5 minutes and a direct Supabase Auth check at execution (ADR-0028) (on by default; turning it off needs the owner and is audited) |
| P12 | The approver must personally hold the command's permission and legal-entity scope. For R3, and for any proposal with P03-P07 in its outcome, the approver must be a human; an agent never approves work from its own causal chain (ADR-0029). Eligible approvers are snapshotted when the proposal is created; role changes while pending are audited and re-checked |
| P13 | System does R3 only with a same-org approval in `approved` state matching the command and `input_sha256`, usable once (`UNIQUE executed_command_id`). Imports that post entries also go through an R3 proposal |

**Recorded outcome:** decision, approver, rule ids, `policy_version`, `org_policy.version`, git SHA.

**On `main` (#75):** `kernel.proposal.approve` enforces P10 and P12 through `packages/kernel/src/approval.ts`, and `kernel.inbox.get` reports the same decision (`canApprove`, `approveReason`: `ok`, `not_pending`, `not_eligible` or `four_eyes`). Authors of a revision are the extraction component, the user who uploaded the source file (an author of the final input: the content is read from what they supplied) and every user who edited it; only users count. The eligible-approver snapshot is never rewritten: every decision filters it against current membership and role, so an approver who was removed or demoted neither approves nor counts toward the two eligible approvers four-eyes needs (#119). The approval audit row records the revision, `aal`, the P10 and P12 outcome, the number of eligible approvers and `self_approved`; a refusal records its code and rule. #88 adds the liveness rule (`policy.P10`: `pass`, `self_approved` or `owner_override`; `self_approved: true` for both flagged outcomes), audits every role and membership change with `target_user`, `role` and `previous_role` (`kernel.member.invite.accept`, `kernel.member.change_role`, `kernel.member.remove`), so a demotion that makes a self-approval legal is reviewable next to it, and aligns `canEdit` in `kernel.inbox.get` with what `kernel.proposal.edit` accepts. Not enforced yet: P11 (#22), legal-entity scope, and the recorded `policy_version`, `org_policy.version` and git SHA (Tracking, deferred table).

**Presets:** `founder` and `accountant` are data rows. A Vietnamese accountant reviews the presets before GA. Orgs that keep books default to `accountant`.

**On `main` (#1402):** the presets are rows of `crove_kernel.approval_preset`; each org's choice and its version are `tenant.approval_preset` (default `founder`, see the deferred row in the External-tenant gate section) and `tenant.approval_policy_version`. Only an owner switches it, through the R3 command `kernel.org.set_approval_preset`, refused while nobody holds the chief accountant role; database triggers refuse any other write and any change without that command's audit row. Under `accountant`, P09: only a human holding `finance.proposal.approve` (the chief accountant role) approves the ledger's proposals, decided under the preset in force, so a switch applies at once to pending proposals; an author never approves one, whatever the number of eligible approvers (no sole-approver exception, no `owner_override`), so such a proposal waits for another holder. While an active org is on `accountant` it keeps at least one holder who is not a viewer: revoking that assignment, removing that member or demoting them to viewer is refused (`LAST_CHIEF_ACCOUNTANT`, the trigger `chief_accountant_keep_guard`). A proposal whose snapshot holds no other approver is rejected and raised again, or resubmitted once expired, to take a new snapshot. The approval audit row records `policy_version` (`APPROVAL_POLICY_VERSION` in `approval.ts`), `org_policy` (preset and version) and `build` (the image's git SHA, `CROVE_BUILD`).

The LLM never sees or edits policy.

### 4.8 Idempotency

- **Claim** (in the transaction): `INSERT … ON CONFLICT DO NOTHING RETURNING`.
  - Same command and hash: replay the stored response.
  - Different command or hash: 422.
  - Two concurrent requests: the second waits on the unique index; on `lock_timeout`, 409 with Retry-After.
  - A failed command leaves no key.
- **Keys:**
  - Required for every mutation from agents, MCP and REST.
  - Shell: a client-generated UUIDv7 command id.
  - Agent: `uuidv5(run_id, step_no, tool_call_id)`.
  - Provider calls: `uuidv5(command_id|event_id, operation)`.
  - 7-day TTL.
- **Job keys:** the kernel builds every `singletonKey`, FIFO key and group key as `<org_id>:<job>:<key>`. Lint bans raw keys. Tested with two orgs using the same logical key.
- **Money:** protected by natural UNIQUE constraints (§6), not by queue dedupe.

### 4.9 Outbox, events, jobs, processes

**Writes:**
- `ctx.emit` and `ctx.enqueue` call `crove_kernel.emit()` (owner `crove_definer_tenant`), which:
  - stamps org, actor, command and causation from the context;
  - checks `type` against the registry: a module emits only `<its own id>.*` and enqueues only its own jobs; `kernel.*` comes only from the kernel;
  - inserts into `outbox_event` (insert-only) and `outbox_pending`.
- Module roles have no direct INSERT on outbox or audit.

**Relay** (in the worker, `withSystemTx`; exclusive via advisory lock):

```
loop: BEGIN
  rows := SELECT … FROM crove_kernel.outbox_pending ORDER BY seq LIMIT 200 FOR UPDATE SKIP LOCKED
  per row: SAVEPOINT
    event → boss.send for each consumer in crove_kernel.event_subscription(type, version)
    job   → boss.send(queue, input, {startAfter, singletonKey, group})       -- keys already org-prefixed
    DELETE row from outbox_pending; RELEASE
    error → ROLLBACK TO SAVEPOINT; attempts+1, last_error; skip the row (does not block the batch)
COMMIT
wake: LISTEN crove_outbox (per-statement NOTIFY) + poll every 500 ms
```

**DB-decided fan-out:**
- Subscriptions and queues are data that `gen` writes into migrations.
- An old worker still fans out new events correctly, and queues always exist before the first send.
- v1 does not forward to the DOS Event Router.

**Consume:**
- Every pg-boss handler is **non-transactional**. Each job runs one kernel tx on :6543:
  1. `enter_context` (with the job ref) and switch to the module role;
  2. `INSERT processed_message(consumer, event_id) ON CONFLICT DO NOTHING`;
  3. run the handler;
  4. COMMIT.

  pg-boss completes the job only after the commit. The result is at-least-once plus idempotent.
- **Ordering:** `per_subject` uses `key_strict_fifo` with `<org>:<subject>`. Other kinds drop stale events via `aggregate_version`.
- **Job I/O:** goes through the `external_call` ledger with deterministic keys. An `ambiguous` state spawns a reconciliation job that asks the provider before retrying.
- **CPU-heavy work:**
  - Extraction runs in `crove-extract`; archive zipping and hashing run in `worker_threads`.
  - Watchdog: event-loop lag > 5 s sustained for 30 s -> `exit(1)`. On `main` since #894 (`apps/kernel/src/back-pressure.ts`, a `perf_hooks` delay histogram read every second, with an `[alert]` line).
  - A heartbeat is written to the DB for the prober.
- **`perOrg` schedules:** jitter by `hash(org_id)`.
- **Second worker:** enabled before the first paying Finance tenant. The relay stays exclusive; consumers use SKIP LOCKED.

**pg-boss contract:**
- `crove_jobs` is vendored with `pnpm db:vendor:pgboss`:
  - wrapped in a version-guarded `DO` block;
  - `CONCURRENTLY` replaced by plain statements plus lock retry, applied only in the promote window.
- `migrate:false`, `createSchema:false`. Lint bans `partition:true`.
- `useListenNotify` runs on `crove_queue`.
- Defaults: `retryLimit 8`, exponential backoff, max 1 h. DLQ `<queue>.dlq` raises the Inbox item `kernel.job.dead_lettered`.
  - On `main` (#1720): one dead letter queue, `kernel-job.dlq`, for every queue, instead of one `<queue>.dlq` each. Why: pg-boss works one queue per worker loop, so 44 dead letter queues would poll 44 times as often for jobs that arrive a few times a month, and the copy pg-boss makes keeps the queue it failed on (`source_name`). A new queue's migration names it (`apps/kernel/test/jobs.db.test.ts` fails otherwise). Its worker (`apps/kernel/src/dead-letter.ts`) runs the system command `kernel.job.dead_letter` in the job's org, which writes a `crove_kernel.inbox_item` (queue name, job id, retries; never the job's data or error); since #1747 one open item per queue and day in Vietnam counts that day's failures, and a failure after a dismissal raises a new one. The org is the one the job's key or group was built for (`job-keys.ts`) and its data's `orgId`; when they disagree, or the job has neither (a schedule, a sweep, raw inbound mail), no org gets an item and the worker logs it. The failed job stays where the prober counts it. Only a system context inserts an item (a RESTRICTIVE policy); owners and admins see the open ones as an Inbox card and dismiss them (`kernel.inbox.raised`, `kernel.inbox.dismiss`). The org purge deletes an org's items, and the daily retention run deletes dismissed and old ones (#1747, §4.9 Retention); a dismissal names the context's own user (`inbox_item_dismiss`). A dead letter of an org the system may not enter (closed, unknown) raises nothing and completes; a job that is not a pg-boss copy fails.
- At most 25 physical queues; several logical jobs can share `<id>.default`.
- `pg-boss doctor` runs in G3. On `main` (#1603): `apps/kernel/test/jobs.db.test.ts` starts pg-boss as `crove_worker` on the migrated database and runs its drift scan (`detectSchemaDrift()`, what `pg-boss doctor` runs): tables, columns, constraints, enums, indexes and function bodies must match the pinned version, and a dropped index is reported.

**Schedules:**
- System schedules use `schedule()` with `tz` Asia/Ho_Chi_Minh, registered idempotently at boot.
- Tenant business schedules are domain rows with `next_run_at`, scanned by a job.
- `pg_cron` does pure-SQL housekeeping only.

**Processes:** transitions are pure functions; state lives in `process_instance`; timers are job intents; waiting on a human is a proposal.

**Back-pressure:** outbox lag > 30 s pauses background, agent and bulk jobs. Interactive work keeps running. On `main` since #894: every 10 s the worker reads `crove_kernel.outbox_lag_seconds()` (worker only); over `OUTBOX_LAG_PAUSE_SECONDS` (default 30) it stops fetching the agent, bulk mail, archive and retention queues (pg-boss `offWork`) and works them again once the lag is at or under half of it (measured by the load test since #1717, [load-test.md](../runbooks/load-test.md)). Each change is logged and posted to the alert webhook ([incidents.md](../runbooks/incidents.md), section 2).

**Event versioning:**
- Adding an optional field: same version.
- Breaking change: v+1 with an upcaster; integration events are published in both versions during the deprecation window.

**Retention** (TTL tables are not partitioned; batched DELETE of <=10k rows via `pg_cron`; per-table autovacuum `scale_factor` 0.01-0.02):

| Table | Keep | Notes |
|---|---|---|
| `outbox_event` | 30 days | Archived as org-prefixed JSONL with a sha256 manifest before deletion. Done in #997: the daily retention run archives each org's UTC day to the WORM archive store (`outbox/v1/<org_id>/<day>.jsonl`, locked 13 months), reads it back, records it in `crove_kernel.outbox_archive` and deletes exactly that day's events; the database refuses any other delete (`outbox_event_guard`) |
| `processed_message`, `security_event`, `idp_event` | 30 days | |
| `idempotency_key` | 7 days | |
| `ai_step` | 180 days | |
| `inbox_item` | 30 days after dismissal, 90 days after raising | Done in #1747: the daily retention run pages through the active orgs `crove_kernel.inbox_item_prune_due()` names (`crove_worker` only, outside every context) and runs `kernel.inbox.prune` in each org's system context; a RESTRICTIVE policy lets only the system context delete. The failed jobs stay where the prober counts them |
| pg-boss | per `deleteAfterSeconds` | |

- Purge functions are owned by `crove_definer_system`, with explicit policies on the machinery tables.
- pgTAP asserts that purges delete real rows.
- Alert when a purge deletes 0 rows while eligible rows remain.

### 4.10 Audit and immutability

- **Three streams, linked by `command_id`, `correlation_id`, `causation_id`:**
  - `audit_event` (security and compliance):
    - First planned as a definer `audit_write()` stamping from the context and checking `approved_by` against `proposal`; superseded by the trigger below, which stamps but checks no approval.
    - On `main` (#1482): stamping is done by the BEFORE INSERT trigger `audit_event_stamp` instead of an `audit_write()` function. Why: a trigger stamps every insert at the table boundary, whatever path writes it, while a function stamps only the callers that choose it; and a definer could not authenticate the command name either. A user context gives the row its user, a system context the system with no actor id, an agent context keeps `agent_write_guard`'s rule, and `occurred_at` is always the transaction's `now()`; no context, or another org's, writes nothing. A row forged for someone else becomes the session's own, so a `*_requires_audit` trigger is satisfied only by a row written in that user's own context. Staff writes are not stamped.
    - Still unproven: a session can write a row in its own name with any command name, outcome and detail (the runtime and any statement on its connection are one session, so the database cannot tell the command ran); `approved_by` is not checked against the proposal (`audit_event` has no such column).
    - On `main` (#1695): a row's `proposal_id` is checked by the BEFORE INSERT trigger `audit_event_proposal`. The row must be for the org of the session's context (checked before the proposal is read, so a row aimed at another org gets one refusal whatever that org holds), and the proposal the row's own org's. A row for the proposal's own command needs it `approved`, a state the runtime never commits (the approving transaction ends `executed` or rolls back to `pending`); the check reads the proposal as the session's transaction sees it, and since #1707 a session can move a proposal there only from `pending`, naming the executing command, and never back. A row for another command needs it `approved` (a command the execution runs, such as `kernel.party.link_for_tax_code` under `finance.purchase.record`) or `pending` (the reviser `kernel.proposal.edit` runs). A row naming an executed, rejected, failed or expired proposal is refused. Staff writes are not checked. Why not the proposal's own command on every row: the runtime passes a command's proposal id on to the commands it runs, and each writes its own row. Still open: a row under another command name naming a pending proposal of its own org; only the execution row carrying `proposal_id` would close it (#1706).
    - On `main` (#1707, `20261104070000_crove_kernel_proposal_status_guard.sql`): the BEFORE INSERT OR UPDATE OR DELETE trigger `proposal_status_guard` allows only the transitions the runtime makes, pending -> approved (naming `executed_command_id`), pending -> rejected (naming who and when), pending -> expired (naming when) and approved -> executed, for every tenant writer; the terminal states (`executed`, `rejected`, `failed`, `expired`) stay terminal, `approved` never goes back to `pending`, and `pending` never jumps to `executed` (`PROPOSAL_STATUS_TRANSITION`). Once approved, the decision (who, when, the executing command) is frozen, and a terminal proposal does not change at all (its authors and eligible approvers are the P10 and P12 evidence); no proposal's id changes, no tenant writer inserts one `approved` or `executed`, naming an executing command or who or when decided it, or deletes one that is no longer `pending`. Staff, and definers owned by the table's owner (the org purge), are not checked. Invariant test `proposal-status.db.test.ts`.
    - On `main` (#1793, `20261104150000_crove_kernel_proposal_approve_gate.sql`): a user's context moves a proposal to `approved` only through the SECURITY DEFINER gate `crove_kernel.proposal_approve(proposal, revision, executing command)`, which decides P09, P10 and P12 in the database (the rules of `decideApproval`, with the policy table `crove_kernel.approval_command_policy` kept equal to `approval.ts`'s by a test) and writes the approval; `kernel.proposal.approve` (and so `approve_many`) calls it, and `proposal_status_guard` refuses the plain update except in the system context (the worker executing an agent's approval). P11 stays in the runtime. Invariant test `proposal-approve-gate.db.test.ts`.
    - On `main` (#1816, `20261104170000_crove_kernel_proposal_executed_gate.sql`): an approved proposal moves to `executed` only when the ok audit row of its own command, naming it, was written in the same transaction by the same actor (`crove_kernel.proposal_execution_recorded`, read by `proposal_status_guard`), as the runtime writes it when the command ran; a session with raw SQL can still write such a row, which then stays in the append-only, archived audit under its actor. That residual is bounded only by "no raw SQL on the API connection" (#1840): anything `crove_app` can call or compute (the keyed input hash, any definer the runtime calls), a raw session on it can too, so binding the row to the payload or writing it through a definer would only make a forged row look right. The controls that stay: the row is stamped with the context's actor and time (#1482), append-only and archived in the WORM stream (#891), so a forgery is detectable after the fact; binding the context to a verified session is #1822. A row undone with its savepoint carries nothing, and one statement that writes the row first (a CTE the update reads) counts as two. Invariant test `proposal-status.db.test.ts`.
    - Assumed by the trigger (review of #1488): a future definer that writes audit rows without a context leaves them unstamped, so a definer writing audit rows must run in a context; the staff exemption holds only while no login role is ever granted the table owner's role.
    - Success and pending are written in the command's transaction; denied/failed in a new transaction.
    - Refusals audited: 403 as `denied`, and 404, 409 and 422 as `failed`, once membership is established (§4.4 step 14). A 404 is audited since #119: a record the actor named that is not in the org (`MEMBER_NOT_FOUND` for a member of another org, a proposal that does not exist) is a probe worth a row. The row carries the code and policy rule, the session, and the facts the command attaches to the refusal for the audit only (`DomainError` `audit`, never sent to the caller; for example the target and roles of a `LAST_OWNER`), which cannot overwrite the code, rule or session.
    - **Bound per actor and org** (on `main` since #162): before the row is written, the refusal transaction counts it in `refusal_tally` (definer-only machinery, keyed by org, fixed window, actor and (command, code); org and actor from the sealed context) through the definer `refusal_tally_note()`. In each window (`REFUSAL_AUDIT_WINDOW_SECONDS`, default 3600) a refusal gets a row when it is the actor's first of its (command, code), when the actor has fewer than `REFUSAL_AUDIT_RESERVE_PER_ACTOR` (default 10) refusals (a reserve no other member can use up), or when the actor has fewer than `REFUSAL_AUDIT_LIMIT_PER_ACTOR` (default 50) and either the org fewer than `REFUSAL_AUDIT_LIMIT_PER_ORG` (default 500) or the refusal is security relevant (an explicit list in the runtime, `SECURITY_REFUSAL_CODES`: `FORBIDDEN`, `STEP_UP_REQUIRED` and the like, plus every 404). Otherwise it is only counted (`refusals`, `audited`, `first_at`, `last_at`). The count is in the database, so it holds across API instances; it takes no lock, so a concurrent burst can pass a limit by the refusals in flight. A failing count is logged (`REFUSAL_TALLY_FAILED`, ids and codes only) and never suppresses the row. The tally grows with windows that saw refusals, not with the request rate; the worker deletes windows older than `REFUSAL_TALLY_RETENTION_DAYS` (default 7) in its daily retention job (§4.9) through the definer `refusal_tally_prune()` (`crove_worker` only). A reader for owners comes with the audit view.
    - If the denied/failed write fails, the caller still gets the original refusal: the command rolled back, so no change is left unaudited, and a 500 would only hide why it was refused. The loss is never silent: the runtime logs `AUDIT_WRITE_FAILED` with ids and codes only, also when the actor was removed from the org in between (the row is written only through the actor's own context; since #1006 that case is noted in `security_event`). An org-less command whose new org rolled back with it has no org to audit in and writes nothing (on `main` since #102).
    - Sensitive reads are audited before the read.
  - `outbox_event`: business facts.
  - `activity`: user-facing projection; the system kind is written only via a definer.
- **PII:**
  - `input_redacted` drops fields classified `pii` or `national_id`, keeping only `input_sha256`.
    - On `main` (#1626): the audit row stores no input, only `input_sha256`, and the facts a command adds (`ctx.audit`, a refusal's audit facts) keep no value of a column classified anything but `internal` (§5.2). `auditValue(table, column, value)` (`@crove/kernel-contract`) puts a marker naming the class in place of the value (`{ "redacted": "pii" }`), keeping the key and a null; `apps/kernel/test/audit-facts.test.ts` scans every fact for a key or a value that names a classified column without it. Why every class and not only `pii` and `national_id`: a contact detail, a payment account and a secret are personal or secret data too, and an audit row can never be erased. The org's tax code guard (`tenant_tax_code_requires_audit`) accepts the marker for a code that is set (20261103070000). Rows written before stay as they are.
    - On `main` (#1634): activity summaries (`crove_kernel.activity.summary`, the text of a record's timeline) keep no value of a classified column either: they say what happened (`Đổi tên`, `Đặt mã số thuế của tổ chức`, `Ghi sổ HĐ <số>`), and the record's page shows its current values. Values that are internal by class but carry a party's name in practice stay out too: proposal titles, invoice memos, voucher and entry descriptions, file names. `apps/kernel/test/activity-summary.test.ts` scans the summary of every `ctx.activity(...)` for a read of a classified column, with a reasoned list of reads that hold internal data (an account's, an asset's or a position's name); a value carried in a variable of another name is left to review. Rows written before stay as they are: the table is append-only, and the PDPL erasure (#923) is where old rows of a person are dealt with.
    - On `main` (#1732): `input_sha256` is keyed. The server's runtime stores `k1:` and an HMAC-SHA256 under the deployment's hash key (`crove_kernel.command_input_hash`, the key no runtime role reads), over the org of the sealed context, the actor, the command and the canonical input, so whoever holds an exported or archived row cannot confirm a guessed input (a private note, ADR-0037). The idempotency row's `request_sha256` is the same hash; a key claimed with the plain SHA-256 before the switch still replays until its 7-day retention ends. Rows written before stay plain; the WORM stream anchors the value as stored.
  - Immutable stores that need PII use crypto-shredding: a per-subject key in `subject_key`; deleting the key deletes the data.
- **Immutability triggers:**
  - `make_append_only(regclass)` raises on BEFORE UPDATE/DELETE/TRUNCATE, for every role including `service_role`.
  - The variant `append_only_with_retention(age, purge_role)` for TTL logs: only the purge role may delete, and only expired rows.
  - Grants are only SELECT and INSERT.
- **`audit_event` storage:**
  - RANGE partitioned **by year** from day one; partitions pre-created through 2031 by migration; no DEFAULT.
  - Alert when under 18 months remain; `pnpm db:partitions` generates the extending migration.
  - PK `(id, occurred_at)`; indexes lead with `org_id`, plus BRIN; no FK to tenant.
  - No automatic deletion in v1.
- **Tamper resistance:**
  - Tables are owned by `crove_owner` (NOLOGIN), which prevents accidental edits.
  - That does not stop `postgres`. The real control is the **WORM fact stream**: the relay writes batches of <=5 minutes to `crove-archive-<env>` (locked retention), containing:
    - journal entries;
    - number allocations, voided numbers included;
    - e-invoice issuance results;
    - hashes of signed documents;
    - chain hashes of audit batches.
  - A nightly verifier compares the DB with the WORM anchors and alerts on mismatch.

### 4.11 Surfaces

| Surface | Phase | Content |
|---|---|---|
| `/` | MVP | SPA static files (`apps/app/dist`); deep links fall back to `index.html`; hash-based CSP + Trusted Types (spike A14) |
| `/api/config` | MVP | Public runtime config: Supabase Auth URL and public key, feature flags; no secrets |
| `/auth/v1/*` | MVP, self-host | Allowlisted proxy to the bundled Supabase Auth; body-limited; drops the client's forwarding headers (`Sb-Forwarded-For` included) and sets `X-Real-IP` from the socket, or from the trusted proxies' `X-Forwarded-For` entry, for Supabase Auth's per-client rate limits. Verified end to end by `e2e/tests/auth-rate-limits.spec.ts` (#34, with the email budget below raised on the e2e stack): sign-in, sign-up and recovery each allow a burst of 30 requests per client address in Supabase Auth, then 429 `over_request_rate_limit` (refill: sign-in and token refresh 150, sign-up and recovery 30 per 5 minutes); spoofed headers do not reach a fresh bucket and another address is unaffected. Supabase Auth's port is not published, so the proxy is the only way in. Absent when the deployment points at an external Supabase Auth (Crove Cloud), whose email limit is a setting of that project. <ul><li>**Tokens issued to OAuth clients (#277).** Supabase Auth accepts the access tokens its OAuth server issues to third-party clients on the routes it authenticates with the user's token (`/user`, `/logout`, `/reauthenticate`, `/factors/*`). On every forwarded path the proxy decodes the bearer JWT payload without verifying it and refuses one with a `client_id` claim (any value) or an `oauth_provider/` `amr` method, the kernel's rule (ADR-0028 section 1): 401 `OAUTH_CLIENT_TOKEN_REFUSED` in Supabase Auth's error shape, before the email budget, nothing forwarded and nothing logged. Malformed tokens pass through for Supabase Auth to reject. Tests: `apps/kernel/test/http.test.ts`.</li><li>**Email budget (#190).** Supabase Auth sends every email from one deployment-wide bucket (`GOTRUE_RATE_LIMIT_EMAIL_SENT`, set from `AUTH_RATE_LIMIT_EMAIL_SENT`, default 100 per hour in compose; counted while confirmations are on), and its per-address limits (`GOTRUE_RATE_LIMIT_OTP`, a burst of 30) are larger than that bucket, so one client could use it up and stop confirmation and recovery emails for everyone for an hour. Before forwarding a request that sends an email (sign-up while confirmations are on, recovery, OTP and magic link, resend, email change, reauthentication) the proxy reserves a slot in the database: at most `AUTH_EMAIL_CLIENT_LIMIT_PER_HOUR` (default 5) per client address in any rolling hour, IPv6 per /64, and one per recipient every `AUTH_EMAIL_ADDRESS_INTERVAL_SECONDS` (default 60). Over either: 429 `over_email_send_rate_limit` (Supabase Auth's own shape) with `Retry-After`, nothing forwarded. A request Supabase Auth refuses (4xx, 5xx) sent nothing and gives its slot back; one it does not answer in time keeps it, since it may still have sent. The body is read as Supabase Auth's Go decoder reads it (keys in any case, any Content-Type); a body the proxy cannot read with certainty still counts per client, with no recipient.</li><li>The client address is the socket address, or with `TRUSTED_PROXY_HOPS` the `X-Forwarded-For` entry the trusted proxy appended; client-supplied forwarding headers are dropped. The count runs in `crove_kernel.auth_email_reserve()` (executable by `crove_app` alone) under per-client and per-recipient advisory locks with a 3 s lock timeout, so it holds across API instances and restarts, and of concurrent requests at the limit exactly as many as the limit win. The table stores SHA-256 hashes only and each reservation sweeps rows older than an hour, so it holds about one hour of traffic; Supabase Auth itself writes a row per sign-up, so the limiter adds no write an outsider could not cause already. If the limiter cannot decide (database error), the proxy answers 503: the budget never opens.</li><li>A public deployment refuses to start when fewer than 10 client addresses could use up the budget (`AUTH_EMAIL_CLIENT_LIMIT_PER_HOUR` x 10 > `AUTH_RATE_LIMIT_EMAIL_SENT`). Behind a reverse proxy with `TRUSTED_PROXY_HOPS=0` every client shares the proxy's address and one budget; the proxy logs a warning once when requests carry `X-Forwarded-For`.</li><li>Decision (2026-10-16): size the budget to the SMTP provider's quota and cap it per client; no CAPTCHA by default, since the OSS core must run with no third-party service. Residual risks: a client with many addresses (a botnet, many IPv6 /64s) can still use up the budget, and optional CAPTCHA on sign-up and recovery is #203; the per-recipient interval lets someone with several addresses delay one person's recovery email by a minute at a time, as Supabase Auth's own per-user frequency (`GOTRUE_SMTP_MAX_FREQUENCY`, 60 s) already does; several users behind one IPv4 address (an office NAT) share its 5 emails an hour, so such deployments raise `AUTH_EMAIL_CLIENT_LIMIT_PER_HOUR` with the budget. Tests: `apps/kernel/test/auth-email-limit.test.ts` (which requests count, client buckets, the configuration guard, the proxy's answers), `apps/kernel/test/invariant/auth-email-limit.db.test.ts` (EXECUTE matrix, closed table, per-client and per-recipient rules, concurrency, sweep) and `apps/kernel/test/auth-email-proxy.db.test.ts` (through the proxy in front of a fake Supabase Auth with one deployment-wide bucket: one client signing up 30 new addresses gets 5 through and another client still gets its confirmation and recovery emails; without the cap the same flood blocks it).</li></ul> |
| `/api/rpc/*` | MVP | oRPC; Bearer Supabase access token + `X-Crove-Org` (org slug); every command through `execute()` |
| `/api/files`, `/api/files/:id`, `/api/export/journal.xlsx`, `/api/export/vat.xlsx?period=`, `/api/export/ledger.xlsx?period=` | MVP | Upload (type sniffed from content, size-limited), download, Excel exports (the journal; the VAT working of a month `2026-09` or quarter `2026-Q3`, #316; the ledger reports of a month, quarter or year `2026`, #321: trial balance, general ledger per account, receivables and payables per party); same token and org header |
| `/api/inbound/email` | MVP | Raw MIME from a mail worker, authenticated with `INBOUND_SECRET`; the recipient token selects the org. Decided: the API only verifies, size-limits and stores the raw message; parsing and `kernel.inbound.receive` run in the worker (External-tenant gate T5) |
| `/webhooks/<provider>/<binding_public_id>` | 2a | <ul><li>Raw body, size-limited.</li><li>Signature verified **inside the API** (secret in the deployment's secret store); invalid -> 401 and nothing stored.</li><li>Valid -> `record_inbound_webhook(binding_public_id, payload_ref)`, org derived from the binding.</li><li>The worker processes it as actor `system:webhook:<provider>`.</li><li>DOS org events (later, DOS-27) take the same path through a deployment-level binding with no org; the org is mapped from `external_org_id` in the event.</li></ul> |
| `/healthz` `/readyz` `/version` | MVP, Cloud | <ul><li>The startup probe calls only `/healthz`.</li><li>`/readyz`: every committed migration applied (implemented); worker build >= API build (Cloud).</li><li>`/version`: build and missing migrations (Cloud).</li></ul> |
| `/api/stream` (SSE), `POST /api/stream/tickets` | Built (#69) | The invalidation stream (§9). `POST /api/stream/tickets` (bearer token + `X-Crove-Org`, through the same per-user rate limit, then that org's session check and membership) returns a one-time ticket: 32 random bytes, valid 30 s, stored as SHA-256 in `crove_kernel.stream_ticket` with the user, org, session, `aal`, MFA time and the token's `exp`, at most 10 unexpired per user (429 past it; 401 when the token expired by the database's clock, #281). `GET /api/stream?ticket=` (EventSource cannot send headers) redeems it once on any instance (before that, a client address with 20 failed redeems in the last minute gets 429 and at most 32 redeems run at once per process, 8 per address, 503 `STREAM_BUSY` past them; #281), applies the rate limit, takes a slot (`STREAM_MAX_CONNECTIONS` per process, `STREAM_MAX_PER_USER` per user and process; 503 `STREAM_BUSY` past them), runs the session check and membership again and opens `text/event-stream` with `Cache-Control: no-store`. Off with `STREAM_MAX_CONNECTIONS=0` (404, the app polls) |
| `/ai/*` | 2b | Runs on `crove-stream` |
| `/v1` (OpenAPI 3.1, RFC 9457, `Idempotency-Key`), outbound webhooks | 3 | Commands that declare `http`; oRPC v2 (Decision 14); Standard Webhooks |
| `/mcp` | 3 (Cloud: after DOS-9) | Registered MCP clients only, with tokens from the OAuth 2.1 authorization server (Decision 14), never a user's browser token; org and grant derived server-side |

**Rules:**
- Handlers only call `kernel.execute`.
- `DomainError` maps to typed oRPC errors, `problem+json`, or MCP `isError`.
- Same origin: CORS stays closed for `/api`.
- No body-reading middleware runs before `/api/rpc`.
- With the S3 adapter, uploads and downloads use presigned URLs (§7.6); with local disk they stream through the kernel.

### 4.12 Entitlements, quotas, kill switches, staff

- **Entitlements:**
  - v0: statically seeded `org_entitlement`.
  - Before charging (Cloud): DOS-7 + `usage_counter`, with the conditional increment `… AND used + $n <= $limit RETURNING used`.
- **Per-org abuse limits**, from v0:
  - inbound emails per day;
  - attachment MB;
  - extraction pages;
  - LLM cost per day (Crove-side pre-flight and hard cap; Cloud adds the DOS.AI wallet hard cap).
  - On `main` since #675: `crove_kernel.org_usage` counts each use over a sliding 24 hours, and the worker checks the limits (`ORG_LIMIT_*`, with AI cost priced by `AI_PRICE_*_PER_MTOK`) before it files a message or reads a document.
    - An item over a limit is kept, not dropped: it is recorded in `crove_kernel.usage_deferral` and queued again for when the org is back under the limit. A document shows as waiting in the Inbox; a requested re-extraction fails with when to ask again.
    - The owners get one mail per limit in any 24 hours. The totals are not in the weekly usage report yet (#895).
    - The check comes before use and is not a locked reservation, so jobs running at the same time can pass a limit by a few items.
- **Kill switches:** table `crove_kernel.kill_switch(key, scope global|org)`.
  - Checked at: agent writes, automations, outbound sends, relay per type, extraction.
  - Flipped by a break-glass definer (audited, no outbox), from the `crove-ops` job.
  - Owners get a "Stop AI" button for their org.
- **Feature flags:** later; flags never gate paid features.

### 4.13 Errors and observability

- **Errors and results:** errors are `DomainError{code,status,details,retryable}`. Results are `{status:'ok',data,command_id,event_ids}` or `{status:'pending_approval',proposal_id,inbox_item_id}`.
- **Tracing:** one `crove.command` span per execute, no PII. `traceparent` is stored on the outbox so traces continue across async work.
- **Metrics:** `crove_command_total{command,outcome}`, latency, outbox lag, oldest job age, DLQ, subscriber errors, pending proposals, AI cost.
- **Crove-owned alerting path (Crove Cloud, before the first external tenant; issue #39):**
  - Cloud Scheduler runs the `crove-prober` job every minute. The prober calls `crove_kernel.health()` as `crove_prober` and reads: age of the oldest unpublished outbox row, longest-queued job, DLQ, relay/worker heartbeats, purge results.
  - Results become Cloud Monitoring metrics, with absence alerts.
  - SEV1 pages the owner's phone and also opens an issue for an agent to handle per runbook.
  - Open-source core (issue #39): the image's `prober` role and `crove_kernel.health()` (outbox and inbound relay age, oldest queued job, dead letters, worker heartbeat), with a webhook (Slack, Discord, Telegram or generic JSON) or stdout alert and `--test-alert`. Alerts are de-duplicated (issue #151): a notification on a new, changed or resolved problem and a repeat every `ALERT_REPEAT_MINUTES`, with the state in `crove_kernel.prober_alert_state` behind `prober_alert_gate()`, locked while one prober delivers. Self-hosters schedule it with cron or the Compose `prober` profile (README); Cloud Scheduler, Cloud Monitoring and paging stay in Crove Cloud. Absence on a self-hosted deployment (issue #309): with `PROBER_HEARTBEAT_URL` the prober pings an outside heartbeat monitor after each probe that read the database and delivered what it owed, and an outside uptime check requests `/healthz` every 5 minutes, so a stopped prober, a broken alert path or a dead host still pages the owner ([docs/runbooks/alerts.md](../runbooks/alerts.md)); `pilot:check` fails without an https `ALERT_WEBHOOK_URL`.

## 5. Modules

### 5.1 Structure

Every module, `@crove/kernel` included, has exactly 4 exports:
- `./contract`: isomorphic.
- `./server`.
- `./ui`.
- `./manifest`: data only.

No wildcards. `contract/index.ts` is the only barrel.

```
modules/<id>/
  AGENTS.md (≤150 lines)  CLAUDE.md(@AGENTS.md)  package.json  manifest.ts
  contract/{index,commands,queries,events,permissions,errors,entities}.ts
  domain/          pure TS: aggregates, invariants, state machines, decimal math (no db/react/fetch)
  commands/<entity>.<verb>.ts (+ .test.ts)   queries/<entity>.<name>.ts   subscribers/   jobs/ (the only place with I/O)
  processes/   infra/repo/ (the only place touching ctx.db)   infra/adapters/ (called only by jobs)
  ui/{screens,widgets}/   ai/{skill.md,prompts/}   messages/{vi,en}.json   tests/
```

### 5.2 Manifest

`defineModule(...) satisfies ModuleManifest`, validated by zod at boot.

```ts
defineModule({ id: 'finance', version: '0.1.0', dependsOn: ['kernel'], dbSchema: 'crove_finance',
  entities: [{ type: 'finance.invoice', table: 'invoice', record: true, timeline: true, files: true,
    numbering: { docType: 'invoice', scope: 'legal_entity', period: 'year' }, sharingDefault: 'org_read',
    legalEntityScoped: true, audit: 'row',
    classify: { party_tax_code: 'national_id_if_individual', bank_account_no: 'payment', memo: 'internal' } }],
  permissions: [{ key: 'finance.invoice.post', risk: 'R3', defaultRoles: ['finance.chief_accountant', 'owner'] }],
  commands: [], queries: [], events: [], subscriptions: [], jobs: [], schedules: [], processes: [],
  aiTools: { expose: ['finance.bill.create_draft'], skill: './ai/skill.md' },
  routes: [{ id: 'finance.invoice.list', kind: 'list', path: 'invoices', screen: 'InvoiceListScreen',
    permission: 'finance.invoice.read', load: [['finance.invoice.list', { limit: 50 }]] }],
  nav: [], slots: { 'party.tabs': [] }, settings: {}, entitlements: [{ key: 'finance', kind: 'feature' }],
  inboxTypes: ['finance.bank_line.unmatched'], i18n: ['finance'] });
```

Every column of an entity table must have a `classify` entry; the default is `internal`. CI fails if one is missing.

On `main` (#1599): every column of every `crove_*` table is classified in its module manifest, `columns([...internal], { column: class })` per table, with the classes `internal`, `pii`, `contact`, `payment`, `national_id`, `national_id_if_individual` and `sensitive` (`DATA_CLASSES` in `@crove/kernel-contract`, defined there; `sensitive` also covers secrets such as sealed credentials and bearer tokens). `apps/kernel/test/manifest.db.test.ts` fails on a column with no class or a classified column that does not exist, and when personal data the PDPL registry (#923) erases or keeps is classified `internal` or against its kind. The first consumer is on `main` (#1626): audit facts keep a marker naming the class in place of any classified value (§4.10). The second is on `main` (#1697): P04 on writes of `contact` or `payment` (§4.7). Not built yet: the search projector.

On `main` (#1652): `routes` and `nav` are in every manifest. A route is a screen's path under `/o/$slug`, with the permission it needs beyond membership when it has one (none does yet: the server checks every query and command a screen calls) and, for a screen no menu item names, the app it opens in; a menu item names one of its module's routes, its app and group (or `app: null` for the org's own screens) and its label key. Since `apps/app` must not import a module's server code, the lists live in `MODULE_SCREENS` of `@crove/kernel-contract` and each manifest names its entry. A screen of a module the deployment leaves out redirects to the inbox through one guard on the org route (ADR-0031 §3). Not built yet: `screen`, `load` and `kind`, which wait for module UI packages.

On `main` (#1656): `entities` are in every manifest, each with its `type` (`<module>.<entity>`), its `table` in the module's own schema, `legalEntityScoped`, `numbering.docType` for the records the kernel numbers (#1401; a doc type ending in `<column>` takes that column's value, so `finance.cash_voucher.<voucher_type>` gives receipts, payments and bank credits and debits (PT, PC, BC, BN) a series each) and `audit` (`command`: every change is an audited command; `append_only`: and the table carries the append-only trigger, so a correction is a new row). The entities are the record types the code already names: the commands' audit targets, the numbered vouchers, `finance.purchase_document` and `crm.booking`. `apps/kernel/test/manifest.db.test.ts` fails when a name does not follow `<module>.<entity>`, the table does not exist, `legalEntityScoped` differs from a `legal_entity_id` column, `audit` differs from the append-only trigger, a numbered entity's doc type is not the series a trigger on its table allocates for it (or a trigger numbers a series no entity declares), or a command's audit target is no entity (`kernel.user`, the control plane's account, aside). The plan's `numbering.scope` is always the legal entity (every series belongs to one) and its `period` stays the org's numbering policy, so neither is declared. Not built yet: `record`, `timeline`, `files`, `sharingDefault` and `classify` per entity (the columns' classes are per table), and `audit: 'row'` (a per-row history).

### 5.3 Naming rules

| Artifact | Rule | Example |
|---|---|---|
| Token (module id) | `^[a-z][a-z0-9]{1,11}$`. Modules: `crm service social email sign finance hr projects`. Reserved: `kernel`, `jobs` | `finance` |
| Package / schema / role | `@crove/mod-<id>` / `crove_<id>` / `crove_m_<id>` | `crove_m_finance` |
| Table / column / wire field | snake_case, singular table names; identical from SQL to JSON, OpenAPI, MCP, events | `journal_entry.posting_date` |
| Entity / command / query / event | `<id>.<entity>` / `.<verb>` / `.<get\|list\|search>` / `.<past>` + `version` | `finance.journal_entry.posted` v1 |
| Permission / LLM tool | `<id>.<entity>.<action>` / `.` replaced by `_`, <=64 chars | `finance_journal_entry_post` |
| Job / subscriber / DLQ | `<id>.<noun>.<verb>` / `<id>.sub.<handler>` / `<queue>.dlq` | `finance.bank_feed.sync` |
| Inbox / error code | `<id>.<entity>.<condition>` / `<ID>.<UPPER_SNAKE>` | `FINANCE.PERIOD_LOCKED` |
| Public CloudEvents | `com.crove.<event>.v<n>`, frozen in ADR-0014 | `com.crove.finance.journal_entry.posted.v1` |
| Migration | `^[0-9]{14}_crove_(kernel\|jobs\|crm\|service\|social\|email\|sign\|finance\|hr\|projects)_[a-z0-9]+(_[a-z0-9]+)*\.sql$` (UTC); every file in `supabase/migrations/` must match | `20261103090000_crove_finance_ledger_core.sql` |
| pgTAP | `supabase/tests/database/<token>/<desc>.test.sql` | - |
| Generated files | First line `// @generated by crove gen: do not edit` | - |

Existing fork schemas are not in the Crove DB. The `crove_` prefix is kept so self-hosters can share one database with other apps without name clashes.

### 5.4 Boundary rules and enforcement

| Rule | Mechanism | Fails at |
|---|---|---|
| No deep imports; isomorphic contracts; DAG | `exports` + pnpm isolation; dependency-cruiser generated from `dependsOn`; pure `domain/`; the shell does not import kernel/db | Typecheck, G5 |
| No cross-module SQL | Module role + `$pickTables` + ast-grep (SQL in `infra/` may only mention `crove_<id>.` and `crove_kernel.`) | `permission denied`, lint. On `main`: `tools/test/module-schemas.test.ts` (#1464) fails when a file under `modules/<id>/` names a schema other than `crove_<id>` and `crove_kernel` |
| Tenant conventions | `apply_tenant_conventions()` + pgTAP conformance | G3 |
| No side-door writes | Not exposed through PostgREST; revoked from anon, authenticated, PUBLIC; module roles cannot INSERT directly into outbox/audit | G3 |
| Valid registry | Every command has permission, risk (>= derived risk), idempotency, i18n, `implement()`, synthetic examples | G5 |
| Money and dates | Ban `parseFloat`/`Number()`/`+` on Money; ban `new Date(str)` and `Date.now()` outside Clock | G5 |
| Allowed imports | pg-boss, ai/@ai-sdk, @orpc/server, @base-ui only in their designated packages; ban string model ids and `@ai-sdk/gateway` | G5: `tools/test/allowed-imports.test.ts` (#1387) checks the sources and the workspace manifests: pg-boss and `@orpc/server` only in `apps/kernel`, `ai` and `@ai-sdk/*` only in `packages/agent`, `@base-ui/*` only in `packages/ui`, `@ai-sdk/gateway` nowhere; `tools/test/model-ids.test.ts` (#1462) refuses a model id literal of a known family in any product source (the model comes from `AI_MODEL`) |

### 5.5 DB schema and migrations

- **Modules:**
  - Each module has one schema `crove_<id>` and one role `crove_m_<id>` (NOLOGIN, member of `crove_tenant`, CRUD on its own schema through RLS).
  - A module's migration creates its own role with the same token, and seeds the catalog through `crove_kernel.register_catalog(jsonb)`. A new module therefore needs exactly 1 file.
- **Kernel:** `crove_m_kernel` writes the kernel entity tables; other modules may only SELECT.
- **FKs:**
  - Module -> `crove_kernel` is the only direction. Every FK between tenant tables is composite `(org_id, x_id)` with an index leading with `org_id`.
  - No FK leaves Crove's DB. Identity is a projection table in `crove_kernel` (§7.3): `role_assignment` -> `tenant_member` (CASCADE); `record.owner_user_id`/`party.user_id` -> `user_account` (SET NULL).
  - No FKs between modules. No Crove triggers on non-`crove_*` tables.
- **Migration discipline** (same as DOS, applied to Crove's own ledger):
  - Prod and beta receive schema only through the pipeline (§3.5): the `migrate` role of the released image. Never run DDL via Supabase MCP, the Dashboard or `psql` against `crove-db-prod`/`crove-db-beta`. Try DDL on a local PG17; every change must become a committed file before merge.
  - Every PR is replayed on plain PG17 by the built-in runner (G3); Crove Cloud adds a beta replay (G4).
  - The ledger is `crove_meta.schema_migrations` (version, name, sha256); it is never edited by hand, and the runner refuses a file edited after it was applied.
  - Never DROP a table or schema to fix drift: write a new idempotent forward migration (`CREATE … IF NOT EXISTS`), tested on a fresh database first.
  - Bulk backfills of the tables that send stream hints (`proposal`, `file`, `extraction`, `journal_entry`, `purchase_document`, `purchase_document_void`; the `stream_hint` triggers of #69) disable the trigger around the statement in the same file: `ALTER TABLE ... DISABLE TRIGGER stream_hint`, the backfill, `ALTER TABLE ... ENABLE TRIGGER stream_hint`. Each file runs in its own transaction, so the trigger is never left off. Otherwise every row sends one `NOTIFY`: the payloads are held in memory until commit, then go through the cluster's notification queue (8 GB, shared by every database; when it is full, every commit that notifies fails) to every API instance, whose open streams collapse them into one `resync` anyway. Open screens then get no hint for those rows and show them after their next refetch (window focus or navigation); when that is not enough, keep the trigger on for a small backfill and accept the `resync` (#281).
- **Runs on plain PG17 (self-host):** the `_crove_kernel_bootstrap` migration creates the `extensions` schema with `pgcrypto`, `pg_trgm`, `unaccent` (`btree_gist` from 2a; `pg_cron` optional, without it housekeeping runs in the worker). It is the only file allowed to touch the `extensions` schema. Statements touching Supabase-specific roles (`anon`, `authenticated`, `service_role`) are wrapped in existence guards.

```sql
-- 20261103090000_crove_finance_ledger_core.sql: one schema per file; idempotent; no BEGIN/COMMIT/CONCURRENTLY
SET LOCAL lock_timeout = '2s';
CREATE SCHEMA IF NOT EXISTS crove_finance;
CREATE TABLE IF NOT EXISTS crove_finance.journal_draft (org_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(), legal_entity_id uuid NOT NULL, …, PRIMARY KEY (org_id, id));
DO $$ BEGIN ALTER TABLE crove_finance.journal_draft ADD CONSTRAINT journal_draft_le_fk FOREIGN KEY (org_id, legal_entity_id)
  REFERENCES crove_kernel.legal_entity (org_id, id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS journal_draft_le_idx ON crove_finance.journal_draft (org_id, legal_entity_id);
SELECT crove_kernel.apply_tenant_conventions('crove_finance.journal_draft', 'finance', '{"mode":"crud","le_scoped":true}');
-- Hot tables (in a _crove_kernel_ file): the generator emits a lock-retry block
DO $$ DECLARE n int := 0; BEGIN LOOP BEGIN
    PERFORM set_config('lock_timeout', '2s', true);
    ALTER TABLE crove_kernel.audit_event ADD COLUMN IF NOT EXISTS surface text; EXIT;
  EXCEPTION WHEN lock_not_available THEN n := n + 1; IF n >= 15 THEN RAISE; END IF; PERFORM pg_sleep(1 + random());
  END; END LOOP; END $$;
```

**G2 migration-lint** (uses `libpg-query`, parses `DO` bodies too):
- **Required:**
  - touch only the schema named in the file name;
  - `IF NOT EXISTS`, `OR REPLACE` or a guarded `DO`;
  - `DROP POLICY IF EXISTS` before every `CREATE POLICY`;
  - `SET search_path = pg_catalog, pg_temp` on **every** function (an empty path still resolves type names in the caller's temporary schema first);
  - `REVOKE ALL ON FUNCTION … FROM PUBLIC` plus explicit GRANTs;
  - a retry block for DDL on hot tables (`outbox_*`, `audit_event`, `record`, `idempotency_key`, `processed_message`, `crove_jobs.*`);
  - a contract header on every breaking statement.
- **Banned:** `CONCURRENTLY`, `BEGIN`/`COMMIT`, `DROP SCHEMA`, `TRUNCATE`, GRANTs to anon or PUBLIC.

### 5.6 Cross-module communication

1. **Reads:** via `ctx.query` (RBAC re-checked) or kernel read models. Never direct SQL on another module's tables.
2. **Writes:** via events with idempotent subscribers, or the caller invokes the other module's command. Atomicity relies on natural keys, e.g. `UNIQUE(source, source_revision)`.
3. **Kernel services** callable in the same transaction: `timeline`, `files`, `records`, `numbering`, `inbox`.
4. **UI** composes only through slots and the `RecordRef` renderer.
5. **Cross-module links** use `crove_kernel.record_link` (Phase 3), not FKs.

### 5.7 Core modules

| Module | Replaces fork / reference | Contents |
|---|---|---|
| CRM (`crm`) | Twenty; Cal.com, Calendly | Contacts, companies, deals, pipelines, timeline; Calendar and booking pages |
| Service (`service`) | Go Desk; Zendesk | Unified inbox: email, social messages and comments; tickets, SLA |
| Social (`social`) | Postiz; Publer, Nuelink, Buffer | Compose, schedule, queues, reposting, analytics |
| Email (`email`) | Mailchimp, Brevo, listmonk; Postmark, Amazon SES | Transactional templates and message log, sender domains, contacts with consent, campaigns, unsubscribe, analytics ([email.md](email.md)) |
| Sign (`sign`) | Documenso; Docusign | Digital signatures via Vietnamese CAs, templates, signing order, audit certificate |
| Accounting (`finance`) | MISA | TT133/TT99 books, vouchers, e-invoices, banking, reports |
| HRM (`hr`) | | Employee records, labor contracts, timekeeping, leave, payroll |
| Projects (`projects`, later) | | Tasks, boards, billable hours |

Every module shares from the kernel: `party`, `activity`, `task`, `file`, `calendar`, `channel`, permissions, `execute()` and the org's agent.

- **Calendar lives in CRM.** The core (events, availability, external calendar sync) is the kernel `calendar` service, so HRM (interviews, leave) and Service (customer appointments) share it. The Calendly-style booking page is a CRM feature.
- **Service and Social share the `channel` layer but are two modules.** Each Facebook, Instagram, Zalo OA or TikTok page connects once. Messages and comments land in Service's inbox; Social only publishes. They are split because the users and permissions differ (customer support vs marketing) and so does the cadence (SLA-driven replies vs scheduled posting). In the UI, a post shows its comment count and opens straight into the conversation.
- **Sending mail is a kernel service; Email is the module that manages it.** Every module sends mail through the kernel pipeline (queue, log, suppression, one send per mail), so it works with `email` off; the Email module adds domains, templates, consent and campaigns ([ADR-0034](../adr/0034-outbound-email.md)). Replies to campaigns go to the org's Reply-To address until Service's inbox can take them.

## 6. Core data model

**Conventions for every tenant table** (with helpers and meta-tests):
- **Keys:** `org_id uuid NOT NULL` FK -> `tenant`; `id uuid DEFAULT uuid_v7()`; `PRIMARY KEY (org_id, id)`. **No global UNIQUE(id).** App-issued ids must be v7, with clock skew of at most ±5 minutes.
- **Standard columns:** `created_at`, `updated_at`; `version integer` on mutable aggregates.
- **Types:** enums are `text` + CHECK; money uses the kernel domains; accounting dates are `date`.
- **Global reference tables:** no `org_id`, on an allowlist, immutable once published.
- **Unique violations:** return a generic 409 that does not reveal whether an id exists.
- **Phase:** **v0** is Phase 1. **2a/2b/3/4** is the phase that pulls the table in. "later" means when a second consumer appears.

| Table (`crove_kernel`) | Key points | Phase |
|---|---|---|
| `tenant` | `org_id uuid PK` (issued by Crove, v7); `slug`, `name`; status `active\|offboarding\|closed`; `inbound_token` (the active inbound token; every token ever issued is in `inbound_address`); locale, timezone, `base_currency`, `authz_version`; `external_org_id` (nullable, UNIQUE when set) for DOS org sync later. On `main`: status `active\|closed`, no `external_org_id` yet | v0 |
| `user_account` | `id uuid` (issued by Crove); UNIQUE `(issuer, subject)` from the verified Supabase token; email, name, `disabled_at` and `upstream_blocked_at` (ADR-0028), `last_seen_at`. Not named `user` because that is a Postgres keyword. A machinery table without `org_id`, on the conformance allowlist | v0 |
| `tenant_member` | PK `(org_id, user_id)`; `role` (Crove base role); written only by commands (create org, accept invite, change role, remove; audited); rows are inserted only by the definers `create_or_replay_org` and `invite_accept`, and tenant roles may update only `role` (since #132); deleting the row revokes (§7.3). With DOS org sync (later): `source`, `confirmed_at`, `source_seq` | v0 |
| `member_invite` | PK `(org_id, id)`; `email` (lower-cased), `role` (`admin`, `member` or `viewer`), `token_sha256` (UNIQUE; the token itself is never stored), `status` `pending\|accepted\|revoked`, `invited_by`, `expires_at` (7 days, at most 30), `accepted_by`/`accepted_at`, `revoked_by`/`revoked_at`. An invite changes once, from pending to accepted or revoked; an accepted invite commits only with its audit row (§7.3) | v0 |
| `auth_session` | PK `(user_id, session_id)`; `status` `active\|revoked`, `first_seen_at`, `revoked_at`, `revoked_by`, `reason`, `evidence_at` (Crove Cloud), `last_seen_at` (updated at most once a minute). Status only: sessions live in Supabase Auth and Crove issues no tokens (ADR-0027, ADR-0028). A machinery table without `org_id`, on the conformance allowlist | v0 |
| `idp_event` | Crove Cloud: dedupe for DOS org sync events (DOS-27) and, if the optional refinement is built, DOS ID session and user lifecycle events (ADR-0028, DOS-28); PK `(source, event_id)`, 30-day TTL; the last applied sequence and checkpoint are kept alongside | Cloud: DOS org sync |
| `context_key` | Singleton, readable only by `crove_ctx`; random per environment; never exported | v0 |
| `legal_entity` | kind, `tax_code` (UNIQUE when present), parent. On `main` (#1278): kind `company\|branch\|household`, `tax_code` unique per org, `parent_id` (composite FK, no cycle), exactly one `is_default` per org, created with the org by `create_or_replay_org` and backfilled from `tenant.tax_code`; its tax code is the org's (only `kernel.org.set_tax_code` changes it); never deleted; a RESTRICTIVE policy on `ctx_le_scope()` beside the tenant policy | v0 |
| `module_setting`, `org_policy`, `currency`, `entity_type`, `permission` | Catalog seeded from manifests | v0 |
| `record` | <ul><li>UNIQUE `(org_id,id,entity_type)`.</li><li>`legal_entity_id`, `owner_user_id`, `visibility`, `version`.</li><li>`source_trust external\|user\|system`, `verified_at/by`.</li></ul> | v0 |
| `record_le` | Links org-wide records to legal entities | v0 |
| `role`, `role_permission`, `role_assignment` | `(org_id, user_id)` FK -> `tenant_member` (CASCADE). On `main` (#1279): `role` and `role_permission` are global catalog rows (the built-in roles below but the base roles and `team_lead`; `finance.chief_accountant` grants `finance.proposal.approve` and `finance.period.unlock`); `role_assignment` is org-wide or names one legal entity (`external_accountant`), read-only for tenant roles and written by two owner-only definers through the R3 commands `kernel.member.role.assign` and `kernel.member.role.revoke`; custom roles are not built | v0 |
| `position` | Org chart seat: title, module, `role_key`, `reports_to` (composite FK, no self-reference, cycle trigger under a per-org lock), `holder_user_id` (FK -> `tenant_member`, `ON DELETE SET NULL`) or `holder_agent_id`, at most one; `le_scope`, `flags`, structured `job_description`, status; the owner is the root (ADR-0029) | v0 |
| `agent`, `agent_grant` | Agents (not `tenant_member`s): `template_key`, `max_risk`, `runtime builtin\|external`, `model_alias`, status `active\|paused\|retired`; a grant holds permissions, `max_risk`, legal entities, limits, trigger classes, expiry | v0 |
| `agent_wakeup`, `budget_policy` | Wake-up requests (assignment, mention, event, schedule), coalesced per agent / budget per agent, module or org with warn % and hard stop (ADR-0029) | v0 / 2a |
| `org_entitlement` | Static seed + abuse limits | v0 |
| `idempotency_key` | PK `(org_id, actor_key, key)` | v0 |
| `outbox_event` / `outbox_pending` / `event_subscription` / `processed_message` | Insert-only / hot queue / fan-out seeded by migration / PK `(consumer, event_id)` | v0 |
| `audit_event` / `security_event` | Partitioned by year / pre-membership rejections, 30-day TTL | v0 |
| `proposal` / `inbox_item` | Proposals carry `revision`, `authors[]`, `eligible_approvers`; states in §8.3 | v0 |
| `ai_run` / `ai_step` | Payloads in S3 `org/<org_id>/…`; `ai_step` kept 180 days | v0 |
| `kill_switch`, `staff`, `support_grant` | §4.12 | v0 |
| `inbound_address` | Ledger of every inbound email token ever issued (§7.6): `token` UNIQUE across active and retired rows, `retired_at` as the tombstone, at most one active row per org. Rows are never deleted or changed except to retire an active one, for every role. Only definers read or write it. On `main` (#112) the active token is also kept in `tenant.inbound_token`, which must match the org's active row at commit, so the resolver and the org query read one column | v0 |
| `mail_message`, `mail_suppression`, `mail_event` | Outbound mail: one row per mail to one recipient, the suppression list keyed by an address hash (kept after erasure), append-only provider events ([email.md](email.md) §3.2, ADR-0034) | Email E1-E2 |
| `number_series`, `number_allocation`, `external_call`, `process_instance`, `connection_binding`, `credential`, `document`, `document_version`, `field_history` (yearly partitions, PII crypto-shredded), `subject_key` | | 2a |
| `ai_thread`, `ai_message` (per-user RLS) | | 2b |
| `usage_counter`, `feature_flag*` | | Before charging |
| `record_share`, `sharing_default`, `saved_view`, `custom_field_*`, `record_link`, `api_key`, `webhook_*`, `search_doc` | | 3 |
| `automation*`, `notification_pref`, `activity_link` | | 4 |
| `search_chunk`, `list*`, `eval_candidate` | | later |

| Table (kernel module, written by `crove_m_kernel`) | Key points | Phase |
|---|---|---|
| `party`, `party_role`, `party_relationship` | <ul><li>kind, name, `user_id`, status, `verified_at/by`.</li><li>A "known counterparty" means one verified by a human.</li><li>Deduplication is the R1 command "mark duplicate"; destructive merge comes later.</li></ul> | v0 |
| `contact_point` | `value_norm`, **not** unique (Vietnamese SMEs often share phone numbers); `source_trust`, `verified_at` | v0 |
| `party_identifier` | UNIQUE `(org_id, type, value_norm)`; an individual's tax code (= national ID/CCCD, per Circular 86/2024) is classified `national_id` | v0 |
| `address`, `admin_unit`, `admin_unit_successor` | Scheme `vn-2025` (34 provinces, 3,321 communes) + a mapping table from the old administrative boundaries | v0 |
| `inbound_message` | UNIQUE `(org_id, channel, external_id)`; always `external` | v0 |
| `file`, `file_link` | <ul><li>`storage_key org/<org_id>/<sha256>` plus `generation`.</li><li>sha256 computed by the server.</li></ul> | v0 |
| `file_upload` | Single-use grants behind presigned staging uploads (§7.6, ADR-0013): staging key, creator, size limit, created and expiry times from the database clock, `used_at` set once by the claim. Tenant roles insert and claim only; no delete | v0 |
| `extraction` | Always `tainted`; keyed on `(file, schema_key, schema_version, extractor_version)` | v0 |
| `activity`, `task`, `tag`, `record_tag`, `notification` | System-kind activity written only via a definer; notifications per user. `task`: `assignee_position_id`, `parent_task_id`, `source`, status, `request_depth`, atomic checkout (ADR-0029) | v0 |
| `follower` | | later |

**Search v0:** `pg_trgm` on normalized `record.title`: `lower(extensions.unaccent(normalize(x, NFC)))`, through RLS. `search_doc` comes in Phase 3; the projector never copies fields classified `pii`, `national_id` or `sensitive`.

## 7. Multi-tenancy & security

### 7.1 Roles

| Role | Attributes / privileges | Membership | Purpose |
|---|---|---|---|
| `crove_api` | LOGIN NOINHERIT; limits and timeouts per §3.3; EXECUTE only (`enter_context`, `my_orgs`, `identity_upsert`, `auth_session_valid` (self-host, ADR-0028), `record_inbound_message`, `record_inbound_webhook`, `schema_missing`) | `crove_m_*` (SET, no INHERIT) | API |
| `crove_worker` | LOGIN NOINHERIT | `crove_m_*`, `crove_system` (SET) | Worker, Jobs |
| `crove_queue` | LOGIN NOINHERIT; DML on `crove_jobs` | - | pg-boss |
| `crove_prober` | LOGIN; EXECUTE `health()`, `prober_alert_gate()` | - | Prober |
| `crove_tenant` | NOLOGIN, group | - | Target of every tenant policy |
| `crove_m_<id>` | NOLOGIN | `crove_tenant` (INHERIT) | Module role |
| `crove_system` | NOLOGIN; EXECUTE on cross-tenant machinery; DML on `crove_jobs` | - | Relay, purge |
| `crove_owner` | NOLOGIN | - | Owns the `crove_*` tables |
| `crove_ctx` | NOLOGIN NOBYPASSRLS | - | Owns `enter_context` and `ctx_*`; reads `context_key`, `tenant`, `tenant_member`, `user_account`, grants/keys/roles through explicit policies |
| `crove_auth_reader` | NOLOGIN | - | ADR-0028, self-host only: SELECT on `auth.sessions` and `auth.users`, granted by the one-shot `auth-grants` step after Supabase Auth's first start; owns `auth_session_valid` |
| `crove_definer_identity` | NOLOGIN | - | The only writer of `user_account` (`identity_upsert`, EXECUTE to `crove_api`) and of the tenant row and first owner membership (`kernel.org.create`, through `execute()`); later `identity_apply` for DOS org sync (EXECUTE to `crove_system`) |
| `crove_definer_tenant` | NOLOGIN | `crove_tenant` (INHERIT) => RLS applies to it | `emit`, `audit_write`, numbering, posting, proposals |
| `crove_definer_system` | NOLOGIN | - | Outbox claim, purge, refresh: EXECUTE only to `crove_system`. Exception: `schema_missing()` (reads `crove_meta.schema_migrations`) is granted to every Crove login role |

- On `main`: two login roles, `crove_app` (API) and `crove_worker`, both INHERIT members of `crove_tenant`, which holds the table grants; `crove_definer_tenant` exists and owns `crove_finance.post_journal_entry` (#71), while the other definers are still owned by the migration owner; there are no module roles yet; self-host adds `supabase_auth_admin` for the bundled Supabase Auth. The table above is the decided design.
- Roles are created idempotently with drift guards: `createrole_self_grant=''`; raise if a role is superuser, has bypassrls, createrole, createdb, or the wrong login/inherit.
- Passwords are set by the `migrate` role from environment variables (self-host) or from Secret Manager by the Cloud deploy workflow. Rotation is two-step (new secret version -> deploy -> verify -> drop the old one), checking `supabase network-bans` to avoid Fail2ban.
- G3 asserts the **exact EXECUTE matrix** of every role, and runs generated negative tests with forged org/legal-entity parameters.

### 7.2 RLS template

```sql
DROP POLICY IF EXISTS tenant_isolation ON crove_finance.invoice;
CREATE POLICY tenant_isolation ON crove_finance.invoice AS PERMISSIVE FOR ALL TO crove_tenant
  USING (org_id = (SELECT crove_kernel.ctx_org_id())) WITH CHECK (org_id = (SELECT crove_kernel.ctx_org_id()));
DROP POLICY IF EXISTS le_scope ON crove_finance.invoice;
CREATE POLICY le_scope ON crove_finance.invoice AS RESTRICTIVE FOR ALL TO crove_tenant
  USING (crove_kernel.le_allowed(legal_entity_id)) WITH CHECK (crove_kernel.le_allowed(legal_entity_id));
-- le_allowed: TRUE when scope is an explicit '*' or the id is in scope; missing scope or bad seal => FALSE
```

- Per-user policy: `USING (user_id = (SELECT crove_kernel.ctx_user_id()))`, on `ai_thread`, `ai_message`, `notification`, `follower`.
- Load test list queries with 100k records in a single tenant.

### 7.3 Identity seam

Identity comes from Supabase Auth (Decision 5, ADR-0027); how the kernel verifies tokens, checks revocation and requires step-up is set by ADR-0028 (accepted 2026-10-14, design C; External-tenant gate T1). Crove issues no sessions and runs no OIDC client: social and OIDC providers are configured in Supabase Auth.

1. **Every request:** the kernel verifies the access token locally (§7.5), checks the Crove session status record in the request transaction (ADR-0028), and maps `(issuer, subject)` to `user_account` through the `identity_upsert` definer (created on first use; email and name refreshed). The mapping may be cached briefly; it carries no authorization.
2. **Membership lives in Crove.** `tenant_member` is written only by commands through `execute()`, all audited: the org creator becomes `owner` (`kernel.org.create`); owners and admins invite an email with a role and the person joins only by accepting (below); owners change any member's role, co-owner included (`kernel.member.change_role`), and remove members (`kernel.member.remove`) (#36, done in #115). Both are R3 and owner only; they lock the org's owner rows with the actor and the target and re-check the actor's role under the lock, so the org always keeps an owner, even when two owners demote each other at once, and an owner cannot remove themselves (409 `LAST_OWNER`, 422 `CANNOT_REMOVE_SELF`; a `LAST_OWNER` refusal's audit row records the same `target_user`, `role` and `previous_role`). The database backs this up (#119): a deferred constraint trigger on `tenant_member` refuses to commit any transaction, from any role, that leaves an org without an owner (`LAST_OWNER`), with an advisory lock per org so two transactions that each remove a different owner are checked one after the other; there is no exception for closing or deleting an org, since neither path exists yet (§7.9). The settings screen asks for an inline confirmation before a removal and before any change that gives or takes owner rights (promotion to owner, demoting an owner, the owner's own role). `enter_context` reads membership in every transaction, so removal takes effect on the next request. **In-flight requests:** a request that entered the org before a removal or demotion committed may finish with the role it entered with (its context and the rows it read are from before the change); the guarantee is the next request, and approvals (P12) and membership commands re-check roles under row locks, so neither acts on a role that changed before it took the lock. JWT claims never grant membership or roles. Every role or membership change records `target_user`, `role` and `previous_role` in its audit row (`previous_role` is null for a new member, `role` is null for a removal; #88).
   - **Invites with consent** (#35; #125, and #132 removed `kernel.member.add`, which attached any registered user by email without consent and answered `USER_NOT_FOUND` otherwise, with the `user_id_by_email` definer and the tenant roles' INSERT and non-role UPDATE on `tenant_member`, so no path but `create_or_replay_org` and `invite_accept` creates a membership): `kernel.member.invite.create` (R3, fresh MFA; owners and admins, and only owners invite admins; the actor's role is re-checked under `FOR SHARE` on the owner rows and the actor's row, in the order role changes lock them) stores the invite with the SHA-256 of a 256-bit random token and returns the accept path `/-/invite#<token>` once, to the inviter; the fragment keeps the token out of server logs and `Referer`. It never looks the email up, so its answer is the same whether or not an account exists; inviting a current member is 409 `ALREADY_MEMBER` (the inviter can see members anyway), a new invite for the same email replaces the pending one, and an org holds at most 100 pending invites. The invitee previews (`invite_peek`) and accepts (`kernel.member.invite.accept`, org-less like `kernel.org.create`): the definer `invite_accept` checks that the invite is pending and unexpired, that the signed-in user's email (`user_account.email`, written only from verified access tokens) is the invited one, and that the inviter is still a member who may grant that role, then inserts the membership (an existing membership keeps its role) and marks the invite accepted; `execute()` enters the org as the new member and writes the audit row in the same transaction, and a deferred trigger refuses to commit an accepted invite without it. The org comes from the invite alone. Removing a member revokes their pending invites, and a role change revokes those the member can no longer issue (all of them for a member or viewer, the admin invites for an owner who becomes an admin), in the same transaction and recorded as `revoked_invites` in its audit row (#134); accepting still re-checks the inviter as a backstop, and locks the inviter's membership row before the invite row, the order the member commands use, so the two never deadlock. An admin never undoes an owner's decision: an admin's invite for an email with an owner's pending, unexpired invite is refused (409 `INVITE_PENDING_BY_OWNER`, audited with the protected invite) and the owner's invite stays; an admin cannot revoke such an invite either, and a revoke re-checks the actor's role under the same locks. On self-host (`AUTH_SESSION_CHECK=db`) accepting and previewing also require `auth.users.email_confirmed_at` for the user (403 `INVITE_EMAIL_UNCONFIRMED`); the `auth-grants` step waits for that column and grants it, and without the grant or the column itself invites answer 503 rather than skip the check, while other requests are unaffected (#208). The app keeps a pending invite token in the browser for at most an hour and drops it on sign-out. Declining is not recorded (the invite stays pending until it expires or is revoked). The API mails the accept link to the invitee right after the invite commits (#129: SMTP from `SMTP_*`, Mailpit locally, off without `SMTP_HOST`). Only that response holds the raw token and outbox payloads are stored as plain JSON, so the mail cannot come from a worker: it is sent synchronously with two retries on transient errors within a 10-second deadline, and its outcome is logged (error codes only, never the link) and never changes the answer or fails the invite; the inviter still sees the one-time link and passes it on when the mail did not arrive. The mail is the same whether or not the email has an account. Each invite sends a mail, so an org may create at most 50 invites in any 24 hours and 3 per email, and one address gets at most `INVITE_LIMIT_PER_RECIPIENT_PER_DAY` invites (default 5) in any 24 hours from all orgs together, since one account may create several orgs (revoked, replaced and accepted ones count; 429 `INVITE_RATE_LIMITED` with the rule `invite_org_per_day`, `invite_email_per_day` or `invite_recipient_per_day` and the limit). The counts are exact under concurrency (#185): before it reads the pending invite it replaces, the command takes a transaction-level advisory lock per org and then one per recipient email (`invite_mail_lock`, under a 3-second `lock_timeout` set around the locks and restored after; a longer wait or a deadlock is 429 `invite_busy` with `retryAfterSeconds` 1), so invites of one org, and invites of one address from any org, run one at a time, and the definer `invite_mail_gate` counts under those locks. The cap per recipient reuses the `member_invite` rows (no new table keeps emails): the definer reads other orgs' invites of the address, returns nothing and only refuses, never reads accounts, so its answer is the same whether or not the address has an account, and it tells the inviter only that this address got too many invites, never who invited it or when. It refuses only an org's repeat invites of the address: an org's first invite of it in the window always passes, so a stranger with a few orgs cannot use up the cap and keep the address's real employer from inviting it (one account still mails one address at most the larger of the cap and the number of orgs it runs per day). Only an owner or admin of the org in the sealed context may call these definers. The limits that key on an address count its inbox, not its spelling (#270): `invite_cap_key` lower-cases and trims, strips a `+tag` from the local part for every domain and, for the providers known to ignore dots (gmail.com, with googlemail.com folded into it), removes the dots from the local part; no other provider's dots fold, since `a.b@example.com` and `ab@example.com` may be two people, and a provider that treats `+` as an ordinary character only gets a stricter cap. The per-recipient cap, the org's per-email limit, its first-invite exemption and the recipient lock all use that key (an expression index keeps the count to one inbox's recent rows); it never decides who an invite is for: the invite stores the email as given, and acceptance, `ALREADY_MEMBER` and the pending-invite replacement still compare that email. `created_at` is the database's `clock_timestamp()` when the row is written, after the locks, which is the clock of the window, so clock skew between API hosts and the database no longer moves the window edge (the expiry stays the API's clock plus the TTL; an API clock more than the TTL behind gives an invite born expired, dated just before its expiry). Before taking the locks, the command runs its refusals once on what has committed (`INVITE_PENDING_BY_OWNER`, `TOO_MANY_INVITES`, then `invite_mail_precheck`, the gate's counts without the locks), so an invite already over a limit is refused at once with the same answer instead of waiting up to 3 seconds for the locks and holding up other orgs' invites of the address meanwhile; the pass under the locks stays the authority. Public deployments refuse `AUTH_AUTOCONFIRM=true`, so the email in a token has been confirmed by Supabase Auth; on localhost with autoconfirm anyone can claim any email.
3. **Crove Cloud** runs the same code pointed at DOS's Supabase Auth, so DOS ID accounts sign in to Crove. Each Supabase Auth has its own issuer, so `user_account` rows from different deployments never collide.
4. **DOS org sync (deferred, Crove Cloud only).** When per-org billing through DOS.AI needs it (Tracking, deferred table), a `crove-cloud` adapter projects DOS org membership into `tenant_member`, one way (DOS -> Crove):
   - changes arrive as HMAC-signed DOS-27 events (`org.member.added|removed|role_changed`, `org.deleted`, `team.*`, `user.disabled|deleted`), checked for signature and timestamp (±5 minutes), deduped in `idp_event`, applied per org by `seq`; stale events are dropped;
   - leaving an org deletes the `tenant_member` row (cascading `role_assignment`), revokes related grants and keys and bumps `authz_version`; `org.deleted` moves the tenant to `offboarding` (§7.9);
   - a reconcile job compares the projection with the DOS-Me API every 6 h and after repeated webhook failures, fixes drift and alerts when Crove grants more than DOS;
   - each synced membership carries `confirmed_at`; if it is not reconfirmed within 24 h, `enter_context` rejects and queues a reconcile;
   - writes go only through `crove_definer_identity` definers, audited; DOS roles map only to the base role (§4.6);
   - it is enabled only after gate DOS-1 passes. Self-host is unaffected.

**Rest of the seam:**
- Business data never syncs to or from DOS. Crove transactions write only `crove_*`.
- RLS uses the sealed context, not JWT claims.
- Each role has its own connection fence.

**Meta-tests reject:**
- non-composite FKs;
- FKs pointing outside `crove_kernel`, or outside the `crove_*` schemas;
- FKs without an index;
- Crove triggers on tables outside `crove_*`.

**Changing identity provider** (e.g. a self-hoster moving from the bundled Supabase Auth to another Supabase Auth): map the old `(issuer, subject)` to the new one with an audited staff command; Crove's `org_id` and `user_account.id` don't change. Replacing Supabase Auth with another product needs a new identity adapter (ADR-0027).

### 7.4 Credentials and bindings

- **Crove-generated secrets** (inbound email secret, webhook secrets): each deployment holds its own. Cloud uses Secret Manager; self-host uses env vars or its own secret store. There is no path from the Crove DB to DOS's Vault. API keys are stored only as sha256.
- **Third-party credentials** go through the `CredentialBroker` adapter:
  - `crove-local` (every deployment): tokens envelope-encrypted with the deployment key (Cloud: KMS), stored in `crove_kernel.credential`; only jobs with `egress: provider:<x>` can decrypt.
  - `dos-broker` (Cloud, optional): `public.provider_connections` + DOS's Vault, called through the DOS-Me broker (DOS-8, DOS-20).
- **`connection_binding`** is created only through a definer, which requires all three:
  - the connection belongs to the acting user;
  - that user is a member and holds the `kernel.connection.bind` permission;
  - for `dos-broker`: the connection's `organization_id` matches the tenant's `external_org_id` (after DOS-8).
- **On every use:** re-check that the owner is still a member. If not, cancel the job and raise an Inbox item.
- **Calling the DOS broker:** send the org and `binding_id`. The broker contract is DOS-20.

### 7.5 Auth and sessions

Supabase Auth issues and owns sessions (Decision 5, ADR-0027). ADR-0028 (accepted 2026-10-14, design C; Decision 16) sets how the kernel verifies them, tracks their status and revokes them.

- **Login (SPA):** `@supabase/auth-js` with PKCE: email + password, magic link, Google/Microsoft/OIDC providers, MFA and password reset. Self-host runs Supabase Auth in the compose stack behind the kernel's `/auth/v1` proxy; Crove Cloud points the same code at DOS's Supabase Auth (accounts shared with DOS ID). Sign-up, email confirmation and SMTP are Supabase Auth settings; the kernel refuses to start on a public URL with auto-confirm on or a sample JWT secret (implemented in `config.ts`). On `main` (#32): PKCE callbacks for the confirmation and recovery links (the bundled Supabase Auth builds those links with the `/auth/v1` prefix), a new-password screen, TOTP enrollment under Settings and the sign-in challenge (`/mfa`); Playwright covers these plus refresh and sign-out; magic link and OAuth providers are not built yet. A user with a verified MFA factor finishes signing in with the challenge before any data: on self-host the kernel refuses that user's `aal1` token on every request with 401 `MFA_REQUIRED` (#126), and the SPA answers it with the challenge, not a sign-out, so a password or a recovery link alone opens nothing.
- **Kernel, every request** (ADR-0028):
  - verifies the access token locally with `jose`: JWKS (ES256/RS256) when `AUTH_JWKS_URL` is set, otherwise HS256 with the deployment's JWT secret; issuer, audience and expiry required, plus `sub`, `session_id` and `role = authenticated`; anonymous tokens rejected;
  - in the request transaction, checks the Crove session status record (`auth_session`, by user and `session_id`), the user's state and membership, fail closed. The record's upstream status comes from one `SessionStatusSource` interface with two adapters:
    - self-host (`AUTH_SESSION_CHECK=db`, the bundled Supabase Auth on the same PostgreSQL): reads `auth.sessions` (including `not_after`), the user's ban or deletion and whether the user has a verified MFA factor (`auth.mfa_factors`, `user_id` and `status` only) through the minimal-grant `crove_auth_reader`, after the one-shot `auth-grants` step has granted that read; revocation takes effect on the next request;
    - Crove Cloud (`AUTH_SESSION_CHECK=jwt`, the default without `AUTH_UPSTREAM_URL`; DOS's Supabase Auth, no DB access; owner decision 2026-10-15): Supabase Auth's default behavior. The verified token is trusted until its `exp`, on top of Crove's own records (revoked sessions, `disabled_at`) and membership; no per-request call to Auth and no DOS-side change. A sign-out, ban or deletion outside Crove destroys the refresh tokens at once, so access ends when the access token expires: the SLA is the JWT expiry of DOS's Supabase Auth project (15 minutes recommended to DOS). R3 is checked live (below). An `aal1` token does not say whether its user has a verified factor, so the #126 rule needs the identity provider to state it in the token (ADR-0028 section 3); until then Cloud asks for the second factor only on R3. DOS ID lifecycle events with checkpoints (DOS-28) are an optional later refinement, triggered when a customer needs faster cross-app revocation;
  - `email` stays required and non-empty, so phone-only Supabase Auth users get 401;
  - maps `(issuer, subject)` to `user_account`; `enter_context` checks membership in every transaction.
- **Revoke session or device:** the user, an org owner or admin (for a member of their org) and staff revoke one session or all sessions of a user through an audited command. Crove marks the record `revoked` in the same transaction, so it takes effect immediately in both adapters, then asks Supabase Auth to sign the session out so its refresh tokens are destroyed (self-host: the admin sign-out with a short-lived token for that session; Cloud: Crove-side only, since Crove has no admin access to DOS's Supabase Auth). A refresh keeps the `session_id`, so the revoked record also blocks refreshed tokens.
- **On `main`:** the self-host path is implemented (#22): issuer, audience, expiry, `sub`, `session_id` and `role` are required and boot fails without `AUTH_ISSUER`; every request runs `crove_kernel.session_check` in its transaction (Crove record, `disabled_at`, and with `AUTH_SESSION_CHECK=db` the `auth.sessions` and `auth.users` rows, read after `auth-grants`, which also adds a SELECT policy because Supabase Auth enables row-level security on those tables); through `kernel.session.revoke` the user revokes their own sessions globally (the worker then signs them out in Supabase Auth, `local` or `global`), and an org owner revokes a member's session in that org only (`auth_session_org`; no global record, no upstream sign-out, because one org's owner has no say over the member's other orgs); a user with a verified MFA factor gets 401 `MFA_REQUIRED` for an `aal1` token on every request (#126). Crove Cloud runs `AUTH_SESSION_CHECK=jwt` (Crove records only per request, R3 live check with `GET /user`; boot fails on a public URL without `PUBLIC_AUTH_URL` or `AUTH_UPSTREAM_URL`). The route enumeration test is in the invariant suite (#693). The operator blocks or unblocks an account with the `user-disable` and `user-enable` image roles (#985, `docs/runbooks/user-disable.md`: `disabled_at` through the worker-only `crove_kernel.user_set_disabled`, audited in each of the user's orgs); the full staff actor of §4.12 is still to come. Not yet: approver re-checks in jobs (no job executes approved R3 work today: approval runs the command in its own transaction), the per-org P11 opt-out. External-tenant gate T1 tracks the rest.
- **Step-up (R3):** posting, legal or money actions, membership and role changes check Supabase Auth live at execution time (Cloud: `GET /user` with the token, no cache, after the role and MFA checks; 200 for the same user passes, other 4xx is 401, network error, 429 or 5xx is 503; self-host: the per-request `db` read of `auth.sessions` and `auth.users` is that check) and need `aal = aal2` with a second-factor `amr` timestamp in the last 5 minutes (policy P11); otherwise 403 `STEP_UP_REQUIRED` and the SPA runs an MFA challenge. Jobs that execute approved R3 work re-check the approver's session record and permission first. On `main`, every R3 command run by a user requires `aal2` and a second-factor `amr` timestamp in the last 5 minutes, and the audit row records `aal`, `session_id` and that timestamp (#22); Compose defaults to `AUTH_STEP_UP=required` since the MFA screens shipped (#32); `off` is accepted on a local URL only. The live check is implemented for Cloud (`jwt`, #22).
- **Supabase Auth down:** no new logins, no token refresh and no R3 (503); existing sessions keep working (self-host: as long as the DB is up; Crove Cloud: until each access token expires); alert (§7.10).
- **Access token lifetime:** the self-host compose stack sets 15 minutes (`GOTRUE_JWT_EXP=900`) as defense in depth; revocation does not depend on it. Crove Cloud uses DOS's setting.
- **API and MCP clients:** `/v1` and `/mcp` accept only tokens from the OAuth 2.1 authorization server (Decision 14, Phase 3), never a user's browser token.
- **Shell:**
  - `@supabase/auth-js` keeps the session in browser storage and refreshes it; the SPA sends the access token as Bearer. Runtime config (`/api/config`) carries no secrets.
  - Logout calls Supabase sign-out, which removes the session; the old token fails on the next request in self-host and at its expiry on Crove Cloud (immediately once the SPA also revokes the session in Crove before signing out, a follow-up); the SPA clears its query cache and tells other tabs.
  - Client route guards (`beforeLoad`) are UX only.
  - Hash-based CSP + Trusted Types for the static `index.html` (spike A14, retargeted by Decision 6); no third-party scripts.
- **Redirect URLs:** Supabase Auth allows redirects only to domains the owner controls (self-host: `PUBLIC_URL`; Cloud: `app.crove.com`, a DOS-side change, issue #54).

Superseded design (kept only so older references resolve): Crove-issued session JWTs and refresh tokens, the `session` table, OIDC callbacks under `/auth/*`, the `dos-id` and `generic-oidc` `IdentityProvider` adapters and `/.well-known/jwks.json`. Red-team rows S18, O8 and O14-O19 in the Appendix refer to that design. The Supabase Auth check on every request with a 30 s cache (option A in ADR-0028) was rejected on 2026-10-14.

### 7.6 Untrusted input

- **Inbound email:**
  - Opaque, rotatable addresses stored in `inbound_address`. Old addresses are tombstoned and never reissued. No slug-based routing.
  - Rotation is the command `kernel.inbound.rotate`, owner only, run through `execute()` with an audit row and an idempotency key. It is R3 since #113 (it was R2 in #37): the old address is tombstoned for good and the suppliers holding it are cut off, which is the "irreversible" case of §4.7, so a hijacked `aal1` owner session must not be able to do it. As R3 it needs a second factor in the last 5 minutes (P11; 403 `STEP_UP_REQUIRED` otherwise), and the audit row records `aal`, `session_id` and the MFA timestamp. For agents R3 means review, which R2 already required, so only users see a change. The definer `inbound_rotate()` retires the active token and draws a new one from `random_token()`; the UNIQUE constraint on `inbound_address.token` decides, and a collision with any token that ever existed draws again.
  - No grace period: from the moment of rotation, mail to the old token is dropped by the worker exactly like mail to a token that never existed. The API answers 202 to both, so a sender learns nothing about which tokens exist. The settings page (owner only) asks for confirmation and shows the new address.
  - Mail already queued for the old token when the rotation runs is dropped too: the worker resolves the org when it processes a message, not when the API accepts it. That is right for a leaked address, but a supplier's legitimate mail in that window is lost without a bounce, and today nothing tells the owner (only the worker logs the drop). Surfacing a count of such drops to the owner is a follow-up.
  - Rate limit (#113): every rotation leaves a permanent tombstone, so `inbound_rotate()` refuses a rotation when the org rotated 3 times in the last 24 hours or 50 times in total (`INBOUND_ROTATE_LIMIT_PER_DAY`, `INBOUND_ROTATE_LIMIT_TOTAL`, passed to the definer as transaction-local settings; a malformed value is refused): 429 `RATE_LIMITED` with `retryAfterSeconds` for the 24-hour rule, nothing written. The count runs under a per-org advisory lock with a 3 s lock timeout, so the limit holds across API instances, of concurrent rotations at the boundary exactly one wins, and a wait past the timeout is refused (429, rule `inbound_rotate_busy`). A replay of an idempotency key is answered before the definer and does not count.
  - SPF/DKIM results are taken only from the receiving MTA. Even so, every message is treated as untrusted.
  - Per-org size and rate limits are checked before any S3 or DB write.
  - Parties created from email are proposals, in the unverified state.
- **File upload** (ADR-0013, on `main` since #109):
  1. Upload to a random staging key (`staging/<64 hex>`) through a presigned POST: 5-minute TTL, `content-length-range` 1 byte to 25 MB, the exact key in the policy. Single use is a grant row in `crove_kernel.file_upload` (creator and clock from the database), claimed once before the server reads the staging object.
  2. The server streams the staged object through sha256 with the size cap and sniffs its type.
  3. It writes those exact bytes to `org/<org_id>/<sha256>` create-only (`If-None-Match: *`, on GCS `x-goog-if-generation-match: 0`), records the `generation` the store returned, and deletes the staging object. A re-write rather than `CopyObject`, so a second POST to the staging key can never be what is copied.
  4. The bucket has versioning (`S3_VERSIONING=required` refuses writes without a version) and a retention hold for evidence (bucket default; operator setting).
  5. Every reference uses the triple (key, generation, sha256). Reads request the recorded version and check the sha256, and fail closed otherwise; downloads are presigned GETs of that version (60 s, attachment) after the usual authorization. Local disk records `content:<sha256>` and streams through the kernel.
- **Parsing:**
  - `crove-extract` has no IAM permissions, no secrets and no egress (VPC with no outbound route + deny-all firewall), limited to 1 vCPU, 1 GiB, 60 s.
  - The worker sends bytes (<=25 MB for files, <=40 MB for a raw email), receives JSON and validates it with zod. The worker **never parses** PDF, XML or MIME itself, and the kernel image holds no PDF, XML or MIME parsing library (a dependency test walks its production tree, and the image check its `node_modules`; `saxes`, exceljs's XML reader, is removed at build time, since the kernel only writes workbooks, #1719).
  - Inside the service each parse runs in a short-lived process under the Node permission model (no network, no file writes, no child processes), with an empty environment, a capped heap, a resident memory watchdog and a wall-clock limit.
  - Crove Cloud requirements (private infrastructure, not in this repo): its own service account with no IAM roles, internal ingress only and invocation by the worker's identity, no secrets or environment credentials, egress blocked (VPC with no outbound route and a deny-all firewall), 1 vCPU, 1 GiB, 60 s request timeout. No XML-DSig verification runs anywhere (S5).
- **E-invoices:** XML received by email is secondary evidence only. An invoice is marked "verified" only when it matches an official source (inbound e-invoice sync via a connector or broker, or a tax authority lookup).
- **HTML from email, users or AI:**
  - Never rendered on the app origin. Only inside a sandboxed iframe on `usercontent.crove.com` (no `allow-scripts`, no `allow-same-origin`), or converted server-side to sanitized text.
  - AI-generated Markdown does not allow raw HTML.

### 7.7 Egress and SSRF

- One egress policy lives in `@crove/kernel-runtime/egress`; jobs must declare `egress`.
  - The guard for tenant-supplied URLs is `guardedFetch` in `packages/kernel-runtime/src/egress.ts` (#641; first used by Social link previews). It allows HTTP(S) on default ports only. Every resolved address must be public, and the connection is pinned to the checked one. Redirects are followed by hand and checked again. One deadline covers the whole fetch, and there is a byte limit. It sends no credentials and asks for no compression.
  - Every pg-boss queue declares its egress in `QUEUE_EGRESS` (`apps/kernel/src/jobs-schema.ts`, #1653): `none` (only services of the stack itself: the database, the blob store, crove-extract and Supabase Auth), `provider:<x>` (a service outside the deployment through its adapter: the AI endpoint as `provider:ai`, the channel adapters, the mail provider, the chat platforms of team alerts), `tenant_url` (a URL a tenant or a browser supplied, through the guard), or both. A queue without one fails typecheck. `apps/kernel/test/invariant/job-egress.test.ts` parses the worker and follows each handler through the kernel's files and the `WorkerDeps` fields it uses. It fails on a queue the worker works, sends or schedules without a declaration, on a handler that reaches the guard, the AI endpoint, a provider adapter or a bare `fetch()` beyond what its queue declares, and on a declaration its handler no longer needs. Planted sources show each failure.
- Tenant-supplied URLs must pass the guard:
  - block private, link-local and metadata ranges;
  - pin the resolved IP before connecting;
  - don't follow redirects into private ranges;
  - size and time limits.
- The allowlisted NAT IP is used only by provider adapters, and those adapters are limited to an FQDN allowlist.

### 7.8 Threat model, CI evidence, detective controls

- **Threat model:** RLS stops application bugs: a forgotten org filter, a wrong join, an agent-written query. A compromised server is contained by least-privilege login roles, the seal, per-environment identities, immutability triggers and WORM anchors. A compromised API process passes the verified user to `enter_context`, so it can act as any existing member; it cannot create membership outside audited commands. That is contained by least-privilege login roles and per-environment identities, and detected by the controls below; it is not prevented.
- **Evidence (G3):**
  - **Conformance:** `org_id`, RLS and policies using the right helpers, PK rules, indexed composite FKs, money domains, no `timestamp without time zone`, append-only tables with INSERT only, functions with `search_path = pg_catalog, pg_temp`, the exact EXECUTE matrix, no CREATE at runtime.
  - **Generated RLS matrix:** cross-org, cross-legal-entity (kernel tables included), forged `le_scope`/flags/user, no context.
  - **Invariant suite taken from the base branch,** run against the PR's schema, so a PR cannot loosen its own gate (Decision 7, External-tenant gate T15).
  - Vitest `db`: one tenant per test.
  - Red-team evals.
- **Detective controls (with alerts):**
  - one actor or one worker context touching > N orgs within 5 minutes;
  - spikes in `NOT_A_MEMBER` or RLS errors;
  - DDL outside the pipeline on the Crove DB (event trigger logging; Cloud adds pgaudit);
  - owner and admin grants in Crove (audit events), and, with DOS org sync later, role changes at DOS and projection drift found by reconcile.
  - On `main` since #996: the worker alerts on one user acting in more than N orgs, on refusal spikes (the refusal tally) and on owner and admin grants, through the worker-only `crove_kernel.security_signals`, to the log and the prober's webhook ([alerts.md](../runbooks/alerts.md), "Security alerts"). Since #1202, DDL outside the migration pipeline too: event triggers that `migrate` installs record it in `crove_kernel.ddl_event`, and the same path alerts it (signal `out_of_pipeline_ddl`; on hosted Supabase only for sessions that are not superusers). Not yet: one worker context across orgs (system actors carry no instance in the audit rows).

### 7.9 DR, legal retention, PDPL, deletion, offboarding

| Data class | RPO | RTO | Mechanism |
|---|---|---|---|
| Ledger, document numbers, issued e-invoices, signed documents | <=5 minutes (WORM stream; providers are the reconciliation source) | 4 h | Crove project PITR + fact replay as `system:restore` |
| Other business data | <=5 minutes (PITR) | 8 h | In-place PITR, or into a new project then selective copy through commands |
| Files | 0 (versioning) | 1 h | Versioning + retention hold |

**DR rules:**
- **7-day PITR** on `crove-db-prod` from Day 0; with a dedicated project, in-place PITR is allowed. The restore runbook (in place and into a new project) must be rehearsed before Finance GA, then every 6 months. After any restore: reconcile finance with the WORM stream and providers before reopening writes.
- Reseed number series with max(WORM log, numbers already issued by the provider).
- **`xid8` stamps after a restore** (#76): `journal_entry.created_xact_id` is the `xid8` of the transaction that created the entry, and a line may join an entry only in that transaction. An `xid8` is unique only inside one cluster. PITR, a physical replica and `pg_upgrade` keep the transaction counter, so nothing changes for them. A logical dump or logical replication into another cluster keeps the old values while the new counter starts low and later passes each of them once; the rule therefore also compares `created_xact_start` (the transaction start, stamped by the same trigger), so restored entries stay closed (runbook `docs/runbooks/ledger-after-restore.md`). After a logical restore, before reopening writes: `SELECT count(*) FROM crove_finance.journal_entry WHERE created_xact_start >= now()` must be 0, otherwise the new cluster's clock is behind the old one; fix the clock first. Restore the ledger with a full restore (triggers are created after the data) or `pg_restore --disable-triggers`; a data-only restore with triggers on refuses every line unless the whole restore runs as one transaction, and then re-stamps every entry with the restore transaction.
- Logical exports come from a restored clone, not the primary. Exports are KMS-encrypted, exclude `context_key`, and `context_key` is rotated after every restore.
- **Self-host:** owns its backups; docs recommend WAL archiving + PITR (e.g. pgBackRest) and a WORM archive on S3 with Object Lock.

**Legal retention:**
- Each period or year close seals a WORM package per (org, legal entity, fiscal year), kept >=10 years (Accounting Law 88/2015, Art. 41).
- The WORM fact stream runs continuously alongside.

**PDPL** (Law 91/2025 + Decree 356/2025) must be done before the first external tenant:
- data processing impact assessment (DPIA);
- cross-border transfer dossier (Crove Cloud: Supabase SG, GCP, Vercel, Cloudflare, DOS ID, the model providers behind DOS.AI);
- template DPA (Crove is the tenant's data processor);
- 72 h breach notification runbook (deadline to be reconfirmed against Decree 356);
- list of sub-processors.

Data residency requirements are handled with a legal opinion plus a copy in Vietnam if needed.

**Deletion map** (ADR-0017):

| Store | How | When |
|---|---|---|
| Mutable rows | Delete or anonymize | On request |
| Immutable stores | Crypto-shred (delete the subject key) | On request |
| Outbox archive | By org prefix | 13 months |
| `ai_step` payloads | By org prefix | 180 days |
| IPs in audit | Truncate | 6 months |
| Exports | Auto-expire | 35-90 days, encrypted |

**Offboarding** (owner request, or, with DOS org sync, DOS reports `org.deleted`; then the tenant locks writes immediately and an export goes to the last known owner):
1. Export for the tenant.
2. Move to `offboarding`, then `closed`.
3. Delete files, outbox archive, DLQ payloads, eval store, AI payloads.
4. Keep the legally required books in the archive.

### 7.10 Incident response

- **Runbooks:** stuck worker, outbox lag, DLQ, Supabase incident, PITR restore, Supabase Auth incident (no new logins and no R3; existing sessions keep working: self-host while the DB is up, Crove Cloud until each access token expires; ADR-0028), JWKS refresh after a signing-key revocation, quota hit, credential rotation (`context_key`, `crove_*` passwords, the self-host Supabase Auth JWT secret, `INBOUND_SECRET`, webhook secrets, the DOS internal key once DOS org sync exists), breach notification, kill switches.
- **Paging:** SEV1 to the owner's phone, plus an issue for the on-call agent.
- **Status page:** simple.
- **pgaudit** (Cloud): logs DDL/ROLE by `postgres` on `crove-db-prod`.

## 8. AI layer

- **Agents per position (ADR-0029):** modules declare agent templates; each agent holds a position in the org chart, works on tasks, delegates only down its subtree and escalates to its supervisor position. A user can also open a chat with the org assistant, which acts on that user's behalf. Subagents only do heavy reading and return summaries.
- **`@crove/agent`** wraps AI SDK 7 and points at the OpenAI-compatible endpoint configured per deployment (Cloud: `api.dos.ai/v1`). It owns:
  - aliases `crove-fast | crove-reason | crove-vision | crove-embed` (Cloud: aliases defined by DOS.AI; self-host: an alias -> model table in config); lint bans string model ids;
  - tools generated from commands;
  - the per-request toolset via `activeTools` and `prepareStep` = user permissions ∩ entitlements ∩ skill pack ∩ grant ∩ trigger class ∩ taint;
  - budgets: steps, tokens, time, a loop breaker, cost pre-flight (Cloud: DOS.AI credits);
  - `ai_run` and `ai_step` (alias, gateway request id, tokens, cost, prompt and toolset hashes, git SHA).
- **Where it runs:**
  - v0: background only, via job `kernel.agent_run.start` (extraction, Inbox triage).
  - 2b: streamed chat on `crove-stream`. History is stored server-side and is the source of truth.
  - Tools do no external I/O: they read from read models; writes go proposal -> job.
- **Tools from commands:** every command/query with `ai.expose` becomes a model tool, an MCP tool (Phase 3, annotated by risk) and an OpenAPI operation.
  - Strict schemas: decimals as strings, closed enums, ISO dates, UUID handles.
  - Entities are resolved only through tool search.
  - Results are typed data, never throws: `executed | pending_approval | denied | invalid`.
  - CI snapshots every tool schema.

### 8.3 Proposals and the AI Inbox

- **States:** `pending_approval -> approved -> executing -> succeeded | failed_safe | ambiguous`. Terminal states: `rejected | expired | superseded | stale`.
- **Creation:** a review produces `proposal` + `inbox_item`, and the turn ends. No pending state is held in memory. The AI SDK's `needsApproval` is not used as an approval store.
  - On `main` (#138): a user can also ask for a proposal that no file produced, today only reversing a posted journal entry: `kernel.proposal.request` runs the module's preparing command, which writes nothing and supplies the title and payload, and records the requester as the author (P10).
  - On `main` (#165): the API route is `inbox.request` (with an idempotency key), and the Inbox parses a payload by the proposal's kind (a purchase or a reversal), so a reversal shows its own card: the entry it reverses, the reversal date and the reason.
- **Edit while approving:** a content-level edit creates a **new revision** authored by the editor. Policy re-runs; the final approver must not be an author (P10, P12).
  - On `main` (#75): editing and approving are separate commands. `kernel.proposal.edit` (R1, any `owner`, `admin` or `member`) saves changed line accounts as revision n+1, rebuilt by the module (`finance.purchase.revise`), and adds the editor to `authors`; it never approves. `kernel.proposal.approve` executes the stored revision as is: it refuses line accounts that differ from it (`CONTENT_CHANGED`) and an older revision (`STALE_REVISION`). The Inbox shows "Lưu chỉnh sửa" for unsaved changes and disables Approve until they are saved.
  - Proposal state gate (#88): `kernel.proposal.approve` moves the proposal to `approved` (with `executed_command_id` set to itself) before it runs the proposal's command, and to `executed` after, in one transaction, so `approved` is never committed today. The runtime runs a command declared `access: 'proposal'` (`finance.purchase.record`) only when the proposal row is `approved` for that command by the calling command, and a reviser (`access: 'proposal_revision'`, `finance.purchase.revise`) only for a pending proposal; a bare proposal id is not enough, so a bug in the edit path cannot reach a posting command. #161 binds a reviser to the edit: it runs only when the calling command is `kernel.proposal.edit` and the pending proposal is for the command the reviser declares in `revises` (the runtime refuses to register a reviser without it), so no other command, nor a reviser nested in a reviser, runs one. #216 binds it to a declaration instead of the name: the edit command's definition declares `proposalEditor: true` and the runtime checks the calling definition, registers at most one editor (run by users) and no longer knows a kernel command name; the reviser of a proposal command is derived from the registered `revises` (the kernel keeps no reviser map), and `Runtime.validate()`, run when the kernel boots, refuses a reviser whose `revises` names no registered `access: 'proposal'` command, two revisers for one command, or revisers without an editor; a reviser of a command in a module the deployment leaves out (`CROVE_MODULES`) is not an error, a typo in the module part of the name still is (`reviser-registry.test.ts`). Invariant tests (`proposal-gate.db.test.ts`) also pin that every proposal command and `kernel.inbox.get` refuse another org's proposal id exactly like an unknown id, P10 with co-owners, and a co-owner's demotion racing an `owner_override` approval (whichever locks the member rows first wins; the approval never acts on an owner role a committed demotion removed).
- **Approval:**
  - Inline cards, Inbox rows and mobile push all call `kernel.proposal.approve` (optimistic concurrency).
  - Approval enqueues `kernel.proposal.execute`, using `proposal_id` as singleton key and idempotency key.
  - The job re-checks against the stored target version, then runs the stored command with **the approver as actor**, with no LLM involved.
- **After approval:**
  - Continuing the run: `kernel.agent_run.continue` opens a new turn.
  - Expiry, reminders and escalation are delayed jobs.
  - On `main` (#676, #876): one worker sweep every 30 minutes instead of a delayed job per proposal. `proposal_policy` sets the days before the approvers are reminded, before the owners are told and, optionally, before a still pending proposal expires (off by default; it needs the escalation and comes after it). `kernel.proposal.expire` (system only) moves the proposal to `expired` under its lock, only once its owners were told and had the days between escalation and expiry (an old backlog is escalated first), with an audit row and an activity entry and nothing else, so nobody is mailed again. Approve, edit and reject refuse an expired proposal (`PROPOSAL_EXPIRED`). Its author asks for it again with `kernel.proposal.resubmit`: a new pending proposal from the same request (the preparer runs again on the kept request) or the same file reading, at most once per expired proposal.
  - Agent R1 actions get a 24 h Undo via `reversibleBy`.

### 8.4 Evidence and extraction

**Job `kernel.file.extract`** (keyed on sha256, schema and extractor version):
1. Classify the document with `crove-fast`.
2. **E-invoice XML first:** parsed deterministically in the sandbox, no LLM (Decree 254/2026 and Circular 91/2026 from 2026-07-01; before that Decree 123/2020 as amended by 70/2025).
3. PDFs with a text layer: `unpdf`, then structured output.
4. Scanned images: `crove-vision`.
5. Keep field-level evidence: `{file_id, extraction_id, page, bbox, text_span}`.
6. **Confidence is computed deterministically**, not from the model's self-assessment:
   - line totals; VAT adds up to the total;
   - tax rates valid for the package and the date;
   - tax code (MST) format and checksum;
   - plausible dates; duplicates; vendor history.
   - High-risk fields need two extraction passes that agree.
7. Match against party, PO or bank line.
8. Emit `kernel.extraction.completed`; a module subscriber turns it into a proposal.

Every extraction is tainted. A Vietnamese benchmark of 100-300 documents is needed before locking aliases or OCR.

**Re-extraction, on `main` (#40, #143):**
- `kernel.file.reextract` (R2 since #1662, since the file goes to the AI endpoint; `owner`, `admin` or `member`, the roles that may edit a proposal) runs through `execute()` with an audit row and an idempotency key. It records a pending extraction run and emits `kernel.file.reextract_requested`; the worker relays it to the same extraction job as an upload. The API never parses.
- Every run is a numbered version of the file's extraction (`extraction.version`, always numbered by the database, UNIQUE per file; the requester is taken from the sealed context, so no runtime role picks either). A finished version is never changed (guard trigger and column-level UPDATE; no DELETE for the runtime roles), so the history of readings stays.
- The result becomes a new revision of the file's pending proposal, through the same mechanism as an edit (§8.3): approve refuses the older revision (`STALE_REVISION`) and accounts that differ from the new one (`CONTENT_CHANGED`). The requester is added to the revision's authors (P10): they chose to replace the content with a new reading. A failed re-read leaves the proposal unchanged. A booked invoice is never read again (`PROPOSAL_DECIDED`); after a rejection, a successful re-read creates a new proposal and the rejected one stays as it was.
- One run per file at a time (partial UNIQUE index on pending runs; repeated requests get `EXTRACTION_PENDING`), and at most 20 runs per file. Every write locks the file row first, then the proposal; approve, edit and reject refuse while a run is in flight. A pending run older than 15 minutes (database clock only) is presumed lost: it stops blocking decisions, a new request closes it, and if its job still finishes, the result is kept as its version but never applied to a proposal, so an edit or decision made in the meantime stays current. The Inbox shows such a run as stopped and offers "Đọc lại" again, only on the file's newest proposal.

### 8.5 Prompt injection defenses

1. **Taint follows the data, not only the run's input.**
   - Records and fields carry `source_trust` (`external` when they come from email, extraction, webhooks, bank statements, public forms).
   - A tool result containing `external` data taints the run from that step on. `prepareStep` then removes every write and send tool; only the proposal path remains.
2. **Quarantine:** untrusted content only goes through tool-less model calls that produce length-bounded, tainted zod records.
3. **Rule of Two:** runs triggered by inbound content have only R0 tools, read only the triggering thread's records, and may only propose.
4. **No write SQL:** every write is a command.
5. **No exfiltration paths:** no arbitrary URL fetches, no auto-rendering of remote images or links. Sends only to **verified** contacts.
6. **External MCP** (Phase 3+): pinned and approved per org; counted as R2; unavailable in tainted runs.
7. **Limits:** no secrets in prompts; per-run budgets; a loop breaker.
8. **Red-team in CI:** 0 auto-executed R2+, 0 data leaks.

### 8.6 Ask-the-books (2b) and memory

**Ask-the-books:**
- Uses only R0 queries: `finance.metric.query`, `finance.report.get`, `finance.record.drill_down`.
- The LLM does no arithmetic on financial numbers. A post-check flags any number not present in tool results.
- Answers cite the metric id, the query hash and a drill-down link.
- No text-to-SQL.

**Memory, in priority order:**
1. Structured data, fetched through tools.
2. Learned deterministic rules, stored as rows with provenance (e.g. `crove_finance.categorization_rule`), applied before the LLM.
3. Preferences, stored as rows.
4. Thread summaries.

DOS.AI's agent memory (`dosai.agent_memory`) is not used.

### 8.7 Evals and eval data

- **Eval tiers:** deterministic tests -> trajectory evals (seeded DB + documents -> expected proposals; pass-rate gate per command family) -> red-team with promptfoo.
- **`ai.examples`:** drawn only from synthetic fixtures in `@crove/testing`; enforced by lint. CI scans snapshots and examples for checksum-valid tax codes, account numbers, phone numbers and national IDs.
- **Edited or rejected cases:** go only into a per-org `eval_candidate` store when the org opts in (with a DPA clause), kept 90 days, **never in git**.

### 8.8 AI provider boundary and cost

- **Crove keeps (every deployment):** the runtime, threads, `ai_run`/`ai_step`, proposals, policy, the tool registry, business memory, evals, per-org cost caps.
- **The provider is just an OpenAI-compatible endpoint.** A conformance suite (tool calls, structured output, streaming, error codes) must pass before enabling an endpoint or locking an alias.
- **Crove Cloud, DOS.AI keeps:**
  - catalog, aliases, routing (`crove-*` aliases ship as a catalog migration reviewed by DOS-AI, after Crove's evals pass);
  - provider keys, metering, wallet/credits, hard caps;
  - `dosai.usage_transactions`.
- **Calling DOS.AI (Cloud):**
  - Header `X-DOS-App-ID: crove` plus attribution headers (org, user, feature, `ai_run_id`; header names agreed with DOS-AI).
  - The gateway request id is stored on `ai_step`.
  - Per-org AI billing waits for DOS-17.
- **Self-host:** configures its own endpoint, models and keys; no DOS headers are sent. Crove still records tokens and estimated cost on `ai_step`.
- **Cost levers:** learned rules; XML first; extraction cache by hash; stable prompt prefixes; batch API; cheap classification aliases.

### 8.9 External agents (MCP, Phase 3; Cloud: after DOS-9)

- **Grants:** `agent_grant` per (org, client_id, user), created from a connection screen in Crove. Each grant picks exactly one org and one `max_risk`.
- **Resolution:** `/mcp` derives org and grant from the token's `client_id` + `sub`, and rejects every other org.
- **Execution:** R0/R1 run directly; R2/R3 always create proposals. Grants are revoked when membership ends.
- **Position agents on an external runtime (ADR-0029):** an `agent_grant` bound to `(org, client_id, agent_id)`, created by a human with the permission, revoked when the agent is paused or retired or no longer holds a position.
- **DOS.AI agents (Cloud):** bound via `provider_connections(provider='crove')`. Crove is registered as a first-party MCP family so the gateway writes `agent_action_audit`.

## 9. Frontend shell

Updated 2026-10-14 for the Vite + TanStack Router SPA (Decision 6).

- **Routes:**
  - The TanStack Router route tree is built from module manifests (virtual file routes); a small adapter reads each manifest (routes, menu items, whether the module is enabled). `pnpm gen` also emits the nav/slot registry and message types.
  - Navigation uses the router's typed `Link`/`navigate`; lint bans string `href`s in module code.
- **URLs:**
  - `/<orgSlug>/<module>/<entity>/<recordId>`. `/-/` is reserved for org-less routes: login, callback, onboarding, invite, account, orgs; public pages under `/-/p/…` (Phase 5).
  - Org UUIDs redirect to the slug.
  - List state lives in search params, validated with `validateSearch` + zod.
- **Org context:**
  - The org in the URL is the only signal. The last-used org is kept in a cookie, used only to redirect `/`.
  - The org route's `beforeLoad` loads `kernel.me` (org context) and redirects if the user is not a member; this guard is UX only, the kernel checks token and membership on every request.
  - `OrgProvider` supplies: org, role, permissions, entitlements, an oRPC client with `X-Crove-Org` attached, query keys prefixed `['org', org_id]`.
  - Logout: hard navigation, `queryClient.clear()`, and a BroadcastChannel message to other tabs.
- **Locale:** `use-intl` (ICU messages, catalogs `vi` and `en`), no locale prefix in URLs, default `vi`.
  - On `main` (#206, #215): the choice is saved in this browser (`localStorage` key `crove-locale`, else the first supported browser language); other open tabs follow it through the `storage` event, and `<html lang>` follows it. Nothing on the server reads the locale yet, so there is no cookie.
  - `vi.ts` is the source catalog, declared `as const`: use-intl checks the key and the ICU argument names and types of every `t()` call against it, and the typecheck fails when `en.ts` misses a key or gives a message other arguments or tags.
  - Screens keep codes and message keys in state, never translated text, and word them at render, so a switch rewords what is already on screen (sign-in notices, pending confirmations, errors).
  - Money is shown with the currency's usual decimals (none for VND) and more only when the amount has them, up to the ledger's 4, so a line on the journal or inbox detail screen is the exact amount the ledger holds and the lines always add up to the totals shown. The approval preview sums each account exactly and rounds once to 4 decimals, half up, like `@crove/l10n-vn`.
- **Text the server produces:** the kernel writes in Vietnamese and stays the source of truth; the SPA localizes by code.
  - **Errors:** every kernel error carries a stable `code` (and on the RPC path `details`, for example the `rule` of a rate limit). The SPA maps the codes users can meet, and rate limit rules, to messages in both catalogs (`apps/app/src/lib/kernel-errors.ts`). On Vietnamese screens it shows the kernel's message as is, since it names the specific case (which role a `FORBIDDEN` was about); in other languages it shows its own message for the code. Any other code shows the kernel's Vietnamese message. `apps/app/test/kernel-errors.test.ts` reads the kernel sources and fails when a new code or rule is neither mapped nor listed as one the SPA never shows (agents, channels, inbound mail, caller bugs). New kernel errors keep the code stable and put values the message needs in `details`, never only in the text.
  - **Invoice checks** (`checks[].message` in a proposal) stay Vietnamese: they are part of the proposal payload the approver reviewed and the audit keeps, and some embed values (amounts, tax codes, dates) the payload does not carry separately. Localizing them needs a check id plus parameters per check; that is a follow-up, not a rewording in the SPA.
  - **Journal export** (`/api/export/journal.xlsx`) stays Vietnamese in every locale: its column headers ("Ngày hạch toán", "TK Nợ", "TK Có", ...) and memos follow Vietnamese accounting practice (TT133), and the file goes to Vietnamese accountants and their software. The file name follows the SPA's locale. The VAT working export (`/api/export/vat.xlsx`, #316) and the form 01/GTGT indicator labels on its screen follow the same rule: they are the form's own Vietnamese wording. So does the ledger reports workbook (`/api/export/ledger.xlsx`, #321), whose headers are those of the TT133 books (bảng cân đối số phát sinh, sổ cái, sổ chi tiết thanh toán).
  - **Account names** (TT133 chart) and journal memos are ledger data, shown as stored.
- **Data:**
  - Client-first: `useSuspenseQuery`/`useInfiniteQuery`.
  - `useCommand()` generates a UUIDv7 `Idempotency-Key`, with optimistic update and rollback, and invalidates on completion.
  - Route loaders prefetch on hover or focus (`defaultPreload: 'intent'`).
- **Updates (#69):** invalidation over SSE, ids only.
  - **Source:** an `AFTER INSERT OR UPDATE` trigger on `proposal`, `file`, `extraction`, `journal_entry`, `purchase_document` and `purchase_document_void` sends `NOTIFY crove_stream, '<org_id> <type> <id>'` (types `proposal`, `file`, `extraction` with the file's id, `journal_entry`, `document`). Tables rather than the outbox, because approving, editing and rejecting a proposal and an extraction's result emit no outbox event. `NOTIFY` is sent at commit (a rolled-back write sends nothing) and identical hints of one transaction once. Deletes send nothing (only retention and org purges delete). Any database role can `LISTEN` on any channel, so the payload holds ids and nothing else. A row of a table under the `le_scope` policy (`journal_entry`, `purchase_document`, `purchase_document_void`, `extraction`, `notification`) adds its legal entity as a fourth id, `'<org_id> <type> <id> <legal_entity_id>'` (#1692), and so does `proposal` since #1538; `file` and the social tables stay org-wide.
  - **Fan-out:** each API process `LISTEN`s once on a dedicated connection (`DATABASE_LISTEN_URL`, §3.3), parses the payload strictly and hands the hint to the open streams of that org only, and a hint that names a legal entity only to the streams whose scope includes it (#1692); the entity is never sent to the client. Multi-instance: every instance gets every notification and filters by org. When the connection drops, every stream of that process closes with `unavailable`, new streams answer 503 until it is back, and it reconnects with backoff (1 s doubling to 30 s).
  - **Events:** `ready`, `invalidate` `{type, id}`, `resync` (more than 200 distinct hints piled up: refresh everything), `close` `{reason}`, and a `: ping` comment every 25 s. Never row data, never the outbox or a global sequence (red-team S29).
  - **Re-checks:** every `STREAM_RECHECK_SECONDS` (default 30, 5 to 60) and after every 50 hints, the stream runs `kernel.stream.check`, a read through `Runtime.query()` with the ticket's user, session and `aal`: the session check for the org (db mode also sees a sign-out, ban or newly required MFA upstream), context entry and membership. It returns the sealed context's legal-entity scope (`'*'` or the entity ids; none for an empty scope), which the stream applies to every hint it sends afterwards, held ones included, so a narrowed assignment takes effect within the interval (#1692). Hints wait while it runs; a failure closes the stream with `session`, `session_revoked_in_org`, `mfa`, `membership` or `unavailable`. The stream also ends at the token's `exp` (`expired`, at most one hour), so in jwt mode it never outlives the token it was opened with, and a client that leaves 256 KiB unread is dropped.
  - **SPA:** `OrgLayout` opens the stream for the org in the URL (`lib/stream.ts`, `lib/stream-hook.ts`). A hint marks stale the lists of its kind and the detail of that record (by the id in its key, or the file, document or entry it shows); TanStack Query re-fetches what is on screen through the normal authorized calls. An access reason re-runs a normal call (which signs out, leaves the org or asks for MFA) and retries the stream after a minute; other closes and errors reconnect with a new ticket and backoff, and the first `ready` after a reconnect refreshes everything. While the stream is down the Inbox polls as before (pending count 30 s, list 5 s, files 30 s or 2 s while one is read); while it is up they poll every 2 minutes as a safety net.
  - **Not covered yet:** a stream per tab (each tab opens its own).
- **Caching:**
  - Tenant data is **never** cached on a server or in any shared layer; the SPA is static files and TanStack Query caches only in the tab.
  - Only non-tenant data (l10n packs, tax/bank codes, i18n messages) may be cached across users.
  - CI fails if the SPA build contains `SUPABASE_SERVICE_ROLE` or any kernel secret; runtime config carries no secrets.
  - The kernel returns `Cache-Control: no-store`.
- **Mutations:** every write is an oRPC command call to the kernel; the product app has no server-side code.
- **Design system:**
  - `@crove/ui` is the only UI import and the only importer of `@base-ui/react`.
  - OKLCH tokens; lint bans raw color classes (`web` rule): `tools/ui-colors.mjs` rejects Tailwind palette classes (palette names read from the installed `tailwindcss/theme.css`), literal colors and CSS color names in arbitrary values, color attributes, style objects and the app's stylesheets (`none`, `currentColor`, `transparent`, `inherit` and system colors such as `Canvas` are allowed).
  - shadcn's `Card` has `overflow-hidden`: absolutely positioned content inside a card (a popover, a menu, a tooltip) is clipped. Render it in a portal or outside the card.
  - Badges: the solid `default` badge marks the one row to notice (the current session); status chips that repeat down a list (a file being read, the owner role) use the subtle `brand` variant, which keeps the brand hue without a solid fill on every row.
  - A `Spinner` inside a button takes `text-current`, so it has the button's text color on any variant.
  - `DataView` wraps TanStack Table 9 + virtual.
  - AI Elements: vendored in 2b.
- **Safety:** untrusted HTML renders only in a sandboxed iframe (§7.6); CSP and Trusted Types on; R3 approval needs step-up.
- **Preview:** off in Phase 1-2, enabled only with the `ui-only` label. PRs are verified with hermetic `e2e`, and on beta after merge.
- **Navigation checks:** about 10 Playwright tests for the key navigations.

## 10. AI coding foundation

> Every change to `.claude/settings*.json` and hooks in the Crove repo is only a **proposal** until the owner approves it; agents do not edit their own harness config. These files are protected paths (G6).

- **`AGENTS.md` at the repo root** (<=200 lines; `CLAUDE.md` = `@AGENTS.md`). Contents:
  - the architecture in 15 lines;
  - the exact commands to run;
  - the golden path ("add a command" = `pnpm g command …`);
  - naming and migration rules (§5.5);
  - the local DB loop;
  - what needs owner approval;
  - public-repo rules (no project refs, internal URLs, secrets or real data), clean-room rules, CLA.

  Each module has its own `AGENTS.md`, <=150 lines.
- **Path rules (`.claude/rules/`, all with `paths:`):** `core`, `migration`, `finance` (NUMERIC, reverse entries only), `tests`, `web` (Base UI, tokens, typed router links, useCommand), `agent`, `identity` (identity adapters and `/auth`), `orpc` (only for `packages/kernel-http/**` and `packages/kernel-contract/**`; pins v1 idioms).
- **Skills (`.claude/skills/`):** `new-command`, `new-migration`, `new-event`, `i18n-key`, `debug-ci`, `db-local`; `new-module` added from Phase 2a. Each skill calls a generator or a deterministic command.
- **Generators (`tools/`):**
  - `db:new <token> <desc>`: timestamp = max(now, latest on the default branch + 1 s). Also generates a pgTAP stub. Refuses a second file for the same schema.
  - Other DB commands: `db:retime`, `db:types` (local), `db:types:from-ci` (fallback), `db:vendor:pgboss`, `db:partitions`.
  - `g command|query|event|subscriber|job|screen`.
  - `gen` / `gen:check` generate: registry, routes, contract, catalog/subscription/queue seeds into the PR's migration, snapshots, dependency-cruiser rules.
  - `g module` (from Phase 2a) generates the DB part too and migrates the local DB; the generator's gate **includes the DB**.
- **Hooks** (one dispatcher in `tools/agent`):
  - **SessionStart (cloud sessions):**
    - install Node 26 from nodejs.org; run `pnpm install`;
    - start PostgreSQL 17 (Docker `postgres:17`, or embedded PG17 as the fallback) and apply the migrations with the built-in runner (`pnpm db:migrate`); no Supabase CLI.
    - Record first-start, reset and migration timings when the hook lands.
  - **PostToolUse:** `oxfmt` + `oxlint` (not type-aware) on the edited file.
  - **Stop:** lint + typecheck + unit tests for the affected part; reads `stop_hook_active`; 120 s cap.
  - **PreToolUse:**
    - block Supabase MCP `apply_migration`/`execute_sql`, and any migration run (`pnpm db:migrate`, the `migrate` role, `supabase db push`) not pointed at a local DB (no project ref needs to live in the repo);
    - block `git push --force` to `dev`/`main`;
    - block attaching fork repos in implementation sessions (clean-room).
- **CI gates** (all in the core repo; deploy workflows live in `crove-cloud`):

| Gate | Scope | Checks | On `main` (2026-10-23) |
|---|---|---|---|
| G1 `scope` | Every PR | <ul><li>Public/private boundary: blocks paths and content that belong in `crove-cloud` (OpenTofu, deploy workflows, environment config, commercial connectors).</li><li>Scans for Supabase project refs (`<ref>.supabase.co`, pooler connection strings), OIDC client ids, internal domains. The blocklist (DOS's and Crove's project refs) lives in an Actions secret, not in the repo.</li></ul> | Partly. `Secret scan`, a required check: gitleaks over the full history and the project-ref blocklist from the `G1_BLOCKLIST` secret (Decision 9). The path boundary check since #1560 (`tools/ci/path-boundary.mjs`, a step of the required `Docs check`): no OpenTofu or Terraform file, environment file other than an example, `crove-cloud/`, `cloud/` or `infra/` directory, or deploy workflow, with a reasoned allow list. Allowed today: `.github/workflows/deploy.yml`, the pilot deploy over SSH (#56), which lives in this repo until the owner decides (raised on #1204, listed in #1234) |
| G2 `migration-lint` | PRs touching `supabase/**` | <ul><li>Ordering: new version > base max, no duplicates; no editing, deleting or renaming old files; every file matches the naming rule (§5.3).</li><li>Content rules from §5.5.</li></ul> | Done, as steps of the required `Docs check` job rather than a job of its own: version ordering (`tools/ci/migration-order.mjs`, #249, #256; the `migration-recheck` workflow re-runs it on open PRs after every push to `main`), then the §5.5 content rules and no editing or deleting of files already on `main` (`tools/ci/migration-lint.mjs`, #1201 in #1213; older files on an allowlist; a statement touching another module's schema needs a `-- migration-lint: cross-module <reason>` waiver; from #1693, a contract change needs `-- crove:contract adr=<id>` on the lines before it and DDL on a hot table runs in the lock-retry block, for the files after the newest on `main` when that landed) |
| G3 `db-replay` | PRs touching `supabase/**`, `packages/db/**`, `modules/**` | <ul><li>Clean replay on plain PG17 with the built-in runner (on `main`: the `db` test project in `ci`); re-apply new migrations and compare fingerprints; pgTAP.</li><li>Conformance, RLS matrix, **invariant suite from the base branch**, EXECUTE matrix.</li><li>Manifest matches catalog; types diff (prints the fix command).</li><li>splinter, `pg-boss doctor`, `vitest --project db`.</li></ul> | Partly. In the required `Lint, typecheck, test` job, the `db` test project replays every migration on PG17 with the built-in runner and runs the RLS matrix (T8), the EXECUTE matrix, the invariant suite and schema conformance (#1200 in #1216, `packages/db/test/invariant/conformance.db.test.ts`; the foreign keys it lists without an index are being indexed in #1212), and checks that the generated types are current (#48); `Invariant suite (from base)` runs the base copy on protected-path PRs (G6); a separate job repeats the migrations and the hardening guard on the Supabase Postgres image (#179); re-applying every migration on the migrated database must leave the catalog fingerprint (objects, owners, ACLs, RLS flags, policies, triggers, function bodies and settings, event triggers, Crove roles and memberships, row counts of every `crove_*` table) unchanged, and the invariant test names each difference (#1386, `packages/db/test/invariant/migrate.db.test.ts`). Manifest against catalog, first step (#1588): each module declares the tables it owns per schema (`ModuleManifest` in `@crove/kernel-contract`; `packages/kernel/src/manifest.ts`, which also owns `crove_meta` and the vendored `crove_jobs`, and `modules/<module>/src/manifest.ts`), and `apps/kernel/test/manifest.db.test.ts` fails when a `crove_*` table has no owner or two, or a manifest names a table the migrations do not create; every column of those tables carries its data class, checked the same way (#1599, §5.2); each module declares the permissions it owns with their risk and default roles, and the test fails when a `crove_kernel.role_permission` row, a command's `permission`, the approval policy or a database function or policy names an undeclared permission, or the default roles differ from the seeded rows (#1630); each module declares its screens under `/o/$slug` and its menu items (`routes` and `nav`, kept in `MODULE_SCREENS` of `@crove/kernel-contract` so the app's bundle reads them without server code), the app's shell builds its apps, menus, command palette and module guard from them, and `apps/app/test/module-screens.test.ts` fails when a route of the router has no entry or two, or a menu label has no message in Vietnamese or English, while `apps/kernel/test/manifest-screens.test.ts` fails when a manifest drifts from its entry or a screen names an undeclared permission (#1652); each module declares its entities with their table, `legalEntityScoped`, numbering doc type and audit, and the test fails when an entity's name is not `<module>.<entity>`, its table does not exist, `legalEntityScoped` differs from a `legal_entity_id` column, `audit: 'append_only'` differs from the append-only trigger, its doc type differs from the numbering series (#1401) a trigger on its table allocates, a trigger numbers a series no entity declares, or a command's audit target is no entity (#1656, §5.2); the plan's `record`, timeline, files and sharing of an entity are not built. `pg-boss doctor` (#1603): the db project runs pg-boss's drift scan on the vendored `crove_jobs` after every migration (`apps/kernel/test/jobs.db.test.ts`). pgTAP (#1627): the runner in the db project installs the vendored pgTAP 1.3.4 (`packages/db/test/invariant/pgtap/pgtap.sql`, PostgreSQL License) into its throwaway database after the migrations, never by a migration, and runs every `supabase/tests/database/**/*.test.sql`; a file fails on a SQL error, a `not ok`, a count other than its `plan(n)`, a SKIP or a TODO. The gate files `_*.test.sql` run in the invariant suite (`packages/db/test/invariant/pgtap-gate.db.test.ts`), so on protected-path PRs `Invariant suite (from base)` runs the base copies of them, of the runner and of pgTAP (#1643); the modules' files run in `packages/db/test/pgtap.db.test.ts`. Seed files: `_conformance`, `_rls_matrix` and `kernel/party`. Splinter deferred (coordinator, 2026-10-25): the conformance test already covers most of its lints, and vendoring its queries needs a license check first |
| G4 `supabase-preview` | Crove Cloud, once `crove-cloud` and the beta project exist: PRs replayed on a preview branch of `crove-db-beta` | <ul><li>Required on `main`.</li><li>On `dev` it is only a warning, with automatic infra-failure triage; agents use `/reset-preview`.</li><li>PRs from forks of the repo get no preview; G3 is the gate.</li></ul> | Not started: needs `crove-cloud` and the beta project |
| G5 `ci` | Every PR | <ul><li>Format, lint, typecheck, `--affected` tests; dependency-cruiser; knip.</li><li>Derived risk <= declared risk.</li><li>PII scan.</li><li><=800 non-generated lines (unless labelled `split-exempt` with a reason).</li></ul> | Partly. `Lint, typecheck, test`, a required check (since #1041 it gathers parallel jobs: lint, typecheck and unit tests in one, the database tests in three on their own PostgreSQL, and passes only when all of them pass): oxlint, the raw-color check, shellcheck, typecheck of every source and test file (#294), unit and database tests on every PR (all of them, not `--affected`); the parser dependency rule (`tools/test/parser-imports.test.ts`, T12); the allowed imports of §5.4 (`tools/test/allowed-imports.test.ts`, #1387), without the string model id ban. String model ids are refused in product sources (`tools/test/model-ids.test.ts`, #1462). The derived-risk check since #1563: every command may declare `sideEffect` (`none`, `internal`, `external`, `financial`, `legal`, `irreversible`) and `Runtime.register` refuses a declared risk below the one it derives (§4.7); kernel commands are annotated; since that date every command of CRM (#1597), Social (#1614) and Finance (#1631) declares one too, and `apps/kernel/test/side-effects.test.ts` fails on a command that declares none. The PII scan since #1628 (`tools/ci/pii-scan.mjs`, a step of the required `Docs check`): no Vietnamese citizen ID (12 digits, a province prefix that exists), mobile number, individual tax code in a test or fixture file (a valid check digit) or email address outside the reserved example domains in any tracked file; values made up on purpose (one or two digits, a run up or down, repeated groups) pass, other exemptions sit in `tools/ci/pii-scan-allowlist.json`, each with its reason, and the log masks every value it reports. It reads the PR's merged tree, so a value added and removed again within one PR stays in that PR's commits. knip since #1602: its own CI job (part of the required check) fails on unused files, exports, exported types and dependencies, dependencies used but not listed, unused catalog entries and duplicate exports, over every workspace package; `knip.jsonc` lists, with a reason each, the entry points knip cannot find (files run by path or in a container, the composition root a Crove Cloud entrypoint imports) and the few ignores. dependency-cruiser 18 since #1651: `pnpm depcruise`, a step of the static job, with rules generated (`tools/depcruise-rules.mjs`) from every manifest's `dependsOn` (a DAG, checked when the rules are built) and every package's `exports`: a module imports only the modules its manifest lists, the platform packages import no module, no deep import past a package's `exports` (by a relative path or a specifier), no import that does not resolve, `domain/` imports only its own `domain/`, the isomorphic packages, zod, decimal.js and node:crypto, and `apps/app` reaches none of `@crove/db`, `@crove/kernel-runtime` and `@crove/kernel` (transitively) and imports a module only through its `./contract` export (Social's, the composer's rules). Each exception lists its files and its reason there (today: test fixtures and cross-checks shared between packages' tests, `domain/portal-api.ts`'s `DomainError`, #1680, and one `import type` of `@crove/channel`). Not built: a formatter, the 800-line limit. The 800-line limit is deferred (coordinator, 2026-10-25): a task lands end to end in one PR (AGENTS.md), so most feature PRs would need the `split-exempt` label |
| G6 `protected` | Protected paths (`tools/ci/protected-paths.mjs`, matched on paths only): context/policy/authz (`packages/kernel-runtime/src/**`, `packages/db/src/context/**`, approval policy), identity adapters, `/auth` and the HTTP edge, every migration (G6 named GRANT/POLICY/DEFINER/ROLE; any SQL can drop a trigger or replace a function, so all count), the migration runner, `_*.test.sql` and `test/invariant/` tests, the modules' pgTAP runner (`packages/db/test/pgtap.db.test.ts`), `.github/workflows/**`, `CODEOWNERS`, `.gitattributes`, `.claude/settings*`, `.claude/agents/**`, `.mcp.json`, `CLAUDE.md`, hooks, dependencies and test runner configs (every `package.json`, lockfile, workspace, `.npmrc`, `vitest*.config.ts`, `vitest*.workspace.ts`, `playwright*.config.ts`, `global-setup.ts`, `global-teardown.ts`), `AGENTS.md`, `LICENSE`, `CLA.md`, `agent-autonomy.md` | Generates a plain-language before/after summary; the invariant suite runs from base and a security reviewer agent reviews the PR; an external security review comes before the first external tenant (Decision 7). No owner approval label. Every PR to `crove-cloud` counts as protected | Done except the reviewer agent: workflow `protected` (#98, #30) with the path list in `tools/ci/protected-paths.mjs`; `Invariant suite (from base)` is a required check; `Security review (agent)` waits for the `ANTHROPIC_API_KEY` secret (#95, owner), and until then the session runs its own security review (T15) |
| `cla` | Every PR | CLA Assistant: every commit author has signed the CLA (individual or corporate); the project's bot and agent accounts are allowlisted | Not enabled: the CLA waits for the lawyer's review (#62, §12-C) |
| `license` (optional) | New source files | `SPDX-License-Identifier` header matches ADR-0022 | Not built: no source file carries an SPDX header |
| `kernel-migration-lock` | PRs with a `_crove_kernel_` file | Fails if another open PR also has a `_crove_kernel_` file | Not built. Deferred (coordinator, 2026-10-25): the coordinator's version reservations (#1210) and the migration-order recheck already keep kernel migrations apart, and a lock would serialize kernel work across the team leads |
| `e2e` / `evals` / `security` | Merge to `dev` + nightly + by label / prompts, tools, aliases / every PR | <ul><li>Hermetic Playwright + the "new API, old worker" scenario.</li><li>Trajectory + red-team.</li><li>gitleaks (full history, from the first commit), zizmor, dependency-review (blocks AGPL-3.0-incompatible licenses), Opengrep.</li></ul> | Partly. `e2e`: `Playwright on docker compose` on every PR, a required check (#18); the "new API, old worker" scenario is not built (deferred by the coordinator, 2026-10-25: the pilot deploys one `all` instance; build it when a split `api` and `worker` deploy is planned). `evals`: the `ai-eval` workflow runs the synthetic extraction eval on PRs that change `packages/agent/src` and on demand (#757); the extraction red team is in the invariant suite (#900). `security`: gitleaks as in G1; zizmor, dependency-review and Opengrep are not built |

- **CI cost:** per-PR `cancel-in-progress` concurrency; auto-close agent PRs older than 7 days; DB snapshot cache keyed on the migration hash (Preview still replays in full).
- **Golden module:** the party slice of `@crove/kernel`, hand-written with the most care. Templates are extracted from it and snapshot-tested against it. It contains:
  - commands `kernel.party.create|update|mark_duplicate` (R1);
  - queries `get|list|search` (pg_trgm);
  - event `kernel.party.created` v1; a subscriber that writes activity;
  - Inbox type `kernel.party.duplicate_suspected`;
  - list and detail screens (slot `party.tabs`);
  - unit, db and 1 e2e test; one migration + pgTAP.
- **Multi-session workflow:**
  - One worktree per session.
  - `db:new` reserves a timestamp against the default branch.
  - Only one kernel migration PR at a time.
  - "Reviewed" means: automated reviewers (Claude review reading the patch file by file, CodeRabbit) + a fresh-context subagent, plus G6 for protected paths.
- **Weekly effectiveness metrics:** CI minutes and iterations per PR, % of PRs needing human intervention, rate of Preview failures caused by infra.
- **Clean-room with forks:**
  - A "spec extraction" session may read a fork, but outputs only behavioural specs and tests into `docs/specs/<module>/`.
  - Implementation sessions may not attach fork repos.
  - CI runs `jscpd` comparing `modules/<id>` with a snapshot of the fork.
  - No third-party AGPL code is copied into core, so the relicensing right via the CLA (ADR-0022) stays intact.

## 11. Prerequisites in DOS.Me

Only for **Crove Cloud**; self-host depends on none of these. Each item is a separate PR in the DOS.Me repo, under DOS.Me's migration rules. MVP step 2 needs only one DOS-side change: allow `app.crove.com` as a redirect URL on DOS's Supabase Auth (owner approval, issue #54). DOS-28 is optional since 2026-10-15 (ADR-0028 amendment): gate T1 no longer needs it. The other rows matter when DOS org sync, DOS billing or the DOS broker are enabled.

> **Redacted.** `DOS/Ludy` is a public repo. Rows marked "Details in DOS.Me (private)" keep only IDs, priorities and what each item gates; their details and current state live in the private DOS.Me repo. Integration contracts Crove builds against (DOS-27, DOS-7, DOS-17) stay public here.

| # | Priority | Item | Change | Evidence | Needed before |
|---|---|---|---|---|---|
| DOS-1 | P0 | Org membership for Crove | Details in DOS.Me (private) | pgTAP + contract test (in DOS.Me) | Crove Cloud enables DOS org sync (deferred, Tracking) |
| DOS-27 | P0 | Org events and API for Crove | <ul><li>Extend the `team_webhook_outbox` pattern (trigger + `SKIP LOCKED` claim + receipt) to `organizations`/`org_members`: `org.member.added\|removed\|role_changed`, `org.deleted`, `team.*`, `user.disabled\|deleted`.</li><li>Envelope with `event_id`, `org_id`, per-org `seq`, `occurred_at`; HMAC-signed with a Crove-specific rotatable secret; retry with backoff.</li><li>Org/membership API: a user-token endpoint (the user's own orgs and roles) and an internal endpoint (`X-DOS-App-ID: crove` + internal key) for reconcile.</li><li>The prod internal key is readable only by the `crove-prod` worker SA; beta has its own key (absorbs DOS-10).</li></ul> | Contract test: removing a member delivers an event to Crove in <=1 minute; redelivery creates no duplicates | Crove Cloud enables DOS org sync (deferred, Tracking) |
| DOS-28 | Optional (deferred 2026-10-15) | Session and user lifecycle events for Crove (Cloud only; extends DOS-27). Optional refinement of ADR-0028: Crove Cloud uses Supabase Auth's default token lifetime without it | <ul><li>Events `session.signed_out` (with scope), `session.revoked`, `user.banned`, `user.deleted`, from a durable outbox with a global sequence number, `event_id` and `occurred_at`; HMAC-signed with a Crove-specific rotatable secret; retry with backoff. Reuses the DOS-27 outbox and envelope, so that part of DOS-27 is built first.</li><li>A signed checkpoint at least every 15 s ("all events up to N delivered"), or a batch session status endpoint.</li><li>Signs a session out in DOS's Supabase Auth on Crove's request (owner revoke).</li><li>Needs owner approval as a cross-repo PR (ADR-0028).</li></ul> | Contract test: a sign-out reaches Crove in under 5 s; a dropped event is detected through the checkpoint so the session is blocked within 60 s; redelivery creates no duplicates | A customer needs cross-app revocation faster than the JWT expiry (trigger) |
| DOS-26 | P1 | Access token hook | Details in DOS.Me (private) | pgTAP + contract test (in DOS.Me) | Cloud opens to external users (Crove doesn't use the claims, but DOS ID is the login door) |
| DOS-9 | P2 | OAuth client policy | Details in DOS.Me (private) | Playwright | Before Cloud GA and before external MCP (Phase 3) |
| DOS-7 | P2 | `crove` product + per-org entitlements | `plan_features`, `plan_aliases`, `resolve_org_plan(text)`; seed the currently hardcoded matrix | Endpoint returns identical output | Before Cloud charges |
| DOS-17 | P2 | Org attribution on DOS.AI | Org/product in `usage_transactions`; `crove-*` aliases | DOS-AI conformance | Before selling per-org AI credits |
| DOS-8 | P2 | Org link for provider connections | Details in DOS.Me (private) | Migration test | Only if Cloud uses the DOS broker: first binding (2a) |
| DOS-20 | P2 | Broker contract for Crove | Details in DOS.Me (private) | Contract test (in DOS.Me) | Same as DOS-8 |
| DOS-18 | P2 | E-invoice **issuing** broker | Design + legal + provider; with an owner and a deadline | Signed spec | 2b, only if Cloud uses the DOS broker instead of a `crove-cloud` connector |
| DOS-19 | P2 | Bank broker / aggregator | Same as above | Signed spec | Same as DOS-18 |
| DOS-5/6 | P3 | Teams | Team data contract for Crove (unique `(org_id, id)`); details in DOS.Me | pgTAP | Enabling team scope based on DOS teams (Phase 3) |

**No longer prerequisites for Crove (2026-10-13):** DOS-2, DOS-3, DOS-4, DOS-10 (merged into DOS-27), DOS-11, DOS-12, DOS-13, DOS-14 (dropped), DOS-15, DOS-16, DOS-21, DOS-22, DOS-23, DOS-24, DOS-25. Reason: Crove has its own repo, DB, migration ledger and gates, never reads DOS's DB, issues its own `org_id`, and does not connect to the DOS Event Router. They remain DOS-side items, tracked in DOS.Me.

## 12. Setup checklist (status 2026-10-14; D and H updated 2026-10-23)

Day 0 is behind us: the repo exists, is public and has the MVP. This list keeps what is still open; issue numbers are the tracking issues in this repo.

**A. Defaults already decided** (recorded in ADRs or Decisions; no question blocks code)
- **Protected paths (G6):** PRs touching context, policy, authorization, migrations, dependencies, workflows, hooks or infrastructure run the invariant suite from base and get a security reviewer agent review; an external security review comes before the first external tenant (Decision 7). No owner approval label. Recorded in `AGENTS.md`.
- **License:** `AGPL-3.0-only` (declared in `README.md` and `package.json`); license-grant CLA based on the Apache ICLA/CCLA, reviewed by a lawyer before accepting outside PRs (ADR-0022, to write). The repo is public (Decision 9).
- **Release:** SemVer tags from `main`. Crove Cloud promotes through a workflow in `crove-cloud`, with a 1-click approval step.
- **Crove Cloud operations** (Supabase Pro + 7-day PITR on prod, budget, alert channel, domain `app.crove.com`): belong to `crove-cloud`, set up with MVP step 2; they do not block the core repo.
- **Scope:** kernel + Accounting committed; CRM (incl. Calendar), Service (incl. social inbox), Social, Sign and HRM wait for wedge-customer demand (Decisions 1-2). The forks are shut down, not migrated (Decision 8).

**B. Non-code tracks (each has an owner and a deadline)**
- [ ] Owner: 10-15 customer interviews (founders + accounting firms) before Phase 2a scope is frozen (Decision 1; issue #57). Status 2026-10-23: the backlog review rescoped #57 to 10 interviews inside the design partner, 5 staff and 5 of their client companies (M0-2), due 2026-10-31 (D6); open.
- [ ] Vietnamese accountant: golden-company data for TT133/TT99; preset review; report acceptance (issue #61).
- [ ] Lawyer: PDPL (DPIA, TIA, DPA, 72 h runbook; External-tenant gate T16), Cybersecurity Law 116/2025, >=10-year retention, digital signatures, Circular 58/2026, household businesses 2026; CLA (individual + corporate), brand policy, commercial license terms (issue #62).
- [ ] E-invoice issuing provider and bank aggregator (connector in `crove-cloud`, or via DOS-18/19); enable MISA eSign.

**C. Repo and open source**
- [x] `DOS/Ludy` created and public; squash merges to `main` (`dev` is created with Cloud beta).
- [x] gitleaks and the G1 project-ref scan in the required `Secret scan` check, scanning the full history; a local pre-commit hook (Decision 9).
- [x] `LICENSE` (AGPL-3.0 text), `CLA.md` (draft, pending legal review), `CONTRIBUTING.md`, `TRADEMARKS.md`, `SECURITY.md`: added (issue #33; `SECURITY.md` is part of External-tenant gate T14).
- [ ] License-grant CLA, individual + corporate: draft added in `CLA.md`; lawyer review and enabling CLA Assistant remain.
- [ ] File the "Crove" trademark (Vietnam IP Office; consider Madrid for other markets; issue #63).

**D. Crove Cloud, MVP step 2** (OpenTofu in `crove-cloud`, run by CI via WIF; never from an agent sandbox)

Status 2026-10-23: the backlog review put a pilot on one server first (M1). Done for the pilot: spend and DNS approvals (#52, #53), the deploy pipeline on release tags (#56), the instance (#306), nightly backups with a restore drill (#307). Open in M1: #308 and #309. #55 (a private repo for the pilot environment) was closed as superseded on 2026-10-24: the pilot deploys through the public `deploy.yml` (#56), and the owner kept it there. The unchecked items below stay for Crove Cloud.
- [ ] Owner approvals: spend (issue #52), a Cloudflare token for `app.crove.com` DNS and email routing (issue #53), and the DOS-side redirect URL change on DOS's Supabase Auth (issue #54). #52 and #53 were closed for the pilot's server and domain; #54 is open.
- [ ] Create the private `crove-cloud` repo (issue #55).
- [ ] Dedicated Supabase projects `crove-db-prod` and `crove-db-beta` (ap-southeast-1), used as Postgres only:
  - 7-day PITR on prod; restore runbook written now, rehearsed before Finance GA;
  - the agent's Supabase identity is not a member of either project.
- [ ] GCP projects `crove-prod` and `crove-beta`, each with:
  - a dedicated SA per service (API, worker, migrate job);
  - WIF per branch/environment (prod accepts only `main` + environment `crove-prod`);
  - Artifact Registry, Secret Manager, budget alerts.
- [ ] Worker-first deploys to beta and prod (§3.5; issue #56).
- [ ] Before the first deploy to each project, check that the project runs the same Postgres image line as the `supabase-stack` CI job (`select version()` and the image tag in the dashboard). If it is newer, bump the job's image digest first and let it pass: that job is how the hardening guard (T17) is checked against Supabase's extensions and roles (#179), so a project on an unchecked image can fail the first `migrate`. The guard has no bypass; a failure is fixed with a forward migration or a targeted guard rule, never skipped.
- [ ] No NAT yet. No `crove-ci` project before Phase 3.
- [ ] `crove_*` passwords set by the deploy workflow from Secret Manager.
- [ ] Buckets `crove-files-<env>` and `crove-archive-<env>`, reached through the S3 adapter (External-tenant gate T7). Lock retention only **after a dry run**, only on the archive, with bucket names fixed in the workflow.
- [ ] Vercel `crove-web` for the landing page only (root `apps/web`, `sin1`, previews off). DNS for `app.crove.com`.
- [ ] Prober and alerting: a test alert reaches the owner's phone (issue #39). The prober and its test alert are done (#39); delivery to the owner's phone plus an outside uptime check is #309 (M1).

**E. Baseline**
- [ ] After MVP step 2: compute, `max_connections`, Supavisor `pool_size`, IOPS; connections, CPU and WAL per role.
- [ ] Pre-revenue cost model (estimate, enforced with budget alerts). Monthly: Cloud Run ≈110 USD; dedicated Supabase ≈150-200 (Pro plan 25, prod compute Small-Medium 15-60, beta 10-15, 7-day PITR ≈100); preview branches (G4) 20-100; CI minutes 50-300; Vercel/GCS/logs 20-60. **Total ≈350-770 USD.** Self-host and local development cost nothing.
- [ ] At 100 tenants: add 50-150 USD. At 5,000 tenants: ≈1.5-3k USD of infrastructure, excluding LLM; the DB moves to Large/XL by then. Changing compute restarts the Crove DB (a few minutes), done in a maintenance window.

**F. Agent infrastructure:** SessionStart with a local PostgreSQL 17 and the built-in runner (record the timings), rules, skills, hooks (owner-approved), `AGENTS.md` at the repo root (exists).

**G. Bootstrap:** done. MVP step 1 (#8) delivered the workspace, roles and schemas, the runtime (`execute`, audit, outbox, relay), `apps/kernel` (roles, health and readiness, Dockerfile), the SPA and the finance slice. The original 7-PR bootstrap chain is superseded.

**H. Spikes** (each <=1 week; each ends with "pass" or a fallback recorded in an ADR):
- Supabase Auth on the plain `postgres:17` image (Decision 5): the compose stack on `main` runs it; keep it covered by the Playwright end-to-end job (T9).
- Supabase Auth flow in the SPA: PKCE callback, refresh, logout, MFA and `aal2` (Decision 6): pass in #32, covered by the Playwright `auth` tests against the bundled Supabase Auth.
- A2 pg-boss over Supavisor :5432 and :6543 (Crove Cloud).
- A3 Kanel 4 (issue #48): pass, adopted (§2 DB row).
- A5 PG17 on Supabase: `GRANT … WITH SET/INHERIT`, definer ownership, the §4.5 re-entry guard behind Supavisor transaction mode, what Supavisor resets on a server connection between transactions (#117; Cloud runs `DB_RESET_ON_RELEASE=false` and relies on it), whether `postgres` can set `session_replication_role`.
- A8 presign + `if-generation-match` on GCS.
- A10 AI endpoint conformance (DOS.AI and at least one other OpenAI-compatible endpoint; issue #51): the conformance suite and eval gates are built (#51 closed, `pnpm ai:conformance`); the pilot endpoint has a monthly spend cap (#312).
- A12 G3 runtime on plain PG17.
- A14 CSP + Trusted Types for the SPA (retargeted by Decision 6).
- A15 sandbox egress blocking on Cloud Run (External-tenant gate T12).
- DBOS Transact, 1 week, before Phase 2a (Decision 14; issue #59): fail, own process engine kept ([ADR-0033](../adr/0033-dbos-transact-spike.md)).
- Dropped: A1 (separate repo), A7 (OIDC with DOS ID; replaced by Supabase Auth), A16 (`supabase db push --db-url`; replaced by the built-in runner).
- Moved to the phase that needs them: A4 (TS7 at scale) -> 2a; A9 (NAT) -> when a provider requires it; A11 (OAuth RFC 8707) -> 3; A13 (legal) -> track B.

**I. ADRs:** 0026, 0027 and 0028 accepted; the rest per §16.

## 13. Phase roadmap

**General rules:**
- Every phase has a time-box. If it runs out before the exit criteria are met, cut scope or re-plan **in writing**; no silent extensions.
- Demo every 2 weeks: a local `docker compose up` run until Crove Cloud beta exists, then on beta.
- Committed: the MVP, Phases 0b, 1, 2a and 2b (kernel + Accounting). Phases 3-7 start only when wedge customers pull for them (Decision 2). If several are pulled, two module streams can run in parallel, since modules depend only on the kernel (estimate if all are pulled: sequential ≈74 weeks, 2 streams ≈54 weeks).

**Definition of Done for every module phase:**
- Every write goes through `execute()`; G1-G6 green; RLS matrix with 0 leaks.
- 10-20 Playwright journeys.
- Every `ai.expose` command has evals.
- Complete vi/en keys.
- Runbook, dashboard and alerts exist.
- PII classified.
- No AGPL code copied.

### MVP (replaces Phase 0)

The MVP in Tracking replaces Phase 0 (ADR-0027): step 1 (open source, local) merged on 2026-10-13 as #8, and every exit criterion is met (criterion 2: the RLS matrix of T8, #114, and the write-path check, #877; criterion 4: T9, #18); step 2 deploys Crove Cloud, and the backlog review put a pilot on one server (M1) before it. Where each former Phase 0 exit criterion went:

| Former Phase 0 criterion | Now |
|---|---|
| Repo, license, CLA, gitleaks and G1 from the first commit; G1-G6 green | Repo public with gitleaks + G1 required (Decision 9); `LICENSE` and a draft `CLA.md` added; lawyer review of the CLA and CLA Assistant still pending (§12-C); G2 and G6 built, G3 and G5 partly, G4 waits for Cloud (§10, 2026-10-23) |
| Own DB; migrations through preview -> beta -> prod; replay on plain PG17 | Built-in runner on any PG17 (MVP, implemented); the Cloud DB path comes with MVP step 2 |
| OIDC login with DOS ID; membership from the DOS-Me API; `generic-oidc` adapter | Replaced by Supabase Auth with membership in Crove (Decision 5, ADR-0027; sessions per ADR-0028) |
| Gate DOS-1 and minimal DOS-27 events | Deferred with DOS org sync (Tracking, deferred table) |
| Local DB loop in cloud sessions | Local PG17 + built-in runner (§10, §12-F) |
| Skeleton end to end on beta | MVP exit criterion 1, locally today; on Cloud with step 2 |
| Deploy ordering proven (worker first, readiness, new API with old worker) | Crove Cloud deploys (§3.5, issue #56), before the first external tenant. The pilot deploy (#56, `deploy.yml`, `tools/deploy/deploy.sh`) already migrates first, waits for `/readyz`, runs the smoke test and rolls back on failure; it rolls the worker before the API only when they run as separate services, and the pilot runs one `all` container, so worker-first is not yet proven on a deployment; the "new API, old worker" scenario is not tested |
| Prober test alert; budget alerts | Crove Cloud, before the first external tenant (issue #39). The prober and its test alert are done (#39); alerts to the owner's phone with an outside uptime check are #309 (M1) |
| ADRs 0001/0002/0003/0007/0022/0023 | §16; 0023 is replaced by 0027 + 0028 |

### Phase 0b: Finance spike (2 weeks, in parallel with Phase 1)

Build: TS domain + `post_journal_entry` (SQL) + fast-check + TT133 B01/B02 on sample data (issue #58).

**Status (2026-10-15; checked 2026-10-23):** the SQL half is done. [ADR-0021](../adr/0021-finance-kernel-support.md) (proposed) records the decisions, with measurements from a throwaway PostgreSQL 17 prototype in `docs/adr/0021/`.
- Met in the prototype: every entry balances; reversal nets to zero; 1,000 parallel posts yield gapless numbers 1..1000. "Entries cannot be edited" was already on `main` (#71).
- The TS domain with fast-check and draft TT133 B01/B02 landed in #170 (#58 closed); the draft B01-DNN and B02-DNN are on the ledger screen and in Excel since #464.
- Still open in issue #154 (M2): B01/B02 on sample data matched against an accountant's hand calculation (the accountant track, #61). ADR-0021 was accepted by the owner on 2026-10-24.

**Exit criteria:**
- Every entry balances; entries cannot be edited; reversal nets to zero; 1,000 parallel posts yield gapless numbers 1..1000.
- Reports match an accountant's hand calculation.
- An ADR locks the numbering, legal-entity and posting APIs before the kernel is frozen.

### Phase 1: Kernel v0 hardening + "Party & Document Inbox" (8 weeks)

**Scope:**
- The External-tenant gate (Tracking), the MVP follow-ups (Tracking) and the v0 tables from §6 not built yet; pipeline §4; security §7.
- Party (duplicate hints by tax code/national ID/phone; 2025 addresses + mapping from the old ones).
- Intake: upload, or forward email to an opaque address -> extraction in the sandbox (XML first) -> proposal -> AI Inbox (R0/R1).
- In-app notifications; pg_trgm search; audit viewer for admins.
- Identity per ADR-0028 (design C); membership management in Crove (invites with consent, remove, change role).
- Self-host guide (`docs/self-host/`): compose with PG17 + Supabase Auth + Crove, TLS reverse proxy, SMTP, backups, upgrades.

**Exit criteria:**
1. Arch tests + pgTAP prove there is no write path outside `execute()`.
2. RLS matrix with 0 leaks: cross-org, cross-legal-entity (kernel tables included); forged context, `le_scope` and flags all return 0 rows.
3. UPDATE/DELETE on `audit_event` fails even for `service_role`. `DISABLE TRIGGER` by `postgres` is detected by the WORM verifier.
4. An email carrying e-invoice XML produces a vendor proposal + file + timeline + audit, with no LLM call. Resending creates no duplicates. XML with a forged signature is marked "unverified".
5. PDFs and images produce proposals with evidence and deterministic confidence. Red-team >=30 cases: 0 auto-executed R2+, 0 data leaks.
6. A Vietnamese benchmark of >=100 documents is a PR gate.
7. Load with 100k parties per tenant:
   - p95 DB-only R1 command < 150 ms (including the §4.5 re-entry guard and the ADR-0028 session status check);
   - p95 outbox lag < 2 s;
   - target >=50 events/s on 1 worker;
   - back-pressure works.
8. Org and global kill switches rehearsed.
9. 2-week dogfood (DOS org and Crove org): 0 integrity incidents.
10. **Security checkpoint:** independent security review (auth, context/RLS, sandbox, inbound email, webhooks); `SECURITY.md` (private reporting channel, response times); gitleaks + the blocklist scan the full git history (already on every run). The repo is already public (Decision 9).
11. Every External-tenant gate row is green with its evidence linked.

**Status (2026-10-23, #1204):** in progress; Phase 1 work is tracked in milestones M1 and the GA gate (backlog review).
- Scope built: party duplicate hints and marking a duplicate (#913); in-app notifications (#890); search from the command palette (#858); the audit log for owners and admins (#875); identity per ADR-0028 (T1) and membership management (invites #123, #125, #132; remove and update #115); the self-host guide (#872).
- Met: criterion 1, the write-path check (#680 in #877); 3, `audit_event` append-only for every role and the WORM verifier catching a trigger the database owner disabled and an edited, deleted or backdated row (#891 in #924); 4, an e-invoice email becomes a proposal with no LLM call, a resend creates no duplicate, and an unverified XML signature is marked and must be confirmed at approval (#674 in #938); 5, the red team of 30+ synthetic PDFs and photos (#893 in #900); 7, the load test with 100k parties (#998, [load-test.md](../runbooks/load-test.md): command p95 22.9 ms, outbox lag p95 14.3 ms, relay about 28,000 events/s; back-pressure built in #1016, #894, and measured in #1717: with the relay stopped the lag passed 30 s, the agent, bulk mail, archive and retention queues paused at the next 10 s check (10.0 s later) and held their jobs while interactive commands and `kernel-notify` kept running, then resumed 5.9 s after the lag fell back to 15 s; `load-test.db.test.ts` fails when back-pressure does not engage); 8, the kill switches rehearsed on the compose stack in the e2e job of every pull request (#1718, `e2e/tests/kill-switches.spec.ts`, [incidents.md](../runbooks/incidents.md) §7): the org switch (#79) from the Agents page and the deployment's `ai` refuse agent wake-ups and `ai` leaves a new PDF unread with "AI đang tạm dừng" (#886), `mail` holds a booking's confirmation until released (#897), and `relay:crm.booking.requested` holds the booking until released (#1696).
- Partly: 2, cross-org and forged-context cases are done (T8, T11), cross-legal-entity cases and forged `le_scope` and flags wait for legal entities; 10, `SECURITY.md` (#144) and gitleaks over the full history are done, the independent review is open (#31, owner).
- Open: 6, the benchmark of >=100 Vietnamese documents (the eval runs on a synthetic set, #757; the real set waits for #304 and #153); 9, the 2-week dogfood (needs the pilot running, #308); 11, the gate rows not yet green (T1, T7, T12, T14, T15, T16).

### Phase 2a: Finance A1 (10 weeks)

**Kernel additions:**
- numbering, `external_call`, `process_instance`, `connection_binding` + `CredentialBroker` (`crove-local`; Cloud using the DOS broker needs DOS-8, DOS-20);
- effective-dated data helpers (`btree_gist`);
- hash chain + WORM stream;
- `field_history`; R3 with P09-P13 (`aal2` for R3 is already required by the External-tenant gate).

**Finance** (scope frozen after the interviews, Decision 1; issue #60):
- `legal_entity_books` TT133/TT99 v2026.1; chart of accounts; periods; opening balances.
  - On `main` (#1403 phase A, `20261103020000_crove_finance_books_regime.sql`): `crove_finance.chart` lists the charts as (regime, version), TT133 2026.1 and TT99 2026.1; `crove_finance.chart_account` holds the 184 TT99 accounts (Circular 99/2025, Appendix II; to be checked by the accountant, #61), while TT133 2026.1 stays `crove_finance.account`. `crove_finance.legal_entity_books` gives an entity a chart from the first day of a fiscal year; an entity without a row keeps TT133 2026.1 books. A row is written, changed or removed only while the entity has no journal entry from that date on (`BOOKS_REGIME_IN_USE`, also against a posting in flight), and a journal line of an entity not under TT133 2026.1 must name an account of its chart (no TT133-only account, no sub-account). Tenant roles only read the table: the command that chooses a regime comes with the TT99 posting templates, B01-DN/B02-DN and opening balances under TT99 (#1403 phase B, with the accountant).
- Purchase vouchers from intake; sales invoices; receipt/payment/bank debit/bank credit/general journal vouchers (PT/PC/BN/BC/NVK).
- Post, reverse, period close; VAT.
  - On `main` (#165), a reversed purchase: reversing the journal entry of a purchase document also voids Crove's record of that document, in the same transaction, so the same supplier invoice can be recorded again with the right accounts (the file is read again into a new proposal). Documents stay append-only: the void is its own append-only row (`crove_finance.purchase_document_void`) that names the reversal entry, and the database checks that it is the reversal of that document's entry; since #204 it also checks the other way, for every writer: a reversal of a purchase entry commits only together with that void (a deferred constraint trigger on `journal_entry`, `20261018150000`). The kernel asks the finance module which proposals had their document voided through `ctx.query` (`finance.documents.voided_proposals`) instead of reading the finance tables. Since #254 a request to reverse an entry is refused while a reversal of it waits for approval (`REVERSAL_PENDING`), so `kernel.proposal.request` raises at most one open reversal proposal per entry. A document recorded again names the voided document it replaces (`replaces_document_id`), so at most one document per supplier invoice is in force: the duplicate check (`DUPLICATE_INVOICE`) ignores voided documents only. This is an internal correction of Crove's records, not a change to the supplier's e-invoice, which stays valid at the tax authority; correcting or cancelling it is the supplier's business (an adjustment or replacement invoice). **An accountant should confirm this treatment** before Finance is charged for, together with how an adjustment invoice is booked.
- **File-based bank statements** with dedupe by running balance.
- **Inbound e-invoices** (Cloud: `misa-inbound-einvoice` via the DOS broker, or a connector in `crove-cloud`).
- Reports: trial balance, general ledger, B01/B02, receivables/payables.
- Archive package; accountant preset.

**Exit criteria:**
- Ledger invariants (pgTAP + model-based fast-check), specifically:
  - re-posting after a reversal uses `source_revision`;
  - `period_balance` is writable only by the posting definer, and reconciled nightly;
  - voided numbers are in the hash chain.
- The golden company's reports match to the dong under both TT133 and TT99, signed off by an accountant.
- Back-dated posting into a closed period fails.
- An `external_accountant` scoped to legal entity A sees nothing of legal entity B anywhere.
- Legitimate duplicate bank lines are not lost; unresolved lines become Inbox exceptions.
- The archive package verifies from its manifest; `crove-db-prod` PITR restore rehearsed.
- Accounting legal work done before charging for Finance.

**Status (2026-10-23, #1204):** in progress, ordered by milestones M2 (monthly close loop) and M3 (paid pilot) of the backlog review rather than as one 10-week phase.
- On `main`: sales e-invoices (#427); purchase vouchers exported to MISA SME (#357) and cash vouchers too (#660); general journal vouchers, NVK (#925); the VAT working per month or quarter (#356) and the 01/GTGT XML (#508); opening balances (#367, #758); org sub-accounts under the TT133 chart (#363); ledger reports for a month, quarter or year (#364); draft B01-DNN and B02-DNN (#464); file-based bank statements, deduplicated (#486), with vouchers from statement lines (#551); the period lock (#477); year-end closing (#936); the fiscal year archive package (#954, #970); voucher numbers and voids in the WORM stream (#987); the assisted tax portal purchase sync (#1089, ADR-0036); period balances as append-only deltas written only by the posting definer and reconciled nightly (#1284, ADR-0021 section 3).
- Open in M2: #316 (VAT working), #317 (MISA import), #154 (B01/B02 checked by an accountant), #153 (extraction accuracy on real documents), #61 (accountant track). Open in M3: #326 (bank statement matching), #332 (01/GTGT accepted by HTKK and eTax), #657 (cash and bank vouchers in the MISA templates), #920 (annual statements as HTKK XML), #921 (tax calendar), #1100 (first supervised tax portal run), #323, #328 and #331. Not built yet: TT99 postings and reports (#1403 phase B; the chart and the regime per entity are on `main`), `field_history` and the `crove-db-prod` PITR rehearsal (Crove Cloud).

### Phase 2b: Finance A2 (starts when e-invoice issuing and bank connectors are ready, in `crove-cloud` or via DOS-18/19; 8 weeks)

**Scope:** e-invoice issuing (covers timeout -> `ambiguous` -> reconciliation); bank API; Ask-the-books; chat dock on `crove-stream`; SSE.

**Exit criteria:**
- A timeout injected mid-flight never causes duplicate issuance.
- Ask-the-books answers always cite the metric and the query hash.
- A tainted run cannot send anything.

### Phase 3: CRM + Calendar (12 weeks, when wedge customers pull for it; reference: Twenty, Cal.com, Calendly)

Calendar started early, on its own (Decision 20, 2026-10-24); its detailed plan is [calendar.md](calendar.md). The rest of this phase still waits for wedge-customer demand.

**Kernel additions:** `record_share`, `saved_view` + Filter AST, custom fields, `record_link`, `search_doc`, `api_key`, `/v1`, outbound webhooks, `/mcp` (Cloud: after DOS-9; grants per org, client and user), the OAuth 2.1 authorization server (Decision 14), project `crove-ci` + kernel `pr-<n>`, team scope (Cloud: after DOS-5/6). Plus the `calendar` service: events, availability, Google Calendar, Microsoft 365 and CalDAV sync through connectors.

**CRM scope:**
- Contacts and companies are `party`; deals and pipelines; saved views, custom fields, record sharing; CSV import.
- A shared customer timeline: email, appointments, conversations, tickets, contracts, invoices.
- AI: customer summaries, next-step suggestions, email drafts; every write is a proposal.

**Calendar scope:**
- Public booking page `/-/b/…`: event types, round-robin, Vietnamese holidays, buffers; only free slots returned; Turnstile, rate limits; reschedule/cancel through single-use token links.
- A booking creates or matches a `party`, writes `activity`, links to a deal; Meet, Zoom, Teams meeting links; reminders as jobs.
- AI proposes slots from email or chat; sending an invitation is a proposal.

**Exit criteria:**
- No double booking: `EXCLUDE USING gist` on `tstzrange`; 200 concurrent bookings of one slot give exactly 1 success.
- Stored as UTC + IANA timezone; free/busy drift against external calendars <=1 minute.

### Phase 4: Service (10 weeks, when wedge customers pull for it; reference: Go Desk, Zendesk)

**Kernel additions:** the `channel` layer: one OAuth connection per page or account (Facebook Page, Instagram, Zalo OA, TikTok, email), shared by Service (inbound) and Social (publishing). Connectors sit behind adapters; Cloud uses platform-approved apps, self-hosters register their own.

**Scope:**
- Unified inbox: email, messages and comments from Facebook Page, Instagram, Zalo OA, TikTok. Each conversation links to a `party` and becomes a ticket when needed.
- Record-based tickets with per-org numbering; SLA, assignment, reply templates; automation v1 with loop protection.
- AI triage, summaries, reply drafts. Outbound sends are R2 and need approval, unless the org enables auto-reply for approved question classes. Customer messages are tainted input.

**Exit criteria:**
- Reconciled against Message-IDs and each channel's message ids: 0 lost messages, correct order within a conversation.
- SLAs correct under a test clock.
- An expired channel token alerts and stops sending; inbound messages are not lost.
- The AI never promises prices, discounts or refunds outside policy.

### Phase 5: Social (6 weeks, started 2026-10-16 per Decision 17; reference: Postiz, Publer, Nuelink, Buffer)

Detailed plan, dependencies and steps: [social.md](social.md). The `channel` layer below moves from Phase 4 to this phase.

**Scope:**
- Reuses the Phase 4 `channel` layer; adds LinkedIn, YouTube, X.
- Compose, per-channel variants, publishing calendar, time-slot queues, evergreen reposting, multi-step approval, media library.
- AI drafts, per-channel rewrites, posting-time suggestions. Publishing is R2 and needs approval, unless the org enables auto-publishing for untainted content.
- Engagement metrics pulled by jobs; comments and messages already live in Service.

**Exit criteria:**
- Each post is published exactly once per channel: idempotency through `external_call`; a mid-flight timeout reconciles by the channel's post id, never double-posts.
- An expired channel token pauses that channel's queue and alerts; no posts lost.
- AI posts drafted from tainted input never auto-publish.

### Phase 6: Sign (8 weeks, when wedge customers pull for it; reference: Documenso, Docusign)

**Scope:**
- Vietnamese CAs via MISA eSign/WeSign.
- Document templates, multiple signers in order; sent from CRM (quotes, contracts) and HRM (labor contracts).
- Signer verification (OTP/eKYC).
- Public page `/-/p/…`: token in the fragment, `Referrer-Policy: no-referrer`, Turnstile, single use, replay protection.
- Audit certificate.

**Exit criteria:**
- Signed documents cannot be altered (hash); the audit certificate verifies independently.
- Reused or forwarded signing links are rejected.

### Phase 7: HRM (10 weeks, when wedge customers pull for it)

**Scope:**
- Employee records, departments; labor contracts signed through Sign; basic recruiting (candidates, interview scheduling via `calendar`).
- Timekeeping and leave per Vietnamese law; multi-level approval.
- Payroll: social insurance, health insurance, unemployment insurance (BHXH, BHYT, BHTN), personal income tax; contribution rates and tax brackets are effective-dated config.
- Payroll posts to Accounting through events with `UNIQUE(source, source_revision)`.
- Salaries and national IDs behind RESTRICTIVE policies + flags, with read audits; HR events carry `type` only.

**Exit criteria:**
- The golden company's payroll matches an accountant's hand calculation.
- Unauthorized users cannot read salaries, including through search, export or the agent.

### Email (8 weeks estimated, added 2026-10-19 per Decision 18; reference: Mailchimp, Brevo, listmonk, Postmark, Amazon SES)

Detailed plan, steps and open decisions: [email.md](email.md); architecture: [ADR-0034](../adr/0034-outbound-email.md) (accepted 2026-10-24). Transactional steps E1-E2 are in M2, marketing after M3 (backlog review D11). Status 2026-10-23: E1 and E2 are done (#538, #539); E3-E9 wait in the Icebox (epic #537).

**Kernel additions:** the mail pipeline (`mail_message`, `mail_suppression`, `mail_event`, a send queue and a throttled bulk queue, each send through `external_call`), provider webhooks and bounce reports, `contact_point` (§6), public unsubscribe and signup routes.

**Scope:**
- Transactional: built-in and org-editable templates in Vietnamese and English for the mail every module sends (invites, invoices, reminders), a message log with delivery status, bounces and complaints that suppress.
- Sender domains verified with SPF, DKIM and DMARC.
- Marketing: topics, subscriptions and an append-only consent record, double opt-in, CSV import with a declared basis, audiences, campaigns with review and approval (R2), throttled sending, one-click unsubscribe, analytics; click counts only when the org turns them on.
- AI drafts and rewrites, tainted, always landing as drafts.

**Exit criteria:**
- No mail to a suppressed address; at most one copy per campaign recipient across a worker crash.
- Every marketing mail has a working one-click unsubscribe, the `[QC]` label while the setting is on, and goes only to contacts with recorded consent, from a verified domain.
- A complaint rate above 0.3% or a hard bounce rate above 5% pauses the org's marketing.
- With `CROVE_MODULES` excluding `email`, invites still go out with the built-in templates.

### Meeting Notes (6 weeks estimated, added to the roadmap 2026-10-21 per Decision 19; reference: Otter, Fireflies, tl;dv, Google Meet notes)

Not started. A detailed plan and an ADR come before the first PR; until then this section is the scope.

**Kernel additions:** none required to start. Audio is a `file` (a new upload purpose); transcription and summaries go through the provider-agnostic AI layer with its budgets and kill switches (§4.12); action items become `kernel.task` rows through proposals; follow-up mail uses the Email pipeline (Decision 18).

**Scope:**
- Record in the browser or upload a recording (audio or video, size and length capped). The recording is parsed and transcoded in the sandbox (T12), never in the API.
- A transcript with speakers and timestamps, Vietnamese first; a summary, the decisions taken and action items with an owner and a due date.
- Link a meeting to parties, a deal (Phase 3) or a calendar event (Phase 3, Meet, Zoom and Teams links); search across an org's meetings.
- Action items are proposals that create tasks; a follow-up email draft is a proposal sent through the Email module (R2).
- Later, on demand: a bot that joins Meet, Zoom or Teams calls through a connector, and live notes.
- Consent: the recorder confirms that participants were told (PDPL, T16); the org sets retention for recordings separately from transcripts, and deletion is crypto-shredding like other personal data.

**Exit criteria:**
- A one-hour Vietnamese meeting is transcribed and summarized within the agreed time; word error rate measured on a fixed eval set of synthetic meetings.
- No task, email or record change happens without a human approval; prompt injection in a recording cannot raise a proposal's risk or skip approval (red-team cases in CI, as #893 does for documents).
- A recording past its retention is gone from storage and backups within the documented window; the transcript keeps no audio.
- With `CROVE_MODULES` excluding `meetings`, nothing of it loads.

### After the core modules

- **Projects:** `task_ext` attached to `kernel.task`; boards on `list`; billable hours flow to Accounting exactly once.
- **Notes and personal to-dos** (module `notes`, owner request 2026-10-27, epic #1648): private or shared notes linked to clients, parties and documents, a member's private to-do list, and a "My work" view with the tasks of their positions; plan [notes.md](notes.md), private items in [ADR-0037](../adr/0037-private-notes-and-todos.md) (Accepted). The owner approved the plan on 2026-10-28; its steps N1 to N10 are issues under the epic.
- Workflow builder, websites, ads: only on real customer demand. Email marketing is the Email module above (Decision 18).

### The forks

No fork has real users. The owner archived the five fork repositories on 2026-10-14 (Decision 8); taking down their running deployments is a DOS-side step, tracked outside this repo (issue #70). Nothing is synced, imported, compared for parity or kept as a rollback target. Native modules may use a fork only as a behavioural reference, under the clean-room rule (§10).

| Fork | Native module | Starts |
|---|---|---|
| Twenty (CRM) | CRM | Phase 3, on demand |
| Cal (from Cal.com) | CRM calendar and booking pages | Phase 3, on demand |
| Go Desk | Service, including the social inbox | Phase 4, on demand |
| Post (from Postiz) | Social; comments and messages go to Service | Phase 5, on demand |
| Documenso (Sign) | Sign, with Vietnamese CAs | Phase 6, on demand |

## 14. Major risks and mitigations

| Risk | Mitigation |
|---|---|
| Revocation is late or fails open (a signed-out, banned or removed user keeps access) | <ul><li>ADR-0028 (design C): issuer, audience and expiry required; a Crove session status record checked in the request transaction; self-host reads `auth.sessions` (next request); Crove Cloud keeps Supabase Auth's default (access ends at token expiry after a sign-out elsewhere; DOS-28 events optional); owner revoke is immediate; R3 checks Supabase Auth live with fresh MFA.</li><li>Membership read from the DB on every request; claims never grant membership.</li><li>External-tenant gate T1.</li></ul> |
| Crove Cloud depends on DOS's Supabase Auth | Per-request checks do not call Auth, so an Auth outage stops new logins, refresh and R3 but not existing sessions until their tokens expire; a sign-out outside Crove takes effect at token expiry (ADR-0028 amendment 2026-10-15; DOS-28 events optional); runbook §7.10; status page; measure Auth latency and rate limits before the first external tenant (issue #34) |
| A stolen phone that holds the TOTP app passes step-up | Prefer passkeys; password re-entry for R3; owner "revoke all sessions" (ADR-0028) |
| Coupling to Supabase Auth internals (self-host reads `auth.sessions` and `auth.users`; Supabase Auth migrates its own schema) | Supabase documents the `auth.sessions` lookup; compose pins the Supabase Auth image; a CI contract test checks sign-out, `not_after`, ban and deletion against that version; a schema change breaks the check closed; a new identity adapter can replace Supabase Auth (`user_account` keeps `(issuer, subject)`) |
| Known MVP gaps reach an external tenant | External-tenant gate (Tracking): every row needs its evidence (test, CI check or report) before Crove Cloud accepts an external tenant |
| DOS org sync enabled before gate DOS-1 passes (later) | Hard gate on enabling the adapter; self-host unaffected; team scope off until DOS-5 |
| DOS incident (AI, later org events) | AI jobs retry, then DLQ; the e-invoice XML path needs no AI; reconcile covers failed org events; runbooks §7.10 |
| Security code merged without any human reading it | Invariant suite from base; G6 (security reviewer agent on every protected-path PR); external security review before the first external tenant (Decision 7; T14, T15); small PRs; per-environment identities |
| Agents get tools that touch prod or see tenant PII | Local DB; agents are not members of Crove Cloud's Supabase projects; no Supabase MCP or migration runs against prod/beta; PreToolUse hook |
| Leaks through the public repo (project refs, internal URLs, secrets, customer data) | <ul><li>gitleaks scans the full history on every run; `Secret scan` is required on `main`.</li><li>G1 scans for project refs against a blocklist kept outside the repo.</li><li>Environment config only in `crove-cloud`; fixtures only synthetic data.</li></ul> |
| AGPL/CLA friction (contributors reluctant to sign, companies wary of AGPL) | License-grant CLA (contributors keep copyright), with a corporate version; a clear `CONTRIBUTING.md` (both still to add, issue #33); commercial license; third-party plugins run out of process via API/MCP |
| Brand impersonation (forks using the Crove name, fake Cloud offerings) | Trademark registration (issue #63); `TRADEMARKS.md`: redistributions must change name and logo; official domains |
| Second-system effect, scope creep | Wedge first; only kernel + Accounting committed; Phases 3-7 on demand (Decisions 1-2); time-boxes; demo every 2 weeks |
| External Finance dependencies (e-invoice issuing, banks, legal) | Non-code tracks; split into 2a/2b |
| API and worker version skew (Crove Cloud; `all` has none) | Worker-first; DB-decided fan-out; skew test in e2e |
| Out-of-order or edited migrations | Built-in runner: one ledger with sha256 per file, refuses edited files; `/readyz` waits for missing versions; pre-promote check; hotfix rule |
| Malicious content in files, email, prompts | Sandbox (T12); inbound processing out of the API (T5); provenance-based taint; opaque addresses; Rule of Two |
| Using another org's credentials through the broker | Bindings check ownership and org (§7.4); default `crove-local`; `dos-broker` stays off until gates DOS-8 and DOS-20 pass |
| Connection exhaustion | Per-workload roles; Crove project baseline; separate `crove-stream`; scale compute before raising limits |
| PDPL and data residency | PDPL package before external tenants (T16); crypto-shredding; deletion map; a copy in Vietnam if a lawyer requires it |
| Operating with only the owner and agents | Prober + alerts; runbooks; kill switches; on-call agent; scheduled releases |
| Libraries ship new versions constantly (oRPC, pg-boss, AI SDK) | Daily Renovate + CI/eval gates; 1-2 importing packages per library; version-matched vendor docs; Plan B for each |
| Large scope if many modules are pulled | Only kernel + Accounting committed; later modules reuse the kernel's party, activity, file, task, `calendar`, `channel`, notifications and AI Inbox; generators for commands, screens and tests; per-phase time-boxes |
| Pre-revenue cost | Self-host and local development cost nothing; Cloud spend needs owner approval (MVP step 2); budget alerts; CI concurrency; auto-close stale PRs; no NAT or per-PR kernel before needed; Supabase compute starts small and grows with the baseline |

## 15. Deliberately NOT in v1

- **Infrastructure:**
  - No microservices, Kafka, Redis, k8s, Elasticsearch or ledger service.
  - No pg_partman; no runtime partition creation; no DEFAULT partition.
  - No Supabase Realtime/Broadcast-from-DB; no replication slots.
  - No forwarding to the DOS Event Router.
- **Schema:**
  - No runtime DDL, metadata engine, custom objects, per-tenant schemas or EAV.
  - No ORM migrator; no vendor self-migration (Mastra, LangGraph, DBOS; the DBOS spike showed its schema can ship as committed SQL, but DBOS is not adopted, ADR-0033).
- **Jobs:** no transactional pg-boss handlers.
- **Frontend:**
  - No persisted client cache; no server-side caching of tenant data.
  - No server-side code in the product app: it is a static SPA and every write is a kernel command (Decision 6).
  - No offline-first app; no realtime co-editing (PWA + Web Push later).
- **Customization and integrations:**
  - No tenant-written code or policy language.
  - No visual workflow builder beyond narrow automation.
  - No website or landing page builder or ads. Email marketing is the Email module since 2026-10-19 (Decision 18), without bought lists or cold outreach.
  - No connector marketplace, no public plugin SDK.
  - No in-process third-party plugins in v1 (use API/MCP).
- **AI:**
  - No multi-agent swarm, no agent catalog.
  - Never auto-run R3 on tainted input.
  - The LLM does no arithmetic on financial numbers; no text-to-SQL.
  - No approvals stored in AI SDK messages.
  - No tenant data in git or evals unless the org opts in.
- **Platform:**
  - No OpenFGA/SpiceDB, no in-house IdP (identity comes from Supabase Auth, Decision 5; the Phase 3 OAuth 2.1 server is an off-the-shelf component, Decision 14: `oidc-provider`, proposed in ADR-0032, holds no users), no GraphQL.
  - No Supabase Vault for Crove secrets (self-host doesn't have it); no Sentry in v0.
  - No FKs, DB connections or business-data sync with DOS.
- **Finance A:** no consolidated reporting, inventory costing, fixed-asset depreciation, automatic FX revaluation, full payroll or tax filing.
- **Fork replacement:**
  - No sync, imports or parity checks with the archived forks (Decision 8); no copying AGPL code.
- **Reporting and infrastructure:**
  - No custom report builder, no multi-region, no customer-managed keys.
  - No NAT before a provider requires it; no per-PR kernel before Phase 3.

## 16. ADRs

ADRs live in `docs/adr/`, using the MADR template. They keep the "why"; this plan describes the current design.

**Written:**

| ADR | Content | Status |
|---|---|---|
| [0026](../adr/0026-wedge-scope-and-phase-0.md) | Wedge (Document Inbox), scope (kernel + Accounting), rigor by stage, protected-path review without an owner label, forks frozen | Accepted 2026-10-13; partly superseded by 0027 |
| [0027](../adr/0027-oss-core-and-crove-cloud.md) | Open-source core vs Crove Cloud; auth on Supabase Auth only; app shell (Vite + TanStack Router SPA); brand | Accepted 2026-10-13 and 2026-10-14 |
| [0028](../adr/0028-identity-sessions-and-revocation.md) | Identity: Supabase Auth access tokens verified locally with required issuer, audience and expiry; design C: a Crove session status record checked in the request transaction, fed by `auth.sessions` (self-host); Crove Cloud keeps Supabase Auth's default token lifetime for sign-outs outside Crove (amended 2026-10-15, DOS-28 events optional); immediate owner revoke; disabled users; membership on every request; R3 with a live Auth check, `aal2` and MFA in the last 5 minutes | Accepted 2026-10-14 (owner) with conditions, amended 2026-10-15; its acceptance tests are External-tenant gate T1 (issue #22) |
| [0029](../adr/0029-agents-positions-and-org-chart.md) | Agents as org members: positions held by humans or agents, module agent templates, tasks with delegation and escalation, wake-ups, budgets, R3 always ends at a human, runtimes as adapters | Accepted 2026-10-14 (direction); details proposed until the Phase 1 PR |
| [0013](../adr/0013-evidence-storage-and-integrity.md) | Evidence storage and integrity: the triple (key, generation, sha256) on every file row, version-pinned reads checked by sha256 (S25), bucket versioning required by default, staged uploads through a single-use presigned POST with the server-side hash, presigned GETs of the recorded version | Accepted 2026-10-16 (issue #109) |
| [0021](../adr/0021-finance-kernel-support.md) | Kernel support for Finance, from the Phase 0b spike (measured on PostgreSQL 17): <ul><li>money domains `amount numeric(20,4)`, `unit_amount numeric(24,8)`, `quantity numeric(20,6)`, `fx_rate numeric(24,10)` (direct quote), plus a per-currency scale check because `numeric(20,4)` rounds silently;</li><li>gapless numbering: a counter row per (org, legal entity, doc type, period key) allocated last in the posting transaction, voids as append-only facts; 1,000 parallel posts gave 1..1000;</li><li>period close: `FOR SHARE` guard in a `BEFORE INSERT` trigger, close in order, reopen newest first (R3, reason);</li><li>hash chain per legal entity, appended asynchronously from a pending queue, anchored by the WORM stream;</li><li>`source_revision` with a payload hash for replay and re-posting after reversal;</li><li>bank line keys: bank reference, else date + amount + running balance, else an Inbox exception.</li></ul> | Accepted by the owner 2026-10-24 (proposed 2026-10-15, issue #58); numbering #977, the period lock #329 and the hash chain #891 were built on it before that |
| [0034](../adr/0034-outbound-email.md) | Outbound email: one kernel pipeline (log per mail, suppression, one send per mail through `external_call`, transactional and marketing streams apart, providers behind `@crove/mail`) and an optional Email module (domains, templates, consent, campaigns); marketing needs consent, a verified domain, one-click unsubscribe and an R2 approval | Proposed 2026-10-19 (Decision 18); accepted before Email step E1 |
| [0036](../adr/0036-assisted-tax-portal-sync.md) | Assisted purchase-invoice sync from the tax portal (#325): the accountant types the client's portal password and solves the CAPTCHA in Crove; the API logs in and seals only the portal's session for the browser (bound to user, org and period, 20 minutes); the list goes through the import path and the XML through the upload path; egress to one fixed origin through the egress guard; off unless `TAX_PORTAL_SYNC=true` | Accepted 2026-10-23 (owner decision on #325) |
| [0037](../adr/0037-private-notes-and-todos.md) | Private notes and to-dos of the `notes` module ([notes.md](notes.md), #1649): read by their author only, enforced by restrictive policies on the sealed context with the system context kept out except through named definers; a leaving member's private items sealed 30 days then deleted; private items out of the org export; the PDPL finder sees counts, never text | Accepted by the owner 2026-10-28 (proposed 2026-10-27, decisions N-2 to N-6 of the plan) |

**To write** (the ones the External-tenant gate depends on first):

| ADR | Content | Due |
|---|---|---|
| 0007 | Tenancy and context: `enter_context`, full seal, the re-entry guard of §4.5, actor bound to `session_user`, split definer roles, RLS template, `search_path` | Before the first external tenant (T10, T11) |
| 0018 | Untrusted content: extraction sandbox, inbound email processed in the worker, opaque email addresses, provenance-based taint | Before the first external tenant (T5, T12) |
| 0001 | Repos (public core + private `crove-cloud`), Crove's own migration ledger and built-in runner, G1-G6 gates, PR policy (size, protected paths, what "reviewed" means, the Decision 7 flow) | Before the first external tenant (T15) |
| 0002 | Crove's own DB: dedicated Supabase prod/beta projects, runs on any PG17, capacity baseline, DR/RPO/RTO, 7-day PITR + rehearsed restore runbook, WORM stream, >=10-year retention | Before MVP step 2 |
| 0003 | Runtime and environments: one image with roles `migrate`, `api`, `worker` and `all`, separate GCP projects, WIF, worker-first deploys from `crove-cloud`, readiness, per-role connection budget, egress | Before MVP step 2 |
| 0022 | `AGPL-3.0-only` license, license-grant CLA (individual + corporate, CLA Assistant), trademark + brand policy, open-core boundary, business model, commercial license, third-party extension via API/MCP | Before accepting outside contributions (the repo is already public) |
| Decision 12 proposals | Composition root (`createKernel`), per-deployment module enablement, modules that run when others are off | Before the matching PR (issues #43, #44) |
| 0004 | Surfaces: oRPC 1.x contract-first; `/api/rpc`, `/api/*`, the `/auth/v1` proxy and `/webhooks` | Before Phase 1 features |
| 0005 | Data access: Kysely + Kanel, type parsers, snake_case on the wire, cell-ready pool resolution | Before Phase 1 features |
| 0006 | Naming rules (§5.3) | Before Phase 1 features |
| 0008 | Async: <ul><li>insert-only outbox + `outbox_pending`; fan-out seeded by migration;</li><li>non-transactional handlers; org-scoped keys;</li><li>pg-boss schema vendored into migrations (T6);</li><li>retention; yearly partitions;</li><li>bytes per 1M commands.</li></ul> | Before Phase 1 features |
| 0010 | Risk and policy: levels, derived risk, P01-P13, who may approve R3 (T2), proposal revisions, the agent autonomy table | Before Phase 1 features |
| 0011 | Frontend: SPA cache policy, CSP/Trusted Types, untrusted HTML | Before Phase 1 features |
| 0015 | Version and upgrade policy (including the Vite+/Oxfmt exception) | Before Phase 1 features |
| 0017 | Data classification, PII, crypto-shredding, deletion map, PDPL | Before Phase 1 features |
| [0033](../adr/0033-dbos-transact-spike.md) | Process engine: the plan's own engine, not DBOS Transact (spike result, Decision 14) | Accepted 2026-10-16 (Decision 14's rule; issue #59) |
| 0009 / 0012 | Agent runtime and chat (OpenAI-compatible provider) / SSE invalidation | 2b |
| [0032](../adr/0032-oauth-authorization-server.md) | OAuth 2.1 authorization server for self-host and Cloud (Decision 14; issue #67): proposed 2026-10-16, embedded `oidc-provider`, fallback Ory Hydra | Accepted before Phase 3 (acceptance tests in the ADR) |
| 0020 | Clean-room process for using the archived forks as references | Before Phase 3 |
| 0014 / 0019 / 0016 | Freezing public names + the `com.crove` prefix / MCP grants / egress, SSRF and NAT | Phase 3, or when the first provider requires an IP allowlist |
| [0024](../adr/0024-calendar-service.md) | Kernel `calendar` service: events, availability, external calendar sync, double-booking prevention; the booking page is a `crm` feature | Accepted 2026-10-25 (Decision 20, [calendar.md](calendar.md)); recorded after Calendar steps C1 to C5 and C8 (#1383); external calendars and meeting links wait for the owner's OAuth apps (#1374, #1375) |
| [0025](../adr/0025-channel-layer.md) | `channel` layer: social and email connections shared by Service and Social, Cloud apps vs self-host | Accepted 2026-10-16 (owner); implemented in Social step S2 (#232) |

0023 (federated identity: DOS ID via OIDC, `IdentityProvider` adapter, Crove sessions) will not be written: ADR-0027 and ADR-0028 replace it.

## Appendix: Red-team log

History: this log records the 2026-10-12 review rounds and is not rewritten. Where it conflicts with the body, the body wins; for example S6's advisory-lock re-entry guard is corrected in §4.5, and S18, O8 and O14-O19 refer to Crove-issued sessions, superseded by Supabase Auth (§7.5).

Legend: S = security, F = feasibility and agent DX, O = operations and cost. Severity: B = blocker, M = major, m = minor.

| # | Issue | Sev | Decision | Addressed in |
|---|---|---|---|---|
| S1 | Beta, prod and PRs share a GCP project, SAs, NAT and secrets | B | **Accepted, amended:** <ul><li>split `crove-prod` and `crove-beta`; add `crove-ci` from Phase 3;</li><li>deploy with GitHub Actions + WIF per branch/environment instead of Cloud Build approval;</li><li>NAT prod-only, and only when needed.</li></ul>(2026-10-13: infrastructure moved to the private `crove-cloud` repo; amended 2026-10-24 by the owner: the pilot deploy workflow stays in this public repo as `.github/workflows/deploy.yml`, generic and driven by secrets in the GitHub environment, with nothing DOS-specific in it (#55, #56); Supabase also split into `crove-db-prod`/`crove-db-beta`; DOS-10 merged into DOS-27.) | §3.1, §3.3, §3.5, §12-D, DOS-27 |
| S2 | A single `crove_definer` bypasses RLS and can read identity and Vault | B | **Accepted, amended:** <ul><li>split into 4 definer roles;</li><li>Crove secrets in Secret Manager, no definer reading Vault;</li><li>REVOKE PUBLIC per function;</li><li>EXECUTE matrix + negative tests.</li></ul>(2026-10-13: no longer reads DOS identity or Vault; added `crove_definer_identity`, which only writes the projection.) | §4.5, §7.1, §7.8 |
| S3 | Module roles insert directly into outbox/audit; jobs run as system | M | **Accepted:** <ul><li>writes through stamping definers that check type against the registry;</li><li>jobs carry the enqueuing actor;</li><li>added P13; imports that post entries are R3 proposals.</li></ul> | §4.7, §4.9, §4.10 |
| S4 | Bindings don't check connection ownership | M | **Accepted;** DOS-8 before the first binding (2026-10-13: only if Cloud uses the DOS broker; default is `crove-local`) | §7.4, DOS-8/20 |
| S5 | File parsing in the privileged worker | M | **Accepted, amended:** <ul><li>the sandbox receives bytes directly in the request, no presigned URL or egress;</li><li>the worker does not re-verify XML; e-invoice authenticity comes from the official source.</li></ul> | §7.6, §8.4 |
| S6 | The seal covers only org and actor | M | **Accepted, amended:** <ul><li>seal the whole context;</li><li>block re-entry with an advisory lock, since a marker table can't be written in READ ONLY;</li><li>actor bound to `session_user`.</li></ul> | §4.5 |
| S7 | Kernel projections leak across legal entities and private data | M | **Accepted:** <ul><li>RESTRICTIVE legal-entity policies on kernel tables; `record_le`;</li><li>per-user policies;</li><li>`classify`; individual tax code = `national_id`.</li></ul> | §4.6, §5.2, §6 |
| S8 | `search_path` hijack via a shared `public` schema | M | **Accepted:** `search_path` set on roles; schema-qualified function calls; G2 requires `SET search_path` on every function (2026-10-13: Crove has its own DB; `search_path` rules unchanged) | §4.5, §5.5 |
| S9 | Forwarding events to the DOS Event Router | M | **Accepted:** no forwarding in v1; DOS-24 (2026-10-13: DOS-24 no longer a prerequisite; Crove does not connect to the Event Router) | §4.9 |
| S10 | MCP takes the org from a client-set header | M | **Accepted** (Phase 3, after DOS-9): grants per (org, client, user) (2026-10-13: DOS-9 applies to Cloud only) | §8.9 |
| S11 | Security SQL merged unread; a PR can loosen its own tests | M | **Accepted:** <ul><li>invariant suite from `origin/dev`;</li><li>G6 needs the owner to amend the policy in AGENTS.md; alternative: an outsourced security reviewer.</li></ul>(2026-10-13: the Crove repo's `AGENTS.md`.) | §10, §12-A |
| S12 | Agent tooling able to touch prod DBs | M | **Accepted, amended:** local DB instead of a separate non-prod project (2026-10-13: the agent is not a member of the Crove prod/beta projects, a hook blocks `db push` outside CI) | §10, §12-D |
| S13 | Taint follows the run's input, not the data | M | **Accepted:** <ul><li>`source_trust`; taint propagates from tool results;</li><li>P03 applies from R1; P04 widened;</li><li>"known" means verified; limited to the thread.</li></ul> | §4.7, §8.5 |
| S14 | Email routed by slug; SPF results can be spoofed | M | **Accepted:** opaque addresses with tombstones; quota before write; parties created from email are proposals | §7.6 |
| S15 | Edit-on-approve lets one person decide R3 alone | M | **Accepted:** new revision; authors can't approve; P12; aal2 by default | §4.7, §8.3 |
| S16 | Permission cache misses role changes on the DOS side | M | **Accepted:** cache keyed on the membership fingerprint, TTL <=60 s (2026-10-13: DOS role changes arrive via events + reconcile; the fingerprint comes from `tenant_member`) | §4.6, §7.3 |
| S17 | API keys keep permissions after the creator leaves | M | **Accepted:** intersected with the creator's current permissions; auto-disabled; <=90 days; no R3 | §4.3 |
| S18 | Tokens readable by JS; CSP conflicts; R3 approval without step-up | M | **Accepted:** <ul><li>sandboxed iframe for untrusted HTML;</li><li>SRI CSP or dynamic rendering; Trusted Types;</li><li>aal2 for R3;</li><li>first-party token option dropped.</li></ul>(2026-10-13: Crove-issued sessions; httpOnly refresh token.) | §7.5, §9 |
| S19 | Immutability doesn't stop `postgres` | M | **Accepted, partly rejected:** <ul><li>`crove_owner` can't stop `postgres`, since `postgres` holds ADMIN OPTION on roles it created; used only against accidental edits.</li><li>The real control is the WORM stream.</li></ul> | §4.10 |
| S20 | Deleting an owner hits RESTRICT; people may switch to CASCADE and lose books | M | **Accepted:** extend DOS-4 (owner decides); G3 asserts the FK stays RESTRICT (2026-10-13: dropped; no FKs to DOS any more, offboarding follows the `org.deleted` event) | §7.9 |
| S21 | Idempotency after the version check; job keys not org-scoped | M | **Accepted:** claim before step 7; keys of the form `<org>:<job>:<key>` | §4.4, §4.8 |
| S22 | Global UNIQUE(id); import ids without the org | M | **Accepted:** drop UNIQUE(id); uuidv5 including `org_id`; check ownership in `legacy_id_map` | §6, §13 |
| S23 | Tenant-chosen egress shares the allowlisted IP | M | **Accepted;** NAT built only when needed, with two separate paths | §3.3, §7.7 |
| S24 | Outsiders can grow data without limit | M | **Accepted:** `security_event` with TTL; rate limit before the DB; webhooks verified in the API | §4.4, §4.11 |
| S25 | Evidence swapped after approval | M | **Accepted:** staging, `if-generation-match: 0`, triple references | §7.6 |
| S26 | Content hashing loses legitimate duplicate bank transactions | M | **Accepted:** <ul><li>fallback key = (bank_account_id, import_id, position in statement, value date, amount, running balance);</li><li>overlaps reconciled by running balance;</li><li>unclear cases become Inbox exceptions.</li></ul> | §13 2a, ADR-0021 |
| S27 | Salted PII hashes are reversible; stores missed in deletion; PDPL applies early | M | **Accepted:** <ul><li>crypto-shredding and a deletion map;</li><li>PDPL gate before the first external tenant; accounting/tax legal stays a Finance GA gate.</li></ul> | §4.10, §7.9, §13 |
| S28 | Tenant data leaking into evals and git | M | **Accepted** | §8.7 |
| S29 | Realtime hints reach people who left, exposing legal entities and seq | m | **Accepted** with a different design: no Realtime in v0; SSE re-filtered periodically (built in #69: ids only, no sequence, session and membership re-checked every 30 s) | §9 |
| S30 / S31 | `ctx.query` doesn't re-check permissions / sensitive read audit fails open | m | **Accepted** | §4.4 |
| S32 | UNIQUE(source) blocks re-posting; `period_balance`; voided numbers | m | **Accepted** | §13 2a |
| S33 | Anyone with `service_role` could make others a Crove admin | m | **Accepted:** privileged permissions come only from Crove `role_assignment`; DOS-23 (2026-10-13: DOS's `service_role` doesn't touch the Crove DB; DOS roles map only to `member`; DOS-23 replaced by DOS-27 events) | §4.6 |
| F1 | The agent DB loop rests on wrong assumptions | B | **Accepted:** a local DB via SessionStart is the main loop; G3 and Preview are only safety nets | §3.4, §10 |
| F2 | Second-system effect, no time-boxes | B | **Accepted, amended:** <ul><li>2-week skeleton; Finance spike before locking the API;</li><li>v0 trimmed but keeps proposals, Inbox and audit (core value);</li><li>a time-box per phase.</li></ul> | §6, §12, §13 |
| F3 | Requiring green Preview on `dev` while agents can't reset it | M | **Accepted:** Preview is only a warning on `dev`; local G3 required; added `preview-reset` | §3.5, §10 |
| F4 | Phase 2 depends on integrations that don't exist | M | **Accepted:** DOS-18/19; non-code tracks; split 2a/2b; NAT deferred (2026-10-13: or a connector in `crove-cloud`) | §11-§13 |
| F5 | Two sources of customer data; "0 row diff" parity is unattainable | M | **Accepted:** one-way sync from 2a; checklist-based parity (2026-10-13: Cal merged into CRM in Phase 3; Post becomes Social in Phase 5) | §13 |
| F6 | The stack picks versions that are too new | M | **Rejected by the owner's stance (2026-10-13):** always the latest stable; risk handled by facades, vendor docs, CI/eval gates and a 1-day `minimumReleaseAge` | §2 |
| F7 | Bootstrap PRs exceed GitHub's diff limits | M | **Accepted:** a chain of 7 PRs of <=800 lines; review reads the patch file by file | §10, §12-G |
| F8 | The agent declares its own risk levels | M | **Accepted:** derived risk; the agent autonomy table is a protected path | §4.7 |
| F9 | Crove hooks run for every session and can loop | M | **Accepted:** dispatcher; 120 s cap; config applies only when the owner approves (2026-10-13: separate repo, so the dispatcher needn't filter Crove paths) | §10 |
| F10 | Privileged operations assume a technical human | M | **Accepted:** OpenTofu/workflows via WIF; irreversible steps get a dry run | §7.1, §12-D |
| F11 | Previews call the beta kernel and break | M | **Accepted:** previews off in Phase 1-2; CLAUDE.md fix via DOS-2 (2026-10-13: written directly into the Crove repo's `AGENTS.md`, DOS-2 not needed) | §3.4, §9 |
| F12 | "Don't copy AGPL" has no enforcement | M | **Accepted:** clean-room; `jscpd` (2026-10-13: added the reason of preserving the relicensing right via the CLA) | §10 |
| F13 / F14 / F15 | Router type imports / generator gate missing the DB part / release gate waits for a build on migration-only commits | m | **Accepted** (F14 amended: modules create their own role, so only 1 file is needed) | §2, §5.5, §3.5 |
| O1 | API deployed before the worker; fan-out taken from memory | B | **Accepted:** worker-first; fan-out seeded by migration; a savepoint per row | §3.5, §4.9 |
| O2 | Readiness checks only the max version | M | **Accepted:** full manifest; pre-promote check; hotfix rule | §3.5 |
| O3 | A 2 s `lock_timeout` breaks a shared prod push | M | **Accepted:** retry blocks; promote window (2026-10-13: own ledger; kept because of Crove's hot tables) | §3.5, §5.5 |
| O4 | Restoring a shared project rolls back tax documents | M | **Accepted:** WORM stream <=5 minutes (replacing the daily anchor of S19); RPO/RTO (2026-10-13: own project, 7-day PITR allowed; still reconciled against the WORM stream after a restore) | §4.10, §7.9 |
| O5 | Broadcast-from-DB adds a slot and hits the Realtime ceiling | M | **Accepted, amended:** no Realtime at all in v0; SSE in 2b | §2, §9 |
| O6 | Connection math wrong; HTTP tied to the DB budget | M | **Accepted, amended:** per-workload roles; `crove-stream`; plus: no transactional pg-boss handlers | §3.3, §4.9 |
| O7 | NAT not in front of the broker; broker rate limits | M | **Accepted:** decided per provider; DOS-20 (2026-10-13: DOS-20 only if Cloud uses the DOS broker) | §3.3, DOS-20 |
| O8 | Token bloat from the auth hook | M | **Accepted:** DOS-22 (2026-10-13: no longer applies; DOS tokens are used only server-side at login, Crove session JWTs are small) | §7.5 |
| O9 | One worker carries everything and can't self-heal | M | **Accepted, partly rejected:** the relay stays in the worker since CPU-heavy work moved out; split only when p95 lag > 2 s | §4.9 |
| O10 | Alerting depends on an undeployed collector | M | **Accepted:** prober + Cloud Monitoring | §4.13 |
| O11 | No kill switches or break-glass | M | **Accepted** (2026-10-13: out-of-band DDL detection runs on the Crove DB) | §4.12, §7.8 |
| O12 | The partition and retention plan can't be executed | M | **Accepted, amended (hybrid):** <ul><li>never-deleted logs: yearly partitions, pre-created through 2031;</li><li>TTL tables: not partitioned, `outbox_pending` keeps HOT updates.</li></ul> | §4.9, §4.10 |
| O13 | Release gate and trigger use different globs | M | **Accepted** (merged with F15) | §3.5 |
| O14-O19 | Fail2ban; CI cost; startup probe; per-IP refresh; seam; definer sees 0 rows | m | **Accepted** (2026-10-13: per-IP refresh no longer applies since Crove handles refresh; the seam is replaced by the identity seam §7.3) | §3.3, §3.5, §7.1, §7.3, §7.5, §4.9 |

**Resolving conflicts between reviews:**
- **S27 <-> F2 (legal gates):** PDPL must be done before Phase 1 exit; accounting and tax legal before Finance GA.
- **S23 <-> F4 (NAT):** defer NAT; when built, two separate paths.
- **F2 <-> S15/S18 (R3):** R3 controls land with the first R3 command (2a).
- **F2 + O5 + S29 (realtime):** no Realtime in v0.
- **O12 <-> v1 verdict:** hybrid approach.
- **S11 <-> AGENTS.md:** owner decides.
- **S19 <-> O4:** use the <=5-minute stream.
- **S12 <-> F1:** with a local DB, no separate non-prod project for agents is needed.

**Missing topics added:**

| Topic | Where |
|---|---|
| Incident response, credential rotation | §7.10, §7.1 |
| Kill switches, staff actor, abuse limits | §4.12, §4.3 |
| Offboarding, sub-processor map, backup security, RPO/RTO | §7.9 |
| Data classification | §5.2, ADR-0017 |
| Detective controls | §7.8 |
| Public surfaces | §13 Phase 3, 6 |
| SessionStart, parallel sessions, PR size, definition of "reviewed", agent effectiveness metrics | §10 |
| Time-boxes, coexisting with forks | §13 |
| Non-code tracks, privileged operations | §12-B, §12-D |
| Cost, capacity baseline, Supabase plan | §12-A, §12-E |
| Async load testing, back-pressure, autovacuum | §4.9, §13 |
| DOS-Me broker contract | DOS-20 |
| Promote cadence | §3.5 |
