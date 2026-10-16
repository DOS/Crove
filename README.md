# Crove

**The open-source, AI-native Business OS for solo founders and SMEs.** Vietnam first.

Forward or upload your purchase invoices. Crove reads them (Vietnamese e-invoice XML deterministically, PDFs and photos with any OpenAI-compatible model), checks every number, and puts a proposed TT133 journal entry in your AI Inbox. You review, adjust accounts if needed, and approve. Approved invoices become vendors, purchase documents and balanced journal entries you can export to Excel for your accountant.

## Quick start

Requirements: Docker with Compose.

```bash
git clone https://github.com/DOS/Crove.git
cd Crove
docker compose up
```

Open http://localhost:8080, create an account, create your organization, and drop an e-invoice XML into the Inbox. Emails sent by the bundled auth service (confirmation, password reset) and Crove's member invites are caught by Mailpit at http://localhost:8025.

The defaults are for local use. Before anyone else can reach your instance, copy `.env.example` to `.env` and change every secret.

## What works today (MVP)

- Email + password sign-up and sign-in (bundled [Supabase Auth](https://github.com/supabase/auth)), organizations, members and roles
- Upload of e-invoice XML (Decree 123/2020, Circular 78/2021), PDF and images; inbound email per organization
- Deterministic checks: line totals, VAT, tax-code check digit, tax-authority code, duplicates
- AI Inbox: proposals with suggested TT133 accounts that learn per vendor; approve, edit or reject
- Purchase documents, vendors, journal entries that always balance, Excel export
- Tenant isolation with PostgreSQL row-level security, append-only audit log, idempotent approvals

## Configuration

| Feature | Variables |
|---|---|
| AI for PDFs and photos | `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL` (any OpenAI-compatible endpoint: OpenAI, Ollama, vLLM, ...) |
| Inbound email | `INBOUND_DOMAIN`, `INBOUND_SECRET`; your mail worker POSTs raw MIME to `/api/inbound/email` |
| Email delivery | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `AUTH_AUTOCONFIRM=false`. Supabase Auth and Crove's member invites use the same server; port 465 is implicit TLS, other ports with credentials require STARTTLS. Without `SMTP_HOST` Crove sends no invite mail and the inviter passes the one-time link on |
| Email rate limits | `AUTH_RATE_LIMIT_EMAIL_SENT` (default 100): the emails Supabase Auth may send per hour for the whole deployment; size it to your SMTP provider's quota. `AUTH_EMAIL_CLIENT_LIMIT_PER_HOUR` (default 5, IPv6 counted per /64) and `AUTH_EMAIL_ADDRESS_INTERVAL_SECONDS` (default 60): the per-client and per-recipient caps the `/auth/v1` proxy applies first, so one client cannot use up the budget for everyone; on a public URL Crove refuses to start unless it takes at least 10 client addresses to use it up. `AUTH_RATE_LIMIT_OTP` (default 30): Supabase Auth's requests per 5 minutes per client address on sign-up, recovery and OTP. Behind a reverse proxy set `TRUSTED_PROXY_HOPS`, or every client shares the proxy's address |
| File storage | `STORAGE=local` (default, the `files` volume; needs a filesystem with hard links, otherwise writes fall back to a non-atomic create and the store logs a warning) or `STORAGE=s3` with `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE` (AWS S3, MinIO, Cloudflare R2, GCS with HMAC keys). With S3 the `api` and `worker` roles need no shared volume. The credentials need `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` and `s3:ListBucket` (without ListBucket a missing file reads as 403, not 404) |
| File parsing sandbox | `EXTRACT_URL` on the kernel (Compose sets it). `crove-extract` takes no secrets: its image refuses to start with any variable outside its allowlist (its `EXTRACT_*` settings, `HOST`, `PORT`, `NODE_ENV` and what the container runtime sets), whatever `NODE_ENV` says. On Kubernetes set `enableServiceLinks: false` on its pod, or the injected `*_SERVICE_HOST` and `*_PORT` variables refuse the start |
| Database pooling | `DB_RESET_ON_RELEASE` (default `true`: each pooled connection's session is reset before reuse); set `false` only behind a transaction-mode pooler such as PgBouncer or Supavisor, whose own reset then governs (plan §3.3) |
| Sessions and MFA | `AUTH_ISSUER` (required), `AUTH_SESSION_CHECK`, `AUTH_STEP_UP`; without Compose, run the image's `auth-grants` role after Supabase Auth's first start and after each Supabase Auth upgrade. With a remote Supabase Auth (`AUTH_SESSION_CHECK=jwt`, the default without `AUTH_UPSTREAM_URL`), set `PUBLIC_AUTH_URL` (and `PUBLIC_AUTH_ANON_KEY` for hosted Supabase): R3 actions are confirmed live there, and a sign-out outside Crove takes effect when the access token expires (ADR-0028) |

See [`.env.example`](./.env.example) for the full list.

## Monitoring and alerts

The image's `prober` role checks that background work is moving and alerts you when it is not. It connects as `crove_prober`, a login that can only call `crove_kernel.health()` (aggregate ages and counts, no tenant data), and alerts when:

| Check | Default limit | Variable |
|---|---|---|
| Oldest unpublished outbox event or unrelayed inbound email | 300 s | `PROBER_MAX_OUTBOX_AGE_SECONDS` |
| Oldest job waiting in the queue | 900 s | `PROBER_MAX_JOB_AGE_SECONDS` |
| Jobs that failed after their last retry (dead letters) in the last `PROBER_DEAD_LETTER_WINDOW_SECONDS` (default: the `--every` interval plus 60 s, else 3600) | more than 0 | `PROBER_MAX_DEAD_LETTERS` |
| Freshest worker heartbeat (the worker writes one every 30 s); none at all also alerts | 120 s | `PROBER_MAX_HEARTBEAT_AGE_SECONDS` |
| The database cannot be reached or `health()` fails | always | |

Alerts go to `ALERT_WEBHOOK_URL` as a JSON POST whose body has `text` (Slack and Mattermost incoming webhooks, Google Chat), `content` (Discord) and a structured `crove` object for anything else; without it they are printed to stdout. Name the deployment with `ALERT_INSTANCE` (default: the host of `PUBLIC_URL`). Exit codes: 0 healthy, 1 a limit was exceeded, 2 the check could not run, 3 the alert could not be delivered (it is printed instead). Use an `https` webhook: most webhook URLs carry their secret in the path.

Set `CROVE_PROBER_DB_PASSWORD` (applied by `migrate`) and `ALERT_WEBHOOK_URL` in `.env`, then pick one way to run it:

```bash
# Check the alert path end to end: you should receive "[Crove] Test alert from ..."
docker compose run --rm prober prober --test-alert

# Compose: a long-running prober that checks every PROBER_INTERVAL_SECONDS (default 300)
docker compose --profile prober up -d

# Or cron on the host: one check every 5 minutes; a failed job counts for 360 s, so each one alerts once (twice at most)
*/5 * * * * cd /path/to/Crove && docker compose run --rm -e PROBER_DEAD_LETTER_WINDOW_SECONDS=360 prober prober >> /var/log/crove-prober.log 2>&1
```

Without Compose, run `node apps/kernel/src/main.ts prober` from any scheduler with `PROBER_DATABASE_URL=postgres://crove_prober:<password>@<host>:5432/<db>`. The prober repeats an alert on every run while the problem lasts, and it cannot report its own absence or a whole-host outage: for those, add an external uptime check on `/healthz`.

## Development

Node 26 and pnpm (any version; the pinned one is downloaded automatically).

```bash
pnpm install
docker compose up -d db auth auth-grants mailpit   # or point .env at your own PostgreSQL 17
pnpm db:migrate
pnpm dev                                # kernel on :8080, web app on :5173
pnpm test                               # unit tests
CROVE_TEST_ADMIN_URL=postgres://postgres:...@localhost:5432/postgres pnpm test:db
CROVE_TEST_S3_URL=http://<key>:<secret>@localhost:9000/crove-test pnpm test   # also runs the S3 tests (e.g. MinIO)
```

Layout:

```
apps/kernel        API, worker, prober and migrations runner (one image: migrate | api | worker | all | prober)
apps/app           web app (Vite + React + TanStack Router), served by the kernel
apps/web           marketing site (Next.js)
packages/db        PostgreSQL pool, Kysely types, migration runner
packages/kernel-*  contract (zod + oRPC), runtime (the single write path), kernel module
apps/extract       crove-extract: the file parsing sandbox and every parser, e-invoice XML included (bytes in, JSON out; no secrets, no egress)
packages/extract-contract  limits, schemas and the worker's client for crove-extract
packages/l10n-vn   Vietnamese invoice checks, tax codes, TT133 accounting rules (no parser)
packages/agent     AI extraction (only package that talks to a model)
modules/finance    purchase invoices, journal entries, export
supabase/migrations  the only place for schema changes
```

Architecture and roadmap: [`docs/plan/crove-os-kernel.md`](./docs/plan/crove-os-kernel.md) (concise Vietnamese decision page: [`docs/plan/crove-os-kernel.vi.html`](./docs/plan/crove-os-kernel.vi.html)). Design system: [`DESIGN.md`](./DESIGN.md).

### AI endpoint conformance and evals

Before enabling an AI endpoint or changing the extraction prompt or model, run both suites against it. They read the same variables as the kernel and are skipped when `AI_BASE_URL` or `AI_MODEL` is not set, so `pnpm test` and CI never call a model.

```bash
export AI_BASE_URL=http://localhost:11434/v1 AI_MODEL=<model> AI_API_KEY=<key-if-any>
pnpm ai:conformance   # chat, tool calls, structured output (zod), streaming, error mapping
pnpm ai:eval          # extraction accuracy on synthetic invoices; fails below AI_EVAL_THRESHOLD (default 0.9)
                      # or when isInvoice or the total is wrong on any fixture
```

Fixtures live in `packages/agent/test/fixtures/extraction` (`<id>.txt` document text plus `<id>.json` expected fields). They are synthetic: use invented names and checksum-invalid tax codes only (a unit test rejects checksum-valid tax codes and 12-digit IDs). 429 and 5xx mapping is tested against a local fake server in `pnpm test`.

## License

AGPL-3.0-only, see [`LICENSE`](./LICENSE). © Crove / DOS. See also [`CONTRIBUTING.md`](./CONTRIBUTING.md), [`SECURITY.md`](./SECURITY.md), [`TRADEMARKS.md`](./TRADEMARKS.md) and the draft [`CLA.md`](./CLA.md).
