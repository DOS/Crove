// The multi-client home screen (issue #318): every org the user belongs to, with what waits in it and when its next VAT
// return is due. There is no cross-org query: the org list comes from the control plane (my_orgs through sessionOrgs,
// the same list as me.get and the org switcher), and each org's figures are read by kernel.org.overview in that org's
// own context (runtime.query: session check, enter_context, membership, RLS), exactly as if the user had opened the
// org. An org the user cannot read just then (they left it, or its owner revoked this session there, since the list
// was read) is left out. Reading an org checks the session there, which records it as first seen in that org
// (auth_session_org): after one visit to the home screen, the session is listed among each org's member sessions,
// which is accurate, since it did read every one of them.
//
// The org's VAT filing period (monthly or quarterly) is set by owners and admins (kernel.org.set_vat_filing_period,
// tax-code.ts).
import { sql } from 'kysely';
import { z } from 'zod';
import { nextVatDeadline, vietnamToday, type VatDeadline, type VatFilingPeriod } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineQuery, type Runtime, type UserActor } from '@crove/kernel-runtime';
import { fileStatuses } from './file-status.ts';
import { sessionOrgs } from './commands.ts';
import type { OrgSummary } from './identity.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];

// The Inbox lists this many of the newest files (kernel.files.recent); the home screen counts the failed ones among
// the same files, so a click into the org shows exactly the files the count named.
export const RECENT_FILES = 50;

// Orgs read at once for one home screen, and at most this many orgs per screen (each is one short read-only
// transaction).
const OVERVIEW_CONCURRENCY = 4;
export const MAX_CLIENT_ORGS = 200;

export interface OrgOverview {
  pendingProposals: number;
  failedFiles: number;
  lastActivityAt: string | null;
  vatFilingPeriod: VatFilingPeriod | null;
  vatDeadline: VatDeadline | null;
}

export interface ClientOverview extends OrgSummary {
  overview: OrgOverview;
}

// total: the orgs the user has, of which the first MAX_CLIENT_ORGS are read (#495).
export interface ClientOverviews {
  clients: ClientOverview[];
  total: number;
}

export function orgOverviewQuery(options: { now?: () => Date } = {}) {
  const now = options.now ?? (() => new Date());
  return defineQuery({
    name: 'kernel.org.overview',
    input: z.object({}),
    access: ALL,
    handler: async (ctx): Promise<OrgOverview> => {
      const tenant = await ctx.trx.selectFrom('crove_kernel.tenant').select('vat_filing_period').where('org_id', '=', ctx.orgId).executeTakeFirstOrThrow();
      const pending = await ctx.trx
        .selectFrom('crove_kernel.proposal')
        .select(sql<string>`count(*)`.as('n'))
        .where('org_id', '=', ctx.orgId)
        .where('status', '=', 'pending')
        .executeTakeFirstOrThrow();
      const files = await fileStatuses(ctx, { recent: RECENT_FILES });
      const last = await ctx.trx
        .selectFrom('crove_kernel.activity')
        .select(sql<Date | null>`max(occurred_at)`.as('at'))
        .where('org_id', '=', ctx.orgId)
        .executeTakeFirstOrThrow();
      const period = tenant.vat_filing_period;
      return {
        pendingProposals: Number(pending.n),
        failedFiles: files.filter((f) => f.status.status === 'failed').length,
        lastActivityAt: last.at ? new Date(last.at).toISOString() : null,
        vatFilingPeriod: period,
        vatDeadline: period ? nextVatDeadline(period, vietnamToday(now())) : null,
      };
    },
  });
}

export const orgOverview = orgOverviewQuery();

// Runs fn over items with at most `limit` calls in flight, keeping the order of items. Once a call fails, or `signal`
// aborts (the client went away), no worker starts another item (#495): the answer is lost anyway, and each item is a
// transaction on the API's pool. The calls already running finish before the first error is thrown, so the caller's
// slot (rpc.ts) is released only when no transaction of this answer is left.
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>, signal?: AbortSignal): Promise<R[]> {
  const out: R[] = Array.from({ length: items.length });
  let next = 0;
  let failure: { error: unknown } | null = null;
  const worker = async () => {
    while (next < items.length && !failure && !signal?.aborted) {
      const index = next++;
      try {
        out[index] = await fn(items[index] as T);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure) throw (failure as { error: unknown }).error;
  signal?.throwIfAborted();
  return out;
}

// Refusals that mean the user may no longer read the org: leave it out of the list.
const GONE = new Set(['NOT_A_MEMBER', 'SESSION_REVOKED_IN_ORG']);

// The home screen: the user's orgs (the same list as me.get), each with its figures read in its own context, and how
// many orgs the user has, so a list cut at MAX_CLIENT_ORGS says so. Any other failure of one org fails the whole
// answer, so the screen never shows a partial list as if it were complete.
export async function clientOverviews(runtime: Runtime, actor: UserActor, options: { signal?: AbortSignal } = {}): Promise<ClientOverviews> {
  const all = await runtime.forUser(actor, (db) => sessionOrgs(db, actor.userId, actor.sessionId ?? null));
  const orgs = all.slice(0, MAX_CLIENT_ORGS);
  const rows = await mapLimit(
    orgs,
    OVERVIEW_CONCURRENCY,
    async (org): Promise<ClientOverview | null> => {
      try {
        const overview = await runtime.query<OrgOverview>('kernel.org.overview', {}, { actor, orgId: org.orgId });
        return { ...org, overview };
      } catch (error) {
        if (error instanceof DomainError && GONE.has(error.code)) return null;
        throw error;
      }
    },
    options.signal,
  );
  return { clients: rows.filter((row): row is ClientOverview => row !== null), total: all.length };
}
