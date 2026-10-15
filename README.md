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

Open http://localhost:8080, create an account, create your organization, and drop an e-invoice XML into the Inbox. Emails sent by the bundled auth service (confirmation, password reset) are caught by Mailpit at http://localhost:8025.

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
| Email delivery | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `AUTH_AUTOCONFIRM=false` |
| File storage | `STORAGE=local` (default, the `files` volume; needs a filesystem with hard links, otherwise writes fall back to a non-atomic create and the store logs a warning) or `STORAGE=s3` with `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE` (AWS S3, MinIO, Cloudflare R2, GCS with HMAC keys). With S3 the `api` and `worker` roles need no shared volume. The credentials need `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` and `s3:ListBucket` (without ListBucket a missing file reads as 403, not 404) |
| File parsing sandbox | `EXTRACT_URL` on the kernel (Compose sets it). `crove-extract` takes no secrets: its image refuses to start with any variable outside its allowlist (its `EXTRACT_*` settings, `HOST`, `PORT`, `NODE_ENV` and what the container runtime sets), whatever `NODE_ENV` says. On Kubernetes set `enableServiceLinks: false` on its pod, or the injected `*_SERVICE_HOST` and `*_PORT` variables refuse the start |
| Database pooling | `DB_RESET_ON_RELEASE` (default `true`: each pooled connection's session is reset before reuse); set `false` only behind a transaction-mode pooler such as PgBouncer or Supavisor, whose own reset then governs (plan §3.3) |
| Sessions and MFA | `AUTH_ISSUER` (required), `AUTH_SESSION_CHECK`, `AUTH_STEP_UP`; without Compose, run the image's `auth-grants` role after Supabase Auth's first start and after each Supabase Auth upgrade |

See [`.env.example`](./.env.example) for the full list.

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
apps/kernel        API, worker and migrations runner (one image: migrate | api | worker | all)
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

## License

AGPL-3.0 © Crove / DOS.
