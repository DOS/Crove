// What an outbox event may carry (#1949, ADR-0017 section 1): ids and codes only. An event row is append-only, and the
// outbox archive keeps every payload as plain JSON for 400 days under Object Lock, so no erasure can reach a value once
// it is emitted. Names, addresses, free text, emails, phone numbers and tax codes stay in the rows the event points to.
// ctx.emit refuses a payload that breaks this, so every test that emits checks it.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A code: a command or event name, an enum value, an account code, a period, a date or time, a decimal. No space, no @,
// ASCII only.
const CODE = /^[A-Za-z0-9+-][A-Za-z0-9_.:/+=,-]*$/;
// A key that names personal data: its value is refused whatever its shape (a phone number or a tax code looks like any
// other run of digits, such as an account code, so the key decides).
const PERSONAL_KEY = /(email|phone|address|taxcode|nationalid|idnumber|recipient|personname|fullname|displayname|birthdate)s?$/;
const MAX_CODE = 200;
const MAX_DEPTH = 8;

// Text a module builds from a template, which an event hands to the agents' task maker as the task's title
// (agent_task.title, packages/kernel/src/agents.ts): "Rà soát bài gửi duyệt: <n> kênh" (Social), "Khách hủy lịch hẹn:
// <event type>" (CRM bookings). The task row holds the same text. A new template that names a person must not use it.
const TEMPLATE_TEXT_PATHS = new Set(['payload.agent_task.title']);

// The first value of the payload that is not an id, a code, a number, a boolean or null, as "<path>: <why>"; null when
// every value is allowed. The value itself is never named.
export function eventPayloadProblem(value: unknown, path = 'payload', depth = 0): string | null {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  const key = path.slice(path.lastIndexOf('.') + 1).replace(/\[\d+\]$/, '');
  if (PERSONAL_KEY.test(key.toLowerCase().replace(/[^a-z]/g, ''))) return `${path}: a key that names personal data`;
  if (typeof value === 'number') return Number.isFinite(value) ? null : `${path}: not a finite number`;
  if (typeof value === 'string') {
    if (value === '' || UUID.test(value)) return null;
    if (TEMPLATE_TEXT_PATHS.has(path)) return value.length <= 300 ? null : `${path}: longer than 300 characters`;
    if (value.length > MAX_CODE) return `${path}: a string longer than ${MAX_CODE} characters`;
    if (!CODE.test(value)) return `${path}: a string that is neither an id nor a code`;
    return null;
  }
  if (depth >= MAX_DEPTH) return `${path}: nested deeper than ${MAX_DEPTH}`;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const problem = eventPayloadProblem(value[i], `${path}[${i}]`, depth + 1);
      if (problem) return problem;
    }
    return null;
  }
  if (typeof value === 'object') {
    for (const [k, item] of Object.entries(value as Record<string, unknown>)) {
      const problem = eventPayloadProblem(item, `${path}.${k}`, depth + 1);
      if (problem) return problem;
    }
    return null;
  }
  return `${path}: a ${typeof value}`;
}
