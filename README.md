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

See [`.env.example`](./.env.example) for the full list.

## Development

Node 26 and pnpm (any version; the pinned one is downloaded automatically).

```bash
pnpm install
docker compose up -d db auth mailpit   # or point .env at your own PostgreSQL 17
pnpm db:migrate
pnpm dev                                # kernel on :8080, web app on :5173
pnpm test                               # unit tests
CROVE_TEST_ADMIN_URL=postgres://postgres:...@localhost:5432/postgres pnpm test:db
```

Layout:

```
apps/kernel        API, worker and migrations runner (one image: migrate | api | worker | all)
apps/app           web app (Vite + React + TanStack Router), served by the kernel
apps/web           marketing site (Next.js)
packages/db        PostgreSQL pool, Kysely types, migration runner
packages/kernel-*  contract (zod + oRPC), runtime (the single write path), kernel module
packages/l10n-vn   Vietnamese e-invoice XML, tax codes, TT133 accounting rules
packages/agent     AI extraction (only package that talks to a model)
modules/finance    purchase invoices, journal entries, export
supabase/migrations  the only place for schema changes
```

Architecture and roadmap: [`docs/plan/crove-os-kernel.md`](./docs/plan/crove-os-kernel.md) (Vietnamese reading copy: [`docs/plan/crove-os-kernel.vi.html`](./docs/plan/crove-os-kernel.vi.html)). Design system: [`DESIGN.md`](./DESIGN.md).

## License

AGPL-3.0 © Crove / DOS.
