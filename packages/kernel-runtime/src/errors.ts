export type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 429 | 500 | 503;

export interface DomainErrorOptions {
  // Facts about the refusal for the denied/failed audit row only (plan §4.10), for example the roles a LAST_OWNER
  // refusal was about. Never sent to the caller: details go to the caller, audit stays on the server.
  audit?: Record<string, unknown>;
}

export class DomainError extends Error {
  readonly code: string;
  readonly status: ErrorStatus;
  readonly details: Record<string, unknown> | undefined;
  // Non-enumerable (set in the constructor), so JSON.stringify, spreads and loggers that walk own enumerable keys
  // never carry it out of the server.
  declare readonly audit: Record<string, unknown> | undefined;

  constructor(code: string, status: ErrorStatus, message: string, details?: Record<string, unknown>, options: DomainErrorOptions = {}) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.status = status;
    this.details = details;
    Object.defineProperty(this, 'audit', { value: options.audit, enumerable: false, writable: false, configurable: false });
  }
}

interface PgLikeError {
  code?: string;
  message?: string;
  detail?: string;
  constraint?: string;
}

// The JSON DETAIL of ORG_CREATE_RATE_LIMITED (crove_kernel.create_or_replay_org): which limit refused, and for the
// rolling 24-hour limit, when the oldest org in the window leaves it. org_create_busy: the user's other creations held
// the per-user lock past the definer's lock_timeout.
function rateLimited(detail: string | undefined): DomainError {
  let parsed: { rule?: unknown; limit?: unknown; retryAfterSeconds?: unknown } = {};
  try {
    parsed = JSON.parse(detail ?? '{}') as typeof parsed;
  } catch {
    parsed = {};
  }
  const limit = typeof parsed.limit === 'number' ? parsed.limit : null;
  if (parsed.rule === 'org_create_busy') {
    return new DomainError('RATE_LIMITED', 429, 'Bạn đang tạo nhiều tổ chức cùng lúc, hãy thử lại sau', {
      rule: 'org_create_busy',
      retryAfterSeconds: 1,
    });
  }
  const details: Record<string, unknown> = { rule: parsed.rule === 'org_create_total' ? 'org_create_total' : 'org_create_per_day', limit };
  if (details.rule === 'org_create_total') {
    return new DomainError('RATE_LIMITED', 429, `Bạn đã tạo đủ số tổ chức tối đa cho một tài khoản${limit ? ` (${limit})` : ''}`, details);
  }
  if (typeof parsed.retryAfterSeconds === 'number') details.retryAfterSeconds = parsed.retryAfterSeconds;
  return new DomainError(
    'RATE_LIMITED',
    429,
    `Bạn đã tạo quá nhiều tổ chức trong 24 giờ qua${limit ? ` (tối đa ${limit})` : ''}, hãy thử lại sau`,
    details,
  );
}

// The JSON DETAIL of INBOUND_ROTATE_RATE_LIMITED (crove_kernel.inbound_rotate, #113): which per-org limit refused,
// and for the rolling 24-hour limit, when the oldest rotation in the window leaves it. inbound_rotate_busy: another
// rotation of the same org held the per-org lock past the definer's lock_timeout.
function inboundRotateLimited(detail: string | undefined): DomainError {
  let parsed: { rule?: unknown; limit?: unknown; retryAfterSeconds?: unknown } = {};
  try {
    parsed = JSON.parse(detail ?? '{}') as typeof parsed;
  } catch {
    parsed = {};
  }
  const limit = typeof parsed.limit === 'number' ? parsed.limit : null;
  if (parsed.rule === 'inbound_rotate_busy') {
    return new DomainError('RATE_LIMITED', 429, 'Địa chỉ nhận hóa đơn đang được đổi, hãy thử lại sau', {
      rule: 'inbound_rotate_busy',
      retryAfterSeconds: 1,
    });
  }
  if (parsed.rule === 'inbound_rotate_total') {
    return new DomainError('RATE_LIMITED', 429, `Tổ chức đã đổi địa chỉ nhận hóa đơn đủ số lần tối đa${limit ? ` (${limit})` : ''}`, {
      rule: 'inbound_rotate_total',
      limit,
    });
  }
  const details: Record<string, unknown> = { rule: 'inbound_rotate_per_day', limit };
  if (typeof parsed.retryAfterSeconds === 'number') details.retryAfterSeconds = parsed.retryAfterSeconds;
  return new DomainError(
    'RATE_LIMITED',
    429,
    `Tổ chức đã đổi địa chỉ nhận hóa đơn quá nhiều lần trong 24 giờ qua${limit ? ` (tối đa ${limit})` : ''}, hãy thử lại sau`,
    details,
  );
}

