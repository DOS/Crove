// oRPC implementation of @crove/kernel-contract. Handlers only call the runtime (execute/query).
import { implement, ORPCError } from '@orpc/server';
import { RPCHandler } from '@orpc/server/fetch';
import { contract } from '@crove/kernel-contract';
import { BlueskyError, ConnectorError, connectBluesky, newOAuthAttempt, oauthStateHash, sandbox, type OAuthConnector } from '@crove/channel';
import type { SocialWriter, WriterChannel } from '@crove/agent';
import { CAPABILITIES, isProvider as isSocialProvider } from '@crove/mod-social/contract';
import {
  createOrg,
  myOrgs,
  previewInvite,
  revokeOwnSessionsWithoutOrg,
  sessionOrgs,
  upstreamAuth,
  type AcceptedInvite,
  type BulkApproveResult,
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

// Drafts Social posts with the deployment's model (SocialWriter in @crove/agent); unset: AI drafting is off.
export type SocialDrafter = Pick<SocialWriter, 'draft'>;

// What the writer is told about a channel: the limits the channel rules check afterwards.
function writerChannel(c: { id: string; provider: string; displayName: string }): WriterChannel {
  const caps = isSocialProvider(c.provider) ? CAPABILITIES[c.provider] : null;
  return {
    key: c.id,
    provider: c.provider,
    label: `${PROVIDER_LABELS[c.provider] ?? c.provider} (${c.displayName})`,
    maxChars: caps?.body.max ?? null,
    unit: caps?.body.count === 'bytes' ? 'bytes' : 'characters',
    title: caps?.title ? { required: caps.title.required, max: caps.title.max } : null,
  };
}

const PROVIDER_LABELS: Record<string, string> = { sandbox: 'test channel', facebook_page: 'Facebook Page', instagram: 'Instagram', zalo_oa: 'Zalo Official Account (article)', tiktok: 'TikTok', youtube: 'YouTube', threads: 'Threads', linkedin: 'LinkedIn', x: 'X', bluesky: 'Bluesky' };

export interface RpcChannels {
  // Seals tokens before kernel.channel.connect stores them; never opens one in the API.
  broker: CredentialBroker;
  // The offline sandbox channel is enabled (CHANNEL_SANDBOX).
  sandbox: boolean;
  // Bluesky accounts may connect with an app password (CHANNEL_BLUESKY).
  bluesky?: boolean;
  // Providers connected through an OAuth dialog that this deployment configured (Social plan S6), by provider id.
  connectors?: Readonly<Partial<Record<string, OAuthConnector>>>;
  // PUBLIC_URL: the provider sends the browser back to PUBLIC_URL/channels/oauth/:provider/callback.
  publicUrl?: string;
}

// A provider's refusal or failure during the code exchange, as the answer the user sees. Never the provider's own
// message: it is logged, and the user gets a fixed text.
function connectorFailure(error: unknown): DomainError {
  if (error instanceof ConnectorError) {
    console.warn(`[channels] OAuth exchange failed: ${error.kind}${error.code ? ` (${error.code})` : ''}: ${error.message}`);
    if (error.kind === 'invalid_grant') return new DomainError('OAUTH_CODE_REJECTED', 400, 'Nền tảng từ chối mã cấp quyền (đã dùng hoặc hết hạn), hãy kết nối lại');
    if (error.kind === 'denied') return new DomainError('OAUTH_PERMISSION_MISSING', 422, 'Bạn chưa cấp đủ quyền cần thiết trong hộp thoại của nền tảng, hãy kết nối lại và chấp nhận mọi quyền');
    return new DomainError('OAUTH_PROVIDER_FAILED', 503, 'Nền tảng không phản hồi đúng, hãy thử lại sau');
  }
  console.error('[channels] OAuth exchange failed', error instanceof Error ? error.name : typeof error);
  return new DomainError('OAUTH_PROVIDER_FAILED', 503, 'Nền tảng không phản hồi đúng, hãy thử lại sau');
}

// sendInviteMail unset: invite mail is off (tests, or an embedder without mail). channels unset: no channel can be
// connected through the API (the list and disconnect still work).
export function createRpcHandler(runtime: Runtime, sendInviteMail?: SendInviteMail, channels?: RpcChannels, socialWriter?: SocialDrafter) {
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

  // The connector of an OAuth provider this deployment configured, for an owner or admin of the org in the header.
  // The commands check the role again; checking first keeps a member from learning how the deployment is set up.
  const oauthConnector = async (context: RpcContext, provider: string) => {
    const { orgId, role } = await resolveMembership(runtime, context.user, context.orgSlug);
    if (role !== 'owner' && role !== 'admin') throw new DomainError('FORBIDDEN', 403, 'Chỉ chủ sở hữu hoặc quản trị viên mới kết nối được kênh');
    const connector = channels?.connectors?.[provider];
    if (!channels || !connector) throw new DomainError('CHANNEL_PROVIDER_DISABLED', 404, 'Kênh này chưa được cấu hình trên máy chủ');
    // Checked before an attempt is written or used up: without a key the tokens could never be sealed, and the user
    // would go through the provider's dialog for nothing.
    if (channels.broker.id === 'none') throw new DomainError('BROKER_NOT_CONFIGURED', 503, 'Chưa cấu hình khóa mã hóa thông tin kết nối (CREDENTIAL_KEY)');
    return { orgId, actor: actorOf(context.user), connector, broker: channels.broker };
  };
  const oauthRedirectUri = (provider: string) => `${(channels?.publicUrl ?? '').replace(/\/$/, '')}/channels/oauth/${provider}/callback`;

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
        repost: os.social.posts.repost.handler(socialCommand('social.post.repost')),
        setEvergreen: os.social.posts.setEvergreen.handler(socialCommand('social.post.set_evergreen')),
        draftWithAi: os.social.posts.draftWithAi.handler(({ context, input }) =>
          inSocial(context, async (orgId, actor) => {
            // The model costs money: only those who may write posts get to call it, checked before anything else (the
            // create command checks the role again).
            const { role } = await resolveMembership(runtime, context.user, context.orgSlug);
            if (role !== 'owner' && role !== 'admin' && role !== 'member') throw new DomainError('FORBIDDEN', 403, 'Vai trò chỉ xem không soạn được bài');
            if (!socialWriter) throw new DomainError('AI_NOT_CONFIGURED', 503, 'Máy chủ chưa cấu hình AI (AI_BASE_URL, AI_MODEL)');
            if (new Set(input.connectionIds).size !== input.connectionIds.length) throw new DomainError('CHANNEL_ALREADY_IN_POST', 409, 'Mỗi kênh chỉ có một bản trong bài đăng');
            const connections = await runtime.query<{ id: string; provider: string; displayName: string; status: string }[]>('kernel.channel.list', {}, { actor, orgId });
            const chosen = input.connectionIds.map((id) => connections.find((c) => c.id === id && c.status === 'active'));
            if (chosen.some((c) => !c)) throw new DomainError('CHANNEL_NOT_FOUND', 404, 'Có kênh không tồn tại hoặc đã ngắt kết nối');
            const channels = (chosen as { id: string; provider: string; displayName: string }[]).map((c) => writerChannel(c));
            const draft = await socialWriter.draft({ brief: input.brief, channels, language: input.language ?? 'vi', ...(input.tone ? { tone: input.tone } : {}) }).catch((error: unknown) => {
              console.error('[social-ai] draft failed', error instanceof Error ? error.name : typeof error);
              throw new DomainError('AI_DRAFT_FAILED', 503, 'AI không soạn được bài lúc này, hãy thử lại sau');
            });
            if (!draft) throw new DomainError('AI_DRAFT_EMPTY', 422, 'AI không soạn được bài từ mô tả này, hãy viết rõ hơn');
            const own = new Map(draft.variants.map((v) => [v.key, v]));
            const created = await runtime.execute<{ postId: string }>(
              'social.post.create',
              {
                body: draft.body,
                title: draft.title,
                origin: 'ai',
                channels: input.connectionIds.map((connectionId) => {
                  const v = own.get(connectionId);
                  return { connectionId, ...(v?.body ? { body: v.body } : {}), ...(v?.title ? { title: v.title } : {}) };
                }),
              },
              { actor, orgId },
            );
            return { postId: created.postId };
          }),
        ),
      },
      variants: {
        update: os.social.variants.update.handler(socialCommand('social.variant.update')),
        decide: os.social.variants.decide.handler(socialCommand('social.variant.decide')),
        schedule: os.social.variants.schedule.handler(socialCommand('social.variant.schedule')),
        unschedule: os.social.variants.unschedule.handler(socialCommand('social.variant.unschedule')),
        cancel: os.social.variants.cancel.handler(socialCommand('social.variant.cancel')),
        retry: os.social.variants.retry.handler(socialCommand('social.variant.retry')),
        resolve: os.social.variants.resolve.handler(socialCommand('social.variant.resolve')),
      },
      metrics: {
        summary: os.social.metrics.summary.handler(socialQuery('social.metrics.summary')),
      },
      media: {
        list: os.social.media.list.handler(socialQuery('social.media.list')),
        usage: os.social.media.usage.handler(socialQuery('social.media.usage')),
      },
      policies: {
        list: os.social.policies.list.handler(socialQuery('social.channel.policies')),
        set: os.social.policies.set.handler(socialCommand('social.channel.set_policy')),
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
      // An app password is checked once by opening a session, then sealed with the account's DID and dropped; it never
      // reaches a log, an audit row or an answer.
      connectBluesky: os.channels.connectBluesky.handler(({ context, input }) =>
        guard(async () => {
          const { orgId, role } = await resolveMembership(runtime, context.user, context.orgSlug);
          if (role !== 'owner' && role !== 'admin') throw new DomainError('FORBIDDEN', 403, 'Chỉ chủ sở hữu hoặc quản trị viên mới kết nối được kênh');
          if (!channels?.bluesky) throw new DomainError('CHANNEL_PROVIDER_DISABLED', 404, 'Kênh này chưa được bật trên máy chủ');
          if (channels.broker.id === 'none') throw new DomainError('BROKER_NOT_CONFIGURED', 503, 'Chưa cấu hình khóa mã hóa thông tin kết nối (CREDENTIAL_KEY)');
          const account = await connectBluesky({ handle: input.handle, appPassword: input.appPassword }).catch((error: unknown) => {
            if (error instanceof BlueskyError) {
              if (error.code === 'NotAnAppPassword') throw new DomainError('BLUESKY_APP_PASSWORD', 422, 'Hãy dùng mật khẩu ứng dụng (app password) của Bluesky, không dùng mật khẩu tài khoản');
              if (error.code === 'UnsupportedPds') throw new DomainError('BLUESKY_PDS_UNSUPPORTED', 422, 'Hiện Crove chỉ hỗ trợ tài khoản lưu trên máy chủ của Bluesky');
              if (error.status === 401 || error.status === 400) throw new DomainError('BLUESKY_LOGIN_FAILED', 422, 'Bluesky không chấp nhận tên tài khoản hoặc mật khẩu ứng dụng này');
            }
            throw new DomainError('OAUTH_PROVIDER_FAILED', 503, 'Nền tảng không phản hồi đúng, hãy thử lại sau');
          });
          const sealed = channels.broker.seal(account.secret, { orgId, provider: account.provider, externalAccountId: account.externalAccountId });
          const command: ChannelConnectInput = {
            provider: account.provider,
            externalAccountId: account.externalAccountId,
            displayName: account.displayName,
            scopes: account.scopes,
            expiresAt: null,
            credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') },
          };
          return runtime.execute<{ connectionId: string; reconnected: boolean }>('kernel.channel.connect', command, { actor: actorOf(context.user), orgId });
        }),
      ),
      // The state and the PKCE verifier are made here; only the state's hash and the verifier reach the database.
      oauthStart: os.channels.oauthStart.handler(({ context, input }) =>
        guard(async () => {
          const { orgId, actor, connector } = await oauthConnector(context, input.provider);
          const attempt = newOAuthAttempt(connector.pkce);
          const begun = await runtime.execute<{ attemptId: string; expiresAt: string }>(
            'kernel.channel.oauth_begin',
            { provider: input.provider, stateHash: attempt.stateHash, codeVerifier: attempt.codeVerifier },
            { actor, orgId },
          );
          const authorizeUrl = connector.authorizeUrl({ state: attempt.state, redirectUri: oauthRedirectUri(input.provider), codeChallenge: attempt.codeChallenge });
          return { authorizeUrl, state: attempt.state, expiresAt: begun.expiresAt };
        }),
      ),
      // The attempt is consumed before the code is exchanged, so a code and state work once even if the exchange
      // fails. The tokens the provider returns are sealed here and dropped; only envelopes reach the command.
      oauthFinish: os.channels.oauthFinish.handler(({ context, input }) =>
        guard(async () => {
          const { orgId, actor, connector, broker } = await oauthConnector(context, input.provider);
          const { codeVerifier } = await runtime.execute<{ codeVerifier: string | null }>(
            'kernel.channel.oauth_consume',
            { provider: input.provider, stateHash: oauthStateHash(input.state) },
            { actor, orgId },
          );
          if (connector.pkce && !codeVerifier) throw new DomainError('OAUTH_STATE_INVALID', 400, 'Lượt kết nối này không hợp lệ hoặc không phải của bạn, hãy bắt đầu lại');
          const accounts = await connector.exchange({ code: input.code, redirectUri: oauthRedirectUri(input.provider), codeVerifier }).catch((error: unknown) => {
            throw connectorFailure(error);
          });
          if (accounts.length === 0) throw new DomainError('CHANNEL_NO_ACCOUNTS', 422, 'Không có tài khoản nào bạn được quyền đăng bài trong lần cấp quyền này');
          const connections: { connectionId: string; displayName: string; reconnected: boolean }[] = [];
          for (const account of accounts) {
            const sealed = broker.seal(account.secret, { orgId, provider: account.provider, externalAccountId: account.externalAccountId });
            const command: ChannelConnectInput = {
              provider: account.provider,
              externalAccountId: account.externalAccountId,
              displayName: account.displayName,
              scopes: account.scopes,
              expiresAt: account.expiresAt?.toISOString() ?? null,
              credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') },
            };
            const done = await runtime.execute<{ connectionId: string; reconnected: boolean }>('kernel.channel.connect', command, { actor, orgId });
            connections.push({ connectionId: done.connectionId, displayName: account.displayName, reconnected: done.reconnected });
          }
          return { connections };
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
      approveMany: os.inbox.approveMany.handler(({ context, input }) =>
        inOrg(context, async (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          const { results } = await runtime.execute<{ results: BulkApproveResult[] }>('kernel.proposal.approve_many', rest, { actor, orgId, idempotencyKey });
          return {
            results: results.map((r) => {
              if (r.outcome === 'refused') return r;
              const ids = r.result as { journalEntryId?: string; documentId?: string; reversedEntryId?: string; voidedDocumentId?: string };
              return {
                id: r.id,
                outcome: r.outcome,
                ...(ids.journalEntryId ? { journalEntryId: ids.journalEntryId } : {}),
                ...(ids.documentId ? { documentId: ids.documentId } : {}),
                ...(ids.reversedEntryId ? { reversedEntryId: ids.reversedEntryId } : {}),
                ...(ids.voidedDocumentId ? { voidedDocumentId: ids.voidedDocumentId } : {}),
              };
            }),
          };
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
      batch: os.files.batch.handler(({ context, input }) =>
        inOrg(context, (orgId, actor) => runtime.query('kernel.files.batch', input, { actor, orgId })),
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
      setDefaultAccount: os.parties.setDefaultAccount.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.execute('finance.vendor.set_default_account', input, { actor, orgId })),
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
    openingBalance: {
      preview: os.openingBalance.preview.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.opening_balance.preview', input, { actor, orgId })),
      ),
      post: os.openingBalance.post.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('finance.opening_balance.post', rest, { actor, orgId, idempotencyKey });
        }),
      ),
    },
    accounts: {
      list: os.accounts.list.handler(({ context }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.accounts.list', {}, { actor, orgId })),
      ),
      create: os.accounts.create.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.execute('finance.account.create', input, { actor, orgId })),
      ),
      update: os.accounts.update.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.execute('finance.account.update', input, { actor, orgId })),
      ),
    },
    vat: {
      period: os.vat.period.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.vat.period', input, { actor, orgId })),
      ),
    },
    ledger: {
      period: os.ledger.period.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.ledger.period', input, { actor, orgId })),
      ),
      account: os.ledger.account.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.ledger.account', input, { actor, orgId })),
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
