// Maps a failed AI call to what the caller should do about it. The endpoint is any OpenAI-compatible server,
// so only the HTTP status is trusted: 401/403 is a configuration problem, 429 and 5xx are worth a retry, and
// any other 4xx means the request itself is wrong and will fail again. The AI SDK retries 429/5xx on its own
// and then throws a RetryError; the last attempt's error decides.
import { APICallError, NoObjectGeneratedError, RetryError } from 'ai';

export type AiErrorKind = 'auth' | 'rate_limit' | 'unavailable' | 'invalid_request' | 'timeout' | 'network' | 'unknown';

export interface AiErrorInfo {
  kind: AiErrorKind;
  retryable: boolean;
  status: number | null;
  // From Retry-After / retry-after-ms on a 429, when the endpoint sends one.
  retryAfterMs: number | null;
}

function info(kind: AiErrorKind, retryable: boolean, status: number | null, retryAfterMs: number | null = null): AiErrorInfo {
  return { kind, retryable, status, retryAfterMs };
}

function retryAfter(headers: Record<string, string> | undefined): number | null {
  const ms = Number.parseFloat(headers?.['retry-after-ms'] ?? '');
  if (Number.isFinite(ms) && ms >= 0) return ms;
  const seconds = Number.parseFloat(headers?.['retry-after'] ?? '');
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

export function classifyAiError(error: unknown): AiErrorInfo {
  const last = RetryError.isInstance(error) ? error.lastError : error;
  if (APICallError.isInstance(last)) {
    const status = last.statusCode ?? null;
    // No status: the request never got an HTTP answer (DNS, refused connection, reset).
    if (status === null) return info('network', true, null);
    if (status === 401 || status === 403) return info('auth', false, status);
    if (status === 429) return info('rate_limit', true, status, retryAfter(last.responseHeaders));
    if (status === 408) return info('timeout', true, status);
    // 501: the endpoint does not implement what was asked (tools, response_format); a retry cannot help.
    if (status === 501) return info('invalid_request', false, status);
    if (status >= 500) return info('unavailable', true, status);
    if (status >= 400) return info('invalid_request', false, status);
    return info('unknown', false, status);
  }
  if (last instanceof Error && last.name === 'TimeoutError') return info('timeout', true, null);
  return info('unknown', false, null);
}

// Whether a reading that failed every attempt failed because of the document rather than the service (#1998): the
// endpoint refused the request itself (a 4xx other than 401, 403, 408 and 429: an image over its size limit, text over
// the model's context) or the model's answer never fit the invoice schema. The prober pages only for the service
// (auth, rate limit, an endpoint down, network, timeout, and every error that is not the AI's).
export function aiDocumentFailure(error: unknown): boolean {
  const last = RetryError.isInstance(error) ? error.lastError : error;
  return NoObjectGeneratedError.isInstance(last) || classifyAiError(error).kind === 'invalid_request';
}
