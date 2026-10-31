# Runbook: sizing document extraction

How many documents the worker reads at once, what limits that, and how to set it. Issue #2119, from the outside review of 2026-10-29 (section 8). Read it before a bulk intake (a ZIP of a client's year of invoices) or when the Inbox fills slower than uploads arrive.

## What runs at once

Every uploaded document, and every document inside a ZIP, is one job on the `extract` queue. The worker takes jobs from that queue in parallel:

| Setting | Where | Default | What it is |
|---|---|---|---|
| `EXTRACT_WORKER_CONCURRENCY` | the worker | 4, or `EXTRACT_CONCURRENCY` when that is lower | extract jobs the worker runs at once (1 to 8) |
| `EXTRACT_CONCURRENCY` | the sandbox `crove-extract` **and** the worker | 4 in `docker-compose.yml`; 1 where nothing sets it (the sandbox's own default) | the sandbox's parser slots (1 to 8); the worker reads it only to cap itself |
| `AI_MAX_RETRIES` | the worker | 1 | times a failing AI call is sent again (0 to 5) |

The worker refuses to start when `EXTRACT_WORKER_CONCURRENCY` is above `EXTRACT_CONCURRENCY`: more jobs than slots only wait for a slot, or are refused as busy. The extract client also holds back any call over its slots, so the sandbox never sees more than the worker's setting from one worker. `docker-compose.yml` passes `EXTRACT_CONCURRENCY` to both services from one variable in `.env`, so they cannot differ. Where the sandbox runs apart from compose (`pnpm dev`, another orchestrator or host), set the same value on both: unset on either side means 1, so the worker then reads one document at a time and the sandbox never answers busy.

The worker's log says what it started: `[extract] up to N extract job(s) at once`.

## How to size it

Time per document is mostly the AI call: 10 to 20 s for a PDF or a photo that needs it, a fraction of a second for an e-invoice XML. So:

```
documents per hour  ≈  EXTRACT_WORKER_CONCURRENCY × 3600 / seconds per document
```

A ZIP of 200 PDFs at 15 s each takes about 50 minutes with 1 job at a time, about 12 minutes with 4, and about 6 with 8. Month end with 20 orgs works through the same queue; fairness between orgs is a separate item (#631).

Three limits stop you raising it:

1. **The AI provider's rate limit.** Each job holds one AI call at a time, so the setting is also the most calls in flight. Keep `EXTRACT_WORKER_CONCURRENCY × 60 / seconds per call` (requests a minute) below the provider's limit, with room for the other AI calls the worker makes (drafts, summaries) and for retries. A provider that answers 429 under load is told so by this setting going down, not up. If the provider answers 429 often, lower it.
2. **The sandbox's slots.** At most `EXTRACT_CONCURRENCY`, which is at most 8. The sandbox is sized for 4 slots in `docker-compose.yml` (3 GB, 2 CPUs, 256 processes). The memory figure is the worst case: a parser process is held to 768 MB resident, and four of them at the cap come to 3 GB, though a PDF rarely uses a tenth of that. With more slots, raise those limits in `compose.host.yml` in step: 768 MB of memory (worst case) and 64 processes per extra slot, and CPUs if parses time out under load. `EXTRACT_MAX_QUEUE` and `EXTRACT_TIMEOUT_MS` are bounded so that a call waiting for a slot still answers inside the worker's 60 s; the sandbox refuses to start with values that break that.
3. **The database.** The worker's connection pool has 10 connections and a job takes one only for the moments it writes, so 8 jobs plus the other queues fit.

## The worst case of one failing document

A failing AI call is sent again `AI_MAX_RETRIES` times (429, 5xx, network), so one document costs the provider at most `1 + AI_MAX_RETRIES` calls per job attempt: 2 with the default 1, against 3 with the AI SDK's own default of 2. The whole call, retries included, stops at the 120 s timeout, so a document holds its slot for 120 s at most per attempt. The job itself is then retried by pg-boss up to 3 times with a growing delay (20 s, then doubling) and, after the last attempt, recorded as failed on the file (`Không đọc được chứng từ sau nhiều lần thử`); the person re-reads it from the Inbox once the AI is fixed. Answers that mean the request is wrong (401, 403, 404, and 4xx other than 408, 409 and 429: a bad key, a missing model) are not sent again at all.

Lower `AI_MAX_RETRIES` to 0 when you would rather have the job retry later, after pg-boss's delay, than send a failing document twice at once; raise it to 2 or 3 for a provider that often answers 429 or 503 for a few seconds.

## What parallel reading changes

Documents are read at the same time, so two checks that look at the other documents first and write after can both pass for documents in the same batch (#2119):

- **A duplicate invoice inside one batch** is still flagged (#2137). The reader looks for a copy before it records, which two readers of the same invoice can both do before either has recorded; so `kernel.extraction.record` takes a lock on the invoice (the org, the seller and the series and number), asks the lookup again inside its own transaction and flags the proposal when it now finds an earlier one. Of two copies read at once, exactly one carries `duplicate.found` (the one that records second), and posting it is refused by the ledger's own uniqueness check as before.
- **The org's daily limits** (`ORG_LIMIT_EXTRACTION_PAGES_PER_DAY`, `ORG_LIMIT_AI_COST_PER_DAY`) are checked before a document is read and counted after, so an org can pass a limit by up to `EXTRACT_WORKER_CONCURRENCY - 1` documents; the next ones wait for the window as before.

## Change it

1. Set `EXTRACT_CONCURRENCY` (both services), and `EXTRACT_WORKER_CONCURRENCY` if the worker should use fewer, in `.env`. With the pilot layout ([deploy.md](deploy.md), "The pilot layout"), the worker takes them like every setting of `docker-compose.yml`.
2. `docker compose up -d crove-extract worker` (`crove` on the all-in-one layout). Jobs in progress finish first on a clean stop; the queued ones wait.
3. Read the worker log for the `[extract] up to N extract job(s) at once` line, then upload a ZIP of ten documents and watch the Inbox fill about N at a time.
4. Under load, `docker stats` on `crove-extract` should stay below its memory limit. A sandbox restarted by the kernel's out-of-memory killer shows up as `crove-extract did not answer` in the worker log: lower the slots, or raise the memory.
