// Errors the SPA reads from the kernel. The RPC path throws oRPC errors that carry `code` and `status`; the plain
// fetch paths (upload, download, export) throw ApiError with the same fields, so the same checks recognise both
// (issue #180): MFA_REQUIRED opens the MFA challenge instead of a sign-out, a dead session signs the user out.
import type { Translate } from '../i18n/runtime.ts';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

// The kernel answers non-RPC errors as JSON `{ code, message }`. A body that is not JSON, or lacks a field, still
// gives an ApiError with the HTTP status, so the checks below never depend on the body.
export async function apiErrorFromResponse(response: Response, t: Translate): Promise<ApiError> {
  const body = (await response.json().catch(() => null)) as { code?: unknown; message?: unknown } | null;
  const code = typeof body?.code === 'string' && body.code ? body.code : `HTTP_${response.status}`;
  const message = typeof body?.message === 'string' && body.message ? body.message : t('common.httpError', { status: response.status });
  return new ApiError(code, response.status, message);
}

// The session is valid but has not passed the user's second factor yet (issue #126): the kernel refuses every
// call until it has. Not a sign-out: the server's message tells the user to enter their MFA code, and the MFA
// challenge screen (issue #32) takes over once it ships.
export function isMfaRequired(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'MFA_REQUIRED';
}

export function isUnauthenticated(error: unknown): boolean {
  const e = error as { status?: number; code?: string } | null;
  if (isMfaRequired(error)) return false;
  return e?.status === 401 || e?.code === 'UNAUTHORIZED' || e?.code === 'UNAUTHENTICATED';
}

// The kernel completes a few staged uploads at a time and answers 503 UPLOAD_BUSY past that (issue #223), leaving the
// upload's grant unused for its 5 minutes. Retries fn after each delay while it is refused that way; any other error,
// or the last refusal, is thrown.
export const UPLOAD_BUSY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];

export async function retryWhileBusy<T>(
  fn: () => Promise<T>,
  delaysMs: readonly number[] = UPLOAD_BUSY_DELAYS_MS,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const delay = delaysMs[attempt];
      if ((error as { code?: string } | null)?.code !== 'UPLOAD_BUSY' || delay === undefined) throw error;
      await sleep(delay);
    }
  }
}
