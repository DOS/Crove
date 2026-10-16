// Experiment 2: does a 7-day approval wait hold a queue slot or a database connection?
//
// A. 1000 approval workflows wait in DBOS.recv(7 days), started from an unlimited queue. Measure connections, the
//    transaction rate their polling causes, and worker memory, while a limited queue keeps running other work.
// B. The same wait started from a queue with globalConcurrency 5: do waiters hold its slots?
// C. Approve all 1000 (sendInTransaction, in the same transaction as a domain write) and time completion.
// D. 7 days pass: SIGKILL the worker, start a new one whose clock is 7 days ahead. Recovery must keep the recorded
//    deadlines: approvals expire, timers fire. Also time how long a restart takes to re-dispatch 1000 waiters.
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import pg from 'pg';
import { DEFAULT_SQL, setup } from './setup.ts';
import { SCHEMA, runnerUrl, sleep } from './env.ts';
import { client, connections, kill, observer, q, startWorker, statusCounts, stop, waitFor, type Worker } from './harness.ts';

const WAITERS = Number(process.env.WAITERS ?? 1000);
const SEVEN_DAYS_S = 7 * 24 * 3600;
const results: Record<string, unknown> = {};
const db = observer();
const dbos = await client();
const all: Worker[] = [];

const lastMem = (w: Worker) => [...w.output].reverse().find((l) => l.startsWith('MEM'));
const effectsByStep = async (like: string) =>
  Object.fromEntries(
    (await q<{ step: number; n: number }>(db, `SELECT step, count(*)::int AS n FROM spike.effects WHERE workflow_id LIKE $1 GROUP BY 1 ORDER BY 1`, [like])).map((r) => [
      ({ 0: 'proposed_or_armed', 1: 'executed_or_fired', 2: 'expired', 100: 'approval_domain_write' } as Record<number, string>)[r.step] ?? r.step,
      r.n,
    ]),
  );

async function xactRate(seconds: number) {
  const read = async () =>
    (await q<{ x: string }>(db, `SELECT xact_commit + xact_rollback AS x FROM pg_stat_database WHERE datname = current_database()`))[0]!.x;
  const before = Number(await read());
  const samples: Awaited<ReturnType<typeof connections>>[] = [];
  for (let i = 0; i < seconds; i++) {
    samples.push(await connections(db));
    await sleep(1000);
  }
  const after = Number(await read());
  return {
    transactionsPerSecond: Math.round((after - before) / seconds),
    runnerConnections: {
      maxTotal: Math.max(...samples.map((s) => s.total)),
      maxActive: Math.max(...samples.map((s) => s.active)),
      maxIdleInTransaction: Math.max(...samples.map((s) => s.idleInTx)),
    },
  };
}

