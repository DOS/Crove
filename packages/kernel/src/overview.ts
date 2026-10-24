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
// tax-code.ts); the rest of its tax calendar (#921) by kernel.tax_profile.save (tax-calendar.ts).
//
// Modules add their own figures (#1261) through an overview contribution: a query the module registers, named to the
// kernel by the composition root for the modules CROVE_MODULES enables, so the kernel never imports a module. Each runs
// with ctx.query in the org's own transaction, as the member (their role, and whatever the module's own rules hide
// from them), so its figures are the ones the member would see on that org's screens. An org whose figures cannot be
// read (an error, the statement timeout) is one error row, not a failed screen (#495).
import { sql } from 'kysely';
import { z } from 'zod';
import { nextVatDeadline, vietnamToday, type TaxDueView, type VatDeadline, type VatFilingPeriod } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineQuery, type Runtime, type UserActor } from '@crove/kernel-runtime';
import { fileStatuses } from './file-status.ts';
import { sessionOrgs } from './commands.ts';
import { taxDuesOf } from './tax-calendar.ts';
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
  // The tax calendar (#921): what is due in the next 30 days or overdue and not marked done, by due date.
  taxDues: TaxDueView[];
  // Each contributing module's figures by its module id (#1261); a module this deployment leaves out has no key.
  modules: Record<string, unknown>;
}

// A module's figures on the home screen (#1261): `query` is one of the module's registered queries, taking {}, whose
// answer is kept under `module` in OrgOverview.modules. The composition root passes the contributions of the enabled
// modules to kernelQueries; a contribution whose module the runtime does not register adds nothing.
export interface OverviewContribution {
  readonly module: string;
  readonly query: string;
}

// One org on the home screen: its figures, or, when they could not be read, null and the error's code (#495), so the
// other orgs still show.
export type ClientOverview = OrgSummary & ({ overview: OrgOverview; error: null } | { overview: null; error: string });

// total: the orgs the user has, of which the first MAX_CLIENT_ORGS are read (#495).
export interface ClientOverviews {
  clients: ClientOverview[];
  total: number;
}

export function orgOverviewQuery(options: { now?: () => Date; contributions?: readonly OverviewContribution[] } = {}) {
  const now = options.now ?? (() => new Date());
  const contributions = options.contributions ?? [];
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
      const modules: Record<string, unknown> = {};
      for (const c of contributions) {
        const answer = await ctx.query<unknown>(c.query, {});
        if (answer.status === 'ok') modules[c.module] = answer.value;
      }
      return {
        pendingProposals: Number(pending.n),
        failedFiles: files.filter((f) => f.status.status === 'failed').length,
        lastActivityAt: last.at ? new Date(last.at).toISOString() : null,
        vatFilingPeriod: period,
        vatDeadline: period ? nextVatDeadline(period, vietnamToday(now())) : null,
        taxDues: await taxDuesOf(ctx, period, vietnamToday(now())),
        modules,
      };
    },
  });
}

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

// After this many server failures in a row (status 500 or above, or no domain error at all), the store is taken as down:
// the answer fails at once instead of opening a transaction for every other org (#1261 review).
export const OVERVIEW_FAIL_FAST = 3;

// Refusals that mean the user may no longer read the org: leave it out of the list.
const GONE = new Set(['NOT_A_MEMBER', 'SESSION_REVOKED_IN_ORG']);

// The home screen: the user's orgs (the same list as me.get), each with its figures read in its own context, and how
// many orgs the user has, so a list cut at MAX_CLIENT_ORGS says so. An org whose figures fail is an error row with the
// error's code (#495), so one slow or broken org no longer fails the screen; a refusal of the user themselves (no
// session or a revoked one, 401) still fails the answer, since every other org would refuse them too, and so do
// OVERVIEW_FAIL_FAST server failures in a row (503 OVERVIEW_UNAVAILABLE). Failures are logged once per answer: the
// first with its org, and how many there were.
export async function clientOverviews(runtime: Runtime, actor: UserActor, options: { signal?: AbortSignal } = {}): Promise<ClientOverviews> {
  const all = await runtime.forUser(actor, (db) => sessionOrgs(db, actor.userId, actor.sessionId ?? null));
  const orgs = all.slice(0, MAX_CLIENT_ORGS);
  let failures = 0;
  let streak = 0;
  let first: { orgId: string; error: unknown } | null = null;
  const log = () => {
    if (first) console.error(`[clients] ${failures} org overview(s) failed; the first, of org ${first.orgId}:`, first.error);
  };
  let rows: (ClientOverview | null)[];
  try {
    rows = await mapLimit(
      orgs,
      OVERVIEW_CONCURRENCY,
      async (org): Promise<ClientOverview | null> => {
        try {
          const overview = await runtime.query<OrgOverview>('kernel.org.overview', {}, { actor, orgId: org.orgId });
          streak = 0;
          return { ...org, overview, error: null };
        } catch (error) {
          if (error instanceof DomainError && GONE.has(error.code)) return null;
          if (error instanceof DomainError && error.status === 401) throw error;
          // The client went away: the answer fails once the orgs already running finish.
          if (options.signal?.aborted) throw error;
          if (!(error instanceof DomainError) || error.status >= 500) {
            failures += 1;
            streak += 1;
            first ??= { orgId: org.orgId, error };
            if (streak >= OVERVIEW_FAIL_FAST) {
              throw new DomainError('OVERVIEW_UNAVAILABLE', 503, 'Chưa tải được số liệu các doanh nghiệp, hãy thử lại sau ít phút', { retryAfterSeconds: 10 });
            }
          }
          return { ...org, overview: null, error: error instanceof DomainError ? error.code : 'INTERNAL' };
        }
      },
      options.signal,
    );
  } finally {
    log();
  }
  return { clients: rows.filter((row): row is ClientOverview => row !== null), total: all.length };
}
