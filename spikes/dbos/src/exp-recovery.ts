// Experiment 1: workflow recovery on a pool of workers without Conductor.
//
// 1. Three workers (new random-ish executor IDs, as on a Cloud Run worker pool) run 40 ten-step workflows.
//    SIGKILL two of them mid-workflow. With DBOS alone (no sweeper), their workflows stay PENDING forever: an
//    executor recovers only its OWN executor ID, at its own launch.
// 2. Start a fourth worker with the sweeper on: it sees the dead executors' stale heartbeats and resumes their
//    workflows onto their queues. Everything completes; count re-executed steps.
// 3. Restart with the SAME executor ID: DBOS's built-in launch recovery picks its own workflows back up.
// 4. Zombie: a worker stops heartbeating but keeps running. The sweeper hands its workflows to another worker;
//    DBOS's ownership token (owner_xid) must stop the zombie from checkpointing them.
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { DEFAULT_SQL, setup } from './setup.ts';
import { SCHEMA, sleep } from './env.ts';
import { client, kill, observer, q, startWorker, statusCounts, stop, waitFor, type Worker } from './harness.ts';

const N = 40;
const STEPS = 10;
const env = { STEP_MS: '300' };
const results: Record<string, unknown> = {};
const db = observer();
const dbos = await client();
const all: Worker[] = [];

async function enqueueBatch(prefix: string, n = N) {
  for (let i = 0; i < n; i++) {
    await dbos.enqueue({ queueName: 'work', workflowName: 'longSteps', workflowID: `${prefix}-${i}` }, STEPS);
  }
}

async function duplicates(prefix: string) {
  const [r] = await q<{ effects: number; distinct_steps: number }>(
    db,
    `SELECT count(*)::int AS effects, count(DISTINCT (workflow_id, step))::int AS distinct_steps FROM spike.effects WHERE workflow_id LIKE $1`,
    [`${prefix}-%`],
  );
  return { effects: r!.effects, distinctSteps: r!.distinct_steps, reExecutedSteps: r!.effects - r!.distinct_steps };
}

try {
  await setup([DEFAULT_SQL]);

  // Phase 1: no sweeper.
  const a = await startWorker(`exec-${randomUUID().slice(0, 8)}`, env);
  const b = await startWorker(`exec-${randomUUID().slice(0, 8)}`, env);
  const c = await startWorker(`exec-${randomUUID().slice(0, 8)}`, env);
  all.push(a, b, c);
  await enqueueBatch('p1');
  await waitFor('a and b are mid-workflow', async () => {
    const rows = await q<{ n: number }>(db, `SELECT count(*)::int AS n FROM spike.effects WHERE executor_id IN ($1, $2)`, [a.id, b.id]);
    return rows[0]!.n >= 12;
  });
  const killedAt = Date.now();
  await kill(a);
  await kill(b);
  const orphaned = await q<{ executor_id: string; n: number }>(
    db,
    `SELECT executor_id, count(*)::int AS n FROM "${SCHEMA}".workflow_status WHERE status = 'PENDING' AND executor_id IN ($1, $2) GROUP BY 1`,
    [a.id, b.id],
  );
  // c drains the rest of the queue; the orphans must stay PENDING.
  await waitFor('no ENQUEUED left', async () => !(await statusCounts(db, `workflow_uuid LIKE 'p1-%'`)).ENQUEUED, 120_000);
  await sleep(15_000);
  const stuck = await q<{ n: number }>(
    db,
    `SELECT count(*)::int AS n FROM "${SCHEMA}".workflow_status WHERE status = 'PENDING' AND executor_id IN ($1, $2)`,
    [a.id, b.id],
  );
  results.phase1_noSweeper = {
    orphanedAtKill: orphaned,
    stillPendingOnDeadExecutors15sAfterQueueDrained: stuck[0]!.n,
    statuses: await statusCounts(db, `workflow_uuid LIKE 'p1-%'`),
  };

  // Phase 2: a new worker with the sweeper.
  const d = await startWorker(`exec-${randomUUID().slice(0, 8)}`, { ...env, SWEEPER: '1' });
  all.push(d);
  const recoveredIn = await waitFor('all p1 workflows succeed', async () => (await statusCounts(db, `workflow_uuid LIKE 'p1-%'`)).SUCCESS === N);
  results.phase2_sweeper = {
    msFromSweeperStartToAllSuccess: recoveredIn,
    msFromKillToAllSuccess: Date.now() - killedAt,
    recoveryLog: await q(db, `SELECT swept_by, dead_executor, workflows FROM spike.recovery_log ORDER BY id`),
    ...(await duplicates('p1')),
    expectedEffects: N * STEPS,
  };

  // Phase 3: same executor ID restarts (built-in launch recovery), sweeper off on c so it cannot interfere.
  await stop([d]);
  await enqueueBatch('p3', 12);
  await waitFor('c is mid-workflow', async () => {
    const rows = await q<{ n: number }>(db, `SELECT count(*)::int AS n FROM spike.effects WHERE executor_id = $1 AND workflow_id LIKE 'p3-%'`, [c.id]);
    return rows[0]!.n >= 6;
  });
  await kill(c);
  const pendingOnC = (await statusCounts(db, `workflow_uuid LIKE 'p3-%' AND executor_id = $1`, [c.id])).PENDING ?? 0;
  const c2 = await startWorker(c.id, env);
  all.push(c2);
  const sameIdRecoveredIn = await waitFor('all p3 succeed', async () => (await statusCounts(db, `workflow_uuid LIKE 'p3-%'`)).SUCCESS === 12);
  results.phase3_sameExecutorId = { pendingOnKilledExecutor: pendingOnC, msToAllSuccessAfterRestart: sameIdRecoveredIn, ...(await duplicates('p3')) };
  await stop([c2]);

  // Phase 4: zombie executor.
  await q(db, `TRUNCATE spike.executor_heartbeat`);
  const zombie = await startWorker(`zombie-${randomUUID().slice(0, 8)}`, { ...env, STEP_MS: '1500', HEARTBEAT_STOP_AFTER_MS: '2000' });
  all.push(zombie);
  await enqueueBatch('p4', 4);
  await sleep(1500);
  const healthy = await startWorker(`exec-${randomUUID().slice(0, 8)}`, { ...env, SWEEPER: '1' });
  all.push(healthy);
  await waitFor('all p4 succeed', async () => (await statusCounts(db, `workflow_uuid LIKE 'p4-%'`)).SUCCESS === 4, 120_000);
  await sleep(3000);
  const byExecutor = await q(
    db,
    `SELECT executor_id, count(*)::int AS effects FROM spike.effects WHERE workflow_id LIKE 'p4-%' GROUP BY 1 ORDER BY 1`,
  );
  const conflicts = zombie.output.filter((l) => /no longer owned|DBOSWorkflowConflict/i.test(l));
  const finalOwner = await q(db, `SELECT workflow_uuid, status, executor_id FROM "${SCHEMA}".workflow_status WHERE workflow_uuid LIKE 'p4-%' ORDER BY 1`);
  results.phase4_zombie = {
    effectsByExecutor: byExecutor,
    ...(await duplicates('p4')),
    expectedEffects: 4 * STEPS,
    zombieConflictLogLines: conflicts.length,
    zombieConflictSample: conflicts.slice(0, 2),
    finalOwner,
  };
} finally {
  await stop(all);
  await dbos.destroy();
  await db.end();
  console.log(JSON.stringify(results, null, 2));
  writeFileSync(new URL('../results/recovery.json', import.meta.url), `${JSON.stringify(results, null, 2)}\n`);
}
