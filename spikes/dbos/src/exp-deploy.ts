// Experiment 5: what a deploy does to a workflow that waits for days.
//
// A 7-day approval wait outlives many deploys. DBOS recovers a workflow by replaying its code against the recorded
// steps, and an executor only runs workflows of its own application version.
// a. Same application version, changed workflow code (a step added before the wait): what happens on recovery?
// b. New application version (the default when the version is not pinned: a hash of the workflow code): are the
//    old version's waiting workflows recovered by the new workers?
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { DEFAULT_SQL, setup } from './setup.ts';
import { SCHEMA, sleep } from './env.ts';
import { client, kill, observer, q, startWorker, statusCounts, stop, waitFor, type Worker } from './harness.ts';

const SEVEN_DAYS_S = 7 * 24 * 3600;
const results: Record<string, unknown> = {};
const db = observer();
const dbos = await client();
const all: Worker[] = [];
const id = () => `exec-${randomUUID().slice(0, 8)}`;
const proposed = (prefix: string, n: number) =>
  waitFor(`${prefix} proposed`, async () => {
    const [r] = await q<{ n: number }>(db, `SELECT count(*)::int AS n FROM spike.effects WHERE workflow_id LIKE $1 AND step = 0`, [`${prefix}-%`]);
    return r!.n === n;
  });

try {
  await setup([DEFAULT_SQL]);

  // a. Same version, changed code.
  const v1 = await startWorker(id(), { WF_VARIANT: '1' });
  all.push(v1);
  for (let i = 0; i < 3; i++) await dbos.enqueue({ queueName: 'processes', workflowName: 'approval', workflowID: `same-${i}` }, SEVEN_DAYS_S);
  await proposed('same', 3);
  await kill(v1);
  const v1b = await startWorker(id(), { WF_VARIANT: '2', SWEEPER: '1' });
  all.push(v1b);
  await waitFor('same-* re-dispatched or failed', async () => {
    const [r] = await q<{ n: number }>(db, `SELECT count(*)::int AS n FROM "${SCHEMA}".workflow_status WHERE workflow_uuid LIKE 'same-%' AND (executor_id = $1 OR status = 'ERROR')`, [v1b.id]);
    return r!.n === 3;
  });
  await sleep(3000);
  for (let i = 0; i < 3; i++) await dbos.send(`same-${i}`, 'approved', 'approval', `approve-same-${i}`);
  await sleep(12_000);
  results.a_sameVersionChangedCode = {
    statuses: await statusCounts(db, `workflow_uuid LIKE 'same-%'`),
    stepsAfterChange: await q(db, `SELECT step, count(*)::int AS n FROM spike.effects WHERE workflow_id LIKE 'same-%' GROUP BY 1 ORDER BY 1`),
    workerErrors: v1b.output.filter((l) => /Unexpected|DBOSUnexpectedStep|error/i.test(l)).slice(0, 3),
  };
  await stop([v1b]);

  // b. New application version.
  await q(db, `TRUNCATE spike.executor_heartbeat`);
  const old = await startWorker(id(), { WF_VARIANT: '1', SPIKE_APP_VERSION: 'spike-v1' });
  all.push(old);
  for (let i = 0; i < 3; i++) await dbos.enqueue({ queueName: 'processes', workflowName: 'approval', workflowID: `ver-${i}`, appVersion: 'spike-v1' }, SEVEN_DAYS_S);
  await proposed('ver', 3);
  await kill(old);
  const neu = await startWorker(id(), { WF_VARIANT: '2', SPIKE_APP_VERSION: 'spike-v2', SWEEPER: '1' });
  all.push(neu);
  await sleep(15_000);
  for (let i = 0; i < 3; i++) await dbos.send(`ver-${i}`, 'approved', 'approval', `approve-ver-${i}`);
  await sleep(12_000);
  results.b_newApplicationVersion = {
    statuses: await statusCounts(db, `workflow_uuid LIKE 'ver-%'`),
    rows: await q(db, `SELECT workflow_uuid, status, application_version, executor_id = $1 AS on_new_worker FROM "${SCHEMA}".workflow_status WHERE workflow_uuid LIKE 'ver-%' ORDER BY 1`, [neu.id]),
    recoveryLog: await q(db, `SELECT dead_executor, workflows FROM spike.recovery_log ORDER BY id`),
  };
} finally {
  await stop(all);
  await dbos.destroy();
  await db.end();
  console.log(JSON.stringify(results, null, 2));
  writeFileSync(new URL('../results/deploy.json', import.meta.url), `${JSON.stringify(results, null, 2)}\n`);
}
