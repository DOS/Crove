import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { createTanstackQueryUtils } from '@orpc/tanstack-query';
import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { MAX_UPLOAD_BYTES, type contract } from '@crove/kernel-contract';
import { activeLocale, translator } from '../i18n/runtime.ts';
import { accessToken, auth, getConfig } from './auth.ts';
import { ClientError, apiErrorFromResponse, describeError, isMfaRequired, isOrgAccessRevoked, isUnauthenticated, retryWhileBusy } from './errors.ts';
import { createSessionErrorHandler, rememberOrgLeft, requestHeaders, takeOrgLeft } from './org-access.ts';

let currentOrg: string | null = null;

export function setCurrentOrg(slug: string | null): void {
  currentOrg = slug;
}

export function getCurrentOrg(): string | null {
  return currentOrg;
}

async function headers(): Promise<Record<string, string>> {
  return requestHeaders(await accessToken(), currentOrg);
}

const link = new RPCLink({ url: `${window.location.origin}/api/rpc`, headers });

export const client: ContractRouterClient<typeof contract> = createORPCClient(link);
export const orpc = createTanstackQueryUtils(client);

// The same API without the org header, whatever page this is: the user's own sign-out revoke (issue #247).
const orglessLink = new RPCLink({ url: `${window.location.origin}/api/rpc`, headers: async () => requestHeaders(await accessToken(), null) });
export const orglessClient: ContractRouterClient<typeof contract> = createORPCClient(orglessLink);

export { ApiError, ClientError, isMfaRequired, isOrgAccessRevoked, isUnauthenticated } from './errors.ts';

function sessionStore(): Storage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

// A stale or revoked session signs the user out locally; main.tsx then routes to /login. A session revoked in this
// org only leaves the org: the start page then lists only the orgs this session can enter (issue #247).
const onError = createSessionErrorHandler({
  currentOrg: getCurrentOrg,
  leaveOrg: (slug) => {
    const me = queryClient.getQueryData<{ orgs: Array<{ slug: string; name: string }> }>(orpc.me.get.queryKey());
    rememberOrgLeft(sessionStore(), { name: me?.orgs.find((o) => o.slug === slug)?.name ?? slug });
    setCurrentOrg(null);
    queryClient.clear();
    window.location.assign('/');
  },
  signOut: () => void auth().signOut({ scope: 'local' }),
});

export const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError }),
  mutationCache: new MutationCache({ onError }),
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      refetchOnWindowFocus: true,
      retry: (count, error) => !isUnauthenticated(error) && !isMfaRequired(error) && !isOrgAccessRevoked(error) && count < 1,
    },
  },
});

// An error in words, in the active locale. Call it while rendering, never when the error is caught, so the text
// follows a language switch (the components that show it re-render through I18nProvider).
export function errorMessage(error: unknown): string {
  return describeError(error, translator(), activeLocale());
}

// Authenticated fetch for non-RPC endpoints (files, export). A refusal throws ApiError with the kernel's code and
// the HTTP status, like the RPC path, so MFA_REQUIRED and a dead session are recognised here too.
export function takeOrgLeftNotice() {
  return takeOrgLeft(sessionStore());
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(path, { ...init, headers: { ...(await headers()), ...(init.headers as Record<string, string> | undefined) } });
  if (!response.ok) throw await apiErrorFromResponse(response);
  return response;
}

// A one-time ticket for the invalidation stream of `slug` (issue #69): EventSource cannot send the Authorization
// header, so the stream opens with this ticket, valid for seconds and bound to this session and org.
export async function fetchStreamTicket(slug: string): Promise<string> {
  const response = await fetch('/api/stream/tickets', { method: 'POST', headers: requestHeaders(await accessToken(), slug) });
  if (!response.ok) throw await apiErrorFromResponse(response);
  return ((await response.json()) as { ticket: string }).ticket;
}

// A stored file's bytes. With presigned transfers the kernel hands out a short-lived URL for the exact version it
// recorded (after the same authorization), fetched without Crove's headers; otherwise the kernel streams it.
export async function fetchFile(fileId: string): Promise<Blob> {
  if (getConfig().uploads === 'presigned') {
    const { url } = (await (await apiFetch(`/api/files/${fileId}?link=1`)).json()) as { url: string | null };
    if (url) {
      const response = await fetch(url, { credentials: 'omit' }).catch(() => null);
      if (!response?.ok) throw new ClientError('inbox.storageDownloadFailed', (t) => t('inbox.storageDownloadFailed'));
      return response.blob();
    }
  }
  return (await apiFetch(`/api/files/${fileId}`)).blob();
}

type Uploaded = { fileId: string; duplicate: boolean };

// One file through a presigned staging upload (plan §7.6): a single-use form from the kernel, the bytes straight to
// the bucket, then the kernel reads them back, hashes them and records the file.
async function uploadStaged(file: File): Promise<Uploaded> {
  if (file.size > MAX_UPLOAD_BYTES) throw new ClientError('inbox.fileTooLarge', (t) => t('inbox.fileTooLarge', { name: file.name }));
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
  if (!stored?.ok) throw new ClientError('inbox.storageUploadFailed', (t) => t('inbox.storageUploadFailed', { name: file.name }));
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