try {
  await setup([DEFAULT_SQL]);
  const w1 = await startWorker(`exec-${randomUUID().slice(0, 8)}`, { MEM_LOG: '1', STEP_MS: '200' });
  all.push(w1);
  await sleep(5000);
  const idleBaseline = { ...(await xactRate(10)), mem: lastMem(w1) };

  // A. 1000 waiters from an unlimited queue.
  const t0 = Date.now();
  for (let i = 0; i < WAITERS; i++) {
    await dbos.enqueue({ queueName: 'processes', workflowName: 'approval', workflowID: `appr-${i}` }, SEVEN_DAYS_S);
  }
  const enqueueMs = Date.now() - t0;
  await waitFor('all waiters proposed', async () => {
    const [r] = await q<{ n: number }>(db, `SELECT count(*)::int AS n FROM spike.effects WHERE workflow_id LIKE 'appr-%' AND step = 0`);
    return r!.n === WAITERS;
  }, 300_000);
  const allWaitingMs = Date.now() - t0;
  await sleep(12_000); // past one 10 s recv polling interval
  const whileWaiting = await xactRate(30);
  // Other work on a limited queue still flows while 1000 wait.
  const t1 = Date.now();
  for (let i = 0; i < 20; i++) await dbos.enqueue({ queueName: 'work', workflowName: 'longSteps', workflowID: `side-${i}` }, 3);
  await waitFor('side jobs done', async () => (await statusCounts(db, `workflow_uuid LIKE 'side-%'`)).SUCCESS === 20);
  results.A_waitersOnUnlimitedQueue = {
    waiters: WAITERS,
    enqueueMs,
    msUntilAllWaiting: allWaitingMs,
    idleBaseline,
    whileWaiting: { ...whileWaiting, mem: lastMem(w1) },
    statuses: await statusCounts(db, `workflow_uuid LIKE 'appr-%'`),
    twentyThreeStepJobsOnWorkQueueMs: Date.now() - t1,
    recordedDeadline: await q(
      db,
      `SELECT function_name, round((output::text::numeric - created_at_ms) / 86400000.0, 3) AS days_after_start FROM (
         SELECT o.function_name, o.output, s.created_at AS created_at_ms FROM "${SCHEMA}".operation_outputs o
           JOIN "${SCHEMA}".workflow_status s USING (workflow_uuid)
          WHERE workflow_uuid = 'appr-0' AND o.function_name = 'DBOS.sleep') x`,
    ).catch((e) => `query failed: ${(e as Error).message}`),
  };

  // B. Waiters on a limited queue.
  for (let i = 0; i < 10; i++) {
    await dbos.enqueue({ queueName: 'approvals_limited', workflowName: 'approval', workflowID: `lim-${i}` }, SEVEN_DAYS_S);
  }
  await sleep(8000);
  results.B_waitersOnQueueWithGlobalConcurrency5 = { statuses: await statusCounts(db, `workflow_uuid LIKE 'lim-%'`) };

  // C. Approve all 1000, each in a transaction that also writes a "domain" row (the approval command's own write).
  const tx = new pg.Client({ connectionString: runnerUrl });
  await tx.connect();
  const t2 = Date.now();
  for (let i = 0; i < WAITERS; i++) {
    await tx.query('BEGIN');
    await tx.query('INSERT INTO spike.effects (workflow_id, step, executor_id) VALUES ($1, 100, $2)', [`appr-${i}`, 'api']);
    await dbos.sendInTransaction(tx, `appr-${i}`, 'approved', 'approval', `approve-appr-${i}`);
    await tx.query('COMMIT');
  }
  const sendMs = Date.now() - t2;
  // One rolled-back approval must not reach its workflow.
  await tx.query('BEGIN');
  await dbos.sendInTransaction(tx, 'lim-0', 'approved', 'approval', 'approve-lim-0');
  await tx.query('ROLLBACK');
  await tx.end();
  await waitFor('all approvals executed', async () => (await statusCounts(db, `workflow_uuid LIKE 'appr-%'`)).SUCCESS === WAITERS, 300_000);
  // Step 1 = executed after approval, step 2 = expired (see worker.ts).
  const outputs = await effectsByStep('appr-%');
  await sleep(3000);
  results.C_approveAll = {
    sendMs,
    msFromFirstSendToAllSuccess: Date.now() - t2 - 3000,
    outputs,
    rolledBackSendReachedWorkflow: (await statusCounts(db, `workflow_uuid = 'lim-0'`)).SUCCESS === 1,
  };

  // A2. 1000 waiters in DBOS.sleep(7 days) instead of recv: a timer, no polling expected.
  await sleep(12_000);
  const afterApprovals = await xactRate(10);
  for (let i = 0; i < WAITERS; i++) {
    await dbos.enqueue({ queueName: 'processes', workflowName: 'timer', workflowID: `slp-${i}` }, SEVEN_DAYS_S * 1000);
  }
  await waitFor('timers armed', async () => {
    const [r] = await q<{ n: number }>(db, `SELECT count(*)::int AS n FROM spike.effects WHERE workflow_id LIKE 'slp-%' AND step = 0`);
    return r!.n === WAITERS;
  }, 300_000);
  await sleep(12_000);
  results.A2_timersOnly = { beforeTimers: afterApprovals, whileTimersWait: { ...(await xactRate(30)), mem: lastMem(w1) } };

  // D. Seven days pass across a crash.
  for (let i = 0; i < 50; i++) {
    await dbos.enqueue({ queueName: 'processes', workflowName: 'approval', workflowID: `exp-${i}` }, SEVEN_DAYS_S);
    await dbos.enqueue({ queueName: 'processes', workflowName: 'timer', workflowID: `tmr-${i}` }, SEVEN_DAYS_S * 1000);
  }
  for (let i = 0; i < WAITERS; i++) {
    await dbos.enqueue({ queueName: 'processes', workflowName: 'approval', workflowID: `re-${i}` }, SEVEN_DAYS_S * 2);
  }
  await waitFor('d waiters armed', async () => {
    const [r] = await q<{ n: number }>(db, `SELECT count(*)::int AS n FROM spike.effects WHERE step = 0 AND (workflow_id LIKE 'exp-%' OR workflow_id LIKE 'tmr-%' OR workflow_id LIKE 're-%')`);
    return r!.n === 100 + WAITERS;
  }, 300_000);
  await kill(w1);
  await q(db, `TRUNCATE spike.executor_heartbeat`);
  const offset = String((SEVEN_DAYS_S + 60) * 1000);
  const t3 = Date.now();
  const w2 = await startWorker(`exec-${randomUUID().slice(0, 8)}`, { MEM_LOG: '1', SWEEPER: '1', CLOCK_OFFSET_MS: offset });
  all.push(w2);
  await waitFor('expired and fired', async () => {
    const e = await statusCounts(db, `workflow_uuid LIKE 'exp-%' OR workflow_uuid LIKE 'tmr-%'`);
    return e.SUCCESS === 100;
  }, 300_000);
  const expiredMs = Date.now() - t3;
  await waitFor('1000 re-dispatched to the new executor', async () => {
    const [r] = await q<{ n: number }>(db, `SELECT count(*)::int AS n FROM "${SCHEMA}".workflow_status WHERE workflow_uuid LIKE 're-%' AND status = 'PENDING' AND executor_id = $1`, [w2.id]);
    return r!.n === WAITERS;
  }, 300_000);
  const redispatchMs = Date.now() - t3;
  results.D_sevenDaysAcrossACrash = {
    msFromRestartToAllExpiredOrFired: expiredMs,
    approvalsByFinalStep: await effectsByStep('exp-%'),
    timersByFinalStep: await effectsByStep('tmr-%'),
    msFromRestartUntil1000LongerWaitersRedispatched: redispatchMs,
    longerWaitersStillWaiting: await statusCounts(db, `workflow_uuid LIKE 're-%'`),
    reExecutedStepsAfterRecovery: (await q<{ n: number }>(db, `SELECT count(*)::int - count(DISTINCT (workflow_id, step))::int AS n FROM spike.effects WHERE workflow_id LIKE 're-%' OR workflow_id LIKE 'exp-%' OR workflow_id LIKE 'tmr-%'`))[0]!.n,
    memAfterRecovery: lastMem(w2),
  };
} finally {
  await stop(all);
  await dbos.destroy();
  await db.end();
  console.log(JSON.stringify(results, null, 2));
  writeFileSync(new URL('../results/wait.json', import.meta.url), `${JSON.stringify(results, null, 2)}\n`);
}
