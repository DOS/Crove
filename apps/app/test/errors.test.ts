// Typed errors on the SPA's plain fetch paths (issue #180): upload, download and export failures carry the kernel's
// code and the HTTP status like RPC errors, so MFA_REQUIRED and a dead session are recognised there too.
import { describe, expect, it } from 'vitest';
import { ApiError, apiErrorFromResponse, isMfaRequired, isUnauthenticated } from '../src/lib/errors.ts';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('apiErrorFromResponse', () => {
  it('keeps the kernel code, status and message', async () => {
    const error = await apiErrorFromResponse(json(401, { code: 'MFA_REQUIRED', message: 'Hãy nhập mã xác thực hai lớp' }));
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ code: 'MFA_REQUIRED', status: 401, message: 'Hãy nhập mã xác thực hai lớp' });
  });

  it('falls back to the status when the body has no code or message, or is not JSON', async () => {
    expect(await apiErrorFromResponse(json(404, { code: 'NOT_FOUND' }))).toMatchObject({ code: 'NOT_FOUND', status: 404, message: 'Lỗi 404' });
    expect(await apiErrorFromResponse(new Response('<html>Bad gateway</html>', { status: 502 }))).toMatchObject({
      code: 'HTTP_502',
      status: 502,
      message: 'Lỗi 502',
    });
    expect(await apiErrorFromResponse(json(500, { code: 42, message: null }))).toMatchObject({ code: 'HTTP_500', status: 500, message: 'Lỗi 500' });
  });
});

describe('error checks on fetch-path errors', () => {
  it('treats MFA_REQUIRED as a pending second factor, never as a sign-out', async () => {
    const error = await apiErrorFromResponse(json(401, { code: 'MFA_REQUIRED', message: 'm' }));
    expect(isMfaRequired(error)).toBe(true);
    expect(isUnauthenticated(error)).toBe(false);
  });

  it('treats a dead session as unauthenticated', async () => {
    const error = await apiErrorFromResponse(json(401, { code: 'UNAUTHENTICATED', message: 'm' }));
    expect(isUnauthenticated(error)).toBe(true);
    expect(isMfaRequired(error)).toBe(false);
  });

  it('leaves other refusals alone', async () => {
    for (const [status, code] of [
      [403, 'NOT_A_MEMBER'],
      [503, 'AUTH_NOT_READY'],
      [413, 'FILE_TOO_LARGE'],
    ] as const) {
      const error = await apiErrorFromResponse(json(status, { code, message: 'm' }));
      expect(isUnauthenticated(error)).toBe(false);
      expect(isMfaRequired(error)).toBe(false);
    }
  });
});
