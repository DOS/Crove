// Reads the stack's database as the PostgreSQL superuser (no RLS), so assertions see exactly what was stored.
// Runs psql inside the compose `db` service; the database port is never published.
import { compose } from './compose.ts';

function psql(script: string, vars: Record<string, string>): string {
  const args = ['exec', '-T', 'db', 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1'];
  for (const [name, value] of Object.entries(vars)) args.push('-v', `${name}=${value}`);
  return compose(args, script);
}

// `query` uses psql variables (:'name') for every value in `vars`. Returns the rows as JSON objects.
export function sql<T>(query: string, vars: Record<string, string> = {}): T[] {
  const out = psql(`SELECT coalesce(json_agg(row_to_json(q)), '[]'::json) FROM (${query}) q;
`, vars);
  return JSON.parse(out.trim()) as T[];
}

// Runs one statement that returns no rows (an UPDATE that moves a test's clock forward), with the same variables.
export function exec(statement: string, vars: Record<string, string> = {}): void {
  psql(`${statement};
`, vars);
}
