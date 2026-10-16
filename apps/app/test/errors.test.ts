// Typed errors on the SPA's plain fetch paths (issue #180): upload, download and export failures carry the kernel's
// code and the HTTP status like RPC errors, so MFA_REQUIRED and a dead session are recognised there too.
import { describe, expect, it } from 'vitest';
import { translatorFor } from '../src/i18n/runtime.ts';
import { ApiError, ClientError, apiErrorFromResponse, describeError, isMfaRequired, isUnauthenticated, retryWhileBusy } from '../src/lib/errors.ts';

const vi = translatorFor('vi');
const en = translatorFor('en');

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('apiErrorFromResponse', () => {
  it('keeps the kernel code, status and message', async () => {
    const error = await apiErrorFromResponse(json(401, { code: 'MFA_REQUIRED', message: 'Hãy nhập mã xác thực hai lớp' }));
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ code: 'MFA_REQUIRED', status: 401, serverMessage: 'Hãy nhập mã xác thực hai lớp' });
  });

  it('falls back to the status when the body has no code or message, or is not JSON', async () => {
    expect(await apiErrorFromResponse(json(404, { code: 'NOT_FOUND' }))).toMatchObject({ code: 'NOT_FOUND', status: 404, serverMessage: null });
    expect(await apiErrorFromResponse(new Response('<html>Bad gateway</html>', { status: 502 }))).toMatchObject({
      code: 'HTTP_502',
      status: 502,
      serverMessage: null,
    });
    expect(await apiErrorFromResponse(json(500, { code: 42, message: null }))).toMatchObject({ code: 'HTTP_500', status: 500, serverMessage: null });
  });

  it('holds no translated text: the words come at render, in the locale of that moment', async () => {
    const error = await apiErrorFromResponse(new Response('', { status: 502 }));
    expect(describeError(error, vi, 'vi')).toBe('Lỗi 502');
    expect(describeError(error, en, 'en')).toBe('Error 502');
  });
});

describe('describeError', () => {
  const forbidden = { code: 'FORBIDDEN', status: 403, message: 'Chỉ chủ sở hữu mới đổi được vai trò hoặc xóa thành viên' };

  it('shows the kernel message as is on Vietnamese screens (it names the case)', () => {
    expect(describeError(forbidden, vi, 'vi')).toBe(forbidden.message);
    expect(describeError(new ApiError('UPLOAD_BUSY', 503, 'Máy chủ bận'), vi, 'vi')).toBe('Máy chủ bận');
  });

  it('words a known code in the locale otherwise, and in Vietnamese when the kernel sent no message', () => {
    expect(describeError(forbidden, en, 'en')).toBe('You are not allowed to do this.');
    expect(describeError(new ApiError('UPLOAD_BUSY', 503, 'Máy chủ bận'), en, 'en')).toBe(en('kernelErrors.codes.UPLOAD_BUSY'));
    expect(describeError(new ApiError('NOT_FOUND', 404, null), vi, 'vi')).toBe('Không tìm thấy');
  });

  it('words a rate limit from its rule, and ignores a rule of another code', () => {
    const limited = { code: 'INVITE_RATE_LIMITED', status: 429, message: 'm', data: { rule: 'invite_recipient_per_day', limit: 5 } };
    expect(describeError(limited, en, 'en')).toBe('This email received too many invites in the last 24 hours. Try again later.');
    expect(describeError({ ...limited, code: 'RATE_LIMITED' }, en, 'en')).toBe('Too many requests. Try again later.');
    expect(describeError({ ...limited, data: { rule: 'toString' } }, en, 'en')).toBe('Too many invites were sent. Try again later.');
  });

  it('words the English answers of oRPC itself in every locale', () => {
    const invalid = { code: 'BAD_REQUEST', status: 400, message: 'Input validation failed' };
    expect(describeError(invalid, vi, 'vi')).toBe('Dữ liệu gửi lên không hợp lệ');
    expect(describeError(invalid, en, 'en')).toBe('The request is not valid.');
  });

  it('keeps the kernel message for a code the SPA does not word, then a generic text', () => {
    expect(describeError({ code: 'TASK_CLOSED', message: 'Việc này đã kết thúc' }, en, 'en')).toBe('Việc này đã kết thúc');
    expect(describeError(new TypeError('Failed to fetch'), en, 'en')).toBe('Failed to fetch');
    expect(describeError(null, en, 'en')).toBe('Something went wrong');
    expect(describeError({}, vi, 'vi')).toBe('Đã có lỗi xảy ra');
  });

  it('words the errors of the SPA itself at render', () => {
    const error = new ClientError('inbox.fileTooLarge', (t) => t('inbox.fileTooLarge', { name: 'a.pdf' }));
    expect(describeError(error, vi, 'vi')).toBe('a.pdf vượt quá 25 MB');
    expect(describeError(error, en, 'en')).toBe(en('inbox.fileTooLarge', { name: 'a.pdf' }));
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
      const error = await apiErrorFromResponse(json(status, { code, message: 'm' }));
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
