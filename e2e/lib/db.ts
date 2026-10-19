// Reads the stack's database as the PostgreSQL superuser (no RLS), so assertions see exactly what was stored.
// Runs psql inside the compose `db` service; the database port is never published.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const COMPOSE_FILES = ['../../docker-compose.yml', '../compose.e2e.yml'].map((f) => fileURLToPath(new URL(f, import.meta.url)));
const DEFAULT_PROJECT = 'crove-e2e';
const DEFAULT_BASE_URL = 'http://localhost:8080';

// Scheme and host are case-insensitive (new URL lowercases them); the path is not, so only a bare origin matches.
function isDefaultBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === DEFAULT_BASE_URL && url.pathname === '/' && !url.search && !url.hash;
  } catch {
    return false;
  }
}

// The compose project whose database the helpers shell into. The browser's target (E2E_BASE_URL) and this project
// are separate variables, so a run against its own stack that set only E2E_BASE_URL would write to the shared
// `crove-e2e` database (#496). Fails closed: a non-default base URL needs an explicit project.
export function resolveComposeProject(env: Record<string, string | undefined> = process.env): string {
  const project = env.E2E_COMPOSE_PROJECT?.trim();
  if (project) return project;
  const baseUrl = env.E2E_BASE_URL?.trim();
  if (baseUrl && !isDefaultBaseUrl(baseUrl)) {
    throw new Error(
      `E2E_BASE_URL is ${baseUrl} but E2E_COMPOSE_PROJECT is not set: the database helpers would use the shared '${DEFAULT_PROJECT}' stack. Set E2E_COMPOSE_PROJECT to the compose project that serves ${baseUrl}.`,
    );
  }
  return DEFAULT_PROJECT;
}

function psql(script: string, vars: Record<string, string>): string {
  const args = ['compose', '-p', resolveComposeProject(), ...COMPOSE_FILES.flatMap((f) => ['-f', f]), 'exec', '-T', 'db', 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-t', '-A'];
  args.push('-v', 'ON_ERROR_STOP=1');
  for (const [name, value] of Object.entries(vars)) args.push('-v', `${name}=${value}`);
  return execFileSync('docker', args, { input: script, encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'] });
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
