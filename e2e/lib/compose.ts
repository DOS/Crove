// Runs `docker compose` against the e2e stack with the same project and files as `stack:up`.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const FILES = ['../../docker-compose.yml', '../compose.e2e.yml'].map((f) => fileURLToPath(new URL(f, import.meta.url)));
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

// The compose project the helpers act on. The browser's target (E2E_BASE_URL) and this project are separate
// variables, so a run against its own stack that set only E2E_BASE_URL would act on the shared `crove-e2e` stack
// (#496). Fails closed: a non-default base URL needs an explicit project.
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

// Returns stdout; stderr goes to the test output.
export function compose(args: string[], input?: string): string {
  return execFileSync('docker', ['compose', '-p', resolveComposeProject(), ...FILES.flatMap((f) => ['-f', f]), ...args], {
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'inherit'],
  });
}
