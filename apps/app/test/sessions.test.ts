// Helpers behind the device sessions screens (issue #89).
import { describe, expect, it } from 'vitest';
import {
  describeUserAgent,
  otherActiveSessionIds,
  sessionErrorMessage,
  sessionIdFromToken,
  shortSessionId,
  sortSessions,
  type SessionRow,
} from '../src/lib/sessions.ts';
import { translatorFor } from '../src/i18n/runtime.ts';

const vi = translatorFor('vi');

function token(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}.signature`;
}

const CURRENT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const OLD = '33333333-3333-4333-8333-333333333333';

function row(sessionId: string, status: SessionRow['status'], lastSeenAt: string, revokedAt: string | null = null): SessionRow {
  return { sessionId, status, firstSeenAt: '2026-10-01T00:00:00.000Z', lastSeenAt, revokedAt };
}

describe('sessionIdFromToken', () => {
  it('reads the session_id claim', () => {
    expect(sessionIdFromToken(token({ sub: 'u', session_id: CURRENT }))).toBe(CURRENT);
  });

  it('decodes base64url payloads with non-ASCII claims', () => {
    expect(sessionIdFromToken(token({ name: 'Nguyễn Văn Ả?>~', session_id: OTHER }))).toBe(OTHER);
  });

  it('returns null for missing, empty or malformed tokens', () => {
    expect(sessionIdFromToken(null)).toBeNull();
    expect(sessionIdFromToken('')).toBeNull();
    expect(sessionIdFromToken('not-a-jwt')).toBeNull();
    expect(sessionIdFromToken('a.%%%.c')).toBeNull();
    expect(sessionIdFromToken(token({ sub: 'u' }))).toBeNull();
    expect(sessionIdFromToken(token({ session_id: 42 }))).toBeNull();
  });
});

describe('sortSessions and otherActiveSessionIds', () => {
  const sessions = [
    row(OLD, 'revoked', '2026-10-10T00:00:00.000Z', '2026-10-11T00:00:00.000Z'),
    row(OTHER, 'active', '2026-10-14T00:00:00.000Z'),
    row(CURRENT, 'active', '2026-10-12T00:00:00.000Z'),
  ];

  it('puts the current session first, then active, then revoked', () => {
    expect(sortSessions(sessions, CURRENT).map((s) => s.sessionId)).toEqual([CURRENT, OTHER, OLD]);
    expect(sortSessions(sessions, null).map((s) => s.sessionId)).toEqual([OTHER, CURRENT, OLD]);
  });

  it('does not mutate its input', () => {
    const copy = [...sessions];
    sortSessions(sessions, CURRENT);
    expect(sessions).toEqual(copy);
  });

  it('lists the other active sessions only', () => {
    expect(otherActiveSessionIds(sessions, CURRENT)).toEqual([OTHER]);
    expect(otherActiveSessionIds(sessions, null)).toEqual([OTHER, CURRENT]);
  });
});

describe('labels', () => {
  it('shortens a session id', () => {
    expect(shortSessionId(OTHER)).toBe('222222');
  });

  it('describes the browser in the given locale', () => {
    expect(describeUserAgent('Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0', translatorFor('en'))).toBe('Firefox on Linux');
  });

  it('describes common browsers', () => {
    expect(
      describeUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36', vi),
    ).toBe('Chrome trên Windows');
    expect(
      describeUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0',
        vi,
      ),
    ).toBe('Edge trên Windows');
    expect(
      describeUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', vi),
    ).toBe('Safari trên iOS');
    expect(describeUserAgent('Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0', vi)).toBe('Firefox trên Linux');
    expect(describeUserAgent('curl/8.0', vi)).toBeNull();
    expect(describeUserAgent(null, vi)).toBeNull();
  });
});

describe('sessionErrorMessage', () => {
  it('explains STEP_UP_REQUIRED', () => {
    expect(sessionErrorMessage({ status: 403, code: 'STEP_UP_REQUIRED', message: 'x' }, 'self', vi)).toContain('xác thực hai lớp');
  });

  it('explains a 403 by scope', () => {
    const forbidden = { status: 403, code: 'FORBIDDEN', message: 'Không có quyền thực hiện' };
    expect(sessionErrorMessage(forbidden, 'member', vi)).toContain('Chỉ chủ sở hữu');
    expect(sessionErrorMessage(forbidden, 'member', vi)).toContain('Quản trị viên không có quyền này');
    expect(sessionErrorMessage(forbidden, 'self', vi)).toContain('Bạn không có quyền');
  });

  it('keeps the server message for membership and disabled accounts', () => {
    expect(sessionErrorMessage({ status: 403, code: 'NOT_A_MEMBER', message: 'Bạn không thuộc tổ chức này' }, 'member', vi)).toBe(
      'Bạn không thuộc tổ chức này',
    );
  });

  it('falls back to the message, then a generic text', () => {
    expect(sessionErrorMessage({ status: 503, code: 'OVERLOADED', message: 'Hệ thống đang quá tải' }, 'self', vi)).toBe('Hệ thống đang quá tải');
    expect(sessionErrorMessage(null, 'self', vi)).toBe('Đã có lỗi xảy ra');
  });
});
