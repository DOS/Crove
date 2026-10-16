// One worker process: a stand-in for one Cloud Run worker pool instance. The experiments start several, SIGKILL
// them mid-workflow and start new ones with NEW executor IDs, since a worker pool instance has no stable identity.
//
// Env: EXECUTOR_ID (required), SWEEPER=1 (run the self-hosted recovery sweeper), CLOCK_OFFSET_MS (shift Date.now to
// simulate elapsed time), STEP_MS (duration of each long step), POOL (DBOS system pool size).
import pg from 'pg';

const clockOffset = Number(process.env.CLOCK_OFFSET_MS ?? 0);
if (clockOffset) {
  // DBOS computes sleep and recv deadlines with Date.now(), so shifting it simulates days passing.
  const realNow = Date.now.bind(Date);
  Date.now = () => realNow() + clockOffset;
}

const { DBOS } = await import('@dbos-inc/dbos-sdk');
const { APP_NAME, APP_VERSION, SCHEMA, runnerUrl, sleep } = await import('./env.ts');

const executorID = process.env.EXECUTOR_ID;
if (!executorID) throw new Error('EXECUTOR_ID is required');
const stepMs = Number(process.env.STEP_MS ?? 300);
const app = new pg.Pool({ connectionString: runnerUrl, max: 4, application_name: `spike-app-${executorID}` });

async function effect(workflowId: string, step: number) {
  await app.query('INSERT INTO spike.effects (workflow_id, step, executor_id) VALUES ($1, $2, $3)', [workflowId, step, executorID]);
}

// A multi-step job: each step records an effect (think: calls a provider), then works. A crash before DBOS's
// checkpoint re-runs that one step (at-least-once per step), never the completed ones.
DBOS.registerWorkflow(
  async function longSteps(n: number) {
    for (let i = 0; i < n; i++) {
      await DBOS.runStep(
        async () => {
          await effect(DBOS.workflowID!, i);
          await sleep(stepMs);
        },
        { name: `step${i}` },
      );
    }
    return n;
  },
  { name: 'longSteps' },
);

// A human approval: propose, wait up to 7 days for a message, then execute or expire.
// WF_VARIANT=2 is the same workflow after a code change that adds a step before the proposal (the deploy experiment).
const variant = process.env.WF_VARIANT ?? '1';
DBOS.registerWorkflow(
  async function approval(waitSeconds: number) {
    if (variant === '2') await DBOS.runStep(() => effect(DBOS.workflowID!, 50), { name: 'audit' });
    await DBOS.runStep(() => effect(DBOS.workflowID!, 0), { name: 'propose' });
    const decision = await DBOS.recv<string>('approval', waitSeconds);
    await DBOS.runStep(() => effect(DBOS.workflowID!, decision ? 1 : 2), { name: decision ? 'execute' : 'expire' });
    return decision ?? 'expired';
  },
  { name: 'approval' },
);

// A 7-day durable timer (DBOS.sleep), for the restart-with-clock-shift check.
DBOS.registerWorkflow(
  async function timer(sleepMs: number) {
    await DBOS.runStep(() => effect(DBOS.workflowID!, 0), { name: 'arm' });
    await DBOS.sleep(sleepMs);
    await DBOS.runStep(() => effect(DBOS.workflowID!, 1), { name: 'fire' });
    return 'fired';
  },
  { name: 'timer' },
);

// A short per-org job for the fairness experiment.
DBOS.registerWorkflow(
  async function orgJob(org: string, i: number) {
    await DBOS.runStep(
      async () => {
        await app.query('INSERT INTO spike.fair (org, i, executor_id) VALUES ($1, $2, $3)', [org, i, executorID]);
        await sleep(stepMs);
      },
      { name: 'work' },
    );
  },
  { name: 'orgJob' },
);

DBOS.setConfig({
  name: APP_NAME,
  applicationVersion: APP_VERSION,
  executorID,
  systemDatabaseUrl: runnerUrl,
  systemDatabaseSchemaName: SCHEMA,
  systemDatabasePoolSize: Number(process.env.POOL ?? 10),
  // The runner has no DDL rights: DBOS only verifies the committed schema.
  runMigrations: false,
  logLevel: process.env.LOG_LEVEL ?? 'warn',
});
await DBOS.launch();

