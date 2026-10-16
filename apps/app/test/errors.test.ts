// Typed errors on the SPA's plain fetch paths (issue #180): upload, download and export failures carry the kernel's
// code and the HTTP status like RPC errors, so MFA_REQUIRED and a dead session are recognised there too.
import { describe, expect, it } from 'vitest';
import { translatorFor } from '../src/i18n/runtime.ts';
import { ApiError, apiErrorFromResponse, isMfaRequired, isUnauthenticated, retryWhileBusy } from '../src/lib/errors.ts';

const vi = translatorFor('vi');

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('apiErrorFromResponse', () => {
  it('keeps the kernel code, status and message', async () => {
    const error = await apiErrorFromResponse(json(401, { code: 'MFA_REQUIRED', message: 'Hãy nhập mã xác thực hai lớp' }), vi);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ code: 'MFA_REQUIRED', status: 401, message: 'Hãy nhập mã xác thực hai lớp' });
  });

  it('falls back to the status when the body has no code or message, or is not JSON', async () => {
    expect(await apiErrorFromResponse(json(404, { code: 'NOT_FOUND' }), vi)).toMatchObject({ code: 'NOT_FOUND', status: 404, message: 'Lỗi 404' });
    expect(await apiErrorFromResponse(new Response('<html>Bad gateway</html>', { status: 502 }), vi)).toMatchObject({
      code: 'HTTP_502',
      status: 502,
      message: 'Lỗi 502',
    });
    expect(await apiErrorFromResponse(json(500, { code: 42, message: null }), vi)).toMatchObject({ code: 'HTTP_500', status: 500, message: 'Lỗi 500' });
  });
});

describe('error checks on fetch-path errors', () => {
  it('treats MFA_REQUIRED as a pending second factor, never as a sign-out', async () => {
    const error = await apiErrorFromResponse(json(401, { code: 'MFA_REQUIRED', message: 'm' }), vi);
    expect(isMfaRequired(error)).toBe(true);
    expect(isUnauthenticated(error)).toBe(false);
  });

  it('treats a dead session as unauthenticated', async () => {
    const error = await apiErrorFromResponse(json(401, { code: 'UNAUTHENTICATED', message: 'm' }), vi);
    expect(isUnauthenticated(error)).toBe(true);
    expect(isMfaRequired(error)).toBe(false);
  });

  // Issue #272: a browser never holds a token issued to an OAuth client, so the SPA signs out as for a dead session.
  it('treats a token issued to an OAuth client as unauthenticated', async () => {
    const error = await apiErrorFromResponse(json(401, { code: 'OAUTH_CLIENT_TOKEN_REFUSED', message: 'm' }), vi);
    expect(isUnauthenticated(error)).toBe(true);
    expect(isMfaRequired(error)).toBe(false);
  });

  it('leaves other refusals alone', async () => {
    for (const [status, code] of [
      [403, 'NOT_A_MEMBER'],
      [503, 'AUTH_NOT_READY'],
      [413, 'FILE_TOO_LARGE'],
    ] as const) {
      const error = await apiErrorFromResponse(json(status, { code, message: 'm' }), vi);
      expect(isUnauthenticated(error)).toBe(false);
      expect(isMfaRequired(error)).toBe(false);
    }
  });
});

// Issue #223: a busy kernel refuses a completion with 503 UPLOAD_BUSY and leaves the grant unused.
describe('retryWhileBusy', () => {
  const busy = () => new ApiError('UPLOAD_BUSY', 503, 'busy');

  it('retries while the kernel answers UPLOAD_BUSY, waiting each delay in turn', async () => {
    const waits: number[] = [];
    let calls = 0;
    const result = await retryWhileBusy(
      async () => {
        calls++;
        if (calls < 3) throw busy();
        return 'done';
      },
      [10, 20, 30],
      async (ms) => {
        waits.push(ms);
      },
    );
    expect(result).toBe('done');
    expect(waits).toEqual([10, 20]);
  });

  it('gives up after the last delay, and never retries another error', async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => {
      waits.push(ms);
    };
    await expect(retryWhileBusy(async () => Promise.reject(busy()), [5, 5], sleep)).rejects.toMatchObject({ code: 'UPLOAD_BUSY' });
    expect(waits).toEqual([5, 5]);
    let calls = 0;
    const used = new ApiError('UPLOAD_USED', 409, 'used');
    await expect(
      retryWhileBusy(
        async () => {
          calls++;
          throw used;
        },
        [5],
        sleep,
      ),
    ).rejects.toBe(used);
    expect(calls).toBe(1);
  });
});
