# Runbook: the Phase 1 load test

Plan §13, Phase 1 exit criterion 7 asks for a load test with 100k parties in one org. §4.5 item 1 and §7.2 ask for the same run, to re-check the context guard and the seal with real lock counts and to time list queries over 100k rows. Issue #998 built it. It runs on its own throwaway database and needs no running Crove.

## Running it

It needs a PostgreSQL 17 server and a superuser URL for it. The same server the database tests use works (`CROVE_TEST_ADMIN_URL`).

```sh
node apps/kernel/load/load-test.ts --admin-url "$CROVE_TEST_ADMIN_URL"
```

Point it at a server that is not production. The run creates a database named `crove_load_<time>`, migrates it, measures, and drops it (`--keep` leaves it for a look afterwards).

| Flag | Default | What it sets |
|---|---|---|
| `--parties` | 100000 | parties seeded in the one org |
| `--commands` | 2000 | runs of each measured command |
| `--concurrency` | 8 | commands in flight at once |
| `--queries` | 30 | runs of each list or search query |
| `--rate` | 60 | commands per second while the outbox lag is measured |
| `--seconds` | 30 | how long that lasts |

Exit codes: 0 every target met, 1 a target missed, 2 the run failed.

## What it measures

- **R1 commands** through `Runtime.execute` with the session status check on, as the API runs them: `kernel.party.update` on the seeded parties and `kernel.file.ingest`. Target: p95 < 150 ms.
- **List and search queries** over the parties: `finance.vendors.list` (all, and with a search term), `finance.customers.list`, `finance.search`. The plan sets no target; the report shows p95.
- **Outbox lag.** One relay loop claims events as the worker does (`crove_kernel.outbox_claim`, 100 at a time) while `kernel.file.ingest` runs at `--rate` per second. The lag runs from the event's emit to its claim, both by the database clock: an event id is a UUIDv7 whose first 48 bits are its emit time. Target: p95 < 2 s.
- **Relay capacity.** A backlog of events is drained by the one relay as fast as it can. Target: at least 50 events per second.
- **Context guard cost** (plan §4.5 item 1, gate row T10). While the commands run, a second connection counts `pg_locks` every 100 ms. The guard reads `pg_locks` on every context entry, and #105 measured that at about 13 µs plus about 0.27 µs per lock held server-wide, so the report gives the cost those lock counts imply. No target: the plan asks for the re-check.
- **Back-pressure** (outbox lag over 30 s pauses background jobs) is not built yet (#894). The report marks it N/A.

The relay here claims and drops. The worker also hands each claimed event to its job queue, so the numbers are the database's share of the lag and of the throughput.

## First results

2026-10-21, a cloud development container with PostgreSQL 17 in Docker, default flags:

| Measure | Result | Target |
|---|---|---|
| `kernel.party.update` p50 / p95 / p99 | 13.9 / 22.9 / 33.0 ms | p95 < 150 ms |
| `kernel.file.ingest` p50 / p95 / p99 | 11.6 / 18.3 / 23.5 ms | p95 < 150 ms |
| Outbox lag at 60 commands/s, p95 / max | 14.3 / 69.0 ms | p95 < 2 s |
| Relay capacity (backlog of 1800) | about 28,000 events/s | >= 50/s |
| `finance.customers.list` p95 | 42 ms | none |
| `finance.search` p95 | 85 ms | none |
| `finance.vendors.list` p95 | 1.1 s | none |
| `finance.vendors.list` with a search term, p95 | 3.8 s | none |

Every plan target passes. The vendor list was the slow query at this size (#999, fixed below).

2026-10-21, same container, default flags, after #1010 added the lock count:

| Measure | Result |
|---|---|
| `kernel.party.update` p95 | 15.8 ms |
| `kernel.file.ingest` p95 | 18.4 ms |
| Locks held server-wide during the commands, p50 / p95 / max (54 samples) | 157 / 230 / 238 |
| Context guard cost per entry at p95 / max locks | 75.1 / 77.3 µs |

At 230 locks the guard adds about 0.08 ms to a command whose p95 is 15.8 ms, under 0.5%. The `pg_locks` read stays (#105).

2026-10-22, after #999 (vendor list ordered on `party_name_idx`, the search term matched once, an index on `purchase_document (org_id, party_id, direction)`):

| Query | Before | After |
|---|---|---|
| `finance.vendors.list` p95 | 831 ms | 11.8 ms |
| `finance.vendors.list` with a search term, p95 | 3315 ms | 71.6 ms |
