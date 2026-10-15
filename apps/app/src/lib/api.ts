import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { createTanstackQueryUtils } from '@orpc/tanstack-query';
import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { ORG_HEADER, type contract } from '@crove/kernel-contract';
import { accessToken, auth } from './auth.ts';

let currentOrg: string | null = null;

export function setCurrentOrg(slug: string | null): void {
  currentOrg = slug;
}

export function getCurrentOrg(): string | null {
  return currentOrg;
}

async function headers(): Promise<Record<string, string>> {
  const token = await accessToken();
  return {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(currentOrg ? { [ORG_HEADER]: currentOrg } : {}),
  };
}

const link = new RPCLink({ url: `${window.location.origin}/api/rpc`, headers });

export const client: ContractRouterClient<typeof contract> = createORPCClient(link);
export const orpc = createTanstackQueryUtils(client);

// The session is valid but has not passed the user's second factor yet (issue #126): the kernel refuses every
// call until it has. Not a sign-out: the server's message tells the user to enter their MFA code.
export function isMfaRequired(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'MFA_REQUIRED';
}

export function isUnauthenticated(error: unknown): boolean {
  const e = error as { status?: number; code?: string } | null;
  if (isMfaRequired(error)) return false;
  return e?.status === 401 || e?.code === 'UNAUTHORIZED' || e?.code === 'UNAUTHENTICATED';
}

// A stale or revoked session signs the user out locally; main.tsx then routes to /login.
function onError(error: unknown): void {
  if (isUnauthenticated(error)) void auth().signOut({ scope: 'local' });
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError }),
  mutationCache: new MutationCache({ onError }),
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      refetchOnWindowFocus: true,
      retry: (count, error) => !isUnauthenticated(error) && !isMfaRequired(error) && count < 1,
    },
  },
});

export function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message;
  return 'Đã có lỗi xảy ra';
}

// Authenticated fetch for non-RPC endpoints (files, export).
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(path, { ...init, headers: { ...(await headers()), ...(init.headers as Record<string, string> | undefined) } });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? `Lỗi ${response.status}`);
  }
  return response;
}

export async function uploadFiles(files: File[]): Promise<{ files: Array<{ fileId: string; duplicate: boolean }> }> {
  const form = new FormData();
  for (const file of files) form.append('file', file);
  const response = await apiFetch('/api/files', { method: 'POST', body: form });
  return (await response.json()) as { files: Array<{ fileId: string; duplicate: boolean }> };
}
