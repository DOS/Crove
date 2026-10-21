// Team alerts in a Telegram or Discord chat (#863): the API's half. It checks a target with the platform, seals it with
// the credential broker for the binding (org, 'social.chat_alert', a new alert id) and hands the envelope to the save
// command, which seals it into crove_social.chat_alert_target. It never reads a target back or opens one (ADR-0025:
// the API seals, only the worker opens): a test line is only asked for here, and the worker sends it
// (apps/kernel/src/chat-alerts.ts).
import { randomUUID } from 'node:crypto';
import { checkTelegramChat, connectDiscord, ConnectorError, discordLogin, telegramChatLogin, type DiscordChatTarget, type Fetch, type TelegramChatTarget } from '@crove/channel';
import type { MemberRole } from '@crove/db';
import { CHAT_ALERT_PROVIDER, type ChatAlertKind } from '@crove/mod-social';
import { DomainError, type CredentialBroker, type Runtime, type UserActor } from '@crove/kernel-runtime';
import { RateLimiter } from './rate-limit.ts';

export type ChatAlertSaveInput = { kind: 'telegram'; botToken: string; chatId: string; events: ChatAlertKind[] } | { kind: 'discord'; webhookUrl: string; events: ChatAlertKind[] };

export interface ChatAlertApiDeps {
  runtime: Runtime;
  // Seals the target; never opens one here.
  broker: Pick<CredentialBroker, 'id' | 'seal'>;
  // The platforms' fetch (tests); every call still goes through the adapters' host allowlist.
  fetch?: Fetch;
}

export interface ChatAlertScope {
  orgId: string;
  actor: UserActor;
  role: MemberRole;
}

// Why a chat could not be saved, in words for the settings card.
function checkFailure(error: unknown): DomainError {
  const code = error instanceof ConnectorError ? error.code : undefined;
  switch (code) {
    case 'TELEGRAM_TOKEN_INVALID':
      return new DomainError('TELEGRAM_TOKEN_INVALID', 422, 'Đây không phải mã bot Telegram; hãy chép mã @BotFather gửi khi tạo bot');
    case 'TELEGRAM_TOKEN_REFUSED':
      return new DomainError('TELEGRAM_TOKEN_REFUSED', 422, 'Telegram không chấp nhận mã bot này; có thể mã đã bị đổi trong @BotFather');
    case 'TELEGRAM_CHAT_INVALID':
      return new DomainError('TELEGRAM_CHAT_INVALID', 422, 'Hãy nhập mã số của nhóm chat, tên dạng @tennhom hoặc đường dẫn t.me');
    case 'TELEGRAM_CHAT_NOT_FOUND':
      return new DomainError('TELEGRAM_CHAT_NOT_FOUND', 422, 'Bot không thấy nhóm chat này; hãy thêm bot vào nhóm rồi thử lại');
    case 'TELEGRAM_BOT_CANNOT_SEND':
      return new DomainError('TELEGRAM_BOT_CANNOT_SEND', 422, 'Bot chưa được gửi tin trong nhóm chat này; với kênh, hãy đặt bot làm quản trị viên có quyền đăng bài');
    case 'DISCORD_WEBHOOK_INVALID':
      return new DomainError('DISCORD_WEBHOOK_INVALID', 422, 'Hãy dán địa chỉ webhook của kênh Discord, dạng https://discord.com/api/webhooks/...');
    case 'DISCORD_WEBHOOK_REFUSED':
      return new DomainError('DISCORD_WEBHOOK_REFUSED', 422, 'Discord không nhận webhook này, có thể nó đã bị xóa; hãy tạo webhook mới');
    default:
      return new DomainError('CHAT_ALERT_UNREACHABLE', 503, 'Không kết nối được tới Telegram hoặc Discord lúc này; hãy thử lại sau');
  }
}

function requireAdmin(scope: ChatAlertScope) {
  if (scope.role !== 'owner' && scope.role !== 'admin') throw new DomainError('FORBIDDEN', 403, 'Chỉ chủ sở hữu hoặc quản trị viên mới đổi được nơi nhận tin báo');
}

// Checks the target with the platform (Telegram: the bot, the chat and its right to write there; Discord: an incoming
// webhook of a server's channel), seals it for a new alert id and saves it in place of the org's chat.
export async function saveChatAlert(deps: ChatAlertApiDeps, scope: ChatAlertScope, input: ChatAlertSaveInput): Promise<{ saved: boolean }> {
  // Checked before any call, so a member cannot make the server call a platform.
  requireAdmin(scope);
  if (deps.broker.id === 'none') throw new DomainError('BROKER_NOT_CONFIGURED', 503, 'Chưa cấu hình khóa mã hóa thông tin kết nối (CREDENTIAL_KEY)');
  let checked: { target: TelegramChatTarget | DiscordChatTarget; label: string };
  try {
    if (input.kind === 'telegram') {
      checked = await checkTelegramChat(telegramChatLogin(input), deps.fetch);
    } else {
      const login = discordLogin(input);
      const account = await connectDiscord(login, deps.fetch);
      checked = { target: { webhookId: login.webhookId, token: login.token }, label: account.displayName };
    }
  } catch (error) {
    throw checkFailure(error);
  }
  const id = randomUUID();
  const sealed = deps.broker.seal(JSON.stringify(checked.target), { orgId: scope.orgId, provider: CHAT_ALERT_PROVIDER, externalAccountId: id });
  return deps.runtime.execute<{ saved: boolean }>(
    'social.chat_alert.save',
    { id, kind: input.kind, keyId: sealed.keyId, envelope: sealed.envelope.toString('base64'), label: checked.label, events: input.events },
    { actor: scope.actor, orgId: scope.orgId },
  );
}

// A few test lines a minute per org, so the test button cannot flood a chat.
export class ChatAlertTestBudget {
  private readonly limiter: RateLimiter;
  constructor(perMinute = 5, now?: () => number) {
    this.limiter = new RateLimiter({ perMinute, ...(now ? { now } : {}) });
  }
  take(orgId: string) {
    const decision = this.limiter.take(orgId);
    if (!decision.allowed) throw new DomainError('CHAT_ALERT_TEST_LIMIT', 429, 'Bạn vừa gửi nhiều tin thử; hãy đợi một phút rồi thử lại', { retryAfterSeconds: decision.retryAfterSeconds });
  }
}

// Asks the worker for a test line now; the outcome shows on the alert (lastTestAt, lastTestCode) once it is sent.
export async function requestChatAlertTest(runtime: Runtime, budget: ChatAlertTestBudget, scope: ChatAlertScope): Promise<{ queued: boolean }> {
  requireAdmin(scope);
  budget.take(scope.orgId);
  return runtime.execute<{ queued: boolean }>('social.chat_alert.test', {}, { actor: scope.actor, orgId: scope.orgId });
}
