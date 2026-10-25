// The pg-boss schema (`crove_jobs`) is committed SQL like every other schema (plan principle 4, External-tenant
// gate T6). `pnpm db:vendor:pgboss` renders pg-boss's own plans into a migration; no code path runs pg-boss with
// `migrate: true`. The worker starts pg-boss with `migrate: false`, which refuses any other schema version, and
// /readyz compares the database's version with the one the pinned pg-boss expects.
import { readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { getConstructionPlans, getMigrationPlans } from 'pg-boss';
import { CHANNEL_PROVIDERS } from '@crove/channel';

export const JOB_SCHEMA = 'crove_jobs';

// Created by the migration that vendors the schema. A new queue, or a new policy, needs a new migration.
export const QUEUES = {
  extract: 'finance-file-extract',
  inbound: 'kernel-inbound-email',
  signOut: 'kernel-session-signout',
  orgExport: 'kernel-org-export',
  retention: 'kernel-retention-purge',
  agentDispatch: 'kernel-agent-dispatch',
  agentWake: 'kernel-agent-wake',
  agentSweep: 'kernel-agent-sweep',
  // Created by the agent proposals migration (20261019180000).
  agentProposal: 'kernel-agent-proposal',
  // Created by the portal invoice list migration (20261020060000).
  portalList: 'finance-portal-list',
  // Created by the mail events migration (20261021100000).
  mailEvent: 'kernel-mail-event',
  // Created by the Social link preview migration (20261021150000).
  socialLinkPreview: 'social-link-preview',
  // Created by the Social channel option migration (20261029060000).
  socialChannelOption: 'social-channel-option',
  // Created by the Social notifications migration (20261021140000).
  socialNotify: 'social-notify',
  // Created by the Social remove migration (20261023141000).
  socialRemove: 'social-remove',
  // Created by the Social edit published migration (20261029175000).
  socialEdit: 'social-edit',
  // Created by the Social push subscription migration (20261029215000).
  socialPush: 'social-push',
  // Created by the team chat alert migration (20261023143000).
  socialChatAlert: 'social-chat-alert',
  // Created by the WORM archive migration (20261023230000).
  archiveWrite: 'kernel-archive-write',
  archiveVerify: 'kernel-archive-verify',
  // Created by the kernel notifications migration (20261025030000).
  notify: 'kernel-notify',
  // Created by the fiscal year archive migration (20261025230000).
  yearArchive: 'finance-year-archive',
  // Created by the crm bookings migration (20261031020000).
  crmBooking: 'crm-booking',
  // Created by the crm booking manage migration (20261031250000).
  crmBookingRemind: 'crm-booking-remind',
  // Created by the period balance migration (20261101070000).
  periodBalanceVerify: 'finance-period-balance-verify',
} as const;
type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

// One publish queue per channel provider (Social plan §3.6), so each provider gets its own concurrency; only providers
// a deployment can publish to are worked. 'stately' with the singleton key <org>:<variant>: one queued and one active
// job per variant; a job active longer than 300 seconds is retried (its begin then finds the variant in flight and
// waits until it is stale). Created by the Social publish migration (20261019040000).
export const socialPublishQueue = (provider: string) => `social-publish-${provider}`;
export const SOCIAL_PUBLISH_QUEUES: readonly string[] = CHANNEL_PROVIDERS.map(socialPublishQueue);

// Queued mail (Email plan §3.2, #548): system and transactional mail at once, marketing throttled. 'stately' with the
// mail's id as singleton key, so a sweep never queues a mail twice. Created by the mail queue migration
// (20261022050000).
export const MAIL_QUEUES: readonly string[] = ['kernel-mail-send', 'kernel-mail-bulk'];

// The pg-boss policy of each queue that is not 'standard'. kernel-agent-wake is 'stately' with the singleton key
// <org>:<agent>: at most one queued and one active job per agent, so wake-ups coalesce and an agent runs once at a
// time (ADR-0029 section 5; the database also allows one running ai_run per agent).
const QUEUE_POLICIES: Partial<Record<QueueName, 'stately'>> = { [QUEUES.agentWake]: 'stately' };

// What `boss.createQueue(name, { policy })` sends to crove_jobs.create_queue.
export function queueOptions(queue: string): string {
  return JSON.stringify({ policy: QUEUE_POLICIES[queue as QueueName] ?? 'standard' });
}

// First line of every vendored migration.
const MARKER = /^-- pg-boss schema version: (\d+)$/m;
const PIN = 'SET search_path = pg_catalog, pg_temp';

let expected: number | null = null;

// The schema version the installed pg-boss release expects (its package.json `pgboss.schema`).
export function pgBossSchemaVersion(): number {
  if (expected !== null) return expected;
  const path = createRequire(import.meta.url).resolve('pg-boss/package.json');
  const pkg = JSON.parse(readFileSync(path, 'utf8')) as { pgboss?: { schema?: number } };
  const version = pkg.pgboss?.schema;
  if (!Number.isInteger(version)) throw new Error('pg-boss package.json has no pgboss.schema');
  expected = version as number;
  return expected;
}

// The highest pg-boss schema version any committed migration vendors, or null if none does.
export async function vendoredSchemaVersion(migrationsDir: string): Promise<number | null> {
  let highest: number | null = null;
  for (const name of (await readdir(migrationsDir)).filter((n) => n.endsWith('.sql'))) {
    const match = MARKER.exec(await readFile(join(migrationsDir, name), 'utf8'));
    if (match?.[1]) highest = Math.max(highest ?? 0, Number(match[1]));
  }
  return highest;
}

// pg-boss plans run as their own transaction under an advisory lock; the migration runner already applies each
// file in one transaction under its lock, so the wrapper goes. Every function pins search_path (AGENTS.md).
export function adaptPlans(plans: string): string {
  let body = plans
    .replace(/^\s*BEGIN;\s*$/m, '')
    .replace(/^\s*SET LOCAL (?:lock_timeout|idle_in_transaction_session_timeout) = \d+;\s*$/gm, '')
    .replace(/^\s*SELECT pg_advisory_xact_lock\(.*\);\s*$/m, '')
    .replace(/^\s*COMMIT;\s*$/m, '');
  if (/^\s*(?:BEGIN|COMMIT|ROLLBACK);/m.test(body)) throw new Error('pg-boss plans contain more than one transaction');
  const functions = body.match(/CREATE (?:OR REPLACE )?FUNCTION /g)?.length ?? 0;
  let pinned = 0;
  body = body.replace(/(\n\s*LANGUAGE (?:sql|plpgsql)\b[^;\n]*);/g, (_, head: string) => {
    pinned += 1;
    return `${head} ${PIN};`;
  });
  if (pinned !== functions) throw new Error(`pinned search_path on ${pinned} of ${functions} pg-boss functions`);
  if (body.includes('$pgboss$')) throw new Error('pg-boss plans contain the $pgboss$ quote tag');
  return body.trim();
}

const GRANTS = `-- The worker (pg-boss and the outbox relay) uses crove_jobs; nobody else may.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA ${JOB_SCHEMA} FROM PUBLIC;
GRANT USAGE ON SCHEMA ${JOB_SCHEMA} TO crove_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${JOB_SCHEMA} TO crove_worker;
-- The version row decides whether a vendored upgrade runs, so only migrations write it. pg-boss started with
-- migrate: false only stamps its maintenance columns.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ${JOB_SCHEMA}.version FROM crove_worker;
GRANT UPDATE (cron_on, bam_on, flow_on, reindex_on, monitor_backoff_on) ON ${JOB_SCHEMA}.version TO crove_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${JOB_SCHEMA} TO crove_worker;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${JOB_SCHEMA} TO crove_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA ${JOB_SCHEMA} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO crove_worker;`;

// Renders the migration that brings crove_jobs to `target`: pg-boss's construction plans on a fresh database
// (`from` null), else its migration plans from `from`. Re-applying it is a no-op; any other version stops it.
export function renderJobsMigration(target: number, from: number | null, queues: readonly string[]): string {
  const plans = from === null ? getConstructionPlans(JOB_SCHEMA) : getMigrationPlans(JOB_SCHEMA, from);
  // The schema holds exactly one version row; anything else stops the migration.
  const versions = `(SELECT array_agg(version) FROM ${JOB_SCHEMA}.version)`;
  const held = `(SELECT string_agg(version::text, ', ') FROM ${JOB_SCHEMA}.version)`;
  const found =
    from === null
      ? `IF ${versions} = ARRAY[${target}] THEN
      RETURN;
    END IF;
    RAISE EXCEPTION '${JOB_SCHEMA} holds pg-boss schema version %, this migration installs ${target}', ${held};`
      : `IF ${versions} = ARRAY[${target}] THEN
      RETURN;
    END IF;
    IF ${versions} IS DISTINCT FROM ARRAY[${from}] THEN
      RAISE EXCEPTION '${JOB_SCHEMA} holds pg-boss schema version %, this migration upgrades ${from} to ${target}', ${held};
    END IF;
    -- pg-boss's upgrade plans put queue.table_name into SQL as is, and the worker may write that column.
    IF EXISTS (SELECT 1 FROM ${JOB_SCHEMA}.queue WHERE table_name !~ '^(job_common|j[0-9a-f]{56})$') THEN
      RAISE EXCEPTION '${JOB_SCHEMA}.queue holds a table name pg-boss does not create';
    END IF;`;
  const missing = from === null ? `\n  ELSE\n    EXECUTE $pgboss$\n${adaptPlans(plans)}\n$pgboss$;` : '';
  const upgrade = from === null ? '' : `\n  EXECUTE $pgboss$\n${adaptPlans(plans)}\n$pgboss$;`;
  // One create_queue statement per set of options, so each queue gets the policy the worker expects.
  const byOptions = new Map<string, string[]>();
  for (const queue of queues) byOptions.set(queueOptions(queue), [...(byOptions.get(queueOptions(queue)) ?? []), `'${queue.replaceAll("'", "''")}'`]);
  const createQueues = [...byOptions]
    .map(([options, names]) => `SELECT ${JOB_SCHEMA}.create_queue(q, '${options}'::jsonb) FROM unnest(ARRAY[${names.join(', ')}]) AS q;`)
    .join('\n');
  return `-- pg-boss schema version: ${target}
-- Generated by \`pnpm db:vendor:pgboss\` from pg-boss ${from === null ? 'getConstructionPlans' : `getMigrationPlans (from ${from})`}('${JOB_SCHEMA}').
-- Do not edit: upgrade pg-boss, run the script again and commit the new migration it writes.
-- Changes to pg-boss's SQL: no BEGIN, COMMIT or advisory lock (the runner applies this file in one transaction
-- under its own lock), and every function pins search_path. Before #25 the migrate role let pg-boss create the
-- schema at runtime, so an existing database at version ${target} keeps its tables and only gets the pins.
DO $vendor$
BEGIN
  IF to_regclass('${JOB_SCHEMA}.version') IS NOT NULL THEN
    ${found}${missing}
  END IF;${upgrade}
END
$vendor$;

-- A schema pg-boss created at runtime (before #25) has functions without a pinned search_path. The migration role
-- created them then, so it owns them now.
DO $pin$
DECLARE
  fn regprocedure;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure FROM pg_catalog.pg_proc p
     WHERE p.pronamespace = '${JOB_SCHEMA}'::regnamespace
       AND p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']
  LOOP
    EXECUTE pg_catalog.format('ALTER FUNCTION %s ${PIN}', fn);
  END LOOP;
END
$pin$;
${from === null ? `
-- Queues the worker uses (QUEUES in apps/kernel/src/jobs-schema.ts); create_queue skips existing ones.
${createQueues}

-- /readyz (the API role) compares this with the version its pg-boss expects.
CREATE OR REPLACE FUNCTION crove_kernel.jobs_schema_version()
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER ${PIN} AS $$
  SELECT max(v.version) FROM ${JOB_SCHEMA}.version v
$$;
REVOKE ALL ON FUNCTION crove_kernel.jobs_schema_version() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_kernel.jobs_schema_version() TO crove_app;
` : ''}
${GRANTS}
`;
}
