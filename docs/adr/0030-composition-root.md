# 0030. Composition root: createKernel with adapter ports

- Status: accepted (plan Decision 12, adopted proposal "Composition root"; this ADR records the shape before the PR)
- Date: 2026-10-16
- Deciders: owner (JOY)
- Builds on: ADR-0027 (open-source core vs Crove Cloud), ADR-0028 (identity, sessions and revocation), plan principle 15 (every DOS integration is an adapter)
- Tracking: issue #43

## Context and problem statement

Plan Decision 12 adopted a composition root: the core exports a factory such as `createKernel({ identity, ai, broker, connectors, billing })`, the core entrypoint wires the open-source adapters, and `crove-cloud` later adds its own entrypoint that wires DOS-only adapters and builds the Cloud image, so the Cloud diff is one entrypoint, private packages and configuration.

Before this ADR, `apps/kernel/src/main.ts` built every dependency inline from configuration: the session status source, the authenticator and the session revoker (Supabase Auth, ADR-0028), the AI extractor (any OpenAI-compatible endpoint), the blob store (local disk or S3) and, in the prober, the webhook alert sink. A Cloud entrypoint could only change them through environment variables, and a test could not replace one without rebuilding the role by hand.

## Decision

1. `apps/kernel/src/kernel.ts` (package `@crove/kernel-server`) exports `createKernel(config, adapters)`. It builds no adapter itself: it takes the validated `Config` and one adapter per port, and returns `{ config, adapters, start(role) }`, where `start('api' | 'worker' | 'all')` starts the role's servers and resolves to a stop function. The role checks (worker login, crove-extract URL), the database guards and the command registry stay inside `start`, so an entrypoint cannot skip them.
2. Ports:

   | Port | Type | Required | Open-source default (`defaultAdapters(config)`) |
   |---|---|---|---|
   | `identity` | `IdentityPort`: `sessions` (the ADR-0028 status source), `authenticator(db)` (token verification and identity mapping), `revoker` (upstream sign-out or null) | yes | Supabase Auth per `AUTH_*` settings |
   | `ai` | `InvoiceReader` (`fromText`, `fromImage`) or `null` | yes, `null` means no AI | `InvoiceExtractor` on the OpenAI-compatible endpoint in `AI_*`, else `null` |
   | `storage` | `BlobStore` | yes | local disk or S3-compatible per `STORAGE` |
   | `mail` | `Mailer` (`enabled`, `send`; issue #129) | no | SMTP per `SMTP_*`; without `SMTP_HOST`, a fallback that logs the subject and sends nothing |
   | `broker` | `CredentialBroker` (plan §7.4) | no | none: every lookup fails with `BROKER_NOT_CONFIGURED` |
   | `connectors` | `Connector[]` | no | empty |
   | `billing` | `Billing.entitlements(orgId)` (Decision 10) | no | every org holds `full` |

   The prober is a separate role that loads no kernel configuration. Its port is `AlertSink` (`describe`, `deliver`), passed as `runProber(argv, env, { sink })`; the default is the generic webhook, or stdout without one.
3. A required port that is `undefined` stops the boot with `createKernel: missing adapter(s) <names>`, and so does an identity port without `sessions`, `authenticator` or `revoker` (a runtime without a session source would skip the ADR-0028 check). TypeScript already rejects it; the runtime check covers entrypoints assembled dynamically. `ai: null` is an explicit choice, not a missing port.
4. `main.ts` stays the open-source entrypoint: it loads configuration, runs `migrate`, `auth-grants` and `prober` as before, and for the server roles calls `createKernel(config, defaultAdapters(config))`. No behavior change.
5. Crove Cloud, once it needs a DOS-only adapter, adds its own entrypoint in `crove-cloud` that imports `createKernel` and `defaultAdapters` from this package, replaces the ports it needs (for example `billing` with DOS billing, `ai` with DOS.AI credits, `connectors` with its commercial connectors) and builds the Cloud image. Identity stays the Supabase Auth adapter pointed at DOS's Supabase Auth (ADR-0027 decision 3). Until then Cloud runs the core image with DOS configuration. The core never imports from `crove-cloud`.
6. Nothing in the core consumes `broker`, `connectors` or `billing` yet. Their interfaces are the smallest that name the seam; the first feature that needs one (credential bindings in Phase 2a, the entitlement check, the first connector) extends its interface in the same PR. Mail joined as the optional `mail` port with the invite email (PR #173): the API sends member invites through it.

## Consequences

- One factory for every deployment: the Cloud diff is an entrypoint plus private adapters, as Decision 12 asks.
- Tests can start the real api and worker with fake adapters (`apps/kernel/test/kernel-composition.db.test.ts`).
- `InvoiceReader` (in `@crove/agent`) replaces the `InvoiceExtractor` class in the worker and the finance job signatures, so another AI adapter does not have to subclass it.
- The package has no `exports` map yet; `crove-cloud` adds one entry for `src/kernel.ts` when it is created (a `package.json` change is a protected path, so it goes through the protected-path review).
- Adding a port is an interface change in `kernel.ts`; a required port without a default breaks every entrypoint at compile time, which is intended.
