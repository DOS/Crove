import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConstructionPlans } from 'pg-boss';
import { describe, expect, it } from 'vitest';
import { AVAILABLE_MODULES } from '../src/config.ts';
import { MAIL_QUEUES, QUEUES, SOCIAL_PUBLISH_QUEUES, adaptPlans, pgBossSchemaVersion, queueOptions, renderJobsMigration, vendoredSchemaVersion } from '../src/jobs-schema.ts';

const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));

describe('vendored pg-boss schema (External-tenant gate T6)', () => {
  it('matches the schema version the pinned pg-boss expects', async () => {
    // A pg-boss upgrade that changes the schema fails here until `pnpm db:vendor:pgboss` adds its migration.
    expect(await vendoredSchemaVersion(MIGRATIONS)).toBe(pgBossSchemaVersion());
  });

  it('drops the transaction wrapper and pins search_path on every function', () => {
    const body = adaptPlans(getConstructionPlans('crove_jobs'));
    expect(body).not.toMatch(/^\s*(BEGIN|COMMIT);/m);
    expect(body).not.toContain('pg_advisory_xact_lock');
    const functions = body.match(/CREATE (?:OR REPLACE )?FUNCTION /g)?.length ?? 0;
    expect(functions).toBeGreaterThan(0);
    expect(body.match(/SET search_path = pg_catalog, pg_temp;/g)?.length).toBe(functions);
  });

  it('creates every queue with the policy the worker expects', () => {
    const sql = renderJobsMigration(pgBossSchemaVersion(), null, Object.values(QUEUES));
    const created = [...sql.matchAll(/create_queue\(q, '(\{[^']*\})'::jsonb\) FROM unnest\(ARRAY\[([^\]]*)\]\)/g)].flatMap(([, options, names]) =>
      (names ?? '').split(', ').map((name) => [name.slice(1, -1), JSON.parse(options ?? '{}').policy as string]),
    );
    expect(Object.fromEntries(created)).toEqual(
      Object.fromEntries(Object.values(QUEUES).map((name) => [name, name === QUEUES.agentWake ? 'stately' : 'standard'])),
    );
    expect(queueOptions(QUEUES.agentWake)).toBe('{"policy":"stately","deadLetter":"kernel-job.dlq"}');
    expect(queueOptions(QUEUES.extract)).toBe('{"policy":"standard","deadLetter":"kernel-job.dlq"}');
  });

  it('sends every queue but the dead letter queue to it, and creates the dead letter queue first (#1780)', () => {
    const sql = renderJobsMigration(pgBossSchemaVersion(), null, Object.values(QUEUES));
    const created = [...sql.matchAll(/create_queue\(q, '(\{[^']*\})'::jsonb\) FROM unnest\(ARRAY\[([^\]]*)\]\)/g)].map(([, options, names]) => ({
      options: JSON.parse(options ?? '{}') as Record<string, unknown>,
      names: (names ?? '').split(', ').map((name) => name.slice(1, -1)),
    }));
    // The dead letter queue as 20261103150000 created it, in the first statement and alone there.
    expect(created[0]).toEqual({ options: { policy: 'standard', retryLimit: 5, retryDelay: 30, retryBackoff: true }, names: [QUEUES.deadLetter] });
    for (const { options, names } of created.slice(1)) expect(options.deadLetter, names.join(', ')).toBe(QUEUES.deadLetter);
    expect(created.flatMap((c) => c.names).sort()).toEqual(Object.values(QUEUES).sort());
  });

  // crove_kernel.health() takes a queue's module from its name up to the first '-' (#1877).
  it('names every queue after the module that works it', () => {
    for (const queue of [...Object.values(QUEUES), ...SOCIAL_PUBLISH_QUEUES, ...MAIL_QUEUES]) {
      expect(AVAILABLE_MODULES as readonly string[], queue).toContain(queue.split('-')[0]);
    }
    // health() lists the optional modules, whose queues alone can drop out of its job age: every module but kernel.
    const sql = readFileSync(join(MIGRATIONS, '20261105170000_crove_kernel_health_retained_modules.sql'), 'utf8');
    const listed = /<> ALL \(ARRAY\[([^\]]*)\]\)/.exec(sql)?.[1]?.split(',').map((m) => m.trim().replaceAll("'", ''));
    expect(listed?.sort()).toEqual(AVAILABLE_MODULES.filter((m) => m !== 'kernel').sort());
  });

  it('renders an upgrade that refuses any starting version but its own', () => {
    const target = pgBossSchemaVersion();
    const sql = renderJobsMigration(target, target - 1, Object.values(QUEUES));
    expect(sql.split('\n')[0]).toBe(`-- pg-boss schema version: ${target}`);
    expect(sql).toContain(`IS DISTINCT FROM ARRAY[${target - 1}]`);
    expect(sql).toContain(`upgrades ${target - 1} to ${target}`);
    // pg-boss's upgrade plans read queue.table_name into SQL; the worker can write it.
    expect(sql).toContain("table_name !~ '^(job_common|j[0-9a-f]{56})$'");
    expect(sql).not.toMatch(/^\s*(BEGIN|COMMIT);/m);
  });
});
