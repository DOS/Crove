// Runs `docker compose` against the e2e stack with the same project and files as `stack:up`.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const FILES = ['../../docker-compose.yml', '../compose.e2e.yml'].map((f) => fileURLToPath(new URL(f, import.meta.url)));
const PROJECT = process.env.E2E_COMPOSE_PROJECT ?? 'crove-e2e';

// Returns stdout; stderr goes to the test output.
export function compose(args: string[], input?: string): string {
  return execFileSync('docker', ['compose', '-p', PROJECT, ...FILES.flatMap((f) => ['-f', f]), ...args], {
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'inherit'],
  });
}
