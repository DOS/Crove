# Spike: DBOS Transact vs the plan's process engine (issue #59)

Throwaway code behind [ADR-0033](../../docs/adr/0033-dbos-transact-spike.md). It is not part of the product: not a
pnpm workspace package (`pnpm-workspace.yaml` lists only `apps/*`, `packages/*` and `modules/*`), not linted or
typechecked by the root scripts, ignored by Renovate and kept out of the Docker build context. It has its own
`package.json` and lockfile and is installed with npm.

Everything runs locally: a throwaway `postgres:17` container and several Node processes on the same machine. Nothing
is deployed and no DBOS Conductor or DBOS Cloud account is used.

## What it pins

- `@dbos-inc/dbos-sdk` 5.2.11 (released 2026-09-29; 5.3.0 was less than a day old when the spike ran), MIT.
- `pg` 8.23.1, TypeScript 7.0.2 for `npm run typecheck`, Node 26 (runs the `.ts` files directly).

## Rerun

```sh
docker run -d --name crove-spike-dbos-pg -e POSTGRES_PASSWORD=spike \
  -p 127.0.0.1:55959:5432 postgres:17 -c max_connections=200
cd spikes/dbos
npm ci
npm run typecheck
npm run all            # schema, recovery, wait, fairness (about 10 minutes)
node src/exp-deploy.ts # deploys vs long waits
# schema churn per release (exp-schema.ts already installed 5.0.2 under .cache/)
for v in 4.21.6 4.27.6 5.3.0; do npm install --prefix .cache/sdk-$v --no-save @dbos-inc/dbos-sdk@$v; done
node src/schema-churn.ts .cache/sdk-4.21.6 .cache/sdk-4.27.6 .cache/sdk-5.0.2 . .cache/sdk-5.3.0
docker rm -f crove-spike-dbos-pg
```

`SPIKE_PG_PORT`, `SPIKE_PG_HOST`, `SPIKE_PG_PASSWORD` and `SPIKE_PG_CONTAINER` override the defaults in `src/env.ts`.
`SPIKE_VERBOSE=1` prints the workers' output. Each experiment recreates the `spike` database and writes
`results/<experiment>.json`; the committed files are the run the ADR quotes.

## Files

| File | What it does |
|---|---|
| `src/vendor-schema.ts` | Vendors the DBOS system schema as committed SQL with the SDK's own generator (`npx dbos schema --print-migrations`), with `CONCURRENTLY` removed and a version guard, so Crove's runner can apply it in one transaction. Output: `sql/dbos-5.2.11-from-1.sql` (fresh) and `sql/dbos-5.2.11-from-115.sql` (upgrade from 5.0.2). |
| `src/setup.ts` | Recreates the database: a non-superuser `spike_migrate` applies the vendored file; `spike_runner` gets DML and EXECUTE only. |
| `src/worker.ts` | One worker process (a stand-in for one Cloud Run worker pool instance): the workflows, the queues, a heartbeat, and the optional self-hosted recovery sweeper. |
| `src/harness.ts` | Starts and SIGKILLs workers, enqueues through `DBOSClient`, observes the database. |
| `src/exp-schema.ts` | Experiment 4: committed SQL, upgrades, `runMigrations: false`, runner privileges, function hardening. |
| `src/exp-recovery.ts` | Experiment 1: SIGKILL mid-workflow, recovery without Conductor, same-ID restart, a zombie executor. |
| `src/exp-wait.ts` | Experiment 2: 1000 workflows waiting 7 days (connections, queue slots, polling, memory), approval in the same transaction as a domain write, 7 days passing across a crash. |
| `src/exp-fairness.ts` | Experiment 3: one big org and ten small orgs on a FIFO queue and on a queue partitioned by org. |
| `src/exp-deploy.ts` | Experiment 5: a long wait across a code change and across an application version change. |
| `src/schema-churn.ts` | Counts system schema migrations per SDK release. |
| `src/launch-check.ts` | Launches DBOS once against a database and reports the outcome (used by `exp-schema.ts`). |
