// Invite mail limits (#185), unit part: the per-recipient cap's configuration. The database part (exact counts under
// concurrency, the busy answer, the cap across orgs) is in test/invite-limits.db.test.ts, and the cap's enumeration
// safety in test/invariant/invites.db.test.ts.
import { describe, expect, it } from 'vitest';
import { DEFAULT_INVITE_LIMITS, buildKernelCommands, inviteCreateCommand } from '@crove/kernel';
import { loadConfig } from '../src/config.ts';
import { moduleDefinitions } from '../src/kernel.ts';

const base = { DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: 'unit-test-jwt-secret-0123456789abcdef', AUTH_ISSUER: 'crove-auth' };

describe('invite mail limits', () => {
  it('defaults to 5 invite mails per recipient in any 24 hours, and reads the limit from env', () => {
    expect(DEFAULT_INVITE_LIMITS).toEqual({ perRecipientPerDay: 5 });
    expect(loadConfig(base)).toMatchObject({ INVITE_LIMIT_PER_RECIPIENT_PER_DAY: 5 });
    expect(loadConfig({ ...base, INVITE_LIMIT_PER_RECIPIENT_PER_DAY: '12' })).toMatchObject({ INVITE_LIMIT_PER_RECIPIENT_PER_DAY: 12 });
  });

  it('refuses limits the command would refuse, naming the field and never the value', () => {
    for (const value of ['0', '-1', '1.5', 'abc', '1001']) {
      let message = '';
      try {
        loadConfig({ ...base, INVITE_LIMIT_PER_RECIPIENT_PER_DAY: value });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain('INVITE_LIMIT_PER_RECIPIENT_PER_DAY');
      expect(message).not.toContain(value);
    }
    for (const perRecipientPerDay of [0, 1.5, 1001, Number.NaN]) {
      expect(() => inviteCreateCommand({ perRecipientPerDay })).toThrow(/perRecipientPerDay/);
    }
  });

  it('registers exactly one invite command, with the configured limit', () => {
    const commands = buildKernelCommands({ inviteLimits: { perRecipientPerDay: 2 } });
    expect(commands.filter((c) => c.name === 'kernel.member.invite.create')).toHaveLength(1);
    expect(buildKernelCommands().filter((c) => c.name === 'kernel.member.invite.create')).toHaveLength(1);
    const kernel = moduleDefinitions(loadConfig({ ...base, INVITE_LIMIT_PER_RECIPIENT_PER_DAY: '2' }));
    expect(kernel.commands.filter((c) => c.name === 'kernel.member.invite.create')).toHaveLength(1);
  });
});
