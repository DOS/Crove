// Org creation limits (External-tenant gate T4, issue #94), unit part: configuration and error mapping.
import { describe, expect, it } from 'vitest';
import { DEFAULT_ORG_CREATE_LIMITS, buildKernelCommands, orgCreateCommand } from '@crove/kernel';
import { toDomainError } from '@crove/kernel-runtime';
import { loadConfig } from '../src/config.ts';
import { toORPCError } from '../src/rpc.ts';

const base = { DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: 'unit-test-jwt-secret-0123456789abcdef', AUTH_ISSUER: 'crove-auth' };

describe('org creation limits', () => {
  it('defaults to 5 per 24 hours and 20 in total, and reads both from env', () => {
    expect(DEFAULT_ORG_CREATE_LIMITS).toEqual({ perDay: 5, total: 20 });
    expect(loadConfig(base)).toMatchObject({ ORG_CREATE_LIMIT_PER_DAY: 5, ORG_CREATE_LIMIT_TOTAL: 20 });
    expect(loadConfig({ ...base, ORG_CREATE_LIMIT_PER_DAY: '10', ORG_CREATE_LIMIT_TOTAL: '100' })).toMatchObject({
      ORG_CREATE_LIMIT_PER_DAY: 10,
      ORG_CREATE_LIMIT_TOTAL: 100,
    });
  });

  it('refuses limits the database would refuse', () => {
    for (const value of ['0', '-1', '1.5', 'abc', '1000000']) {
      expect(() => loadConfig({ ...base, ORG_CREATE_LIMIT_PER_DAY: value })).toThrow(/ORG_CREATE_LIMIT_PER_DAY/);
      expect(() => loadConfig({ ...base, ORG_CREATE_LIMIT_TOTAL: value })).toThrow(/ORG_CREATE_LIMIT_TOTAL/);
    }
    expect(() => orgCreateCommand({ perDay: 0, total: 20 })).toThrow(/perDay/);
    expect(() => orgCreateCommand({ perDay: 5, total: 1.5 })).toThrow(/total/);
    expect(buildKernelCommands({ orgCreateLimits: { perDay: 1, total: 1 } })[0]?.name).toBe('kernel.org.create');
  });

  it('maps the definer refusal to 429 RATE_LIMITED with a Vietnamese message', () => {
    const perDay = toDomainError({
      code: 'P0001',
      message: 'ORG_CREATE_RATE_LIMITED',
      detail: '{"rule" : "org_create_per_day", "limit" : 5, "retryAfterSeconds" : 3600}',
    });
    expect(perDay).toMatchObject({
      code: 'RATE_LIMITED',
      status: 429,
      message: 'Bạn đã tạo quá nhiều tổ chức trong 24 giờ qua (tối đa 5), hãy thử lại sau',
      details: { rule: 'org_create_per_day', limit: 5, retryAfterSeconds: 3600 },
    });
    expect(toORPCError(perDay)).toMatchObject({ code: 'RATE_LIMITED', status: 429, data: perDay.details });
    expect(toDomainError({ code: 'P0001', message: 'ORG_CREATE_RATE_LIMITED', detail: '{"rule" : "org_create_total", "limit" : 20}' })).toMatchObject({
      code: 'RATE_LIMITED',
      status: 429,
      message: 'Bạn đã tạo đủ số tổ chức tối đa cho một tài khoản (20)',
      details: { rule: 'org_create_total', limit: 20 },
    });
    // Any other raised exception stays an internal error.
    expect(toDomainError({ code: 'P0001', message: 'SOMETHING_ELSE' })).toMatchObject({ code: 'INTERNAL', status: 500 });
  });
});
