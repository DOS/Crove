import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { createTanstackQueryUtils } from '@orpc/tanstack-query';
import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { MAX_UPLOAD_BYTES, ORG_HEADER, type contract } from '@crove/kernel-contract';
import { translator } from '../i18n/runtime.ts';
import { accessToken, auth, getConfig } from './auth.ts';
import { apiErrorFromResponse, isMfaRequired, isUnauthenticated, retryWhileBusy } from './errors.ts';

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

// A stored file's bytes. With presigned transfers the kernel hands out a short-lived URL for the exact version it
// recorded (after the same authorization), fetched without Crove's headers; otherwise the kernel streams it.
export async function fetchFile(fileId: string): Promise<Blob> {
  if (getConfig().uploads === 'presigned') {
    const { url } = (await (await apiFetch(`/api/files/${fileId}?link=1`)).json()) as { url: string | null };
    if (url) {
      const response = await fetch(url, { credentials: 'omit' }).catch(() => null);
      if (!response?.ok) throw new Error(translator()('inbox.storageDownloadFailed'));
      return response.blob();
    }
  }
  return (await apiFetch(`/api/files/${fileId}`)).blob();
}

type Uploaded = { fileId: string; duplicate: boolean };

// One file through a presigned staging upload (plan §7.6): a single-use form from the kernel, the bytes straight to
// the bucket, then the kernel reads them back, hashes them and records the file.
async function uploadStaged(file: File): Promise<Uploaded> {
  if (file.size > MAX_UPLOAD_BYTES) throw new Error(translator()('inbox.fileTooLarge', { name: file.name }));
  const grant = (await (await apiFetch('/api/files/uploads', { method: 'POST' })).json()) as {
    uploadId: string;
    url: string;
    fields: Record<string, string>;
  };
  const form = new FormData();
  for (const [name, value] of Object.entries(grant.fields)) form.append(name, value);
  // The file goes last: S3 ignores fields after it.
  form.append('file', file);
  // No credentials or Crove headers: the form's signature is the only authorization the bucket sees.
  const stored = await fetch(grant.url, { method: 'POST', body: form, credentials: 'omit' }).catch(() => null);
  if (!stored?.ok) throw new Error(translator()('inbox.storageUploadFailed', { name: file.name }));
  // A busy kernel refuses the completion without using the grant, so the same completion is retried.
  const response = await retryWhileBusy(() =>
    apiFetch(`/api/files/uploads/${grant.uploadId}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: file.name }),
    }),
  );
  return (await response.json()) as Uploaded;
}

export async function uploadFiles(files: File[]): Promise<{ files: Uploaded[] }> {
  if (getConfig().uploads === 'presigned') {
    const results: Uploaded[] = [];
    for (const file of files) results.push(await uploadStaged(file));
    return { files: results };
  }
  const form = new FormData();
  for (const file of files) form.append('file', file);
  const response = await apiFetch('/api/files', { method: 'POST', body: form });
  return (await response.json()) as { files: Uploaded[] };
}
