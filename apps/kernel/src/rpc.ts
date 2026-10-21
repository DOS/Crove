// oRPC implementation of @crove/kernel-contract. Handlers only call the runtime (execute/query).
import { implement, ORPCError } from '@orpc/server';
import { RPCHandler } from '@orpc/server/fetch';
import { OAUTH_MAX_ACCOUNTS_PER_GRANT, contract } from '@crove/kernel-contract';
import { BlueskyError, ConnectorError, blueskyLogin, connectBluesky, connectDiscord, connectMastodon, connectTelegram, connectWordPress, discordLogin, mastodonLogin, telegramLogin, wordpressLogin, newOAuthAttempt, oauthStateHash, sandbox, type OAuthConnector } from '@crove/channel';
import type { SocialWriter, WriterChannel } from '@crove/agent';
import { CAPABILITIES, isProvider as isSocialProvider } from '@crove/mod-social/contract';
import { voiceNotes, type BrandVoice } from '@crove/mod-social';
import {
  clientOverviews,
  createOrg,
  myOrgs,
  previewInvite,
  revokeOwnSessionsWithoutOrg,
  sessionOrgs,
  upstreamAuth,
  type AcceptedInvite,
  type BulkApproveResult,
  type ChannelConnectInput,
  type DirectMail,
  type OrgSummary,
} from '@crove/kernel';
import type { z } from 'zod';
import type { zAgentBudget, zAgentTemplate, zTask } from '@crove/kernel-contract';
import { DomainError, egressFetch, type CredentialBroker, type Runtime, type UserActor } from '@crove/kernel-runtime';
import { DraftBudget } from './ai-draft-limit.ts';
import { BlueskyLoginBudget } from './bluesky-login-limit.ts';
import { actorOf, type AuthUser } from './auth.ts';
import { ConcurrencyLimiter } from './concurrency.ts';
import type { InviteRole, SendInviteMail } from './invite-mail.ts';
import type { Delivery, DeliveryResult } from './mail.ts';
import type { TaxCodeLookup } from './tax-lookup.ts';

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

// The error code a mail_message row gets when the invite mail did not go out: no mail server configured, the server
// refused it or the deadline passed, or the template threw.
const DELIVERY_ERROR: Record<Exclude<Delivery, 'sent'> | 'error', string> = { off: 'MAIL_OFF', failed: 'SEND_FAILED', error: 'SEND_ERROR' };

interface CreatedInvite {
  inviteId: string;
  email: string;
  role: InviteRole;
  expiresAt: string;
  acceptPath: string;
}

// Drafts Social posts with the deployment's model (SocialWriter in @crove/agent); unset: AI drafting is off.
export type SocialDrafter = Pick<SocialWriter, 'draft' | 'rewrite'> &
  Partial<Pick<SocialWriter, 'hashtags'>> & {
    // An image's alt text from its stored bytes (#817), when the deployment's model takes images (AI_VISION).
    describeStored?: (file: { key: string; generation: string | null; sha256: string }, mime: string, language: 'vi' | 'en') => Promise<string | null>;
  };

// The org's saved brand voices (#741) as notes for the writer: the org's, and each channel's by connection.
async function savedVoices(runtime: Runtime, actor: UserActor, orgId: string): Promise<{ org: string | null; byChannel: Map<string, string> }> {
  const rows = await runtime.query<BrandVoice[]>('social.brand_voice.list', {}, { actor, orgId });
  const org = rows.find((v) => v.connectionId === null);
  return { org: org ? voiceNotes(org) : null, byChannel: new Map(rows.filter((v) => v.connectionId !== null).map((v) => [v.connectionId as string, voiceNotes(v)])) };
}

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

// Why a Mastodon account did not connect, in words for the connect form; any other failure (the instance did not
// answer, or the egress guard refused its address) is an instance Crove cannot reach.
function mastodonFailure(code: string | undefined): DomainError {
  if (code === 'MASTODON_INSTANCE_INVALID') return new DomainError('MASTODON_INSTANCE_INVALID', 422, 'Hãy nhập địa chỉ máy chủ Mastodon, ví dụ mastodon.social');
  if (code === 'MASTODON_TOKEN_INVALID') return new DomainError('MASTODON_TOKEN_INVALID', 422, 'Đây không phải mã truy cập Mastodon; hãy chép mã trong Cài đặt > Phát triển của máy chủ');
  if (code === 'MASTODON_TOKEN_REFUSED') return new DomainError('MASTODON_TOKEN_REFUSED', 422, 'Máy chủ Mastodon không chấp nhận mã truy cập này');
  if (code === 'MASTODON_NOT_AN_INSTANCE') return new DomainError('MASTODON_NOT_AN_INSTANCE', 422, 'Địa chỉ này không phải một máy chủ Mastodon');
  return new DomainError('MASTODON_INSTANCE_UNREACHABLE', 422, 'Không kết nối được tới máy chủ Mastodon này; hãy kiểm tra địa chỉ rồi thử lại');
}

