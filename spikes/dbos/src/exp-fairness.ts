// Experiment 3: per-org fairness.
//
// One big org enqueues 200 jobs, then 10 small orgs enqueue 5 jobs each. Two workers, 300 ms per job, a queue-wide
// limit of 4 running jobs. Compared:
//   org_plain  FIFO with globalConcurrency 4 (no partitioning);
//   org_fair   partitioned by org (queuePartitionKey = org id) with partitionConcurrency 1, globalConcurrency 4.
// Measured: how long the small orgs wait, and what the cap costs the big org when it is alone.
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { DEFAULT_SQL, setup } from './setup.ts';
import { client, observer, q, startWorker, statusCounts, stop, waitFor, type Worker } from './harness.ts';

const BIG = 200;
const SMALL_ORGS = 10;
const SMALL_JOBS = 5;
const results: Record<string, unknown> = {};
const db = observer();
const dbos = await client();
const all: Worker[] = [];

async function run(queueName: 'org_plain' | 'org_fair') {
  const tag = queueName;
  const t0 = Date.now();
  const partitioned = queueName === 'org_fair';
  const opts = (org: string, i: number) => ({
    queueName,
    workflowName: 'orgJob',
    workflowID: `${tag}-${org}-${i}`,
    ...(partitioned ? { queuePartitionKey: org } : {}),
  });
  for (let i = 0; i < BIG; i++) await dbos.enqueue(opts('big', i), `${tag}:big`, i);
  const smallEnqueuedAt = Date.now();
  for (let o = 0; o < SMALL_ORGS; o++) {
    for (let i = 0; i < SMALL_JOBS; i++) await dbos.enqueue(opts(`small${o}`, i), `${tag}:small${o}`, i);
  }
  await waitFor(`${tag} done`, async () => (await statusCounts(db, `workflow_uuid LIKE $1`, [`${tag}-%`])).SUCCESS === BIG + SMALL_ORGS * SMALL_JOBS, 600_000);
  const totalMs = Date.now() - t0;
  const perOrg = await q<{ org: string; first_start_s: number; last_start_s: number }>(
    db,
    `SELECT split_part(org, ':', 2) AS org,
            round(extract(epoch FROM min(started_at) - to_timestamp($2 / 1000.0))::numeric, 1)::float AS first_start_s,
            round(extract(epoch FROM max(started_at) - to_timestamp($2 / 1000.0))::numeric, 1)::float AS last_start_s
       FROM spike.fair WHERE org LIKE $1 GROUP BY 1 ORDER BY 1`,
    [`${tag}:%`, smallEnqueuedAt],
  );
  const small = perOrg.filter((r) => r.org !== 'big');
  const maxRunning = await q<{ n: number }>(
    db,
    // Highest number of jobs of one org started within one job duration of each other: the effective per-org parallelism.
    `SELECT max(c)::int AS n FROM (
       SELECT count(*) OVER (PARTITION BY org ORDER BY started_at RANGE BETWEEN interval '250 milliseconds' PRECEDING AND CURRENT ROW) AS c
         FROM spike.fair WHERE org = $1) x`,
    [`${tag}:big`],
  );
  return {
    totalMs,
    secondsAfterSmallEnqueue: {
      smallOrgsFirstStartMax: Math.max(...small.map((r) => r.first_start_s)),
      smallOrgsLastStartMax: Math.max(...small.map((r) => r.last_start_s)),
      bigOrgLastStart: perOrg.find((r) => r.org === 'big')?.last_start_s,
    },
    bigOrgMaxConcurrentStarts: maxRunning[0]!.n,
  };
}

try {
  await setup([DEFAULT_SQL]);
  all.push(await startWorker(`exec-${randomUUID().slice(0, 8)}`, { STEP_MS: '300' }));
  all.push(await startWorker(`exec-${randomUUID().slice(0, 8)}`, { STEP_MS: '300' }));
  results.org_plain_fifo = await run('org_plain');
  results.org_fair_partitioned = await run('org_fair');
} finally {
  await stop(all);
  await dbos.destroy();
  await db.end();
  console.log(JSON.stringify(results, null, 2));
  writeFileSync(new URL('../results/fairness.json', import.meta.url), `${JSON.stringify(results, null, 2)}\n`);
}
