// oRPC implementation of @crove/kernel-contract. Handlers only call the runtime (execute/query).
import { implement, ORPCError } from '@orpc/server';
import { RPCHandler } from '@orpc/server/fetch';
import { OAUTH_MAX_ACCOUNTS_PER_GRANT, contract } from '@crove/kernel-contract';
import { BlueskyError, ConnectorError, blueskyLogin, connectBluesky, connectDiscord, connectMastodon, connectTelegram, connectWordPress, discordLogin, mastodonLogin, telegramLogin, wordpressLogin, newOAuthAttempt, oauthStateHash, sandbox, type OAuthConnector } from '@crove/channel';
import {
  ALT_TEXT_IMAGE_MAX_BYTES,
  ALT_TEXT_IMAGE_TYPES,
  ProofreadChangedError,
  SummaryFigureError,
  type DraftRequest,
  type DraftResult,
  type ScheduleReading,
  type ScheduleWindow,
  type SchedulingReader,
  type SocialWriter,
  type WriterChannel,
} from '@crove/agent';
import { CAPABILITIES, isProvider as isSocialProvider, strictestAltTextLimit } from '@crove/mod-social/contract';
import { channelNotAllowed, periodSummaryInput, voiceNotes, type BrandVoice, type PeriodSummaryData } from '@crove/mod-social';
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
import type { SuggestedSlots } from '@crove/mod-crm';
import { DomainError, egressFetch, type CredentialBroker, type Runtime, type UserActor } from '@crove/kernel-runtime';
import { DraftBudget } from './ai-draft-limit.ts';
import { BlueskyLoginBudget } from './bluesky-login-limit.ts';
import { ChatAlertSaveBudget, ChatAlertTestBudget, requestChatAlertTest, saveChatAlert } from './chat-alert-save.ts';
import { actorOf, type AuthUser } from './auth.ts';
import { ConcurrencyLimiter } from './concurrency.ts';
import type { StockPhotos } from './stock-photos.ts';
import type { MediaUrls } from './media-urls.ts';
import type { InviteRole, SendInviteMail } from './invite-mail.ts';
import type { Delivery, DeliveryResult } from './mail.ts';
import type { TaxCodeLookup } from './tax-lookup.ts';
import type { PortalSync } from './portal-sync.ts';

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

// Reads the days and times a client's message asks for (SchedulingReader in @crove/agent, #1440).
export type BookingReader = Pick<SchedulingReader, 'read'>;

// Drafts Social posts with the deployment's model (SocialWriter in @crove/agent); unset: AI drafting is off.
export type SocialDrafter = Pick<SocialWriter, 'draft' | 'rewrite'> &
  Partial<Pick<SocialWriter, 'hashtags' | 'ideas' | 'summary'>> & {
    // An image's alt text from its stored bytes (#817), when the deployment's model takes images (AI_VISION), within
    // maxChars when the chosen channels take less than the writer's own limit (#1121). The read stops at the size the
    // file row records (#1126).
    describeStored?: (file: StoredImage, mime: string, language: 'vi' | 'en', maxChars?: number | null) => Promise<string | null>;
    // A draft written from photos of the library (#1191) too, read from their stored bytes like alt text, when the model
    // takes images; each read stops at the size its file row records.
    draftStored?: (request: Omit<DraftRequest, 'images'>, images: readonly { file: StoredImage; mime: string }[]) => Promise<DraftResult | null>;
  };

// A stored file as the vision reads take it: the row's reference, hash and recorded size.
export interface StoredImage {
  key: string;
  generation: string | null;
  sha256: string;
  sizeBytes: number;
}

