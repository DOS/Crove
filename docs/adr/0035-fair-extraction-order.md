# 0035. Fair order of extraction jobs across orgs

- Status: accepted
- Date: 2026-10-20
- Deciders: Claude Code session for issue #432 (an engineering choice inside the existing queue; no product decision)
- Builds on: ADR-0033 section 4 (per-org fairness on pg-boss), the bulk intake of #314
- Issue: [#432](https://github.com/DOS/Ludy/issues/432)

## Context and problem statement

Every org shares one extraction queue (`finance-file-extract` in pg-boss) and, behind it, one parser slot in crove-extract. Workers fetch one job at a time. Since bulk intake (#314) one ZIP files up to 500 documents, each an extraction job (an AI call for a PDF or a photo), queued in one transaction. pg-boss fetched them first in, first out, so another org's single upload waited behind the whole batch: minutes, or longer with AI calls.

## Decision

Each extraction job is sent with a priority that ranks it within its org. The outbox relay counts, once per batch, how many extraction jobs each org of the batch already has queued, retrying or running, and sends the org's next job with priority `-n` (`extractPriorities` and `sendExtractJob` in `apps/kernel/src/worker.ts`). Jobs of one org within a batch take the next ranks. pg-boss fetches by priority, then by creation order, so the k-th waiting job of every org runs in round k:

- an org's 500-entry ZIP queues its entries at priorities 0 to -499;
- another org's single upload, at priority 0, runs after the job that is running and the rank-0 jobs of other orgs queued before it, whatever the backlog;
- an org alone on the queue keeps its throughput, and its jobs keep roughly their order.

Jobs are sent in pg-boss's group of their org (`group.id` = org id), which is what the count reads (`crove_jobs.job.group_id`, with the pg-boss tables the worker login already reads and writes). No schema change.

## Options considered

1. **Rank priority (chosen).** One indexed count per relay batch and two send options. Fair by construction, keeps single uploads first, idle capacity is never held back.
2. **pg-boss `groupConcurrency` per org.** A cap on running jobs per org (ADR-0033 section 4). With one parser slot and one job at a time, a cap of 1 changes nothing: the order stays first in, first out. It matters once several workers run, and can be added on top then.
3. **A quota on queued archive entries per org, the rest deferred.** Bounds one org's backlog, but either refuses a legitimate month of invoices or needs a deferral loop that re-queues entries later. With fair order, one org's backlog only delays that org, so the quota is not needed for fairness. It stays an option if one org's volume ever costs too much in AI calls.

## Consequences

- Several worker processes count apart and may send the same rank, so the order is fair to within their number.
- A job's priority is fixed when it is sent. An org that queues more while its earlier jobs wait gets ranks counted from what is still queued, so its new jobs may pass some of its own older ones; across orgs the order stays fair.
- Jobs queued before this change have no group and are not counted; they drain in the first rounds.
- The parser slot is also used by inbound email (its own queue) and the tax portal's lists (their own queue); those queues keep their own order.
- `apps/kernel/test/extract-fairness.db.test.ts` runs the starvation case against the vendored pg-boss schema: org A queues 500 entries, and org B's upload runs within two jobs.