// Queue configuration lives in the system database (crove_dbos.queues), like Crove's queues-as-data.
await DBOS.registerQueue('work', { workerConcurrency: 4, onConflict: 'always_update' });
await DBOS.registerQueue('approvals_limited', { globalConcurrency: 5, onConflict: 'always_update' });
await DBOS.registerQueue('processes', { onConflict: 'always_update' });
await DBOS.registerQueue('org_fair', { globalConcurrency: 4, partitionConcurrency: 1, onConflict: 'always_update' });
await DBOS.registerQueue('org_plain', { globalConcurrency: 4, onConflict: 'always_update' });

// Heartbeat: DBOS records which executor runs a workflow, but not whether that executor is alive.
const beat = () =>
  app.query(
    `INSERT INTO spike.executor_heartbeat (executor_id, beat_at) VALUES ($1, now())
     ON CONFLICT (executor_id) DO UPDATE SET beat_at = now()`,
    [executorID],
  );
await beat();
// HEARTBEAT_STOP_AFTER_MS simulates a zombie: the process keeps working but looks dead (a network partition or a
// long pause), so the sweeper hands its workflows to another executor while it still runs them.
const heartbeatStopAt = process.env.HEARTBEAT_STOP_AFTER_MS ? Date.now() + Number(process.env.HEARTBEAT_STOP_AFTER_MS) : Infinity;
setInterval(() => {
  if (Date.now() < heartbeatStopAt) void beat().catch((e) => console.error('[beat]', e.message));
}, 1000);
process.on('unhandledRejection', (e) => console.error('[unhandled]', (e as Error)?.name, (e as Error)?.message));

// Self-hosted recovery without Conductor. Conductor's only recovery role is to call recoverPendingWorkflows() for an
// executor it saw disconnect; here a leader (advisory lock) finds PENDING workflows owned by executors whose
// heartbeat is stale and hands them back to their queues with the public DBOS.resumeWorkflows().
const DEAD_AFTER_SECONDS = Number(process.env.DEAD_AFTER_SECONDS ?? 5);
async function sweepOnce(leader: pg.PoolClient) {
  const pending = await DBOS.listWorkflows({ status: 'PENDING', loadInput: false, loadOutput: false });
  const executors = [...new Set(pending.map((w) => w.executorId).filter((e): e is string => !!e && e !== executorID))];
  if (executors.length === 0) return;
  const { rows } = await leader.query<{ executor_id: string }>(
    `SELECT e AS executor_id FROM unnest($1::text[]) e
      WHERE NOT EXISTS (SELECT 1 FROM spike.executor_heartbeat h
                         WHERE h.executor_id = e AND h.beat_at > now() - make_interval(secs => $2))`,
    [executors, DEAD_AFTER_SECONDS],
  );
  for (const { executor_id: dead } of rows) {
    const mine = pending.filter((w) => w.executorId === dead);
    const byQueue = new Map<string | undefined, string[]>();
    for (const w of mine) byQueue.set(w.queueName, [...(byQueue.get(w.queueName) ?? []), w.workflowID]);
    for (const [queueName, ids] of byQueue) {
      await DBOS.resumeWorkflows(ids, queueName ? { queueName } : undefined);
    }
    await leader.query('INSERT INTO spike.recovery_log (swept_by, dead_executor, workflows) VALUES ($1, $2, $3)', [executorID, dead, mine.length]);
    console.log(`[sweeper ${executorID}] recovered ${mine.length} workflows of dead executor ${dead}`);
  }
}
if (process.env.SWEEPER === '1') {
  const leader = await app.connect();
  let isLeader = false;
  setInterval(async () => {
    try {
      if (!isLeader) {
        const { rows } = await leader.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(59059) AS ok');
        isLeader = rows[0]!.ok;
      }
      if (isLeader) await sweepOnce(leader);
    } catch (e) {
      console.error('[sweeper]', (e as Error).message);
    }
  }, 2000);
}

if (process.env.MEM_LOG === '1') {
  setInterval(() => {
    const m = process.memoryUsage();
    console.log(`MEM rss=${Math.round(m.rss / 1048576)} heapUsed=${Math.round(m.heapUsed / 1048576)}`);
  }, 2000);
}

console.log(`READY ${executorID} pid=${process.pid}`);
