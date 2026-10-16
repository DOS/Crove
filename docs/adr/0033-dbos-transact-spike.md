# 0033. DBOS Transact vs the plan's own process engine (spike result)

- Status: accepted (plan Decision 14, "DBOS Transact spike"; result: fail, keep the own process engine)
- Date: 2026-10-16
- Deciders: the rule the owner (JOY) set in Decision 14 ("fail means keep the own process engine"), applied to the evidence below
- Builds on: plan section 2 (Jobs row), section 4.9 (outbox, jobs, processes), ADR-0029 (agent wake-ups and task leases)
- Tracking: issue #59
- Evidence: `spikes/dbos/` (code, README to rerun it, raw results in `spikes/dbos/results/`)

## Context and problem statement

Decision 14 adopted a one-week spike of DBOS Transact before Phase 2a. The plan's own process engine is a sketch, not code yet: a process is a row in `process_instance`, transitions are pure functions over that row, timers are delayed pg-boss jobs, and a wait for a human is a proposal (plan section 4.9, ADR-0029 for agent wake-ups). DBOS Transact would replace it with durable workflows: ordinary async functions whose steps are checkpointed in a Postgres system schema and replayed after a crash.

The plan set four pass criteria; failing them means keeping the own engine:

1. workflow recovery on Cloud Run worker pools without the paid Conductor;
2. a 7-day approval wait that does not hold a queue slot;
3. the schema exportable as committed SQL;
4. per-org fairness.

## What was run

Everything ran locally (nothing deployed, no DBOS account): `@dbos-inc/dbos-sdk` 5.2.11 (released 2026-09-29; 5.3.0 was under a day old), Node 26, a throwaway `postgres:17` (17.11) container. Cloud Run worker pool instances were simulated by several local worker processes, killed with SIGKILL and replaced by processes with new executor IDs, since a replacement instance does not get the old one's identity. Cloud Run itself was not tested. Workers connect as `spike_runner` (DML and EXECUTE only); the schema is owned and applied by a non-superuser `spike_migrate`.

## Results per criterion

### 1. Recovery without Conductor: pass, with a sweeper Crove would own

How DBOS recovers (read in the 5.2.11 source, then measured): a workflow row carries the `executor_id` that dequeued it. At launch an executor re-enqueues only the PENDING workflows of its own executor ID. Recovering another executor's workflows is `recoverPendingWorkflows(executorIds)`, which only the Conductor client calls (a websocket to `cloud.dbos.dev`). DBOS has no executor heartbeat, so it never knows that an executor is gone.

| Phase (40 workflows of 10 steps, 3 workers, 2 killed mid-run) | Measured |
|---|---|
| DBOS alone, new executor IDs | 8 workflows of the killed executors still PENDING 15 s after the queue drained; nothing ever picks them up |
| A worker with a 60-line sweeper (heartbeat table, advisory-lock leader, public `DBOS.listWorkflows` + `DBOS.resumeWorkflows` onto the original queue) | All 8 recovered; all 40 SUCCESS 6.6 s after the sweeper started (5 s dead threshold); 8 step bodies re-executed, one per in-flight workflow (at-least-once per step) |
| Restart with the same executor ID | 4 orphans recovered by DBOS's own launch recovery, 11.7 s; 4 step re-executions |
| Zombie (process alive, heartbeat stopped) | The sweeper handed its 4 workflows to a healthy worker; DBOS's ownership token (`owner_xid`) stopped the zombie at its next checkpoint ("no longer owned by this execution"); 4 step re-executions, no workflow ran to completion twice |

So recovery works without Conductor, but only with Crove-owned liveness detection and a sweeper. `resumeWorkflows` resets `recovery_attempts`, so DBOS's poison-workflow limit would not count these recoveries; Crove would need its own.

### 2. A 7-day approval wait without a queue slot: fail

An approval workflow ran a step, then `DBOS.recv` with a 7-day timeout, then a step.

