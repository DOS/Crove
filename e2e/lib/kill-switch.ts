// The operator's deployment-wide kill switch (tools/ops/kill-switch.mjs, #886, #1696) on the e2e stack: the script's
// own argument checks and SQL (parseArgs, runSwitch), run as the database owner through psql in the compose `db`
// service, since the stack publishes no database port. Used by the rehearsal, e2e/tests/kill-switches.spec.ts.
import { parseArgs, runSwitch, type SwitchStatus } from '../../tools/ops/kill-switch.mjs';
import { sql } from './db.ts';

export const REHEARSAL_BY = 'e2e kill-switch rehearsal';

// runSwitch's client: each $n becomes a psql variable (an array as its text form), or NULL for null.
const psqlClient = {
  query(text: string, values: unknown[]): Promise<{ rows: unknown[] }> {
    const vars: Record<string, string> = {};
    const query = text.replace(/\$(\d+)/g, (_, n: string) => {
      const value = values[Number(n) - 1];
      if (value === null || value === undefined) return 'NULL';
      vars[`p${n}`] = Array.isArray(value) ? `{${value.map(String).join(',')}}` : String(value);
      return `:'p${n}'`;
    });
    return Promise.resolve({ rows: sql(query, vars) });
  },
};

// The same arguments as `pnpm ops:kill-switch <key> on --reason <reason> --by <by>`; returns every switch's status.
export function engage(key: string, reason: string, by = REHEARSAL_BY): Promise<SwitchStatus[]> {
  return runSwitch(psqlClient, parseArgs([key, 'on', '--reason', reason, '--by', by]));
}

export function release(key: string, by = REHEARSAL_BY): Promise<SwitchStatus[]> {
  return runSwitch(psqlClient, parseArgs([key, 'off', '--by', by]));
}

export function status(): Promise<SwitchStatus[]> {
  return runSwitch(psqlClient, parseArgs(['status']));
}

// Releases every engaged deployment switch ('ai', 'mail' and each relay key), so the shared stack is never left
// stopped, whatever a test did before it failed. Returns the keys it released.
export async function releaseAll(): Promise<string[]> {
  const engaged = (await status()).filter((s) => s.engaged).map((s) => s.key);
  for (const key of engaged) await release(key);
  return engaged;
}
