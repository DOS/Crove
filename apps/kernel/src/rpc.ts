// oRPC implementation of @crove/kernel-contract. Handlers only call the runtime (execute/query).
import { implement, ORPCError } from '@orpc/server';
import { RPCHandler } from '@orpc/server/fetch';
import { contract } from '@crove/kernel-contract';
import { createOrg, myOrgs, previewInvite, type AcceptedInvite, type OrgSummary } from '@crove/kernel';
import { DomainError, type Runtime, type UserActor } from '@crove/kernel-runtime';
import { actorOf, type AuthUser } from './auth.ts';
import type { InviteRole, SendInviteMail } from './invite-mail.ts';

export interface RpcContext {
  user: AuthUser;
  orgSlug: string | null;
}

export function toORPCError(error: unknown): ORPCError<string, unknown> {
  if (error instanceof ORPCError) return error;
  if (!(error instanceof DomainError) || error.status >= 500) console.error('[rpc]', error);
  const domain = error instanceof DomainError ? error : new DomainError('INTERNAL', 500, 'Lỗi hệ thống');
  return new ORPCError(domain.code, { status: domain.status, message: domain.message, data: domain.details });
}

export async function resolveMembership(runtime: Runtime, user: AuthUser, slug: string | null): Promise<OrgSummary> {
  if (!slug) throw new DomainError('ORG_REQUIRED', 400, 'Thiếu tổ chức (header x-crove-org)');
  const orgs = await runtime.forUser(actorOf(user), (db) => myOrgs(db, user.userId));
  const org = orgs.find((o) => o.slug === slug);
  if (!org) throw new DomainError('NOT_A_MEMBER', 403, 'Bạn không thuộc tổ chức này');
  return org;
}

export async function resolveOrg(runtime: Runtime, user: AuthUser, slug: string | null): Promise<string> {
  return (await resolveMembership(runtime, user, slug)).orgId;
}

interface CreatedInvite {
  inviteId: string;
  email: string;
  role: InviteRole;
  expiresAt: string;
  acceptPath: string;
}

// sendInviteMail unset: invite mail is off (tests, or an embedder without mail).
export function createRpcHandler(runtime: Runtime, sendInviteMail?: SendInviteMail) {
  const os = implement(contract).$context<RpcContext>();

  const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      throw toORPCError(error);
    }
  };
  const inOrg = async <T>(context: RpcContext, fn: (orgId: string, actor: UserActor) => Promise<T>) =>
    guard(async () => fn(await resolveOrg(runtime, context.user, context.orgSlug), actorOf(context.user)));

  const router = os.router({
    me: {
      get: os.me.get.handler(({ context }) =>
        guard(async () => ({
          userId: context.user.userId,
          email: context.user.email,
          displayName: context.user.name,
          orgs: await runtime.forUser(actorOf(context.user), (db) => myOrgs(db, context.user.userId)),
        })),
      ),
    },
    org: {
      create: os.org.create.handler(({ context, input }) =>
        guard(() => createOrg(runtime, actorOf(context.user), input.name, input.idempotencyKey)),
      ),
      get: os.org.get.handler(({ context }) => inOrg(context, (orgId, actor) => runtime.query('kernel.org.get', {}, { actor, orgId }))),
      // No idempotency key: the answer carries the invite token, which must never be stored with a key. The mail
      // goes out after the command has committed (invite-mail.ts says why); its outcome is logged and never changes
      // the answer, which stays the same whether or not the email has an account.
      invite: os.org.invite.handler(({ context, input }) =>
        guard(async () => {
          const org = await resolveMembership(runtime, context.user, context.orgSlug);
          const created = await runtime.execute<CreatedInvite>('kernel.member.invite.create', input, { actor: actorOf(context.user), orgId: org.orgId });
          try {
            await sendInviteMail?.({
              to: created.email,
              orgName: org.name,
              inviterName: context.user.name,
              inviterEmail: context.user.email,
              role: created.role,
              expiresAt: created.expiresAt,
              acceptPath: created.acceptPath,
            });
          } catch (error) {
            console.error(`[mail] invite mail not sent: ${error instanceof Error ? error.name : 'unknown error'}`);
          }
          return created;
        }),
      ),
      listInvites: os.org.listInvites.handler(({ context }) =>
        inOrg(context, (orgId, actor) => runtime.query('kernel.member.invites.list', {}, { actor, orgId })),
      ),
      revokeInvite: os.org.revokeInvite.handler(({ context, input }) =>
        inOrg(context, (orgId, actor) => runtime.execute('kernel.member.invite.revoke', input, { actor, orgId })),
      ),
      rotateInbound: os.org.rotateInbound.handler(({ context, input }) =>
        inOrg(context, async (orgId, actor) => {
          await runtime.execute('kernel.inbound.rotate', {}, { actor, orgId, idempotencyKey: input.idempotencyKey });
          // The current address, not the token stored with the idempotency key: a key replayed after a later
          // rotation must never show a retired address.
          const org = await runtime.query<{ inboundAddress: string | null }>('kernel.org.get', {}, { actor, orgId });
          return { inboundAddress: org.inboundAddress };
        }),
      ),
      changeMemberRole: os.org.changeMemberRole.handler(({ context, input }) =>
        inOrg(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('kernel.member.change_role', rest, { actor, orgId, idempotencyKey });
        }),
      ),
      removeMember: os.org.removeMember.handler(({ context, input }) =>
        inOrg(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('kernel.member.remove', rest, { actor, orgId, idempotencyKey });
        }),
      ),
      offboard: os.org.offboard.handler(({ context, input }) =>
        inOrg(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('kernel.org.offboard', rest, { actor, orgId, idempotencyKey });
        }),
      ),
      export: os.org.export.handler(({ context }) => inOrg(context, (orgId, actor) => runtime.query('kernel.org.export.get', {}, { actor, orgId }))),
    },
    // Org-less: the invite names the org, so the x-crove-org header is ignored here.
    invites: {
      peek: os.invites.peek.handler(({ context, input }) =>
        guard(() => runtime.forUser(actorOf(context.user), (db) => previewInvite(db, context.user.userId, input.token))),
      ),
      accept: os.invites.accept.handler(({ context, input }) =>
        guard(() =>
          runtime.executeOrgless<AcceptedInvite>('kernel.member.invite.accept', { token: input.token }, { actor: actorOf(context.user) }),
        ),
      ),
    },
    sessions: {
      list: os.sessions.list.handler(({ context, input }) =>
        inOrg(context, (orgId, actor) => runtime.query('kernel.sessions.list', input, { actor, orgId })),
      ),
      revoke: os.sessions.revoke.handler(({ context, input }) =>
        inOrg(context, (orgId, actor) => runtime.execute('kernel.session.revoke', input, { actor, orgId })),
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
      edit: os.inbox.edit.handler(({ context, input }) =>
        inOrg(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('kernel.proposal.edit', rest, { actor, orgId, idempotencyKey });
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
      reextract: os.files.reextract.handler(({ context, input }) =>
        inOrg(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('kernel.file.reextract', rest, { actor, orgId, idempotencyKey });
        }),
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
