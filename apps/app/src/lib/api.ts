import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { createTanstackQueryUtils } from '@orpc/tanstack-query';
import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { ORG_HEADER, type contract } from '@crove/kernel-contract';
import { translator } from '../i18n/runtime.ts';
import { accessToken, auth } from './auth.ts';
import { apiErrorFromResponse, isMfaRequired, isUnauthenticated } from './errors.ts';

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

export { ApiError, isMfaRequired, isUnauthenticated } from './errors.ts';

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
  return translator()('common.error');
}

// Authenticated fetch for non-RPC endpoints (files, export). A refusal throws ApiError with the kernel's code and
// the HTTP status, like the RPC path, so MFA_REQUIRED and a dead session are recognised here too.
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(path, { ...init, headers: { ...(await headers()), ...(init.headers as Record<string, string> | undefined) } });
  if (!response.ok) throw await apiErrorFromResponse(response, translator());
  return response;
}

export async function uploadFiles(files: File[]): Promise<{ files: Array<{ fileId: string; duplicate: boolean }> }> {
  const form = new FormData();
  for (const file of files) form.append('file', file);
  const response = await apiFetch('/api/files', { method: 'POST', body: form });
  return (await response.json()) as { files: Array<{ fileId: string; duplicate: boolean }> };
}
