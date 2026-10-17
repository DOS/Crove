// oRPC implementation of @crove/kernel-contract. Handlers only call the runtime (execute/query).
import { implement, ORPCError } from '@orpc/server';
import { RPCHandler } from '@orpc/server/fetch';
import { contract } from '@crove/kernel-contract';
import { sandbox } from '@crove/channel';
import {
  createOrg,
  myOrgs,
  previewInvite,
  revokeOwnSessionsWithoutOrg,
  sessionOrgs,
  upstreamAuth,
  type AcceptedInvite,
  type ChannelConnectInput,
  type OrgSummary,
} from '@crove/kernel';
import type { z } from 'zod';
import type { zAgentBudget, zAgentTemplate, zTask } from '@crove/kernel-contract';
import { DomainError, type CredentialBroker, type Runtime, type UserActor } from '@crove/kernel-runtime';
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

export interface RpcChannels {
  // Seals tokens before kernel.channel.connect stores them; never opens one in the API.
  broker: CredentialBroker;
  // The offline sandbox channel is enabled (CHANNEL_SANDBOX).
  sandbox: boolean;
}

// sendInviteMail unset: invite mail is off (tests, or an embedder without mail). channels unset: no channel can be
// connected through the API (the list and disconnect still work).
export function createRpcHandler(runtime: Runtime, sendInviteMail?: SendInviteMail, channels?: RpcChannels) {
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
  // A procedure of a module this deployment leaves out (CROVE_MODULES, plan Decision 12) answers like a route that
  // does not exist, before any database work. The contract is shared, so the procedure stays in the router.
  const finance = runtime.installed('finance');
  // A command that takes an idempotency key: the key travels in the options, never in the command's input.
  const keyed = <O, I extends { idempotencyKey: string } = { idempotencyKey: string }>(context: RpcContext, name: string, input: I): Promise<O> =>
    inOrg(context, (orgId, actor) => {
      const { idempotencyKey, ...rest } = input;
      return runtime.execute<O>(name, rest, { actor, orgId, idempotencyKey });
    });
  const inFinance = async <T>(context: RpcContext, fn: (orgId: string, actor: UserActor) => Promise<T>) => {
    if (!finance) throw new ORPCError('NOT_FOUND', { status: 404, message: 'Mô-đun tài chính chưa được bật' });
    return inOrg(context, fn);
  };

  const social = runtime.installed('social');
  const inSocial = async <T>(context: RpcContext, fn: (orgId: string, actor: UserActor) => Promise<T>) => {
    if (!social) throw new ORPCError('NOT_FOUND', { status: 404, message: 'Mô-đun mạng xã hội chưa được bật' });
    return inOrg(context, fn);
  };
  // The command or query checks the input again and its answer has the contract's shape (oRPC validates it).
  const socialCommand =
    (name: string) =>
    <I, O>({ context, input }: { context: RpcContext; input: I }): Promise<O> =>
      inSocial(context, (orgId, actor) => runtime.execute<O>(name, input, { actor, orgId }));
  const socialQuery =
    (name: string) =>
    <I, O>({ context, input }: { context: RpcContext; input: I }): Promise<O> =>
      inSocial(context, (orgId, actor) => runtime.query<O>(name, input, { actor, orgId }));

  const router = os.router({
    me: {
      get: os.me.get.handler(({ context }) =>
        guard(async () => ({
          userId: context.user.userId,
          email: context.user.email,
          displayName: context.user.name,
          orgs: await runtime.forUser(actorOf(context.user), (db) => sessionOrgs(db, context.user.userId, context.user.sessionId ?? null)),
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
    social: {
      posts: {
        list: os.social.posts.list.handler(socialQuery('social.post.list')),
        get: os.social.posts.get.handler(socialQuery('social.post.get')),
        create: os.social.posts.create.handler(({ context, input }) =>
          inSocial(context, (orgId, actor) => {
            const { idempotencyKey, ...rest } = input;
            return runtime.execute('social.post.create', rest, { actor, orgId, idempotencyKey });
          }),
        ),
        update: os.social.posts.update.handler(socialCommand('social.post.update')),
        addChannels: os.social.posts.addChannels.handler(socialCommand('social.post.add_channels')),
        submit: os.social.posts.submit.handler(socialCommand('social.post.submit')),
      },
      variants: {
        update: os.social.variants.update.handler(socialCommand('social.variant.update')),
        decide: os.social.variants.decide.handler(socialCommand('social.variant.decide')),
        schedule: os.social.variants.schedule.handler(socialCommand('social.variant.schedule')),
        unschedule: os.social.variants.unschedule.handler(socialCommand('social.variant.unschedule')),
        cancel: os.social.variants.cancel.handler(socialCommand('social.variant.cancel')),
      },
      queues: {
        get: os.social.queues.get.handler(socialQuery('social.queue.get')),
        set: os.social.queues.set.handler(socialCommand('social.queue.set')),
      },
    },
    channels: {
      list: os.channels.list.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.query('kernel.channel.list', input, { actor, orgId }))),
      // The token is made and sealed here and only the envelope reaches the command. No idempotency key: every seal
      // differs, and connecting the same sandbox key again is already a reconnect of the same account.
      connectSandbox: os.channels.connectSandbox.handler(({ context, input }) =>
        guard(async () => {
          const { orgId, role } = await resolveMembership(runtime, context.user, context.orgSlug);
          const actor = actorOf(context.user);
          // The command checks the role again; checking first keeps a member from learning how the deployment is set up.
          if (role !== 'owner' && role !== 'admin') throw new DomainError('FORBIDDEN', 403, 'Chỉ chủ sở hữu hoặc quản trị viên mới kết nối được kênh');
          if (!channels?.sandbox) throw new DomainError('CHANNEL_PROVIDER_DISABLED', 404, 'Kênh thử nghiệm (sandbox) chưa được bật');
          const account = sandbox.connect({ key: input.key, displayName: input.displayName });
          const sealed = channels.broker.seal(account.secret, { orgId, provider: account.provider, externalAccountId: account.externalAccountId });
          const command: ChannelConnectInput = {
            provider: account.provider,
            externalAccountId: account.externalAccountId,
            displayName: account.displayName,
            scopes: account.scopes,
            expiresAt: account.expiresAt?.toISOString() ?? null,
            credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') },
          };
          return runtime.execute('kernel.channel.connect', command, { actor, orgId });
        }),
      ),
      disconnect: os.channels.disconnect.handler(({ context, input }) =>
        inOrg(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('kernel.channel.disconnect', rest, { actor, orgId, idempotencyKey });
        }),
      ),
    },
    // Org-less: the invite names the org, so the x-crove-org header is ignored here.
    invites: {
      peek: os.invites.peek.handler(({ context, input }) =>
        guard(() =>
          runtime.forUser(actorOf(context.user), (db) =>
            previewInvite(db, context.user.userId, input.token, { upstream: upstreamAuth(runtime.sessionMode) }),
          ),
        ),
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
        // A user's own revoke needs no org (issue #184: sign-out on the onboarding and invite pages); anyone else's
        // is org-scoped and still answers ORG_REQUIRED without one.
        !context.orgSlug && input.userId === context.user.userId
          ? guard(() => revokeOwnSessionsWithoutOrg(runtime, actorOf(context.user), input))
          : inOrg(context, (orgId, actor) => runtime.execute('kernel.session.revoke', input, { actor, orgId })),
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
      // Today only a journal reversal can be asked for, a finance command.
      request: os.inbox.request.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('kernel.proposal.request', rest, { actor, orgId, idempotencyKey });
        }),
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
        inFinance(context, (orgId, actor) => runtime.query('finance.vendors.list', input, { actor, orgId })),
      ),
    },
    documents: {
      list: os.documents.list.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.documents.list', input, { actor, orgId })),
      ),
    },
    journal: {
      list: os.journal.list.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.journal.list', input, { actor, orgId })),
      ),
      get: os.journal.get.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.journal.get', input, { actor, orgId })),
      ),
    },
    accounts: {
      list: os.accounts.list.handler(({ context }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.accounts.list', {}, { actor, orgId })),
      ),
    },
    vat: {
      period: os.vat.period.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.vat.period', input, { actor, orgId })),
      ),
    },
    // AI agents (ADR-0029). The kernel module owns them; a template of a module that is off answers MODULE_DISABLED.
    chart: {
      get: os.chart.get.handler(({ context }) => inOrg(context, (orgId, actor) => runtime.query('kernel.chart.get', {}, { actor, orgId }))),
      createPosition: os.chart.createPosition.handler(({ context, input }) => keyed(context, 'kernel.position.create', input)),
      updatePosition: os.chart.updatePosition.handler(({ context, input }) => keyed(context, 'kernel.position.update', input)),
      assign: os.chart.assign.handler(({ context, input }) => keyed(context, 'kernel.position.assign', input)),
      templates: os.chart.templates.handler(({ context }) =>
        inOrg(context, async (orgId, actor) => (await runtime.query<{ templates: z.infer<typeof zAgentTemplate>[] }>('kernel.agent.templates.list', {}, { actor, orgId })).templates),
      ),
      installTemplate: os.chart.installTemplate.handler(({ context, input }) => keyed(context, 'kernel.agent.template.install', input)),
    },
    agents: {
      update: os.agents.update.handler(({ context, input }) => keyed(context, 'kernel.agent.update', input)),
      budgets: os.agents.budgets.handler(({ context }) =>
        inOrg(context, async (orgId, actor) => (await runtime.query<{ budgets: z.infer<typeof zAgentBudget>[] }>('kernel.agent.budgets.list', {}, { actor, orgId })).budgets),
      ),
      setBudget: os.agents.setBudget.handler(({ context, input }) => keyed(context, 'kernel.agent.budget.set', input)),
      stop: os.agents.stop.handler(({ context, input }) => keyed(context, 'kernel.agent.kill_switch.engage', input)),
      release: os.agents.release.handler(({ context, input }) => keyed(context, 'kernel.agent.kill_switch.release', input)),
    },
    tasks: {
      list: os.tasks.list.handler(({ context, input }) =>
        inOrg(context, async (orgId, actor) => (await runtime.query<{ tasks: z.infer<typeof zTask>[] }>('kernel.task.list', input, { actor, orgId })).tasks),
      ),
      get: os.tasks.get.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.query('kernel.task.get', input, { actor, orgId }))),
      create: os.tasks.create.handler(({ context, input }) => keyed(context, 'kernel.task.create', input)),
      comment: os.tasks.comment.handler(({ context, input }) => keyed(context, 'kernel.task.comment', input)),
      setStatus: os.tasks.setStatus.handler(({ context, input }) => keyed(context, 'kernel.task.set_status', input)),
    },
  });

  return new RPCHandler(router);
}
