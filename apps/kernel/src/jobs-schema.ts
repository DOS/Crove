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

// Created by the migration that vendors the schema. A new queue, or a new policy, needs a new migration; a new queue
// names QUEUES.deadLetter as its dead letter queue there ('{"policy":"standard","deadLetter":"kernel-job.dlq"}', #1720).
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
  // Created by the period balance migration (20261101160000).
  periodBalanceVerify: 'finance-period-balance-verify',
  // Created by the notes core migration (20261103130000).
  notesMemberPurge: 'notes-member-purge',
  notesTrash: 'notes-trash',
  // Created by the notes reminders migration (20261103210000).
  notesRemind: 'notes-reminders',
  // Created by the bank feed sync migration (20261108100000): a bank feed connection's sync (ADR-0039, #2044).
  bankFeedSync: 'finance-bank-feed-sync',
  // Created by the calendar write-back queue migration (20261112090000): a booking's event made to match the member's connected calendar (#2124).
  calendarWriteback: 'kernel-calendar-writeback',
  // Created by the dead letter migration (20261103150000): every other queue's dead letters (#1720, dead-letter.ts).
  deadLetter: 'kernel-job.dlq',
} as const;
type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

// One publish queue per channel provider (Social plan §3.6), so each provider gets its own concurrency; only providers
// a deployment can publish to are worked. 'stately' with the singleton key <org>:<queue>:<variant> (job-keys.ts): one
// queued and one active job per variant; a job active longer than 300 seconds is retried (its begin then finds the
// variant in flight and waits until it is stale). Created by the Social publish migration (20261019040000).
export const socialPublishQueue = (provider: string) => `social-publish-${provider}`;
export const SOCIAL_PUBLISH_QUEUES: readonly string[] = CHANNEL_PROVIDERS.map(socialPublishQueue);

// Queued mail (Email plan §3.2, #548): system and transactional mail at once, marketing throttled. 'stately' with the
// singleton key <org>:<queue>:<mail> (job-keys.ts), so a sweep never queues a mail twice. Created by the mail queue
// migration (20261022050000).
export const MAIL_QUEUES: readonly string[] = ['kernel-mail-send', 'kernel-mail-bulk'];

// What a queue's jobs reach over the network (plan §4.6 `defineJob`, §7.7, #1653):
// - 'none': only services of the stack itself, which `docker compose up` runs beside the worker: the database, the blob
//   store, crove-extract and Supabase Auth. They are infrastructure the operator configures, holding the deployment's
//   own data, and no tenant can point them elsewhere.
// - 'provider:<x>': a service outside the deployment through its adapter, which keeps to that service's own hosts: the
//   AI endpoint of packages/agent ('provider:ai', where document content leaves the deployment), the channel adapters
//   of @crove/channel, the mail provider, the chat platforms of team alerts.
// - 'tenant_url': a URL a tenant or a browser supplied, only through the egress guard of @crove/kernel-runtime
//   (guardedFetch, guardedRequest, egressFetch).
// A queue that reaches several lists each. apps/kernel/test/invariant/job-egress.test.ts checks each declaration against what
// the queue's worker handler reaches, and that a command whose events feed a queue with egress declares an external
// effect (R2, plan §4.7 "Derived risk").
export type EgressTarget = 'tenant_url' | `provider:${string}`;
export type JobEgress = 'none' | readonly [EgressTarget, ...EgressTarget[]];

// The channel adapters reach the platforms; the tenant names the host of a Bluesky PDS, a Mastodon instance or a
// WordPress site, which they reach through the egress guard the kernel hands them (channelPublishers in kernel.ts).
const CHANNELS: JobEgress = ['provider:channel', 'tenant_url'];

