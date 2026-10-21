// The user-disable and user-enable arguments and exit codes (issue #985). The database part is in
// user-disable.db.test.ts.
import { describe, expect, it } from 'vitest';
import { USER_DISABLE_EXIT, parseUserDisableArgs, runUserDisable, setUserDisabled } from '../src/user-disable.ts';

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

  it('notes the other orgs when one note fails, then fails naming it', async () => {
    const noted: string[] = [];
    const runtime = {
      orgless: async () => ({ outcome: 'ok', user_id: 'u1', changed: true, disabled_at: new Date(), org_ids: ['org-a', 'org-b'] }) as never,
      execute: async (_name: string, _input: unknown, options: { orgId: string }) => {
        if (options.orgId === 'org-a') throw new Error('lock timeout');
        noted.push(options.orgId);
        return undefined as never;
      },
    } as unknown as Parameters<typeof setUserDisabled>[0];
    await expect(setUserDisabled(runtime, true, { ref: 'a@b.test', reason: 'x' })).rejects.toThrow(/audit note failed in org-a \(lock timeout\); run it again/);
    expect(noted).toEqual(['org-b']);
  });
});
