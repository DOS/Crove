// The user-disable and user-enable arguments and exit codes (issue #985). The database part is in
// user-disable.db.test.ts.
import { describe, expect, it } from 'vitest';
import { USER_DISABLE_EXIT, parseUserDisableArgs, runUserDisable } from '../src/user-disable.ts';

describe('user-disable arguments', () => {
  it('takes one account and a reason', () => {
    expect(parseUserDisableArgs(['a@b.test', '--reason', ' spam '])).toEqual({ ref: 'a@b.test', reason: 'spam' });
    expect(parseUserDisableArgs(['--', '--reason', 'x', '0190a1b2-0000-7000-8000-000000000001'])).toEqual({ ref: '0190a1b2-0000-7000-8000-000000000001', reason: 'x' });
  });

  it('refuses a missing account or reason, a second account and unknown flags', () => {
    for (const argv of [[], ['a@b.test'], ['--reason', 'x'], ['a@b.test', '--reason', ''], ['a@b.test', '--reason', 'x'.repeat(501)], ['a@b.test', 'c@d.test', '--reason', 'x'], ['a@b.test', '--reason', 'x', '--force']]) {
      expect(() => parseUserDisableArgs(argv), argv.join(' ')).toThrow();
    }
  });

  it('fails with exit code 2 on bad arguments without touching the database', async () => {
    let calls = 0;
    const runtime = {
      orgless: async () => {
        calls++;
        return undefined as never;
      },
      execute: async () => {
        calls++;
        return undefined as never;
      },
    };
    const errors: string[] = [];
    expect(await runUserDisable({ runtime, log: () => {}, error: (l) => errors.push(l) }, true, ['a@b.test'])).toBe(USER_DISABLE_EXIT.failed);
    expect(errors[0]).toMatch(/^\[user-disable\] --reason is required/);
    expect(calls).toBe(0);
  });
});
