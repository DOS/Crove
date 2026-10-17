// Reads the stack's database as the PostgreSQL superuser (no RLS), so assertions see exactly what was stored.
// Runs psql inside the compose `db` service; the database port is never published.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const COMPOSE_FILES = ['../../docker-compose.yml', '../compose.e2e.yml'].map((f) => fileURLToPath(new URL(f, import.meta.url)));
const PROJECT = process.env.E2E_COMPOSE_PROJECT ?? 'crove-e2e';

// `query` uses psql variables (:'name') for every value in `vars`. Returns the rows as JSON objects.
export function sql<T>(query: string, vars: Record<string, string> = {}): T[] {
  const args = ['compose', '-p', PROJECT, ...COMPOSE_FILES.flatMap((f) => ['-f', f]), 'exec', '-T', 'db', 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-t', '-A'];
  args.push('-v', 'ON_ERROR_STOP=1');
  for (const [name, value] of Object.entries(vars)) args.push('-v', `${name}=${value}`);
  const script = `SELECT coalesce(json_agg(row_to_json(q)), '[]'::json) FROM (${query}) q;\n`;
  const out = execFileSync('docker', args, { input: script, encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'] });
  return JSON.parse(out.trim()) as T[];
}
