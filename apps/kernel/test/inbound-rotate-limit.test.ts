// Inbound address rotation limits (#113), unit part: configuration and error mapping. The database part is in
// test/invariant/inbound-rotate-limit.db.test.ts.
import { describe, expect, it } from 'vitest';
import { DEFAULT_INBOUND_ROTATE_LIMITS, buildKernelCommands, inboundRotateCommand } from '@crove/kernel';
import { toDomainError } from '@crove/kernel-runtime';
import { loadConfig } from '../src/config.ts';
import { toORPCError } from '../src/rpc.ts';

const base = { DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: 'unit-test-jwt-secret-0123456789abcdef', AUTH_ISSUER: 'crove-auth' };

describe('inbound address rotation limits', () => {
  it('defaults to 3 per 24 hours and 50 in total, and reads both from env', () => {
    expect(DEFAULT_INBOUND_ROTATE_LIMITS).toEqual({ perDay: 3, total: 50 });
    expect(loadConfig(base)).toMatchObject({ INBOUND_ROTATE_LIMIT_PER_DAY: 3, INBOUND_ROTATE_LIMIT_TOTAL: 50 });
    expect(loadConfig({ ...base, INBOUND_ROTATE_LIMIT_PER_DAY: '10', INBOUND_ROTATE_LIMIT_TOTAL: '100' })).toMatchObject({
      INBOUND_ROTATE_LIMIT_PER_DAY: 10,
      INBOUND_ROTATE_LIMIT_TOTAL: 100,
    });
  });

  it('refuses limits the database would refuse, naming the field and never the value', () => {
    for (const value of ['0', '-1', '1.5', 'abc', '1000000']) {
      for (const field of ['INBOUND_ROTATE_LIMIT_PER_DAY', 'INBOUND_ROTATE_LIMIT_TOTAL']) {
        let message = '';
        try {
          loadConfig({ ...base, [field]: value });
        } catch (error) {
          message = (error as Error).message;
        }
        expect(message).toContain(field);
        expect(message).not.toContain(value);
      }
    }
    expect(() => inboundRotateCommand({ perDay: 0, total: 50 })).toThrow(/perDay/);
    expect(() => inboundRotateCommand({ perDay: 3, total: 1.5 })).toThrow(/total/);
    const commands = buildKernelCommands({ inboundRotateLimits: { perDay: 1, total: 1 } });
    expect(commands.filter((c) => c.name === 'kernel.inbound.rotate')).toHaveLength(1);
  });

  it('maps the definer refusal to 429 RATE_LIMITED with a Vietnamese message', () => {
    const perDay = toDomainError({
      code: 'P0001',
      message: 'INBOUND_ROTATE_RATE_LIMITED',
      detail: '{"rule" : "inbound_rotate_per_day", "limit" : 3, "retryAfterSeconds" : 3600}',
    });
    expect(perDay).toMatchObject({
      code: 'RATE_LIMITED',
      status: 429,
      message: 'Tổ chức đã đổi địa chỉ nhận hóa đơn quá nhiều lần trong 24 giờ qua (tối đa 3), hãy thử lại sau',
      details: { rule: 'inbound_rotate_per_day', limit: 3, retryAfterSeconds: 3600 },
    });
    expect(toORPCError(perDay)).toMatchObject({ code: 'RATE_LIMITED', status: 429, data: perDay.details });
    expect(
      toDomainError({ code: 'P0001', message: 'INBOUND_ROTATE_RATE_LIMITED', detail: '{"rule" : "inbound_rotate_total", "limit" : 50}' }),
    ).toMatchObject({
      code: 'RATE_LIMITED',
      status: 429,
      message: 'Tổ chức đã đổi địa chỉ nhận hóa đơn đủ số lần tối đa (50)',
      details: { rule: 'inbound_rotate_total', limit: 50 },
    });
    expect(
      toDomainError({ code: 'P0001', message: 'INBOUND_ROTATE_RATE_LIMITED', detail: '{"rule" : "inbound_rotate_busy", "retryAfterSeconds" : 1}' }),
    ).toMatchObject({
      code: 'RATE_LIMITED',
      status: 429,
      message: 'Địa chỉ nhận hóa đơn đang được đổi, hãy thử lại sau',
      details: { rule: 'inbound_rotate_busy', retryAfterSeconds: 1 },
    });
    // A malformed limit setting is a bug in the caller, never a user's 4xx.
    expect(toDomainError({ code: '22023', message: 'INBOUND_ROTATE_LIMIT_INVALID' })).toMatchObject({ code: 'INTERNAL', status: 500 });
  });
});