// A member limited to some channels (#1081) may not have AI write for another one (#1099): refused before the paid model
// call and before that channel's brand voice is read, as social.post.create would refuse the channel afterwards.
async function refuseChannelsOutside(runtime: Runtime, actor: UserActor, orgId: string, connectionIds: readonly string[]): Promise<void> {
  if (connectionIds.length === 0) return;
  const mine = await runtime.query<{ limited: boolean; connectionIds: string[] }>('social.channel_access.mine', {}, { actor, orgId });
  if (!mine.limited) return;
  const allowed = new Set(mine.connectionIds);
  const outside = [...new Set(connectionIds)].filter((id) => !allowed.has(id)).sort();
  if (outside.length > 0) throw channelNotAllowed(outside);
}

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
  if (code === 'TELEGRAM_NOT_A_CHANNEL') return new DomainError('TELEGRAM_NOT_A_CHANNEL', 422, 'Đây không phải một kênh Telegram; chỉ đăng được lên kênh, không đăng vào nhóm');
  if (code === 'TELEGRAM_BOT_CANNOT_POST') return new DomainError('TELEGRAM_BOT_CANNOT_POST', 422, 'Bot chưa được đăng bài trong kênh; hãy đặt bot làm quản trị viên có quyền đăng bài');
  return null;
}
// Why a Discord channel did not connect, in words for the connect form.
function discordFailure(code: string | undefined): DomainError | null {
  if (code === 'DISCORD_WEBHOOK_INVALID') return new DomainError('DISCORD_WEBHOOK_INVALID', 422, 'Hãy dán địa chỉ webhook của kênh Discord, dạng https://discord.com/api/webhooks/...');
  if (code === 'DISCORD_WEBHOOK_REFUSED') return new DomainError('DISCORD_WEBHOOK_REFUSED', 422, 'Discord không nhận webhook này, có thể nó đã bị xóa; hãy tạo webhook mới');
  return null;
}
const PROVIDER_LABELS: Record<string, string> = { sandbox: 'test channel', facebook_page: 'Facebook Page', instagram: 'Instagram', zalo_oa: 'Zalo Official Account (article)', tiktok: 'TikTok', youtube: 'YouTube', threads: 'Threads', linkedin: 'LinkedIn', x: 'X', bluesky: 'Bluesky', google_business: 'Google Business Profile', telegram: 'Telegram', mastodon: 'Mastodon', pinterest: 'Pinterest', discord: 'Discord', wordpress: 'WordPress (blog post)', linkedin_page: 'LinkedIn Page' };

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
  // Stock photos from Pexels for the media library (#1106, MEDIA_PEXELS_API_KEY); unset: off, and no Pexels call is
  // made. Not a channel: it rides on this object because the HTTP edge hands it to the RPC handler unchanged, so the
  // feature needs no change to http.ts.
  stockPhotos?: StockPhotos;
  // The CSV import's image URLs (#1258), fetched into the library through the egress guard; unset: refused. Rides here
  // for the same reason as stockPhotos.
  mediaUrls?: MediaUrls;
  // Browser push for Social notifications (#1238, VAPID_*): the public key browsers subscribe with; unset: no push is
  // offered. Rides here for the same reason.
  push?: { publicKey: string };
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
// portalSync unset: the assisted sync from the tax portal is off (issue #325, TAX_PORTAL_SYNC).
// bookingReader unset: booking suggestions do not read the client's message (issue #1440, AI_BASE_URL and AI_MODEL).
export function createRpcHandler(
  runtime: Runtime,
  sendInviteMail?: SendInviteMail,
  channels?: RpcChannels,
  socialWriter?: SocialDrafter,
  taxLookup?: TaxCodeLookup,
  drafts: DraftBudget = new DraftBudget(),
  blueskyLogins: BlueskyLoginBudget = new BlueskyLoginBudget(),
  portalSync?: PortalSync,
  bookingReader?: BookingReader,
) {
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
  // The assisted tax portal sync (issue #325): the steps check the member's role again in their commands; the password
  // in login's input goes to the portal and nowhere else.
  const inPortalSync = async <T>(context: RpcContext, fn: (orgId: string, actor: UserActor, sync: PortalSync) => Promise<T>) =>
    inFinance(context, (orgId, actor) => {
      if (!portalSync) throw new DomainError('PORTAL_SYNC_DISABLED', 404, 'Chức năng lấy dữ liệu từ cổng thuế chưa được bật trên máy chủ này');
      return fn(orgId, actor, portalSync);
    });

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

  // The crm module (#1314): its procedures answer 404 when the deployment leaves it out, as Social's do.
  const crm = runtime.installed('crm');
  const inCrm = async <T>(context: RpcContext, fn: (orgId: string, actor: UserActor) => Promise<T>) => {
    if (!crm) throw new ORPCError('NOT_FOUND', { status: 404, message: 'Mô-đun CRM chưa được bật' });
    return inOrg(context, fn);
  };
  const crmCommand =
    (name: string) =>
    <I, O>({ context, input }: { context: RpcContext; input: I }): Promise<O> =>
      inCrm(context, (orgId, actor) => runtime.execute<O>(name, input, { actor, orgId }));

  // The notes module (#1671): its procedures answer 404 when the deployment leaves it out, as CRM's do.
  const notes = runtime.installed('notes');
  const inNotes = async <T>(context: RpcContext, fn: (orgId: string, actor: UserActor) => Promise<T>) => {
    if (!notes) throw new ORPCError('NOT_FOUND', { status: 404, message: 'Mô-đun Ghi chú chưa được bật' });
    return inOrg(context, fn);
  };
  const notesCommand =
    (name: string) =>
    <I, O>({ context, input }: { context: RpcContext; input: I }): Promise<O> =>
      inNotes(context, (orgId, actor) => runtime.execute<O>(name, input, { actor, orgId }));
  const notesQuery =
    (name: string) =>
    <I, O>({ context, input }: { context: RpcContext; input: I }): Promise<O> =>
      inNotes(context, (orgId, actor) => runtime.query<O>(name, input, { actor, orgId }));

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
  // The org's team chat for Social alerts (#863): the target is checked with the platform and sealed here, then saved by
  // the command. The API never reads it back: a test line is only asked for, and the worker sends it.
  const chatAlertTests = new ChatAlertTestBudget();
  const chatAlertSaves = new ChatAlertSaveBudget();
  const chatAlertScope = async (context: RpcContext) => {
    if (!social) throw new ORPCError('NOT_FOUND', { status: 404, message: 'Mô-đun mạng xã hội chưa được bật' });
    const { orgId, role } = await resolveMembership(runtime, context.user, context.orgSlug);
    return { orgId, actor: actorOf(context.user), role };
  };
  // Stock photos (#1106): members and above, in an org with Social, on a deployment with the key, within the budget;
  // the order makes every refusal happen before any call to Pexels.
  const stockScope = async <T>(context: RpcContext, fn: (orgId: string, actor: UserActor, stock: StockPhotos) => Promise<T>) => {
    if (!social) throw new ORPCError('NOT_FOUND', { status: 404, message: 'Mô-đun mạng xã hội chưa được bật' });
    return guard(async () => {
      const { orgId, role } = await resolveMembership(runtime, context.user, context.orgSlug);
      const stock = channels?.stockPhotos;
      if (!stock) throw new DomainError('STOCK_PHOTOS_DISABLED', 404, 'Ảnh từ Pexels chưa được bật trên máy chủ này');
      if (role === 'viewer') throw new DomainError('FORBIDDEN', 403, 'Người xem không tìm hoặc lưu được ảnh vào thư viện');
      const actor = actorOf(context.user);
      const ticket = stock.budget.take(orgId, actor.userId);
      if (!ticket.allowed) throw new DomainError('RATE_LIMITED', 429, 'Bạn đã tìm hoặc lưu nhiều ảnh trong phút này, hãy thử lại sau ít phút', { retryAfterSeconds: ticket.retryAfterSeconds });
      return fn(orgId, actor, stock);
    });
  };
  // The CSV import's image URLs (#1258): members and above, in an org with Social; the budget is per URL, so each
  // refused one says so on its row.
  const mediaUrlScope = async <T>(context: RpcContext, fn: (orgId: string, actor: UserActor, urls: MediaUrls) => Promise<T>) => {
    if (!social) throw new ORPCError('NOT_FOUND', { status: 404, message: 'Mô-đun mạng xã hội chưa được bật' });
    return guard(async () => {
      const { orgId, role } = await resolveMembership(runtime, context.user, context.orgSlug);
      if (role === 'viewer') throw new DomainError('FORBIDDEN', 403, 'Người xem không thêm được ảnh vào thư viện');
      const urls = channels?.mediaUrls;
      if (!urls) throw new DomainError('MEDIA_URLS_DISABLED', 404, 'Máy chủ này chưa tải ảnh từ đường dẫn');
      return fn(orgId, actorOf(context.user), urls);
    });
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
      // The org's overview (#1249): the figures the multi-client home screen reads for each org, for this one.
      overview: os.org.overview.handler(({ context }) => inOrg(context, (orgId, actor) => runtime.query('kernel.org.overview', {}, { actor, orgId }))),
      setTaxCode: os.org.setTaxCode.handler(({ context, input }) =>
        inOrg(context, (orgId, actor) => runtime.execute('kernel.org.set_tax_code', input, { actor, orgId })),
      ),
      setVatFilingPeriod: os.org.setVatFilingPeriod.handler(({ context, input }) =>
        inOrg(context, (orgId, actor) => runtime.execute('kernel.org.set_vat_filing_period', input, { actor, orgId })),
      ),
      setApprovalPreset: os.org.setApprovalPreset.handler(({ context, input }) =>
        inOrg(context, (orgId, actor) => runtime.execute('kernel.org.set_approval_preset', input, { actor, orgId })),
      ),
      setAddress: os.org.setAddress.handler(({ context, input }) =>
        inOrg(context, (orgId, actor) => runtime.execute('kernel.org.set_address', input, { actor, orgId })),
      ),
      setContactEmail: os.org.setContactEmail.handler(({ context, input }) =>
        inOrg(context, (orgId, actor) => runtime.execute('kernel.org.set_contact_email', input, { actor, orgId })),
      ),
      proposalPolicy: os.org.proposalPolicy.handler(({ context }) => inOrg(context, (orgId, actor) => runtime.query('kernel.proposal_policy.get', {}, { actor, orgId }))),
      setProposalPolicy: os.org.setProposalPolicy.handler(({ context, input }) =>
        inOrg(context, (orgId, actor) => runtime.execute('kernel.proposal_policy.save', input, { actor, orgId })),
      ),
      taxProfile: os.org.taxProfile.handler(({ context }) => inOrg(context, (orgId, actor) => runtime.query('kernel.tax_profile.get', {}, { actor, orgId }))),
      setTaxProfile: os.org.setTaxProfile.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.execute('kernel.tax_profile.save', input, { actor, orgId }))),
      // The VAT return's done mark goes through finance when it is on (#1400): finance.vat.return_mark records the
      // return as filed, with Crove's own figures, and writes the same done mark in the same transaction, so the next
      // period's [22] has a [43] to start from.
      markTaxObligation: os.org.markTaxObligation.handler(({ context, input }) =>
        inOrg(context, async (orgId, actor) => {
          const { done, ...mark } = input;
          if (finance && mark.obligation === 'vat_return' && /^\d{4}-(\d{2}|Q\d)$/.test(mark.period)) {
            // Each legal entity files its own return (#1280 part 2b): the entity named, else the one resolved for the
            // caller, as on the VAT screen.
            await runtime.execute(
              'finance.vat.return_mark',
              { period: mark.period, done, ...(mark.legalEntityId !== undefined ? { legalEntityId: mark.legalEntityId } : {}) },
              { actor, orgId },
            );
            return { ...mark, done };
          }
          return runtime.execute(done ? 'kernel.tax_obligation.done' : 'kernel.tax_obligation.undo', mark, { actor, orgId });
        }),
      ),
      audit: os.org.audit.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.query('kernel.audit.list', input, { actor, orgId }))),
      auditCommands: os.org.auditCommands.handler(({ context }) => inOrg(context, (orgId, actor) => runtime.query('kernel.audit.commands', {}, { actor, orgId }))),
      auditExport: os.org.auditExport.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.execute('kernel.audit.export', input, { actor, orgId }))),
      // A command, not a query: every search leaves an audit row (#1678).
      personalData: os.org.personalData.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.execute('kernel.personal_data.find', input, { actor, orgId }))),
      personalDataErase: os.org.personalDataErase.handler(({ context, input }) => keyed(context, 'kernel.personal_data.erase', input)),
      personalDataNotify: os.org.personalDataNotify.handler(({ context, input }) => keyed(context, 'kernel.personal_data.notify', input)),
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
      memberRoles: os.org.memberRoles.handler(({ context }) => inOrg(context, (orgId, actor) => runtime.query('kernel.member.roles.list', {}, { actor, orgId }))),
      assignRole: os.org.assignRole.handler(({ context, input }) =>
        inOrg(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('kernel.member.role.assign', rest, { actor, orgId, idempotencyKey });
        }),
      ),
      revokeRole: os.org.revokeRole.handler(({ context, input }) =>
        inOrg(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('kernel.member.role.revoke', rest, { actor, orgId, idempotencyKey });
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
    notes: {
      list: os.notes.list.handler(notesQuery('notes.note.list')),
      get: os.notes.get.handler(notesQuery('notes.note.get')),
      search: os.notes.search.handler(notesQuery('notes.note.search')),
      panel: os.notes.panel.handler(notesQuery('notes.record.panel')),
      create: os.notes.create.handler(notesCommand('notes.note.create')),
      update: os.notes.update.handler(notesCommand('notes.note.update')),
      setVisibility: os.notes.setVisibility.handler(notesCommand('notes.note.set_visibility')),
      pin: os.notes.pin.handler(notesCommand('notes.note.pin')),
      unpin: os.notes.unpin.handler(notesCommand('notes.note.unpin')),
      archive: os.notes.archive.handler(notesCommand('notes.note.archive')),
      restore: os.notes.restore.handler(notesCommand('notes.note.restore')),
      delete: os.notes.delete.handler(notesCommand('notes.note.delete')),
      linkAdd: os.notes.linkAdd.handler(notesCommand('notes.link.add')),
      linkRemove: os.notes.linkRemove.handler(notesCommand('notes.link.remove')),
      privateCounts: os.notes.privateCounts.handler(notesQuery('notes.private_counts')),
      // A member's own to-dos (#1673).
      todos: {
        list: os.notes.todos.list.handler(notesQuery('notes.todo.list')),
        get: os.notes.todos.get.handler(notesQuery('notes.todo.get')),
        create: os.notes.todos.create.handler(notesCommand('notes.todo.create')),
        update: os.notes.todos.update.handler(notesCommand('notes.todo.update')),
        complete: os.notes.todos.complete.handler(notesCommand('notes.todo.complete')),
        reopen: os.notes.todos.reopen.handler(notesCommand('notes.todo.reopen')),
        reorder: os.notes.todos.reorder.handler(notesCommand('notes.todo.reorder')),
        delete: os.notes.todos.delete.handler(notesCommand('notes.todo.delete')),
        restore: os.notes.todos.restore.handler(notesCommand('notes.todo.restore')),
        handOver: os.notes.todos.handOver.handler(notesCommand('notes.todo.hand_over')),
        myWork: os.notes.todos.myWork.handler(notesQuery('notes.my_work')),
        counts: os.notes.todos.counts.handler(notesQuery('notes.todo.counts')),
      },
    },
    crm: {
      eventTypes: {
        list: os.crm.eventTypes.list.handler(({ context }) => inCrm(context, (orgId, actor) => runtime.query('crm.event_type.list', {}, { actor, orgId }))),
        create: os.crm.eventTypes.create.handler(crmCommand('crm.event_type.create')),
        update: os.crm.eventTypes.update.handler(crmCommand('crm.event_type.update')),
        setActive: os.crm.eventTypes.setActive.handler(crmCommand('crm.event_type.set_active')),
      },
      bookings: {
        list: os.crm.bookings.list.handler(({ context, input }) => inCrm(context, (orgId, actor) => runtime.query('crm.booking.list', input, { actor, orgId }))),
        cancel: os.crm.bookings.cancel.handler(crmCommand('crm.booking.cancel')),
        move: os.crm.bookings.move.handler(crmCommand('crm.booking.move')),
        // Times to offer a client (#1440): the type's free slots, inside the days and times the client's message asks
        // for when the deployment's model can read it (a paid call, on the drafts' budget), else the next free ones.
        // Read-only: the member sends the reply. A model that fails or is off leaves the next free slots and says so.
        suggest: os.crm.bookings.suggest.handler(({ context, input }) =>
          inCrm(context, async (orgId, actor) => {
            const pick = async (windows: readonly ScheduleWindow[]) => {
              const s = await runtime.query<SuggestedSlots>('crm.booking.suggest_slots', { eventTypeId: input.eventTypeId, windows }, { actor, orgId });
              return { eventType: s.eventType, timeZone: s.timeZone, inWindows: s.inWindows, slots: s.slots, today: s.today, days: s.days };
            };
            const { today, days, ...next } = await pick([]);
            if (!input.message) return { ai: 'skipped' as const, asksForMeeting: null, windows: [], ...next };
            if (!bookingReader) return { ai: 'off' as const, asksForMeeting: null, windows: [], ...next };
            const ticket = drafts.take(orgId, actor.userId);
            if (!ticket.allowed) {
              throw new DomainError('RATE_LIMITED', 429, ticket.reason === 'busy' ? 'Đang chờ AI trả lời, hãy đợi xong rồi thử tiếp' : 'Đã dùng AI nhiều lần trong phút này, hãy thử lại sau ít phút', {
                retryAfterSeconds: ticket.retryAfterSeconds,
              });
            }
            let reading: ScheduleReading;
            try {
              reading = await bookingReader.read({ message: input.message, today, days, timeZone: next.timeZone });
            } catch (error: unknown) {
              // Neither the message nor the answer is logged.
              console.error('[crm-ai] suggest failed', error instanceof Error ? error.name : typeof error);
              return { ai: 'failed' as const, asksForMeeting: null, windows: [], ...next };
            } finally {
              ticket.release();
            }
            if (reading.windows.length === 0) return { ai: 'used' as const, asksForMeeting: reading.asksForMeeting, windows: [], ...next };
            const { today: _t, days: _d, ...picked } = await pick(reading.windows);
            return { ai: 'used' as const, asksForMeeting: reading.asksForMeeting, windows: reading.windows, ...picked };
          }),
        ),
      },
      bookingFeed: {
        get: os.crm.bookingFeed.get.handler(({ context }) => inCrm(context, (orgId, actor) => runtime.query('crm.booking_feed.get', {}, { actor, orgId }))),
        create: os.crm.bookingFeed.create.handler(crmCommand('crm.booking_feed.create')),
        revoke: os.crm.bookingFeed.revoke.handler(crmCommand('crm.booking_feed.revoke')),
      },
    },
    social: {
      posts: {
        list: os.social.posts.list.handler(socialQuery('social.post.list')),
        get: os.social.posts.get.handler(socialQuery('social.post.get')),
        reviewDiff: os.social.posts.reviewDiff.handler(socialQuery('social.post.review_diff')),
        preReview: os.social.posts.preReview.handler(socialQuery('social.post.pre_review')),
        versions: os.social.posts.versions.handler(socialQuery('social.post.versions')),
        restoreVersion: os.social.posts.restoreVersion.handler(socialCommand('social.post.restore_version')),
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
        bulkLabels: os.social.posts.bulkLabels.handler(socialCommand('social.post.bulk_labels')),
        bulkAssign: os.social.posts.bulkAssign.handler(socialCommand('social.post.bulk_assign')),
        bulkReplacePreview: os.social.posts.bulkReplacePreview.handler(socialQuery('social.post.bulk_replace_preview')),
        bulkReplace: os.social.posts.bulkReplace.handler(socialCommand('social.post.bulk_replace')),
        bulkAddChannel: os.social.posts.bulkAddChannel.handler(socialCommand('social.post.bulk_add_channel')),
        archive: os.social.posts.archive.handler(socialCommand('social.post.archive')),
        restore: os.social.posts.restore.handler(socialCommand('social.post.restore')),
        bulkArchive: os.social.posts.bulkArchive.handler(socialCommand('social.post.bulk_archive')),
        bulkRestore: os.social.posts.bulkRestore.handler(socialCommand('social.post.bulk_restore')),
        createFromMedia: os.social.posts.createFromMedia.handler(({ context, input }) =>
          inSocial(context, (orgId, actor) => {
            const { idempotencyKey, ...rest } = input;
            return runtime.execute('social.post.create_from_media', rest, { actor, orgId, idempotencyKey });
          }),
        ),
        comment: os.social.posts.comment.handler(socialCommand('social.post_comment.add')),
        editComment: os.social.posts.editComment.handler(socialCommand('social.post_comment.edit')),
        resolveComment: os.social.posts.resolveComment.handler(socialCommand('social.post_comment.resolve')),
        reopenComment: os.social.posts.reopenComment.handler(socialCommand('social.post_comment.reopen')),
        suggest: os.social.posts.suggest.handler(socialCommand('social.post_comment.suggest')),
        acceptSuggestion: os.social.posts.acceptSuggestion.handler(socialCommand('social.post_comment.accept')),
        skipSuggestion: os.social.posts.skipSuggestion.handler(socialCommand('social.post_comment.skip')),
        activity: os.social.posts.activity.handler(socialQuery('social.post.activity')),
        setEvergreen: os.social.posts.setEvergreen.handler(socialCommand('social.post.set_evergreen')),
        setRecurrence: os.social.posts.setRecurrence.handler(socialCommand('social.post.recurrence_set')),
        clearRecurrence: os.social.posts.clearRecurrence.handler(socialCommand('social.post.recurrence_clear')),
        setTextVariations: os.social.posts.setTextVariations.handler(socialCommand('social.post.set_text_variations')),
        aiPhotos: os.social.posts.aiPhotos.handler(({ context }) => inSocial(context, async () => ({ enabled: Boolean(socialWriter?.draftStored) }))),
        draftWithAi: os.social.posts.draftWithAi.handler(({ context, input }) =>
          inSocial(context, async (orgId, actor) => {
            // The model costs money: only those who may write posts get to call it, checked before anything else (the
            // create command checks the role again).
            const { role } = await resolveMembership(runtime, context.user, context.orgSlug);
            if (role !== 'owner' && role !== 'admin' && role !== 'member') throw new DomainError('FORBIDDEN', 403, 'Vai trò chỉ xem không soạn được bài');
            if (!socialWriter) throw new DomainError('AI_NOT_CONFIGURED', 503, 'Máy chủ chưa cấu hình AI (AI_BASE_URL, AI_MODEL)');
            // Photos (#1191) need a model that takes images, said before anything is read.
            const fileIds = input.fileIds ?? [];
            const draftStored = socialWriter.draftStored;
            if (fileIds.length > 0 && !draftStored) throw new DomainError('AI_VISION_OFF', 422, 'Mô hình AI của máy chủ chưa đọc được ảnh (AI_VISION)');
            if (new Set(input.connectionIds).size !== input.connectionIds.length) throw new DomainError('CHANNEL_ALREADY_IN_POST', 409, 'Mỗi kênh chỉ có một bản trong bài đăng');
            await refuseChannelsOutside(runtime, actor, orgId, input.connectionIds);
            const connections = await runtime.query<{ id: string; provider: string; displayName: string; status: string }[]>('kernel.channel.list', {}, { actor, orgId });
            const chosen = input.connectionIds.map((id) => connections.find((c) => c.id === id && c.status === 'active'));
            if (chosen.some((c) => !c)) throw new DomainError('CHANNEL_NOT_FOUND', 404, 'Có kênh không tồn tại hoặc đã ngắt kết nối');
            const channels = (chosen as { id: string; provider: string; displayName: string }[]).map((c) => writerChannel(c));
            // Each photo: an image of the org's Social library the member may use (for a limited member, not another
            // channel's own media, #1081), of a type and size the model is sent (as for alt text), checked before the
            // source page and the budget.
            const photos =
              fileIds.length > 0
                ? await runtime.query<{ fileId: string; storageKey: string; generation: string | null; sha256: string; contentType: string; sizeBytes: number }[]>('social.media.draft_images', { fileIds }, { actor, orgId })
                : [];
            for (const photo of photos) {
              if (!ALT_TEXT_IMAGE_TYPES.includes(photo.contentType)) throw new DomainError('AI_DRAFT_IMAGE_ONLY', 422, 'Vy chỉ soạn bài từ ảnh JPG, PNG hoặc WEBP, không từ video hay tệp PDF', { fileId: photo.fileId });
              if (photo.sizeBytes > ALT_TEXT_IMAGE_MAX_BYTES) throw new DomainError('AI_DRAFT_IMAGE_TOO_LARGE', 413, 'Có ảnh lớn hơn 10 MB nên Vy không đọc được', { fileId: photo.fileId });
            }
            // The source page (#769) as its link preview read it (fetched by the worker through the egress guard, parsed in
            // the extract container): asked for if new, and waited for a few seconds. Before the budget: waiting for a page
            // costs no model call, and a page that cannot be read takes no slot.
            const source = input.sourceUrl ? await sourcePage(runtime, actor, orgId, input.sourceUrl) : undefined;
            // A forwarded mail (#779): its subject and text as kept with the inbound message, read in the caller's org
            // only (a mail of another org is not found). Like the page, tainted data the writer takes facts from.
            const mail = input.inboundMessageId ? await runtime.query<{ subject: string | null; text: string | null }>('kernel.inbound.text', { id: input.inboundMessageId }, { actor, orgId }) : undefined;
            if (mail && !mail.text && !mail.subject?.trim()) throw new DomainError('MAIL_EMPTY', 422, 'Thư này không có nội dung để soạn bài; hãy mô tả bài bằng lời');
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
              const request: Omit<DraftRequest, 'images'> = {
                brief: input.brief,
                channels,
                language: input.language ?? 'vi',
                ...(input.tone ? { tone: input.tone } : {}),
                ...(voices?.org ? { voice: voices.org } : {}),
                ...(source ? { source } : {}),
                ...(mail ? { mail } : {}),
                ...(voices ? { channelVoices: Object.fromEntries(input.connectionIds.flatMap((id) => (voices.byChannel.has(id) ? [[id, voices.byChannel.get(id) as string]] : []))) } : {}),
              };
              draft =
                photos.length > 0 && draftStored
                  ? await draftStored(
                      request,
                      photos.map((p) => ({ file: { key: p.storageKey, generation: p.generation, sha256: p.sha256, sizeBytes: p.sizeBytes }, mime: p.contentType })),
                    )
                  : await socialWriter.draft(request);
            } catch (error: unknown) {
              console.error('[social-ai] draft failed', error instanceof Error ? error.name : typeof error);
              // A photo that could not be read as recorded, or a failed vision call, has its own words (#1126).
              if (photos.length > 0) throw new DomainError('AI_DRAFT_VISION_FAILED', 503, 'Vy chưa đọc được ảnh để soạn bài lúc này, hãy thử lại sau');
              throw new DomainError('AI_DRAFT_FAILED', 503, 'Vy không soạn được bài lúc này, hãy thử lại sau');
            } finally {
              ticket.release();
            }
            if (!draft && photos.length > 0) throw new DomainError('AI_DRAFT_PHOTOS_EMPTY', 422, 'Vy không soạn được bài từ những ảnh này, hãy thêm vài dòng mô tả');
            if (!draft) throw new DomainError('AI_DRAFT_EMPTY', 422, 'Vy không soạn được bài từ mô tả này, hãy viết rõ hơn');
            const own = new Map(draft.variants.map((v) => [v.key, v]));
            const created = await runtime.execute<{ postId: string }>(
              'social.post.create',
              {
                body: draft.body,
                title: draft.title,
                origin: 'ai',
                ...(input.sourceUrl ? { linkUrl: input.sourceUrl } : {}),
                // The photos it was written from, in the order picked, as the post's images.
                ...(photos.length > 0 ? { media: photos.map((p) => ({ fileId: p.fileId })) } : {}),
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
              await refuseChannelsOutside(runtime, actor, orgId, [input.connectionId]);
              const connections = await runtime.query<{ id: string; provider: string; displayName: string; status: string }[]>('kernel.channel.list', {}, { actor, orgId });
              const found = connections.find((c) => c.id === input.connectionId && c.status !== 'revoked');
              if (!found) throw new DomainError('CHANNEL_NOT_FOUND', 404, 'Có kênh không tồn tại hoặc đã ngắt kết nối');
              channel = writerChannel(found);
            }
            const proofread = input.action === 'proofread';
            // The same budget as drafts: each rewrite is a paid model call (#386).
            const ticket = drafts.take(orgId, actor.userId);
            if (!ticket.allowed) {
              throw new DomainError('RATE_LIMITED', 429, ticket.reason === 'busy' ? 'Đang chờ AI trả lời, hãy đợi xong rồi thử tiếp' : 'Đã dùng AI nhiều lần trong phút này, hãy thử lại sau ít phút', {
                retryAfterSeconds: ticket.retryAfterSeconds,
              });
            }
            let result: Awaited<ReturnType<SocialDrafter['rewrite']>>;
            try {
              // A proofread keeps the member's style: no brand voice is read for it.
              const voices = proofread ? null : await savedVoices(runtime, actor, orgId);
              const voice = voices ? ((input.connectionId ? voices.byChannel.get(input.connectionId) : undefined) ?? voices.org) : null;
              result = await socialWriter.rewrite({ text: input.text, title: input.title ?? null, action: input.action, ...(channel ? { channel } : {}), ...(voice ? { voice } : {}) });
            } catch (error: unknown) {
              // The check after a proofread (#1167) found a changed link, hashtag, mention, number or price, or emoji.
              if (error instanceof ProofreadChangedError) {
                throw new DomainError('AI_PROOFREAD_CHANGED', 422, 'Vy đã sửa cả liên kết, hashtag, tài khoản được nhắc (@), con số, giá hoặc emoji nên bản sửa bị bỏ; nội dung của bạn vẫn giữ nguyên', { changed: [...error.kinds] });
              }
              console.error('[social-ai] rewrite failed', error instanceof Error ? error.name : typeof error);
              if (proofread) throw new DomainError('AI_PROOFREAD_FAILED', 503, 'Vy chưa soát được chính tả lúc này, hãy thử lại sau');
              throw new DomainError('AI_DRAFT_FAILED', 503, 'Vy không soạn được bài lúc này, hãy thử lại sau');
            } finally {
              ticket.release();
            }
            if (!result && proofread) throw new DomainError('AI_PROOFREAD_FAILED', 503, 'Vy chưa soát được chính tả lúc này, hãy thử lại sau');
            if (!result) throw new DomainError('AI_REWRITE_EMPTY', 422, 'Vy không viết lại được đoạn này, hãy thử cách khác');
            return result;
          }),
        ),
        // An alt text suggestion for one image (#817, #1121): a proposal the member keeps or edits, never saved here.
        // The image is read only when it is the org's own Social upload, a JPG, PNG or WEBP of at most 10 MB, and goes
        // only to the configured model; neither it nor the prompt is logged.
        describeImage: os.social.posts.describeImage.handler(({ context, input }) =>
          inSocial(context, async (orgId, actor) => {
            const { role } = await resolveMembership(runtime, context.user, context.orgSlug);
            if (role !== 'owner' && role !== 'admin' && role !== 'member') throw new DomainError('FORBIDDEN', 403, 'Vai trò chỉ xem không soạn được bài');
            if (!socialWriter) throw new DomainError('AI_NOT_CONFIGURED', 503, 'Máy chủ chưa cấu hình AI (AI_BASE_URL, AI_MODEL)');
            if (!socialWriter.describeStored) throw new DomainError('AI_VISION_OFF', 422, 'Mô hình AI của máy chủ chưa đọc được ảnh (AI_VISION)');
            const file = await runtime.query<{ storageKey: string; generation: string | null; sha256: string; contentType: string; sizeBytes: number }>('social.media.stored', { fileId: input.fileId }, { actor, orgId });
            if (!ALT_TEXT_IMAGE_TYPES.includes(file.contentType)) throw new DomainError('ALT_TEXT_IMAGE_ONLY', 422, 'Chỉ gợi ý mô tả cho ảnh');
            if (file.sizeBytes > ALT_TEXT_IMAGE_MAX_BYTES) throw new DomainError('ALT_TEXT_IMAGE_TOO_LARGE', 413, 'Ảnh lớn hơn 10 MB nên Vy không đọc được');
            // The post's channels, the org's own (a disconnected one of a saved post included): the suggestion keeps
            // within their strictest alt-text limit. A member limited to some channels (#1081) names only theirs (#1175),
            // checked before the budget and the model call.
            let maxChars: number | null = null;
            if (input.connectionIds && input.connectionIds.length > 0) {
              await refuseChannelsOutside(runtime, actor, orgId, input.connectionIds);
              const connections = await runtime.query<{ id: string; provider: string }[]>('kernel.channel.list', { includeRevoked: true }, { actor, orgId });
              const own = new Map(connections.map((c) => [c.id, c.provider]));
              const providers: string[] = [];
              for (const id of input.connectionIds) {
                const provider = own.get(id);
                if (provider === undefined) throw new DomainError('CHANNEL_NOT_FOUND', 404, 'Có kênh không tồn tại');
                providers.push(provider);
              }
              maxChars = strictestAltTextLimit(providers);
            }
            // The same budget as drafts: each ask is a paid model call (#386).
            const ticket = drafts.take(orgId, actor.userId);
            if (!ticket.allowed) {
              throw new DomainError('RATE_LIMITED', 429, ticket.reason === 'busy' ? 'Đang chờ AI trả lời, hãy đợi xong rồi thử tiếp' : 'Đã dùng AI nhiều lần trong phút này, hãy thử lại sau ít phút', {
                retryAfterSeconds: ticket.retryAfterSeconds,
              });
            }
            let altText: string | null;
            try {
              altText = await socialWriter.describeStored({ key: file.storageKey, generation: file.generation, sha256: file.sha256, sizeBytes: file.sizeBytes }, file.contentType, input.language, maxChars);
            } catch (error: unknown) {
              console.error('[social-ai] describe failed', error instanceof Error ? error.name : typeof error);
              throw new DomainError('AI_ALT_TEXT_FAILED', 503, 'Vy chưa gợi ý được mô tả ảnh lúc này, hãy thử lại sau');
            } finally {
              ticket.release();
            }
            if (!altText) throw new DomainError('AI_ALT_TEXT_EMPTY', 422, 'Vy không mô tả được ảnh này, bạn hãy tự viết mô tả');
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
              // A member limited to some channels (#1081) may not have another channel's name and limits go into the
              // prompt (#1175): refused before the budget and the model call.
              await refuseChannelsOutside(runtime, actor, orgId, [input.connectionId]);
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
              throw new DomainError('AI_DRAFT_FAILED', 503, 'Vy không soạn được bài lúc này, hãy thử lại sau');
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
        remove: os.social.variants.remove.handler(socialCommand('social.variant.remove')),
        editPublished: os.social.variants.editPublished.handler(socialCommand('social.variant.edit_published')),
      },
      metrics: {
        summary: os.social.metrics.summary.handler(socialQuery('social.metrics.summary')),
        totals: os.social.metrics.totals.handler(socialQuery('social.metrics.totals')),
        external: os.social.metrics.external.handler(socialQuery('social.metrics.external')),
        insights: os.social.metrics.insights.handler(socialQuery('social.metrics.insights')),
        export: os.social.metrics.export.handler(socialCommand('social.metrics.export')),
        // An AI summary of a period (#1237): the role gate, AI configured, the channels the member may use (#1081) and
        // the budget (#386) before the one model call, in the org's voice (or the one chosen channel's). The figures are
        // the tab's own totals; a summary citing another number is refused. Nothing is saved.
        writeSummary: os.social.metrics.writeSummary.handler(({ context, input }) =>
          inSocial(context, async (orgId, actor) => {
            const { role } = await resolveMembership(runtime, context.user, context.orgSlug);
            if (role !== 'owner' && role !== 'admin' && role !== 'member') throw new DomainError('FORBIDDEN', 403, 'Vai trò chỉ xem không dùng được AI để viết tóm tắt');
            if (!socialWriter?.summary) throw new DomainError('AI_NOT_CONFIGURED', 503, 'Máy chủ chưa cấu hình AI (AI_BASE_URL, AI_MODEL)');
            const connectionIds = [...new Set(input.connectionIds ?? [])];
            await refuseChannelsOutside(runtime, actor, orgId, connectionIds);
            const { language, ...period } = input;
            // Reading the figures costs no model call: a period with nothing published takes no slot.
            const data = await runtime.query<PeriodSummaryData>('social.metrics.summary_figures', period, { actor, orgId });
            if (data.current.posts === 0 && data.previous.posts === 0) throw new DomainError('AI_SUMMARY_NO_DATA', 422, 'Kỳ này và kỳ trước chưa có bài nào đã đăng nên chưa có gì để tóm tắt');
            const summaryInput = periodSummaryInput(data);
            // The same budget as drafts: each summary is a paid model call (#386).
            const ticket = drafts.take(orgId, actor.userId);
            if (!ticket.allowed) {
              throw new DomainError('RATE_LIMITED', 429, ticket.reason === 'busy' ? 'Đang chờ AI trả lời, hãy đợi xong rồi thử tiếp' : 'Đã dùng AI nhiều lần trong phút này, hãy thử lại sau ít phút', {
                retryAfterSeconds: ticket.retryAfterSeconds,
              });
            }
            let text: string | null;
            try {
              const voices = await savedVoices(runtime, actor, orgId);
              const only = connectionIds.length === 1 ? connectionIds[0] : undefined;
              const voice = (only ? voices.byChannel.get(only) : undefined) ?? voices.org;
              text = await socialWriter.summary({ ...summaryInput, language: language ?? 'vi', ...(voice ? { voice } : {}) });
            } catch (error: unknown) {
              // The check after the call found a number that is not one of the period's figures.
              if (error instanceof SummaryFigureError) {
                throw new DomainError('AI_SUMMARY_FIGURE_INVENTED', 422, 'Vy đã viết một con số không có trong số liệu của kỳ nên bản tóm tắt bị bỏ; hãy thử lại', { numbers: error.numbers.length });
              }
              console.error('[social-ai] summary failed', error instanceof Error ? error.name : typeof error);
              throw new DomainError('AI_SUMMARY_FAILED', 503, 'Vy chưa viết được tóm tắt lúc này, hãy thử lại sau');
            } finally {
              ticket.release();
            }
            if (!text) throw new DomainError('AI_SUMMARY_EMPTY', 422, 'Vy không viết được tóm tắt cho kỳ này, hãy thử lại');
            return { text };
          }),
        ),
      },
      plan: {
        export: os.social.plan.export.handler(socialCommand('social.plan.export')),
      },
      team: {
        report: os.social.team.report.handler(socialQuery('social.team.report')),
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
        // Post ideas from a theme (#1181): the same role gate, budget and brand voice as AI drafting; nothing is saved.
        suggest: os.social.ideas.suggest.handler(({ context, input }) =>
          inSocial(context, async (orgId, actor) => {
            const { role } = await resolveMembership(runtime, context.user, context.orgSlug);
            if (role !== 'owner' && role !== 'admin' && role !== 'member') throw new DomainError('FORBIDDEN', 403, 'Vai trò chỉ xem không soạn được bài');
            if (!socialWriter?.ideas) throw new DomainError('AI_NOT_CONFIGURED', 503, 'Máy chủ chưa cấu hình AI (AI_BASE_URL, AI_MODEL)');
            // A channel's voice: only a channel the member may write for (#1081), and one of the org's.
            if (input.connectionId) {
              await refuseChannelsOutside(runtime, actor, orgId, [input.connectionId]);
              const connections = await runtime.query<{ id: string; status: string }[]>('kernel.channel.list', {}, { actor, orgId });
              if (!connections.some((c) => c.id === input.connectionId && c.status !== 'revoked')) throw new DomainError('CHANNEL_NOT_FOUND', 404, 'Có kênh không tồn tại hoặc đã ngắt kết nối');
            }
            // The same budget as drafts: each ask is a paid model call (#386).
            const ticket = drafts.take(orgId, actor.userId);
            if (!ticket.allowed) {
              throw new DomainError('RATE_LIMITED', 429, ticket.reason === 'busy' ? 'Đang chờ AI trả lời, hãy đợi xong rồi thử tiếp' : 'Đã dùng AI nhiều lần trong phút này, hãy thử lại sau ít phút', {
                retryAfterSeconds: ticket.retryAfterSeconds,
              });
            }
            let ideas: Awaited<ReturnType<NonNullable<SocialDrafter['ideas']>>>;
            try {
              const voices = await savedVoices(runtime, actor, orgId);
              const voice = (input.connectionId ? voices.byChannel.get(input.connectionId) : undefined) ?? voices.org;
              ideas = await socialWriter.ideas({ theme: input.theme, occasion: input.occasion ?? null, count: input.count, language: input.language ?? 'vi', ...(voice ? { voice } : {}) });
            } catch (error: unknown) {
              console.error('[social-ai] ideas failed', error instanceof Error ? error.name : typeof error);
              throw new DomainError('AI_IDEAS_FAILED', 503, 'Vy chưa gợi ý được ý tưởng lúc này, hãy thử lại sau');
            } finally {
              ticket.release();
            }
            if (ideas.length === 0) throw new DomainError('AI_IDEAS_EMPTY', 422, 'Vy không nghĩ ra ý tưởng nào từ chủ đề này, hãy viết rõ hơn');
            return { ideas };
          }),
        ),
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
      savedViews: {
        list: os.social.savedViews.list.handler(socialQuery('social.saved_view.list')),
        save: os.social.savedViews.save.handler(socialCommand('social.saved_view.save')),
        remove: os.social.savedViews.remove.handler(socialCommand('social.saved_view.delete')),
      },
      snippets: {
        list: os.social.snippets.list.handler(socialQuery('social.snippet.list')),
        create: os.social.snippets.create.handler(socialCommand('social.snippet.create')),
        update: os.social.snippets.update.handler(socialCommand('social.snippet.update')),
        remove: os.social.snippets.remove.handler(socialCommand('social.snippet.delete')),
      },
      bannedWords: {
        list: os.social.bannedWords.list.handler(socialQuery('social.banned_word.list')),
        add: os.social.bannedWords.add.handler(socialCommand('social.banned_word.add')),
        remove: os.social.bannedWords.remove.handler(socialCommand('social.banned_word.remove')),
      },
      reviewChecklist: {
        list: os.social.reviewChecklist.list.handler(socialQuery('social.review_check.list')),
        set: os.social.reviewChecklist.set.handler(socialCommand('social.review_check.set')),
      },
      channelAccess: {
        list: os.social.channelAccess.list.handler(socialQuery('social.channel_access.list')),
        mine: os.social.channelAccess.mine.handler(socialQuery('social.channel_access.mine')),
        set: os.social.channelAccess.set.handler(socialCommand('social.channel_access.set')),
      },
      goals: {
        progress: os.social.goals.progress.handler(socialQuery('social.goal.progress')),
        set: os.social.goals.set.handler(socialCommand('social.goal.set')),
        remove: os.social.goals.remove.handler(socialCommand('social.goal.remove')),
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
      reportBranding: {
        get: os.social.reportBranding.get.handler(socialQuery('social.report_branding.get')),
        save: os.social.reportBranding.save.handler(socialCommand('social.report_branding.save')),
        remove: os.social.reportBranding.remove.handler(socialCommand('social.report_branding.remove')),
      },
      publishing: {
        get: os.social.publishing.get.handler(socialQuery('social.publishing.hold_get')),
        hold: os.social.publishing.hold.handler(socialCommand('social.publishing.hold')),
        release: os.social.publishing.release.handler(socialCommand('social.publishing.release')),
      },
      chatAlert: {
        get: os.social.chatAlert.get.handler(socialQuery('social.chat_alert.get')),
        save: os.social.chatAlert.save.handler(({ context, input }) =>
          guard(async () => {
            const scope = await chatAlertScope(context);
            // The role first, as oauthConnector does: a member learns nothing about how the deployment is set up.
            if (scope.role !== 'owner' && scope.role !== 'admin') throw new DomainError('FORBIDDEN', 403, 'Chỉ chủ sở hữu hoặc quản trị viên mới đổi được nhóm nhận báo');
            if (!channels) throw new DomainError('BROKER_NOT_CONFIGURED', 503, 'Chưa cấu hình khóa mã hóa thông tin kết nối (CREDENTIAL_KEY)');
            return saveChatAlert({ runtime, broker: channels.broker, saves: chatAlertSaves }, scope, input);
          }),
        ),
        remove: os.social.chatAlert.remove.handler(socialCommand('social.chat_alert.remove')),
        test: os.social.chatAlert.test.handler(({ context }) =>
          guard(async () => {
            return requestChatAlertTest(runtime, chatAlertTests, await chatAlertScope(context));
          }),
        ),
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
      channelOptions: {
        request: os.social.channelOptions.request.handler(socialCommand('social.channel_option.request')),
        get: os.social.channelOptions.get.handler(socialQuery('social.channel_option.get')),
      },
      notifications: {
        list: os.social.notifications.list.handler(socialQuery('social.notification.list')),
        read: os.social.notifications.read.handler(socialCommand('social.notification.read')),
        mute: os.social.notifications.mute.handler(socialCommand('social.notification.mute')),
        mail: os.social.notifications.mail.handler(socialCommand('social.notification.mail')),
        push: {
          status: os.social.notifications.push.status.handler(({ context, input }) =>
            inSocial(context, async (orgId, actor) => {
              const push = channels?.push;
              const own = await runtime.query<{ devices: { id: string; label: string | null; createdAt: string; lastUsedAt: string | null; current: boolean }[]; subscribed: boolean }>('social.push.devices', input, { actor, orgId });
              return { enabled: Boolean(push), publicKey: push?.publicKey ?? null, ...own };
            }),
          ),
          // Without VAPID keys nothing could ever be sent: refused before a row is written.
          subscribe: os.social.notifications.push.subscribe.handler(({ context, input }) =>
            inSocial(context, (orgId, actor) => {
              if (!channels?.push) throw new DomainError('PUSH_DISABLED', 404, 'Máy chủ này chưa bật thông báo đẩy');
              return runtime.execute<{ id: string }>('social.push.subscribe', input, { actor, orgId });
            }),
          ),
          // Turning a device off works whatever the keys, so a member can always clean up.
          unsubscribe: os.social.notifications.push.unsubscribe.handler(socialCommand('social.push.unsubscribe')),
        },
      },
      accounts: {
        trends: os.social.accounts.trends.handler(socialQuery('social.account.trends')),
      },
      reviewInbox: os.social.reviewInbox.handler(socialQuery('social.review.inbox')),
      attentionInbox: os.social.attentionInbox.handler(socialQuery('social.attention.inbox')),
      reviewLinks: {
        list: os.social.reviewLinks.list.handler(socialQuery('social.review_link.list')),
        create: os.social.reviewLinks.create.handler(socialCommand('social.review_link.create')),
        createPlan: os.social.reviewLinks.createPlan.handler(socialCommand('social.review_link.create_plan')),
        plans: os.social.reviewLinks.plans.handler(socialQuery('social.review_link.list_plans')),
        revoke: os.social.reviewLinks.revoke.handler(socialCommand('social.review_link.revoke')),
        reply: os.social.reviewLinks.reply.handler(socialCommand('social.review.reply')),
      },
      media: {
        list: os.social.media.list.handler(socialQuery('social.media.list')),
        usage: os.social.media.usage.handler(socialQuery('social.media.usage')),
        tags: os.social.media.tags.handler(socialQuery('social.media.tags')),
        tag: os.social.media.tag.handler(socialCommand('social.media.tag')),
        untag: os.social.media.untag.handler(socialCommand('social.media.untag')),
        archive: os.social.media.archive.handler(socialCommand('social.media.archive')),
        restore: os.social.media.restore.handler(socialCommand('social.media.restore')),
        resolve: os.social.media.resolve.handler(socialQuery('social.media.resolve')),
        fetchUrls: os.social.media.fetchUrls.handler(({ context, input }) => mediaUrlScope(context, (orgId, actor, urls) => urls.fetch(runtime, actor, orgId, input.urls))),
      },
      stockPhotos: {
        status: os.social.stockPhotos.status.handler(({ context }) => inSocial(context, async () => ({ enabled: Boolean(channels?.stockPhotos), provider: 'pexels' as const }))),
        search: os.social.stockPhotos.search.handler(({ context, input }) => stockScope(context, (_orgId, _actor, stock) => stock.search(input))),
        save: os.social.stockPhotos.save.handler(({ context, input }) => stockScope(context, (orgId, actor, stock) => stock.save(runtime, actor, orgId, input))),
      },
      policies: {
        list: os.social.policies.list.handler(socialQuery('social.channel.policies')),
        set: os.social.policies.set.handler(socialCommand('social.channel.set_policy')),
        setReminders: os.social.policies.setReminders.handler(socialCommand('social.channel.set_reminders')),
        setShortLinks: os.social.policies.setShortLinks.handler(socialCommand('social.channel.set_short_links')),
        setSignature: os.social.policies.setSignature.handler(socialCommand('social.channel.set_signature')),
        setFourEyes: os.social.policies.setFourEyes.handler(socialCommand('social.channel.set_four_eyes')),
        setClientApproval: os.social.policies.setClientApproval.handler(socialCommand('social.channel.set_client_approval')),
      },
      channels: {
        waiting: os.social.channels.waiting.handler(socialQuery('social.channel.waiting')),
      },
      queues: {
        get: os.social.queues.get.handler(socialQuery('social.queue.get')),
        openSlots: os.social.queues.openSlots.handler(socialQuery('social.queue.open_slots')),
        set: os.social.queues.set.handler(socialCommand('social.queue.set')),
        shuffle: os.social.queues.shuffle.handler(socialCommand('social.queue.shuffle')),
        moveToFront: os.social.queues.moveToFront.handler(socialCommand('social.queue.move_to_front')),
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
              if (error.code === 'UnsupportedPds') return new DomainError('BLUESKY_PDS_UNSUPPORTED', 422, 'Không gọi được máy chủ lưu tài khoản Bluesky này (PDS phải là tên miền công khai, qua https)');
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
    // The org's legal entities (#1278): owners and admins.
    legalEntities: {
      list: os.legalEntities.list.handler(({ context }) => inOrg(context, (orgId, actor) => runtime.query('kernel.legal_entity.list', {}, { actor, orgId }))),
      create: os.legalEntities.create.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.execute('kernel.legal_entity.create', input, { actor, orgId }))),
      update: os.legalEntities.update.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.execute('kernel.legal_entity.update', input, { actor, orgId }))),
    },
    // The member's own calendar (#1313).
    calendar: {
      get: os.calendar.get.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.query('kernel.calendar.get', input, { actor, orgId }))),
      slots: os.calendar.slots.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.query('kernel.calendar.slots', input, { actor, orgId }))),
      saveHours: os.calendar.saveHours.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.execute('kernel.calendar.hours.save', input, { actor, orgId }))),
      addEvent: os.calendar.addEvent.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.execute('kernel.calendar.event.add', input, { actor, orgId }))),
      cancelEvent: os.calendar.cancelEvent.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.execute('kernel.calendar.event.cancel', input, { actor, orgId }))),
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
      timeline: os.inbox.timeline.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.query('kernel.proposal.timeline', input, { actor, orgId }))),
      raised: os.inbox.raised.handler(({ context }) => inOrg(context, (orgId, actor) => runtime.query('kernel.inbox.raised', {}, { actor, orgId }))),
      dismiss: os.inbox.dismiss.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.execute('kernel.inbox.dismiss', input, { actor, orgId }))),
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
      // Every proposal it makes is a finance proposal, like inbox.request.
      resubmit: os.inbox.resubmit.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('kernel.proposal.resubmit', rest, { actor, orgId, idempotencyKey });
        }),
      ),
      // A journal reversal or a cash or bank voucher (#327), both finance commands.
      request: os.inbox.request.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('kernel.proposal.request', rest, { actor, orgId, idempotencyKey });
        }),
      ),
    },
    inbound: {
      recent: os.inbound.recent.handler(({ context }) => inOrg(context, (orgId, actor) => runtime.query('kernel.inbound.recent', {}, { actor, orgId }))),
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
      customers: os.parties.customers.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.customers.list', input, { actor, orgId })),
      ),
      update: os.parties.update.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.execute('kernel.party.update', input, { actor, orgId }))),
      markDuplicate: os.parties.markDuplicate.handler(({ context, input }) =>
        inOrg(context, (orgId, actor) => runtime.execute('kernel.party.mark_duplicate', input, { actor, orgId })),
      ),
      unmarkDuplicate: os.parties.unmarkDuplicate.handler(({ context, input }) =>
        inOrg(context, (orgId, actor) => runtime.execute('kernel.party.unmark_duplicate', input, { actor, orgId })),
      ),
      duplicateHints: os.parties.duplicateHints.handler(({ context }) => inOrg(context, (orgId, actor) => runtime.query('kernel.party.duplicate_hints', {}, { actor, orgId }))),
    },
    documents: {
      list: os.documents.list.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.documents.list', input, { actor, orgId })),
      ),
      exports: os.documents.exports.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.query('finance.document.exports', input, { actor, orgId }))),
    },
    notifications: {
      list: os.notifications.list.handler(({ context }) => inOrg(context, (orgId, actor) => runtime.query('kernel.notification.list', {}, { actor, orgId }))),
      read: os.notifications.read.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.execute('kernel.notification.read', input, { actor, orgId }))),
      mute: os.notifications.mute.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.execute('kernel.notification.mute', input, { actor, orgId }))),
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
    misaGoodsCodes: {
      list: os.misaGoodsCodes.list.handler(({ context }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.misa_goods_codes.list', {}, { actor, orgId })),
      ),
      set: os.misaGoodsCodes.set.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.execute('finance.misa_goods_code.set', input, { actor, orgId })),
      ),
      remove: os.misaGoodsCodes.remove.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.execute('finance.misa_goods_code.remove', input, { actor, orgId })),
      ),
    },
    accountRules: {
      list: os.accountRules.list.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.categorization_rules.list', input ?? {}, { actor, orgId })),
      ),
      create: os.accountRules.create.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.execute('finance.categorization_rule.create', input, { actor, orgId })),
      ),
      remove: os.accountRules.remove.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.execute('finance.categorization_rule.remove', input, { actor, orgId })),
      ),
    },
    vat: {
      period: os.vat.period.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.vat.period', input, { actor, orgId })),
      ),
      markPayment: os.vat.markPayment.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.execute('finance.vat.payment_mark', input, { actor, orgId })),
      ),
      markReturn: os.vat.markReturn.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.execute('finance.vat.return_mark', input, { actor, orgId })),
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
    portalSync: {
      captcha: os.portalSync.captcha.handler(({ context, input }) => inPortalSync(context, (orgId, actor, sync) => sync.captcha(orgId, actor, input.period))),
      login: os.portalSync.login.handler(({ context, input }) => inPortalSync(context, (orgId, actor, sync) => sync.login(orgId, actor, input))),
      // The request's signal: a browser that went away stops the step before its next portal request.
      fetchList: os.portalSync.fetchList.handler(({ context, input, signal }) => inPortalSync(context, (orgId, actor, sync) => sync.fetchList(orgId, actor, input, signal ? { signal } : {}))),
      fetchXml: os.portalSync.fetchXml.handler(({ context, input, signal }) => inPortalSync(context, (orgId, actor, sync) => sync.fetchXml(orgId, actor, input, signal ? { signal } : {}))),
    },
    missingInvoices: {
      status: os.missingInvoices.status.handler(({ context }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.missing_invoices.status', {}, { actor, orgId })),
      ),
      request: os.missingInvoices.request.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.execute('finance.missing_invoices.request', input, { actor, orgId })),
      ),
      setReminder: os.missingInvoices.setReminder.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.execute('finance.missing_invoices.reminder.set', input, { actor, orgId })),
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
      statementsHtkkCheck: os.ledger.statementsHtkkCheck.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.statements.htkk_check', input, { actor, orgId })),
      ),
    },
    yearArchive: {
      list: os.yearArchive.list.handler(({ context }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.archive.list', {}, { actor, orgId })),
      ),
      build: os.yearArchive.build.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('finance.archive.build', rest, { actor, orgId, idempotencyKey });
        }),
      ),
    },
    fixedAssets: {
      list: os.fixedAssets.list.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.fixed_assets.list', input ?? {}, { actor, orgId })),
      ),
      create: os.fixedAssets.create.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('finance.fixed_asset.create', rest, { actor, orgId, idempotencyKey });
        }),
      ),
      end: os.fixedAssets.end.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('finance.fixed_asset.end', rest, { actor, orgId, idempotencyKey });
        }),
      ),
    },
    bookEntities: {
      list: os.bookEntities.list.handler(({ context }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.legal_entities.list', {}, { actor, orgId })),
      ),
    },
    periodLock: {
      state: os.periodLock.state.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.period.lock_state', input ?? {}, { actor, orgId })),
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
      openLines: os.bank.openLines.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.bank.open_lines', input ?? {}, { actor, orgId })),
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
