// Waits until the stack is ready: every migration applied (/readyz) and Supabase Auth answering through the proxy.
import type { FullConfig } from '@playwright/test';

const TIMEOUT_MS = 180_000;

async function ok(url: string): Promise<boolean> {
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) }).catch(() => null);
  return response?.ok ?? false;
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL ?? 'http://localhost:8080';
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if ((await ok(`${baseURL}/readyz`)) && (await ok(`${baseURL}/auth/v1/health`))) return;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`Crove at ${baseURL} is not ready after ${TIMEOUT_MS / 1000} s; start it with: pnpm --filter @crove/e2e stack:up`);
}
