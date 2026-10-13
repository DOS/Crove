export type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 429 | 500 | 503;

export class DomainError extends Error {
  readonly code: string;
  readonly status: ErrorStatus;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: string, status: ErrorStatus, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

interface PgLikeError {
  code?: string;
  message?: string;
  constraint?: string;
}

// Maps database errors to domain errors without leaking whether other tenants' rows exist.
export function toDomainError(error: unknown): DomainError {
  if (error instanceof DomainError) return error;
  const pg = error as PgLikeError;
  switch (pg?.code) {
    case '42501':
      if (pg.message?.includes('NOT_A_MEMBER')) return new DomainError('NOT_A_MEMBER', 403, 'Bạn không thuộc tổ chức này');
      return new DomainError('FORBIDDEN', 403, 'Không có quyền thực hiện');
    case '23505':
      return new DomainError('CONFLICT', 409, 'Bản ghi đã tồn tại', pg.constraint ? { constraint: pg.constraint } : undefined);
    case '23514':
    case '23502':
    case '22P02':
      return new DomainError('INVALID', 422, 'Dữ liệu không hợp lệ');
    case '40001':
    case '40P01':
      return new DomainError('RETRY', 409, 'Xung đột đồng thời, hãy thử lại');
    default:
      return new DomainError('INTERNAL', 500, 'Lỗi hệ thống');
  }
}