// Why a WordPress site did not connect, in words for the connect form; any other failure (the site did not answer, or
// the egress guard refused its address) is a site Crove cannot reach.
function wordpressFailure(code: string | undefined): DomainError {
  if (code === 'WORDPRESS_SITE_INVALID') return new DomainError('WORDPRESS_SITE_INVALID', 422, 'Hãy nhập địa chỉ trang WordPress qua https, ví dụ https://tiemcuaban.vn');
  if (code === 'WORDPRESS_LOGIN_INVALID') return new DomainError('WORDPRESS_LOGIN_INVALID', 422, 'Hãy nhập tên người dùng và mật khẩu ứng dụng (24 chữ cái và chữ số) mà WordPress tạo cho bạn');
  if (code === 'WORDPRESS_LOGIN_REFUSED') return new DomainError('WORDPRESS_LOGIN_REFUSED', 422, 'WordPress không chấp nhận tên người dùng hoặc mật khẩu ứng dụng này');
  if (code === 'WORDPRESS_CANNOT_PUBLISH') return new DomainError('WORDPRESS_CANNOT_PUBLISH', 422, 'Tài khoản này chưa có quyền đăng bài; hãy dùng tài khoản Tác giả, Biên tập viên hoặc Quản trị viên');
  if (code === 'WORDPRESS_NO_REST_API') return new DomainError('WORDPRESS_NO_REST_API', 422, 'Trang này chưa bật REST API của WordPress, hoặc đường dẫn tĩnh đang tắt');
  if (code === 'WORDPRESS_SITE_REDIRECTS') return new DomainError('WORDPRESS_SITE_REDIRECTS', 422, 'Địa chỉ này chuyển sang một địa chỉ khác; hãy nhập địa chỉ cuối cùng của trang, bắt đầu bằng https');
  return new DomainError('WORDPRESS_SITE_UNREACHABLE', 422, 'Không kết nối được tới trang WordPress này; hãy kiểm tra địa chỉ rồi thử lại');
}

type LinkPreviewView = { status: 'pending' | 'ready' | 'failed'; title: string | null; description: string | null; siteName: string | null; text: string | null } | null;
const SOURCE_WAIT_MS = 10_000;
// The link preview of a page an AI draft is written from (#769): requested when there is none, then waited for. A page
// that cannot be read, or one still pending, is said in words; nothing is drafted from it.
async function sourcePage(runtime: Runtime, actor: UserActor, orgId: string, url: string) {
  const options = { actor, orgId };
  const read = () => runtime.query<LinkPreviewView>('social.link_preview.get', { url }, options);
  let view = await read();
  if (!view || view.status !== 'ready') {
    if (!view || view.status === 'failed') await runtime.execute('social.link_preview.request', { url }, options);
    const until = Date.now() + SOURCE_WAIT_MS;
    while (Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      view = await read();
      if (view && view.status !== 'pending') break;
    }
  }
  if (!view || view.status === 'pending') throw new DomainError('SOURCE_NOT_READY', 409, 'Đang đọc trang này, hãy thử lại sau vài giây');
  if (view.status === 'failed' || (!view.title && !view.description && !view.text)) throw new DomainError('SOURCE_UNREADABLE', 422, 'Không đọc được nội dung trang này; hãy mô tả bài bằng lời');
  return { url, title: view.title, description: view.description, siteName: view.siteName, text: view.text };
}

// Why a Telegram channel did not connect, in words for the connect form.
function telegramFailure(code: string | undefined): DomainError | null {
  if (code === 'TELEGRAM_TOKEN_INVALID') return new DomainError('TELEGRAM_TOKEN_INVALID', 422, 'Đây không phải mã bot Telegram; hãy chép mã @BotFather gửi khi tạo bot');
  if (code === 'TELEGRAM_CHANNEL_INVALID') return new DomainError('TELEGRAM_CHANNEL_INVALID', 422, 'Hãy nhập tên kênh dạng @tenkenh, đường dẫn t.me hoặc mã số của kênh');
  if (code === 'TELEGRAM_TOKEN_REFUSED') return new DomainError('TELEGRAM_TOKEN_REFUSED', 422, 'Telegram không chấp nhận mã bot này; có thể mã đã bị đổi trong @BotFather');
  if (code === 'TELEGRAM_CHANNEL_NOT_FOUND') return new DomainError('TELEGRAM_CHANNEL_NOT_FOUND', 422, 'Bot không thấy kênh này; hãy kiểm tra tên kênh và thêm bot vào kênh');
  if (code === 'TELEGRAM_NOT_A_CHANNEL') return new DomainError('TELEGRAM_NOT_A_CHANNEL', 422, 'Đây không phải một kênh Telegram; Crove chỉ đăng lên kênh, không đăng vào nhóm');
  if (code === 'TELEGRAM_BOT_CANNOT_POST') return new DomainError('TELEGRAM_BOT_CANNOT_POST', 422, 'Bot chưa được đăng bài trong kênh; hãy đặt bot làm quản trị viên có quyền đăng bài');
  return null;
}
// Why a Discord channel did not connect, in words for the connect form.
function discordFailure(code: string | undefined): DomainError | null {
  if (code === 'DISCORD_WEBHOOK_INVALID') return new DomainError('DISCORD_WEBHOOK_INVALID', 422, 'Hãy dán địa chỉ webhook của kênh Discord, dạng https://discord.com/api/webhooks/...');
  if (code === 'DISCORD_WEBHOOK_REFUSED') return new DomainError('DISCORD_WEBHOOK_REFUSED', 422, 'Discord không nhận webhook này, có thể nó đã bị xóa; hãy tạo webhook mới');
  return null;
}
const PROVIDER_LABELS: Record<string, string> = { sandbox: 'test channel', facebook_page: 'Facebook Page', instagram: 'Instagram', zalo_oa: 'Zalo Official Account (article)', tiktok: 'TikTok', youtube: 'YouTube', threads: 'Threads', linkedin: 'LinkedIn', x: 'X', bluesky: 'Bluesky', google_business: 'Google Business Profile', telegram: 'Telegram', mastodon: 'Mastodon', pinterest: 'Pinterest', discord: 'Discord', wordpress: 'WordPress (blog post)' };