// Maps database errors to domain errors without leaking whether other tenants' rows exist.
export function toDomainError(error: unknown): DomainError {
  if (error instanceof DomainError) return error;
  const pg = error as PgLikeError;
  switch (pg?.code) {
    // Raised by crove_kernel.session_check (ADR-0028): signed out, revoked, expired upstream, banned or deleted.
    case '28000':
      return new DomainError('UNAUTHENTICATED', 401, 'Phiên đăng nhập đã hết hiệu lực, hãy đăng nhập lại');
    case '55000':
      if (pg.message?.includes('AUTH_GRANTS_MISSING')) {
        return new DomainError('AUTH_NOT_READY', 503, 'Hệ thống đăng nhập chưa sẵn sàng (bước auth-grants chưa chạy)');
      }
      return new DomainError('INTERNAL', 500, 'Lỗi hệ thống');
    case '42501':
      // A second enter_context in one transaction (plan §4.5 item 1): a bug in the caller, never a user's 403.
      if (pg.message?.includes('CONTEXT_REENTRY')) return new DomainError('INTERNAL', 500, 'Lỗi hệ thống');
      // A context or seal that does not verify (plan §4.5 item 5, T11): tampering or a bug, never a user's 403.
      if (pg.message?.includes('CONTEXT_SEAL_INVALID')) return new DomainError('INTERNAL', 500, 'Lỗi hệ thống');
      if (pg.message?.includes('NOT_A_MEMBER')) return new DomainError('NOT_A_MEMBER', 403, 'Bạn không thuộc tổ chức này');
      if (pg.message?.includes('USER_DISABLED')) return new DomainError('USER_DISABLED', 403, 'Tài khoản của bạn đã bị khóa');
      return new DomainError('FORBIDDEN', 403, 'Không có quyền thực hiện');
    case '23505':
      return new DomainError('CONFLICT', 409, 'Bản ghi đã tồn tại', pg.constraint ? { constraint: pg.constraint } : undefined);
    case '23514':
    case '23502':
    case '22P02':
      return new DomainError('INVALID', 422, 'Dữ liệu không hợp lệ');
    case 'P0001':
      if (pg.message === 'ORG_CREATE_RATE_LIMITED') return rateLimited(pg.detail);
      if (pg.message === 'INBOUND_ROTATE_RATE_LIMITED') return inboundRotateLimited(pg.detail);
      // The owner backstop (crove_kernel.tenant_member_keeps_owner, at commit): the same refusal as the commands'.
      if (pg.message === 'LAST_OWNER') return new DomainError('LAST_OWNER', 409, 'Tổ chức phải còn ít nhất một chủ sở hữu');
      return new DomainError('INTERNAL', 500, 'Lỗi hệ thống');
    case '53400':
      return new DomainError('OVERLOADED', 503, 'Hệ thống đang quá tải, hãy thử lại sau');
    case '40001':
    case '40P01':
      return new DomainError('RETRY', 409, 'Xung đột đồng thời, hãy thử lại');
    default:
      return new DomainError('INTERNAL', 500, 'Lỗi hệ thống');
  }
}
