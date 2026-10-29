// CROVE_CONTEXT_TOKEN_KEY (#1822, ADR-0028 section 9): the setting, the token the runtime signs with it, and the
// migration runner's reading of it. The database side is apps/kernel/test/invariant/context-token.db.test.ts.
import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { contextTokenKeyBytes as runnerKeyBytes } from '@crove/db/migrate';
import { CONTEXT_TOKEN_TTL_S, contextTokenKeyBytes, mintContextToken } from '@crove/kernel-runtime';
import { loadConfig } from '../src/config.ts';

const base = {
  DATABASE_URL: 'postgres://localhost/x',
  AUTH_JWT_SECRET: 'x'.repeat(32),
  AUTH_ISSUER: 'crove-auth',
  PUBLIC_URL: 'https://books.example.com',
  AUTH_UPSTREAM_URL: 'http://auth:9999',
};
const TEST_KEY = 'dGVzdC1vbmx5LWNvbnRleHQtdG9rZW4ta2V5LTAxMjM0NTY3ODk=';
const USER = '0190a5b2-0000-7000-8000-00000000000a';
const ORG = '0190a5b2-0000-7000-8000-0000000000b0';
const SESSION = '0190a5b2-0000-7000-8000-0000000000c0';

describe('CROVE_CONTEXT_TOKEN_KEY', () => {
  it('is unset when absent, empty or blank (a compose `${VAR:-}`), and base64 of 32 to 64 bytes when set', () => {
    expect(loadConfig(base).CROVE_CONTEXT_TOKEN_KEY).toBeUndefined();
    expect(loadConfig({ ...base, CROVE_CONTEXT_TOKEN_KEY: '' }).CROVE_CONTEXT_TOKEN_KEY).toBeUndefined();
    expect(loadConfig({ ...base, CROVE_CONTEXT_TOKEN_KEY: '  ' }).CROVE_CONTEXT_TOKEN_KEY).toBeUndefined();
    for (const size of [32, 48, 64]) {
      const key = randomBytes(size).toString('base64');
      expect(loadConfig({ ...base, CROVE_CONTEXT_TOKEN_KEY: key }).CROVE_CONTEXT_TOKEN_KEY).toBe(key);
    }
    for (const bad of [randomBytes(31).toString('base64'), randomBytes(65).toString('base64'), 'not base64 at all!', randomBytes(32).toString('hex').slice(0, 20)]) {
      expect(() => loadConfig({ ...base, CROVE_CONTEXT_TOKEN_KEY: bad }), bad).toThrow(/CROVE_CONTEXT_TOKEN_KEY must be base64 of 32 to 64 random bytes/);
    }
  });

  it('refuses the test suites key on a public URL, and accepts it on a local one', () => {
    expect(() => loadConfig({ ...base, CROVE_CONTEXT_TOKEN_KEY: TEST_KEY })).toThrow(/test suite key/);
    expect(loadConfig({ ...base, PUBLIC_URL: 'http://localhost:8080', CROVE_CONTEXT_TOKEN_KEY: TEST_KEY }).CROVE_CONTEXT_TOKEN_KEY).toBe(TEST_KEY);
  });

  it('never echoes the value in an error', () => {
    const bad = Buffer.from('a short secret value').toString('base64');
    for (const read of [() => loadConfig({ ...base, CROVE_CONTEXT_TOKEN_KEY: bad }), () => contextTokenKeyBytes(bad), () => runnerKeyBytes(bad)]) {
      let message = '';
      try {
        read();
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).not.toBe('');
      expect(message).not.toContain(bad);
    }
  });
});

describe('mintContextToken', () => {
  it('signs the claims, lowercased, with an expiry 60 seconds after the given time', () => {
    const now = Date.UTC(2026, 9, 29, 8, 0, 0, 500);
    const token = mintContextToken(TEST_KEY, { userId: USER.toUpperCase(), sessionId: SESSION, orgId: ORG, aal: 'aal2', mfaAt: 1_790_000_000.7 }, now);
    const exp = Math.floor(now / 1000) + CONTEXT_TOKEN_TTL_S;
    const message = `v1.${USER}.${SESSION}.${ORG}.aal2.1790000000.${exp}`;
    expect(CONTEXT_TOKEN_TTL_S).toBe(60);
    expect(token).toBe(`${message}.${createHmac('sha256', Buffer.from(TEST_KEY, 'base64')).update(message).digest('hex')}`);
    expect(token).not.toContain(TEST_KEY);
    expect(token).not.toContain(Buffer.from(TEST_KEY, 'base64').toString('hex'));
  });

  it('writes - for no session and no MFA time, and aal1 for anything but aal2', () => {
    const token = mintContextToken(TEST_KEY, { userId: USER, sessionId: null, orgId: ORG, aal: 'aal1', mfaAt: null }, 0);
    expect(token.split('.').slice(0, 7)).toEqual(['v1', USER, '-', ORG, 'aal1', '-', String(CONTEXT_TOKEN_TTL_S)]);
  });

  it('signs with the real clock while a test mocks Date for business time', () => {
    const real = Math.floor(performance.timeOrigin + performance.now());
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(real - 8 * 24 * 60 * 60 * 1000);
      const exp = Number(mintContextToken(TEST_KEY, { userId: USER, sessionId: null, orgId: ORG, aal: 'aal1', mfaAt: null }).split('.')[6]);
      expect(Math.abs(exp - (Math.floor(real / 1000) + CONTEXT_TOKEN_TTL_S))).toBeLessThanOrEqual(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses claims that are not UUIDs, so nothing else can reach the token', () => {
    for (const claims of [
      { userId: `${USER}.x`, sessionId: null, orgId: ORG },
      { userId: USER, sessionId: 'session', orgId: ORG },
      { userId: USER, sessionId: null, orgId: `${ORG}.v1` },
    ]) {
      expect(() => mintContextToken(TEST_KEY, { ...claims, aal: 'aal1', mfaAt: null })).toThrow(/UUIDs/);
    }
  });
});