// Every queue in QUEUES; a queue without a declaration fails typecheck.
const QUEUE_EGRESS: { readonly [Q in QueueName]: JobEgress } = {
  // The invoice reader sends the document's text or image to the AI endpoint.
  [QUEUES.extract]: ['provider:ai'],
  [QUEUES.inbound]: 'none',
  [QUEUES.signOut]: 'none',
  [QUEUES.orgExport]: 'none',
  [QUEUES.retention]: 'none',
  [QUEUES.agentDispatch]: 'none',
  [QUEUES.agentWake]: 'none',
  [QUEUES.agentSweep]: 'none',
  [QUEUES.agentProposal]: 'none',
  [QUEUES.portalList]: 'none',
  [QUEUES.mailEvent]: 'none',
  [QUEUES.socialLinkPreview]: ['tenant_url'],
  [QUEUES.socialChannelOption]: CHANNELS,
  [QUEUES.socialNotify]: 'none',
  [QUEUES.socialRemove]: CHANNELS,
  [QUEUES.socialEdit]: CHANNELS,
  // A browser's push service endpoint, through guardedRequest (web-push.ts).
  [QUEUES.socialPush]: ['tenant_url'],
  [QUEUES.socialChatAlert]: ['provider:telegram', 'provider:discord'],
  [QUEUES.archiveWrite]: 'none',
  [QUEUES.archiveVerify]: 'none',
  [QUEUES.notify]: 'none',
  [QUEUES.yearArchive]: 'none',
  [QUEUES.crmBooking]: 'none',
  [QUEUES.crmBookingRemind]: 'none',
  [QUEUES.periodBalanceVerify]: 'none',
  [QUEUES.notesMemberPurge]: 'none',
  [QUEUES.notesTrash]: 'none',
  [QUEUES.notesRemind]: 'none',
  // The bank feed adapters (channels.bankFeeds): the offline sandbox reaches nothing. A real adapter (#2045) adds its
  // provider here, and to DEPS_REACH first.
  [QUEUES.bankFeedSync]: 'none',
  // The calendar adapters (channels.calendars): the provider's events are written through them.
  [QUEUES.calendarWriteback]: ['provider:channel'],
  [QUEUES.deadLetter]: 'none',
};

// The channel providers whose host the tenant names: their adapters get the egress guard (channelPublishers).
export const TENANT_HOSTED_PROVIDERS: readonly string[] = ['bluesky', 'mastodon', 'wordpress'];

// The egress a queue declares; a queue nobody declared throws.
export function queueEgress(queue: string): JobEgress {
  if (Object.hasOwn(QUEUE_EGRESS, queue)) return QUEUE_EGRESS[queue as QueueName];
  const provider = CHANNEL_PROVIDERS.find((p) => socialPublishQueue(p) === queue);
  if (provider) return TENANT_HOSTED_PROVIDERS.includes(provider) ? [`provider:${provider}`, 'tenant_url'] : [`provider:${provider}`];
  if (MAIL_QUEUES.includes(queue)) return ['provider:mail'];
  throw new Error(`queue ${queue} declares no egress (QUEUE_EGRESS in apps/kernel/src/jobs-schema.ts)`);
}

// The pg-boss policy of each queue that is not 'standard'. kernel-agent-wake is 'stately' with the singleton key
// <org>:<queue>:<agent> (job-keys.ts): at most one queued and one active job per agent, so wake-ups coalesce and an
// agent runs once at a time (ADR-0029 section 5; the database also allows one running ai_run per agent).
const QUEUE_POLICIES: Partial<Record<QueueName, 'stately'>> = { [QUEUES.agentWake]: 'stately' };

// The dead letter queue's own options, as 20261103150000_crove_jobs_dead_letter.sql created it: a few retries, in case
// the database or the command is briefly unavailable.
const DEAD_LETTER_OPTIONS = { policy: 'standard', retryLimit: 5, retryDelay: 30, retryBackoff: true } as const;

// What `boss.createQueue(name, options)` sends to crove_jobs.create_queue: the queue's policy, and every queue but the
// dead letter queue sends its dead letters there (#1720, #1780).
export function queueOptions(queue: string): string {
  if (queue === QUEUES.deadLetter) return JSON.stringify(DEAD_LETTER_OPTIONS);
  return JSON.stringify({ policy: QUEUE_POLICIES[queue as QueueName] ?? 'standard', deadLetter: QUEUES.deadLetter });
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
  // One create_queue statement per set of options, so each queue gets the policy the worker expects. The dead letter
  // queue comes first: the others name it, and queue.dead_letter references a queue that exists.
  const byOptions = new Map<string, string[]>();
  const ordered = [...queues].sort((a, b) => Number(b === QUEUES.deadLetter) - Number(a === QUEUES.deadLetter));
  for (const queue of ordered) byOptions.set(queueOptions(queue), [...(byOptions.get(queueOptions(queue)) ?? []), `'${queue.replaceAll("'", "''")}'`]);
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
