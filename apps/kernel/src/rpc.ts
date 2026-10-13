// oRPC implementation of @crove/kernel-contract. Handlers only call the runtime (execute/query).
import { implement, ORPCError } from '@orpc/server';
import { RPCHandler } from '@orpc/server/fetch';
import { contract } from '@crove/kernel-contract';
import { createOrg, myOrgs, type OrgSummary } from '@crove/kernel';
import { DomainError, type Runtime } from '@crove/kernel-runtime';
import type { AuthUser } from './auth.ts';

export interface RpcContext {
  user: AuthUser;
  orgSlug: string | null;
}

export function toORPCError(error: unknown): ORPCError<string, unknown> {
  if (error instanceof ORPCError) return error;
  const domain = error instanceof DomainError ? error : new DomainError('INTERNAL', 500, 'Lỗi hệ thống');
  return new ORPCError(domain.code, { status: domain.status, message: domain.message, data: domain.details });
}

export async function resolveMembership(runtime: Runtime, user: AuthUser, slug: string | null): Promise<OrgSummary> {
  if (!slug) throw new DomainError('ORG_REQUIRED', 400, 'Thiếu tổ chức (header x-crove-org)');
  const orgs = await runtime.orgless((db) => myOrgs(db, user.userId));
  const org = orgs.find((o) => o.slug === slug);
  if (!org) throw new DomainError('NOT_A_MEMBER', 403, 'Bạn không thuộc tổ chức này');
  return org;
}

export async function resolveOrg(runtime: Runtime, user: AuthUser, slug: string | null): Promise<string> {
  return (await resolveMembership(runtime, user, slug)).orgId;
}

export function createRpcHandler(runtime: Runtime) {
  const os = implement(contract).$context<RpcContext>();

  const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      throw toORPCError(error);
    }
  };
  const inOrg = async <T>(context: RpcContext, fn: (orgId: string, actor: { type: 'user'; userId: string }) => Promise<T>) =>
    guard(async () => fn(await resolveOrg(runtime, context.user, context.orgSlug), { type: 'user', userId: context.user.userId }));

  const router = os.router({
    me: {
      get: os.me.get.handler(({ context }) =>
        guard(async () => ({
          userId: context.user.userId,
          email: context.user.email,
          displayName: context.user.name,
          orgs: await runtime.orgless((db) => myOrgs(db, context.user.userId)),
        })),
      ),
    },
    org: {
      create: os.org.create.handler(({ context, input }) => guard(() => createOrg(runtime, context.user.userId, input.name))),
      get: os.org.get.handler(({ context }) => inOrg(context, (orgId, actor) => runtime.query('kernel.org.get', {}, { actor, orgId }))),
      addMember: os.org.addMember.handler(({ context, input }) =>
        inOrg(context, (orgId, actor) => runtime.execute('kernel.member.add', input, { actor, orgId })),
      ),
    },
    inbox: {
      list: os.inbox.list.handler(({ context, input }) =>
        inOrg(context, (orgId, actor) => runtime.query('kernel.inbox.list', input, { actor, orgId })),
      ),
      get: os.inbox.get.handler(({ context, input }) =>
        inOrg(context, (orgId, actor) => runtime.query('kernel.inbox.get', input, { actor, orgId })),
      ),
      approve: os.inbox.approve.handler(({ context, input }) =>
        inOrg(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('kernel.proposal.approve', rest, { actor, orgId, idempotencyKey });
        }),
      ),
      reject: os.inbox.reject.handler(({ context, input }) =>
        inOrg(context, (orgId, actor) => runtime.execute('kernel.proposal.reject', input, { actor, orgId })),
      ),
    },
    files: {
      recent: os.files.recent.handler(({ context }) =>
        inOrg(context, (orgId, actor) => runtime.query('kernel.files.recent', {}, { actor, orgId })),
      ),
    },
    parties: {
      list: os.parties.list.handler(({ context, input }) =>
        inOrg(context, (orgId, actor) => runtime.query('finance.vendors.list', input, { actor, orgId })),
      ),
    },
    documents: {
      list: os.documents.list.handler(({ context, input }) =>
        inOrg(context, (orgId, actor) => runtime.query('finance.documents.list', input, { actor, orgId })),
      ),
    },
    journal: {
      list: os.journal.list.handler(({ context, input }) =>
        inOrg(context, (orgId, actor) => runtime.query('finance.journal.list', input, { actor, orgId })),
      ),
    },
    accounts: {
      list: os.accounts.list.handler(({ context }) =>
        inOrg(context, (orgId, actor) => runtime.query('finance.accounts.list', {}, { actor, orgId })),
      ),
    },
  });

  return new RPCHandler(router);
}