| Measurement | Result |
|---|---|
| 1000 waiters started from an unlimited queue | No connection held: 8 runner connections at most (the pool), 0 active, 0 idle in transaction |
| Same wait started from a queue with `globalConcurrency: 5` | 5 PENDING waiters hold all 5 slots; 5 more stay ENQUEUED for the whole wait |
| Database load of 1000 waiting `recv`s | 209 transactions/s vs 13 idle: each `recv` polls about every 10 s (about 0.2 queries/s per waiter). 1000 waiting `DBOS.sleep` timers: 13/s, no polling |
| Worker memory | 1000 waiters: RSS 95 to 115 MB; after a restart that re-dispatched 2100 waiters to one worker: RSS 223 MB, heap 92 MB |
| Approve all 1000 with `sendInTransaction` in the same transaction as a domain write | 4.8 s to send, all 1000 executed 5.3 s after the first send; a rolled-back send never reached its workflow |
| 7 days pass across a crash (SIGKILL, new worker with the clock 7 days ahead) | The recorded deadline is kept (start + 7.000 days): 50 approvals expired and 50 timers fired 7.6 s after restart; 1000 longer waits re-dispatched in the same 7.6 s and kept waiting; no step re-executed |

A waiting workflow is a live promise inside one worker until it ends. It holds a slot on the queue that started it, so long waits must start from an unlimited queue and push bounded work to child workflows. Then the wait costs worker memory and, for `recv`, steady polling, and a worker crash moves every one of its waiters onto whichever worker recovers them. There is no way to park a waiting workflow in the database only.

The decisive part is deploys, which a 7-day wait always spans (experiment 5, `exp-deploy.ts`):

| Deploy during a wait | Result |
|---|---|
| Same application version, one step added before the proposal | All 3 waiting approvals went to ERROR on recovery: "function propose was recorded when audit was expected. Check that your workflow is deterministic." |
| New application version (the default: DBOS hashes the workflow code into the version) | The 3 waiting approvals of the old version stay ENQUEUED: new-version workers never dequeue them, and the approval sent to them is never consumed |

DBOS's answers are `DBOS.patch()` branches kept until every old execution has finished, or `forkWorkflow` onto the new version by hand. Either way every code change to a workflow that has open instances needs a replay-compatibility review, for as long as the longest wait. The own engine has no replay: a transition reads the stored state, so a code change applies to waiting instances at their next event, and a breaking state change is a versioned upcaster, as for events.

### 3. Schema as committed SQL: pass

| Check | Result |
|---|---|
| Export | The SDK's own generator (`npx dbos schema --print-migrations`) prints every migration; `spikes/dbos/src/vendor-schema.ts` removes `CONCURRENTLY` and adds a version guard. 13 tables, 38 indexes, 3 functions, 1 trigger; no extension, no superuser statement |
| Apply | One transaction, as the non-superuser schema owner, under the custom schema name `crove_dbos` |
| Run without DDL | `runMigrations: false` only verifies the schema; launch as the DML-only runner works. The runner gets permission denied for CREATE TABLE, CREATE SCHEMA and ALTER TABLE |
| Schema behind | `runMigrations: false` refuses to start ("is at schema version 114, but this version of DBOS requires 123"); `runMigrations: true` as the runner fails ("must be owner of table workflow_status") |
| Upgrade | 5.0.2 schema (version 114) plus the vendored delta `sql/dbos-5.2.11-from-115.sql` gives a `pg_dump` identical to a fresh 5.2.11 schema; re-applying either file trips its guard |
| Hardening | All 3 functions pin `search_path = pg_catalog, pg_temp`; none is SECURITY DEFINER, so the T17 guard would accept them |
| Churn | 31 non-empty schema migrations from 4.21.6 (2026-06-22) to 5.2.11 (2026-09-29), 13 of them index rebuilds on `workflow_status` and `operation_outputs`. Vendored without `CONCURRENTLY`, each such bump needs the promote window, like a pg-boss upgrade |

### 4. Per-org fairness: pass, with the same limits as pg-boss groups

One big org enqueued 200 jobs of 300 ms, then 10 small orgs 5 jobs each; 2 workers, at most 4 jobs running.

