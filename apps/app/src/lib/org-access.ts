// What a refused session means for this tab (issue #247, ADR-0028 section 4). An org's owner can revoke a member's
// session in that org only: the kernel then answers 401 SESSION_REVOKED_IN_ORG there, while the session keeps
// working in the member's other orgs. So that answer leaves the org (back to the start page, which lists only the
// orgs this session can enter) and never signs the device out of Supabase Auth. Any other dead session still signs
// out, as before. No browser or API imports, so it is unit tested.
import { ORG_HEADER } from '@crove/kernel-contract';
import { isMfaRequired, isOrgAccessRevoked, isUnauthenticated } from './errors.ts';

// The request headers for the kernel. `org` is null for org-less calls; the user's own sign-out revoke is one, so
// an org that refuses this session cannot swallow it (the kernel picks an org that can run it, or none).
export function requestHeaders(token: string | null, org: string | null): Record<string, string> {
  return {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(org ? { [ORG_HEADER]: org } : {}),
  };
}

const LEFT_KEY = 'crove-org-left';

export interface OrgLeft {
  name: string;
}

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>;

// The org this tab just left, shown once on the next page. Storage may be unavailable (private mode): the notice is
// then skipped, leaving the org still works.
export function rememberOrgLeft(storage: Storage | undefined, left: OrgLeft): void {
  try {
    storage?.setItem(LEFT_KEY, JSON.stringify(left));
  } catch {
    // ignored: see above
  }
}

export function takeOrgLeft(storage: Storage | undefined): OrgLeft | null {
  try {
    const raw = storage?.getItem(LEFT_KEY) ?? null;
    if (raw === null) return null;
    storage?.removeItem(LEFT_KEY);
    const value = JSON.parse(raw) as Partial<OrgLeft> | null;
    return value && typeof value.name === 'string' && value.name ? { name: value.name.slice(0, 200) } : null;
  } catch {
    return null;
  }
}

export interface SessionErrorDeps {
  // The org this tab is in (its slug), or null on org-less pages.
  currentOrg: () => string | null;
  // Leaves that org: forget its data and go back to the start page.
  leaveOrg: (slug: string) => void;
  // Signs this device out locally (the session is dead everywhere).
  signOut: () => void;
  // Opens the MFA challenge: the session is valid but has not passed its second factor yet (MFA_REQUIRED, #126).
  openMfa: () => void;
}

// The handler for every failed query and mutation. Several requests can fail at once; the org is left only once.
export function createSessionErrorHandler(deps: SessionErrorDeps): (error: unknown) => void {
  let leaving: string | null = null;
  return (error) => {
    if (isOrgAccessRevoked(error)) {
      const slug = deps.currentOrg();
      if (slug && leaving !== slug) {
        leaving = slug;
        deps.leaveOrg(slug);
      }
      return;
    }
    if (isMfaRequired(error)) {
      deps.openMfa();
      return;
    }
    if (isUnauthenticated(error)) deps.signOut();
  };
}
