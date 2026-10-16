// What a refused session does in the SPA (issue #247): a session revoked in one org leaves that org and keeps the
// device signed in; any other dead session signs out; the sign-out revoke goes without the org header.
import { describe, expect, it, vi } from 'vitest';
import { ORG_HEADER } from '@crove/kernel-contract';
import { ApiError, isOrgAccessRevoked, isUnauthenticated } from '../src/lib/errors.ts';
import { createSessionErrorHandler, rememberOrgLeft, requestHeaders, takeOrgLeft } from '../src/lib/org-access.ts';

const revokedInOrg = new ApiError('SESSION_REVOKED_IN_ORG', 401, 'revoked here');
const dead = new ApiError('UNAUTHENTICATED', 401, 'dead');
const mfa = new ApiError('MFA_REQUIRED', 401, 'mfa');

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    map,
  };
}

describe('requestHeaders', () => {
  it('sends the org header only when an org is given', () => {
    expect(requestHeaders('t', 'acme')).toEqual({ authorization: 'Bearer t', [ORG_HEADER]: 'acme' });
    expect(requestHeaders('t', null)).toEqual({ authorization: 'Bearer t' });
    expect(requestHeaders(null, null)).toEqual({});
  });
});

describe('isOrgAccessRevoked', () => {
  it('recognises a session revoked in one org, which is not a sign-out', () => {
    expect(isOrgAccessRevoked(revokedInOrg)).toBe(true);
    expect(isOrgAccessRevoked({ code: 'SESSION_REVOKED_IN_ORG', status: 401 })).toBe(true);
    expect(isUnauthenticated(revokedInOrg)).toBe(false);
    expect(isOrgAccessRevoked(dead)).toBe(false);
    expect(isUnauthenticated(dead)).toBe(true);
  });
});

describe('createSessionErrorHandler', () => {
  const setup = (org: string | null) => {
    const deps = { currentOrg: vi.fn(() => org), leaveOrg: vi.fn(), signOut: vi.fn() };
    return { deps, handle: createSessionErrorHandler(deps) };
  };

  it('leaves the org once on a session revoked there, and never signs out', () => {
    const { deps, handle } = setup('acme');
    handle(revokedInOrg);
    handle(revokedInOrg);
    expect(deps.leaveOrg).toHaveBeenCalledExactlyOnceWith('acme');
    expect(deps.signOut).not.toHaveBeenCalled();
  });

  it('signs out on a dead session, as before', () => {
    const { deps, handle } = setup('acme');
    handle(dead);
    expect(deps.signOut).toHaveBeenCalledOnce();
    expect(deps.leaveOrg).not.toHaveBeenCalled();
  });

  it('does nothing for MFA_REQUIRED, other errors, or an org refusal outside an org page', () => {
    const { deps, handle } = setup('acme');
    handle(mfa);
    handle(new ApiError('FORBIDDEN', 403, 'no'));
    handle(new Error('network'));
    const orgless = setup(null);
    orgless.handle(revokedInOrg);
    for (const d of [deps, orgless.deps]) {
      expect(d.signOut).not.toHaveBeenCalled();
      expect(d.leaveOrg).not.toHaveBeenCalled();
    }
  });
});

describe('the org-left notice', () => {
  it('is shown once', () => {
    const storage = memoryStorage();
    rememberOrgLeft(storage, { name: 'Công ty A' });
    expect(takeOrgLeft(storage)).toEqual({ name: 'Công ty A' });
    expect(takeOrgLeft(storage)).toBeNull();
  });

  it('drops a malformed value and survives unavailable storage', () => {
    const storage = memoryStorage();
    storage.setItem('crove-org-left', '{not json');
    expect(takeOrgLeft(storage)).toBeNull();
    storage.setItem('crove-org-left', JSON.stringify({ name: 42 }));
    expect(takeOrgLeft(storage)).toBeNull();
    expect(storage.map.size).toBe(0);
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => undefined,
    };
    expect(() => rememberOrgLeft(broken, { name: 'x' })).not.toThrow();
    expect(takeOrgLeft(broken)).toBeNull();
    expect(takeOrgLeft(undefined)).toBeNull();
  });
});