| Queue | Small orgs' first job started | Big org |
|---|---|---|
| FIFO, `globalConcurrency: 4` | up to 40.9 s after enqueue (behind the whole backlog) | done at 34.8 s, 4 in parallel |
| Partitioned by org (`queuePartitionKey`), `partitionConcurrency: 1` | within 5.9 s | 1 at a time; alone, about 1 job/s (210 s for 200), because a partition starts its next job on the next 1 s poll |

DBOS visits partitions in a shuffled order on each poll, so small orgs are not starved. The per-partition limit is a cap, not a fair share: one value for every partition (no tiers, no weights), and idle capacity is not lent to a busy org. pg-boss 12's `groupConcurrency` (group id = org, optional tiers) is the same kind of cap; it was not measured here.

## Comparison with the own engine

| Criterion | DBOS Transact 5.2.11 (measured) | Own engine: `process_instance` + pg-boss + proposals (from the plan; not built yet) |
|---|---|---|
| Recovery on a worker pool | Needs a Crove sweeper (heartbeat + `resumeWorkflows`); fencing by `owner_xid` works | pg-boss retries an active job of a dead worker after `expireInSeconds` (default 900 s) or a missed `heartbeatSeconds` (documented in pg-boss 12.38.0, not measured here); a transition is one kernel transaction, so a crash rolls it back; no executor identity |
| 7-day wait | Holds a slot on a limited queue; otherwise worker memory and polling; breaks or strands across deploys | A row plus a proposal plus a delayed job: no slot, no memory, no polling; code changes apply at the next transition |
| Schema as committed SQL | Pass, with a vendored delta and promote window per SDK bump | `process_instance` is a Crove migration; pg-boss vendoring is gate T6 (PR #104) |
| Per-org fairness | Partition caps, one value | pg-boss group caps, with tiers |
| Tenancy | No `org_id`, no RLS; workflow inputs and outputs (serialized arguments) sit outside RLS, org export and crypto-shredding; a cell move must carry in-flight workflows | Tenant tables with RLS, inside export and offboarding |
| Retention | Garbage collection runs only on Conductor's retention message; self-host writes its own purge | pg-boss `deleteAfterSeconds` plus Crove's purge jobs (section 4.9) |
| Operations | A second durable runtime next to pg-boss (the outbox fan-out stays on pg-boss): two schemas to vendor, two retention paths, two dashboards | One queue system |
| License and lock-in | MIT (verified: `LICENSE` and `package.json` of 5.2.11). Conductor is the separate hosted service. Workflow code is written to DBOS's determinism and replay contract, and its state lives in DBOS's schema | Crove code and tables |
| Build cost | Ready now | `process_instance`, the transition runner and timer jobs are Phase 2a work |

## Decision

1. DBOS Transact fails criterion 2 as Crove needs it (approvals, reminders and agent tasks that wait for days, across deploys), so per Decision 14 Crove keeps its own process engine. Criteria 1, 3 and 4 pass, 1 only with a Crove-owned sweeper.
2. DBOS is not added as a dependency. `spikes/dbos/` stays as the record and is not built, linted, typechecked or shipped with the product.
3. Ideas taken into the own engine:
   - fence each transition with an ownership token, as DBOS's `owner_xid` stops a zombie (the same rule as ADR-0029's lease fencing tokens);
   - keep the decision and the wake-up in one transaction (DBOS's `sendInTransaction`; in Crove, the approval command's `ctx.emit`);
   - for per-org fairness, use pg-boss group caps keyed by org and visit orgs in a rotating order, and measure them before the second worker is enabled.
4. Revisit only if one of these holds: a DBOS release can park a waiting workflow in the database without a live promise in a worker, and recover a workflow of an old version without code replay; or Crove needs long-running code-shaped workflows (many sequential provider calls) that the transition model makes awkward, in which case DBOS would be judged for that job alone, not for human waits.

## Consequences

- Phase 2a builds `process_instance`, pure transitions, timer jobs and proposal waits as planned (section 4.9); no DBOS work is scheduled.
- The plan's Jobs row and Decision 14 record the result and link here.
- The spike's vendoring script and results are reusable evidence if DBOS is revisited; rerunning them is in `spikes/dbos/README.md`.