export interface RpcChannels {
  // Seals tokens before kernel.channel.connect stores them; never opens one in the API.
  broker: CredentialBroker;
  // The offline sandbox channel is enabled (CHANNEL_SANDBOX).
  sandbox: boolean;
  // Bluesky accounts may connect with an app password (CHANNEL_BLUESKY).
  bluesky?: boolean;
  // Telegram channels may connect with a bot token (CHANNEL_TELEGRAM).
  telegram?: boolean;
  // Mastodon accounts may connect with an access token (CHANNEL_MASTODON).
  mastodon?: boolean;
  // Discord channels may connect with a webhook URL (CHANNEL_DISCORD).
  discord?: boolean;
  // WordPress sites may connect with an application password (CHANNEL_WORDPRESS).
  wordpress?: boolean;
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
// taxLookup unset: the public tax registry lookup is off (issue #324, TAX_CODE_LOOKUP_URL).
export function createRpcHandler(runtime: Runtime, sendInviteMail?: SendInviteMail, channels?: RpcChannels, socialWriter?: SocialDrafter, taxLookup?: TaxCodeLookup, drafts: DraftBudget = new DraftBudget(), blueskyLogins: BlueskyLoginBudget = new BlueskyLoginBudget()) {
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

  // The multi-client home screen reads up to four orgs at once, a transaction each, on the API's pool of ten
  // connections (#495): one screen per user at a time and two per process; another is refused at once (OVERLOADED).
  const clientScreens = new ConcurrencyLimiter({ total: 2, perKey: 1 });

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
      // The multi-client home screen (issue #318): each org's figures are read in that org's own context.
      clients: os.me.clients.handler(({ context, signal }) =>
        guard(async () => {
          const release = clientScreens.tryAcquire(context.user.userId);
          if (!release) throw new DomainError('OVERLOADED', 503, 'Danh sách khách hàng đang được tải, hãy thử lại sau giây lát', { retryAfterSeconds: 2 });
          try {
            return await clientOverviews(runtime, actorOf(context.user), signal ? { signal } : {});
          } finally {
            release();
          }
        }),
      ),
    },
    org: {
      create: os.org.create.handler(({ context, input }) =>
        guard(() => createOrg(runtime, actorOf(context.user), input.name, input.idempotencyKey)),
      ),
      get: os.org.get.handler(({ context }) => inOrg(context, (orgId, actor) => runtime.query('kernel.org.get', {}, { actor, orgId }))),
      setTaxCode: os.org.setTaxCode.handler(({ context, input }) =>
        inOrg(context, (orgId, actor) => runtime.execute('kernel.org.set_tax_code', input, { actor, orgId })),
      ),
      setVatFilingPeriod: os.org.setVatFilingPeriod.handler(({ context, input }) =>
        inOrg(context, (orgId, actor) => runtime.execute('kernel.org.set_vat_filing_period', input, { actor, orgId })),
      ),
      setAddress: os.org.setAddress.handler(({ context, input }) =>
        inOrg(context, (orgId, actor) => runtime.execute('kernel.org.set_address', input, { actor, orgId })),
      ),
      proposalPolicy: os.org.proposalPolicy.handler(({ context }) => inOrg(context, (orgId, actor) => runtime.query('kernel.proposal_policy.get', {}, { actor, orgId }))),
      setProposalPolicy: os.org.setProposalPolicy.handler(({ context, input }) =>
        inOrg(context, (orgId, actor) => runtime.execute('kernel.proposal_policy.save', input, { actor, orgId })),
      ),
      // No idempotency key: the answer carries the invite token, which must never be stored with a key. The mail
      // goes out after the command has committed (invite-mail.ts says why), unless the org stopped mail to the
      // address (#538); its outcome is recorded on the invite's mail_message row and never changes the answer, which
      // stays the same whether or not the email has an account.
      invite: os.org.invite.handler(({ context, input }) =>
        guard(async () => {
          const org = await resolveMembership(runtime, context.user, context.orgSlug);
          const actor = actorOf(context.user);
          const created = await runtime.execute<CreatedInvite>('kernel.member.invite.create', input, { actor, orgId: org.orgId });
          // The invite's mail row, as the command wrote it: no row, or a read that fails, sends nothing, since an
          // address the org stopped must never get mail; the inviter still has the link.
          const mail = await runtime
            .query<DirectMail | null>('kernel.mail.direct.get', { source: 'kernel.member.invite.create', sourceId: created.inviteId }, { actor, orgId: org.orgId })
            .catch((error: unknown) => {
              console.error(`[mail] invite mail not sent, its record was not read: ${error instanceof Error ? error.name : 'unknown error'}`);
              return null;
            });
          if (mail?.status === 'sending') {
            let delivery: Delivery | 'error' = 'off';
            let sent: DeliveryResult | undefined;
            try {
              sent = await sendInviteMail?.({
                  to: created.email,
                  orgName: org.name,
                  inviterName: context.user.name,
                  inviterEmail: context.user.email,
                  role: created.role,
                  expiresAt: created.expiresAt,
                  acceptPath: created.acceptPath,
                  messageId: mail.messageIdHeader,
                  bounceToken: mail.bounceToken,
                });
              delivery = sent?.status ?? 'off';
            } catch (error) {
              delivery = 'error';
              console.error(`[mail] invite mail not sent: ${error instanceof Error ? error.name : 'unknown error'}`);
            }
            const outcome = delivery === 'sent' ? { outcome: 'sent' as const } : { outcome: 'failed' as const, errorCode: DELIVERY_ERROR[delivery] };
            const provider = sent && delivery !== 'off' ? { provider: sent.provider, ...(sent.providerMessageId ? { providerMessageId: sent.providerMessageId } : {}) } : {};
            await runtime.execute('kernel.mail.record_direct', { messageId: mail.messageId, ...outcome, ...provider }, { actor, orgId: org.orgId }).catch((error: unknown) => {
              console.error(`[mail] invite mail outcome not recorded: ${error instanceof Error ? error.name : 'unknown error'}`);
            });
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
        assign: os.social.posts.assign.handler(socialCommand('social.post.assign')),
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
        // A retry with the same idempotencyKey returns the first import instead of a second set of posts.
        import: os.social.posts.import.handler(({ context, input }) =>
          inSocial(context, (orgId, actor) => {
            const { idempotencyKey, ...rest } = input;
            return runtime.execute('social.post.import', rest, { actor, orgId, idempotencyKey });
          }),
        ),
        duplicate: os.social.posts.duplicate.handler(socialCommand('social.post.duplicate')),
        setLabels: os.social.posts.setLabels.handler(socialCommand('social.post.set_labels')),
        comment: os.social.posts.comment.handler(socialCommand('social.post_comment.add')),
        editComment: os.social.posts.editComment.handler(socialCommand('social.post_comment.edit')),
        activity: os.social.posts.activity.handler(socialQuery('social.post.activity')),
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
            // The source page (#769) as its link preview read it (fetched by the worker through the egress guard, parsed in
            // the extract container): asked for if new, and waited for a few seconds. Before the budget: waiting for a page
            // costs no model call, and a page that cannot be read takes no slot.
            const source = input.sourceUrl ? await sourcePage(runtime, actor, orgId, input.sourceUrl) : undefined;
            // The model call is paid: a member gets a few a minute and one at a time, an org a few more (#386).
            const ticket = drafts.take(orgId, actor.userId);
            if (!ticket.allowed) {
              throw new DomainError('RATE_LIMITED', 429, ticket.reason === 'busy' ? 'Đang soạn một bài bằng AI, hãy đợi xong rồi soạn tiếp' : 'Đã soạn bằng AI nhiều bài trong phút này, hãy thử lại sau ít phút', {
                retryAfterSeconds: ticket.retryAfterSeconds,
              });
            }
            let draft: Awaited<ReturnType<SocialDrafter['draft']>>;
            try {
              const voices = input.tone ? null : await savedVoices(runtime, actor, orgId);
              draft = await socialWriter.draft({
                brief: input.brief,
                channels,
                language: input.language ?? 'vi',
                ...(input.tone ? { tone: input.tone } : {}),
                ...(voices?.org ? { voice: voices.org } : {}),
                ...(source ? { source } : {}),
                ...(voices ? { channelVoices: Object.fromEntries(input.connectionIds.flatMap((id) => (voices.byChannel.has(id) ? [[id, voices.byChannel.get(id) as string]] : []))) } : {}),
              });
            } catch (error: unknown) {
              console.error('[social-ai] draft failed', error instanceof Error ? error.name : typeof error);
              throw new DomainError('AI_DRAFT_FAILED', 503, 'AI không soạn được bài lúc này, hãy thử lại sau');
            } finally {
              ticket.release();
            }
            if (!draft) throw new DomainError('AI_DRAFT_EMPTY', 422, 'AI không soạn được bài từ mô tả này, hãy viết rõ hơn');
            const own = new Map(draft.variants.map((v) => [v.key, v]));
            const created = await runtime.execute<{ postId: string }>(
              'social.post.create',
              {
                body: draft.body,
                title: draft.title,
                origin: 'ai',
                ...(input.sourceUrl ? { linkUrl: input.sourceUrl } : {}),
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
        rewriteWithAi: os.social.posts.rewriteWithAi.handler(({ context, input }) =>
          inSocial(context, async (orgId, actor) => {
            const { role } = await resolveMembership(runtime, context.user, context.orgSlug);
            if (role !== 'owner' && role !== 'admin' && role !== 'member') throw new DomainError('FORBIDDEN', 403, 'Vai trò chỉ xem không soạn được bài');
            if (!socialWriter) throw new DomainError('AI_NOT_CONFIGURED', 503, 'Máy chủ chưa cấu hình AI (AI_BASE_URL, AI_MODEL)');
            let channel: WriterChannel | undefined;
            if (input.connectionId) {
              const connections = await runtime.query<{ id: string; provider: string; displayName: string; status: string }[]>('kernel.channel.list', {}, { actor, orgId });
              const found = connections.find((c) => c.id === input.connectionId && c.status !== 'revoked');
              if (!found) throw new DomainError('CHANNEL_NOT_FOUND', 404, 'Có kênh không tồn tại hoặc đã ngắt kết nối');
              channel = writerChannel(found);
            }
            // The same budget as drafts: each rewrite is a paid model call (#386).
            const ticket = drafts.take(orgId, actor.userId);
            if (!ticket.allowed) {
              throw new DomainError('RATE_LIMITED', 429, ticket.reason === 'busy' ? 'Đang chờ AI trả lời, hãy đợi xong rồi thử tiếp' : 'Đã dùng AI nhiều lần trong phút này, hãy thử lại sau ít phút', {
                retryAfterSeconds: ticket.retryAfterSeconds,
              });
            }
            let result: Awaited<ReturnType<SocialDrafter['rewrite']>>;
            try {
              const voices = await savedVoices(runtime, actor, orgId);
              const voice = (input.connectionId ? voices.byChannel.get(input.connectionId) : undefined) ?? voices.org;
              result = await socialWriter.rewrite({ text: input.text, title: input.title ?? null, action: input.action, ...(channel ? { channel } : {}), ...(voice ? { voice } : {}) });
            } catch (error: unknown) {
              console.error('[social-ai] rewrite failed', error instanceof Error ? error.name : typeof error);
              throw new DomainError('AI_DRAFT_FAILED', 503, 'AI không soạn được bài lúc này, hãy thử lại sau');
            } finally {
              ticket.release();
            }
            if (!result) throw new DomainError('AI_REWRITE_EMPTY', 422, 'AI không viết lại được đoạn này, hãy thử cách khác');
            return result;
          }),
        ),
        describeImage: os.social.posts.describeImage.handler(({ context, input }) =>
          inSocial(context, async (orgId, actor) => {
            const { role } = await resolveMembership(runtime, context.user, context.orgSlug);
            if (role !== 'owner' && role !== 'admin' && role !== 'member') throw new DomainError('FORBIDDEN', 403, 'Vai trò chỉ xem không soạn được bài');
            if (!socialWriter?.describeStored) throw new DomainError('AI_VISION_OFF', 422, 'Mô hình AI của máy chủ chưa đọc được ảnh (AI_VISION)');
            // The member's own org's file, an image, small enough to send: the same read a download makes.
            const file = await runtime.query<{ content_type: string; storage_key: string; generation: string | null; sha256: string; size_bytes: string }>('kernel.file.get', { id: input.fileId }, { actor, orgId });
            if (!file.content_type.startsWith('image/')) throw new DomainError('ALT_TEXT_IMAGE_ONLY', 422, 'Chỉ gợi ý mô tả cho ảnh');
            if (Number(file.size_bytes) > 10 * 1024 * 1024) throw new DomainError('TOO_LARGE', 413, 'Ảnh quá lớn để AI đọc');
            const ticket = drafts.take(orgId, actor.userId);
            if (!ticket.allowed) {
              throw new DomainError('RATE_LIMITED', 429, ticket.reason === 'busy' ? 'Đang chờ AI trả lời, hãy đợi xong rồi thử tiếp' : 'Đã dùng AI nhiều lần trong phút này, hãy thử lại sau ít phút', {
                retryAfterSeconds: ticket.retryAfterSeconds,
              });
            }
            let altText: string | null;
            try {
              altText = await socialWriter.describeStored({ key: file.storage_key, generation: file.generation, sha256: file.sha256 }, file.content_type, input.language);
            } catch (error: unknown) {
              console.error('[social-ai] describe failed', error instanceof Error ? error.name : typeof error);
              throw new DomainError('AI_DRAFT_FAILED', 503, 'AI không soạn được bài lúc này, hãy thử lại sau');
            } finally {
              ticket.release();
            }
            if (!altText) throw new DomainError('AI_REWRITE_EMPTY', 422, 'AI không viết lại được đoạn này, hãy thử cách khác');
            return { altText };
          }),
        ),
        suggestHashtags: os.social.posts.suggestHashtags.handler(({ context, input }) =>
          inSocial(context, async (orgId, actor) => {
            const { role } = await resolveMembership(runtime, context.user, context.orgSlug);
            if (role !== 'owner' && role !== 'admin' && role !== 'member') throw new DomainError('FORBIDDEN', 403, 'Vai trò chỉ xem không soạn được bài');
            if (!socialWriter?.hashtags) throw new DomainError('AI_NOT_CONFIGURED', 503, 'Máy chủ chưa cấu hình AI (AI_BASE_URL, AI_MODEL)');
            let channel: WriterChannel | undefined;
            if (input.connectionId) {
              const connections = await runtime.query<{ id: string; provider: string; displayName: string; status: string }[]>('kernel.channel.list', {}, { actor, orgId });
              const found = connections.find((c) => c.id === input.connectionId && c.status !== 'revoked');
              if (!found) throw new DomainError('CHANNEL_NOT_FOUND', 404, 'Có kênh không tồn tại hoặc đã ngắt kết nối');
              channel = writerChannel(found);
            }
            // The same budget as drafts and rewrites: each ask is a paid model call (#386).
            const ticket = drafts.take(orgId, actor.userId);
            if (!ticket.allowed) {
              throw new DomainError('RATE_LIMITED', 429, ticket.reason === 'busy' ? 'Đang chờ AI trả lời, hãy đợi xong rồi thử tiếp' : 'Đã dùng AI nhiều lần trong phút này, hãy thử lại sau ít phút', {
                retryAfterSeconds: ticket.retryAfterSeconds,
              });
            }
            try {
              return { hashtags: await socialWriter.hashtags({ text: input.text, language: input.language, ...(channel ? { channel } : {}), exclude: input.exclude }) };
            } catch (error: unknown) {
              console.error('[social-ai] hashtags failed', error instanceof Error ? error.name : typeof error);
              throw new DomainError('AI_DRAFT_FAILED', 503, 'AI không soạn được bài lúc này, hãy thử lại sau');
            } finally {
              ticket.release();
            }
          }),
        ),
      },
      variants: {
        update: os.social.variants.update.handler(socialCommand('social.variant.update')),
        decide: os.social.variants.decide.handler(socialCommand('social.variant.decide')),
        schedule: os.social.variants.schedule.handler(socialCommand('social.variant.schedule')),
        unschedule: os.social.variants.unschedule.handler(socialCommand('social.variant.unschedule')),
        retryComment: os.social.variants.retryComment.handler(socialCommand('social.comment.retry')),
      retryThread: os.social.variants.retryThread.handler(socialCommand('social.thread.retry')),
        reschedule: os.social.variants.reschedule.handler(socialCommand('social.variant.reschedule')),
        cancel: os.social.variants.cancel.handler(socialCommand('social.variant.cancel')),
        retry: os.social.variants.retry.handler(socialCommand('social.variant.retry')),
        resolve: os.social.variants.resolve.handler(socialCommand('social.variant.resolve')),
      },
      metrics: {
        summary: os.social.metrics.summary.handler(socialQuery('social.metrics.summary')),
        totals: os.social.metrics.totals.handler(socialQuery('social.metrics.totals')),
        insights: os.social.metrics.insights.handler(socialQuery('social.metrics.insights')),
        export: os.social.metrics.export.handler(socialCommand('social.metrics.export')),
      },
      labels: {
        list: os.social.labels.list.handler(socialQuery('social.label.list')),
        create: os.social.labels.create.handler(socialCommand('social.label.create')),
        update: os.social.labels.update.handler(socialCommand('social.label.update')),
        remove: os.social.labels.remove.handler(socialCommand('social.label.delete')),
      },
      calendarFeed: {
        get: os.social.calendarFeed.get.handler(socialQuery('social.calendar_feed.get')),
        create: os.social.calendarFeed.create.handler(socialCommand('social.calendar_feed.create')),
        revoke: os.social.calendarFeed.revoke.handler(socialCommand('social.calendar_feed.revoke')),
      },
      calendarNotes: {
        list: os.social.calendarNotes.list.handler(socialQuery('social.calendar_note.list')),
        save: os.social.calendarNotes.save.handler(socialCommand('social.calendar_note.save')),
        remove: os.social.calendarNotes.remove.handler(socialCommand('social.calendar_note.remove')),
      },
      ideas: {
        list: os.social.ideas.list.handler(socialQuery('social.idea.list')),
        get: os.social.ideas.get.handler(socialQuery('social.idea.get')),
        create: os.social.ideas.create.handler(socialCommand('social.idea.create')),
        update: os.social.ideas.update.handler(socialCommand('social.idea.update')),
        move: os.social.ideas.move.handler(socialCommand('social.idea.move')),
      },
      bio: {
        get: os.social.bio.get.handler(socialQuery('social.bio.get')),
        save: os.social.bio.save.handler(socialCommand('social.bio.save')),
      },
      feeds: {
        list: os.social.feeds.list.handler(socialQuery('social.feed.list')),
        add: os.social.feeds.add.handler(socialCommand('social.feed.add')),
        update: os.social.feeds.update.handler(socialCommand('social.feed.update')),
        remove: os.social.feeds.remove.handler(socialCommand('social.feed.remove')),
      },
      snippets: {
        list: os.social.snippets.list.handler(socialQuery('social.snippet.list')),
        create: os.social.snippets.create.handler(socialCommand('social.snippet.create')),
        update: os.social.snippets.update.handler(socialCommand('social.snippet.update')),
        remove: os.social.snippets.remove.handler(socialCommand('social.snippet.delete')),
      },
      reportLinks: {
        list: os.social.reportLinks.list.handler(socialQuery('social.report_link.list')),
        create: os.social.reportLinks.create.handler(socialCommand('social.report_link.create')),
        revoke: os.social.reportLinks.revoke.handler(socialCommand('social.report_link.revoke')),
      },
      channelSets: {
        list: os.social.channelSets.list.handler(socialQuery('social.channel_set.list')),
        save: os.social.channelSets.save.handler(socialCommand('social.channel_set.save')),
        remove: os.social.channelSets.remove.handler(socialCommand('social.channel_set.remove')),
      },
      brandVoices: {
        list: os.social.brandVoices.list.handler(socialQuery('social.brand_voice.list')),
        save: os.social.brandVoices.save.handler(socialCommand('social.brand_voice.save')),
        remove: os.social.brandVoices.remove.handler(socialCommand('social.brand_voice.remove')),
      },
      watermark: {
        get: os.social.watermark.get.handler(socialQuery('social.watermark.get')),
        save: os.social.watermark.save.handler(socialCommand('social.watermark.save')),
        remove: os.social.watermark.remove.handler(socialCommand('social.watermark.remove')),
      },
      reportSchedules: {
        list: os.social.reportSchedules.list.handler(socialQuery('social.report_schedule.list')),
        save: os.social.reportSchedules.save.handler(socialCommand('social.report_schedule.save')),
        remove: os.social.reportSchedules.remove.handler(socialCommand('social.report_schedule.remove')),
        test: os.social.reportSchedules.test.handler(socialCommand('social.report_schedule.test')),
      },
      linkPreviews: {
        request: os.social.linkPreviews.request.handler(socialCommand('social.link_preview.request')),
        get: os.social.linkPreviews.get.handler(socialQuery('social.link_preview.get')),
      },
      notifications: {
        list: os.social.notifications.list.handler(socialQuery('social.notification.list')),
        read: os.social.notifications.read.handler(socialCommand('social.notification.read')),
        mute: os.social.notifications.mute.handler(socialCommand('social.notification.mute')),
        mail: os.social.notifications.mail.handler(socialCommand('social.notification.mail')),
      },
      accounts: {
        trends: os.social.accounts.trends.handler(socialQuery('social.account.trends')),
      },
      reviewInbox: os.social.reviewInbox.handler(socialQuery('social.review.inbox')),
      attentionInbox: os.social.attentionInbox.handler(socialQuery('social.attention.inbox')),
      reviewLinks: {
        list: os.social.reviewLinks.list.handler(socialQuery('social.review_link.list')),
        create: os.social.reviewLinks.create.handler(socialCommand('social.review_link.create')),
        revoke: os.social.reviewLinks.revoke.handler(socialCommand('social.review_link.revoke')),
      },
      media: {
        list: os.social.media.list.handler(socialQuery('social.media.list')),
        usage: os.social.media.usage.handler(socialQuery('social.media.usage')),
      },
      policies: {
        list: os.social.policies.list.handler(socialQuery('social.channel.policies')),
        set: os.social.policies.set.handler(socialCommand('social.channel.set_policy')),
        setReminders: os.social.policies.setReminders.handler(socialCommand('social.channel.set_reminders')),
        setShortLinks: os.social.policies.setShortLinks.handler(socialCommand('social.channel.set_short_links')),
        setFourEyes: os.social.policies.setFourEyes.handler(socialCommand('social.channel.set_four_eyes')),
        setClientApproval: os.social.policies.setClientApproval.handler(socialCommand('social.channel.set_client_approval')),
      },
      channels: {
        waiting: os.social.channels.waiting.handler(socialQuery('social.channel.waiting')),
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
          const failure = (error: unknown): DomainError => {
            if (error instanceof BlueskyError) {
              if (error.code === 'NotAnAppPassword') return new DomainError('BLUESKY_APP_PASSWORD', 422, 'Hãy dùng mật khẩu ứng dụng (app password) của Bluesky, không dùng mật khẩu tài khoản');
              if (error.code === 'PrivilegedAppPassword') {
                return new DomainError('BLUESKY_APP_PASSWORD_PRIVILEGED', 422, 'Mật khẩu ứng dụng này được đọc cả tin nhắn riêng; hãy tạo mật khẩu ứng dụng mới không bật quyền tin nhắn');
              }
              if (error.code === 'UnsupportedPds') return new DomainError('BLUESKY_PDS_UNSUPPORTED', 422, 'Crove không gọi được máy chủ lưu tài khoản Bluesky này (PDS phải là tên miền công khai, qua https)');
              if (error.status === 401 || error.status === 400) return new DomainError('BLUESKY_LOGIN_FAILED', 422, 'Bluesky không chấp nhận tên tài khoản hoặc mật khẩu ứng dụng này');
            }
            return new DomainError('OAUTH_PROVIDER_FAILED', 503, 'Nền tảng không phản hồi đúng, hãy thử lại sau');
          };
          // The format is checked first, so a typo costs no try; each try is a login on Bluesky, which limits them
          // per account (#399).
          const login = (() => {
            try {
              return blueskyLogin(input);
            } catch (error) {
              throw failure(error);
            }
          })();
          const ticket = blueskyLogins.take(orgId, context.user.userId, login.handle);
          if (!ticket.allowed) {
            throw new DomainError('RATE_LIMITED', 429, 'Đã thử kết nối Bluesky nhiều lần trong phút này, hãy đợi một lát rồi thử lại', { retryAfterSeconds: ticket.retryAfterSeconds });
          }
          const account = await connectBluesky(login, undefined, egressFetch({ timeoutMs: 15_000, maxBytes: 200_000, overLimit: 'fail' })).catch((error: unknown) => {
            throw failure(error);
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
      // A bot token is checked once (the bot, the channel, the bot's right to post), then sealed with the channel's id
      // and dropped; it never reaches a log, an audit row or an answer.
      // An access token is checked once with the instance, through the egress guard (public addresses only, no
      // redirects), then sealed with the account id and dropped; it never reaches a log, an audit row or an answer.
      connectMastodon: os.channels.connectMastodon.handler(({ context, input }) =>
        guard(async () => {
          const { orgId, role } = await resolveMembership(runtime, context.user, context.orgSlug);
          if (role !== 'owner' && role !== 'admin') throw new DomainError('FORBIDDEN', 403, 'Chỉ chủ sở hữu hoặc quản trị viên mới kết nối được kênh');
          if (!channels?.mastodon) throw new DomainError('CHANNEL_PROVIDER_DISABLED', 404, 'Kênh này chưa được bật trên máy chủ');
          if (channels.broker.id === 'none') throw new DomainError('BROKER_NOT_CONFIGURED', 503, 'Chưa cấu hình khóa mã hóa thông tin kết nối (CREDENTIAL_KEY)');
          const failure = (error: unknown) => mastodonFailure(error instanceof ConnectorError ? error.code : undefined);
          const login = (() => {
            try {
              return mastodonLogin(input);
            } catch (error) {
              throw failure(error);
            }
          })();
          const account = await connectMastodon(login, egressFetch({ timeoutMs: 15_000, maxBytes: 200_000, overLimit: 'fail' })).catch((error: unknown) => {
            throw failure(error);
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
      // An application password is checked once with the site, through the egress guard (public addresses only, no
      // redirects), then sealed with the site's id and dropped; it never reaches a log, an audit row or an answer.
      connectWordPress: os.channels.connectWordPress.handler(({ context, input }) =>
        guard(async () => {
          const { orgId, role } = await resolveMembership(runtime, context.user, context.orgSlug);
          if (role !== 'owner' && role !== 'admin') throw new DomainError('FORBIDDEN', 403, 'Chỉ chủ sở hữu hoặc quản trị viên mới kết nối được kênh');
          if (!channels?.wordpress) throw new DomainError('CHANNEL_PROVIDER_DISABLED', 404, 'Kênh này chưa được bật trên máy chủ');
          if (channels.broker.id === 'none') throw new DomainError('BROKER_NOT_CONFIGURED', 503, 'Chưa cấu hình khóa mã hóa thông tin kết nối (CREDENTIAL_KEY)');
          const failure = (error: unknown) => wordpressFailure(error instanceof ConnectorError ? error.code : undefined);
          const login = (() => {
            try {
              return wordpressLogin(input);
            } catch (error) {
              throw failure(error);
            }
          })();
          const account = await connectWordPress(login, egressFetch({ timeoutMs: 15_000, maxBytes: 200_000, overLimit: 'fail' })).catch((error: unknown) => {
            throw failure(error);
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
      connectTelegram: os.channels.connectTelegram.handler(({ context, input }) =>
        guard(async () => {
          const { orgId, role } = await resolveMembership(runtime, context.user, context.orgSlug);
          if (role !== 'owner' && role !== 'admin') throw new DomainError('FORBIDDEN', 403, 'Chỉ chủ sở hữu hoặc quản trị viên mới kết nối được kênh');
          if (!channels?.telegram) throw new DomainError('CHANNEL_PROVIDER_DISABLED', 404, 'Kênh này chưa được bật trên máy chủ');
          if (channels.broker.id === 'none') throw new DomainError('BROKER_NOT_CONFIGURED', 503, 'Chưa cấu hình khóa mã hóa thông tin kết nối (CREDENTIAL_KEY)');
          const failure = (error: unknown): DomainError => {
            const known = error instanceof ConnectorError ? telegramFailure(error.code) : null;
            return known ?? new DomainError('OAUTH_PROVIDER_FAILED', 503, 'Nền tảng không phản hồi đúng, hãy thử lại sau');
          };
          const login = (() => {
            try {
              return telegramLogin(input);
            } catch (error) {
              throw failure(error);
            }
          })();
          const account = await connectTelegram(login).catch((error: unknown) => {
            throw failure(error);
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
      // A webhook is checked once with Discord (an incoming webhook of a server's channel), then its token is sealed with
      // the webhook's id and dropped; it never reaches a log, an audit row or an answer.
      connectDiscord: os.channels.connectDiscord.handler(({ context, input }) =>
        guard(async () => {
          const { orgId, role } = await resolveMembership(runtime, context.user, context.orgSlug);
          if (role !== 'owner' && role !== 'admin') throw new DomainError('FORBIDDEN', 403, 'Chỉ chủ sở hữu hoặc quản trị viên mới kết nối được kênh');
          if (!channels?.discord) throw new DomainError('CHANNEL_PROVIDER_DISABLED', 404, 'Kênh này chưa được bật trên máy chủ');
          if (channels.broker.id === 'none') throw new DomainError('BROKER_NOT_CONFIGURED', 503, 'Chưa cấu hình khóa mã hóa thông tin kết nối (CREDENTIAL_KEY)');
          const failure = (error: unknown): DomainError => {
            const known = error instanceof ConnectorError ? discordFailure(error.code) : null;
            return known ?? new DomainError('OAUTH_PROVIDER_FAILED', 503, 'Nền tảng không phản hồi đúng, hãy thử lại sau');
          };
          const login = (() => {
            try {
              return discordLogin(input);
            } catch (error) {
              throw failure(error);
            }
          })();
          const account = await connectDiscord(login).catch((error: unknown) => {
            throw failure(error);
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
          // Each account connects in its own command, so one that fails leaves the others connected: the answer says
          // which did and which did not (#375), and only a grant where none connected is an error. A grant covering
          // more accounts than a request should connect one by one is cut, and the answer says how many were left.
          const taken = accounts.slice(0, OAUTH_MAX_ACCOUNTS_PER_GRANT);
          const connections: { connectionId: string; displayName: string; reconnected: boolean }[] = [];
          const failed: { displayName: string; code: string }[] = [];
          let firstError: DomainError | null = null;
          for (const account of taken) {
            const sealed = broker.seal(account.secret, { orgId, provider: account.provider, externalAccountId: account.externalAccountId });
            const command: ChannelConnectInput = {
              provider: account.provider,
              externalAccountId: account.externalAccountId,
              displayName: account.displayName,
              scopes: account.scopes,
              expiresAt: account.expiresAt?.toISOString() ?? null,
              credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') },
            };
            try {
              const done = await runtime.execute<{ connectionId: string; reconnected: boolean }>('kernel.channel.connect', command, { actor, orgId });
              connections.push({ connectionId: done.connectionId, displayName: account.displayName, reconnected: done.reconnected });
            } catch (error) {
              // Only a refusal of this one account lets the others go on; a failure of the server (an outage, a bug)
              // ends the request at once, so it is logged and no more transactions pile onto a failing database.
              if (!(error instanceof DomainError) || error.status >= 500) throw error;
              firstError ??= error;
              failed.push({ displayName: account.displayName, code: error.code });
            }
          }
          if (connections.length === 0 && firstError) throw firstError;
          return { connections, failed, skipped: accounts.length - taken.length };
        }),
      ),
    },
    // Org-less: any signed-in user may look up a tax code before the org exists. Nothing is written, so no command.
    taxRegistry: {
      lookup: os.taxRegistry.lookup.handler(({ context, input }) =>
        guard(async () => {
          if (!taxLookup) throw new DomainError('TAX_LOOKUP_DISABLED', 404, 'Máy chủ chưa bật tra cứu mã số thuế; hãy nhập tên và địa chỉ');
          return taxLookup.lookup(input.taxCode, context.user.userId);
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
              const ids = r.result as { journalEntryId?: string; documentId?: string; reversedEntryId?: string; voidedDocumentId?: string; voucherId?: string };
              return {
                id: r.id,
                outcome: r.outcome,
                ...(ids.journalEntryId ? { journalEntryId: ids.journalEntryId } : {}),
                ...(ids.documentId ? { documentId: ids.documentId } : {}),
                ...(ids.reversedEntryId ? { reversedEntryId: ids.reversedEntryId } : {}),
                ...(ids.voidedDocumentId ? { voidedDocumentId: ids.voidedDocumentId } : {}),
                ...(ids.voucherId ? { voucherId: ids.voucherId } : {}),
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
      // A journal reversal or a cash or bank voucher (#327), both finance commands.
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
    search: {
      query: os.search.query.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.search', input, { actor, orgId })),
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
    vouchers: {
      list: os.vouchers.list.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.vouchers.list', input, { actor, orgId })),
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
    portalList: {
      reconcile: os.portalList.reconcile.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.portal_list.reconcile', input, { actor, orgId })),
      ),
      import: os.portalList.import.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.execute('finance.portal_list.import', input, { actor, orgId })),
      ),
      remove: os.portalList.remove.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.execute('finance.portal_list.remove', input, { actor, orgId })),
      ),
    },
    ledger: {
      period: os.ledger.period.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.ledger.period', input, { actor, orgId })),
      ),
      account: os.ledger.account.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.ledger.account', input, { actor, orgId })),
      ),
      statements: os.ledger.statements.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.statements.period', input, { actor, orgId })),
      ),
    },
    periodLock: {
      state: os.periodLock.state.handler(({ context }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.period.lock_state', {}, { actor, orgId })),
      ),
      lock: os.periodLock.lock.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('finance.period.lock', rest, { actor, orgId, idempotencyKey });
        }),
      ),
      unlock: os.periodLock.unlock.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('finance.period.unlock', rest, { actor, orgId, idempotencyKey });
        }),
      ),
    },
    bank: {
      preview: os.bank.preview.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.bank.preview', input, { actor, orgId })),
      ),
      import: os.bank.import.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('finance.bank.import', rest, { actor, orgId, idempotencyKey });
        }),
      ),
      lines: os.bank.lines.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.bank.lines', input, { actor, orgId })),
      ),
      lineVoucher: os.bank.lineVoucher.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.bank.line_voucher', input, { actor, orgId })),
      ),
      suggestions: os.bank.suggestions.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.bank.suggestions', input, { actor, orgId })),
      ),
      openLines: os.bank.openLines.handler(({ context }) => inFinance(context, (orgId, actor) => runtime.query('finance.bank.open_lines', {}, { actor, orgId }))),
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
