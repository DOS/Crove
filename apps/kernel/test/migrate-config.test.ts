// MIGRATE_LOCK_WAIT_SECONDS (#1803): the maximum wait for another run's migration lock. Unset or empty (a compose
// `${VAR:-}`) waits as long as it takes; every role parses the config, so an empty value must not fail it.
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';

const base = {
  DATABASE_URL: 'postgres://localhost/x',
  AUTH_JWT_SECRET: 'x'.repeat(32),
  AUTH_ISSUER: 'crove-auth',
  PUBLIC_URL: 'https://books.example.com',
  AUTH_UPSTREAM_URL: 'http://auth:9999',
};

describe('MIGRATE_LOCK_WAIT_SECONDS', () => {
  it('is unset when absent, empty or blank, a whole number of seconds when set, and refuses anything else', () => {
    expect(loadConfig(base).MIGRATE_LOCK_WAIT_SECONDS).toBeUndefined();
    expect(loadConfig({ ...base, MIGRATE_LOCK_WAIT_SECONDS: '' }).MIGRATE_LOCK_WAIT_SECONDS).toBeUndefined();
    expect(loadConfig({ ...base, MIGRATE_LOCK_WAIT_SECONDS: '  ' }).MIGRATE_LOCK_WAIT_SECONDS).toBeUndefined();
    expect(loadConfig({ ...base, MIGRATE_LOCK_WAIT_SECONDS: '600' }).MIGRATE_LOCK_WAIT_SECONDS).toBe(600);
    for (const bad of ['0', '-5', '1.5', 'ten']) {
      expect(() => loadConfig({ ...base, MIGRATE_LOCK_WAIT_SECONDS: bad }), bad).toThrow(/MIGRATE_LOCK_WAIT_SECONDS/);
    }
  });
});
