// What an outbox event may carry (#1949, ADR-0017 section 1): ids and codes only. An event row is append-only, and the
// outbox archive keeps every payload as plain JSON for 400 days under Object Lock, so no erasure can reach a value once
// it is emitted. Names, addresses, free text, emails, phone numbers and tax codes stay in the rows the event points to.
// ctx.emit refuses a payload that breaks this, so every test that emits checks it.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A code: a command or event name, an enum value, a period, a date or time, a decimal. No space, no @, ASCII only.
const CODE = /^[A-Za-z0-9+-][A-Za-z0-9_.:/+=,-]*$/;
// A phone number, a tax code or a national ID number is a run of 9 digits or more (a time or a date is not).
const LONG_DIGITS = /\d{9,}/;
const MAX_CODE = 200;
const MAX_DEPTH = 8;

// The first value of the payload that is not an id, a code, a number, a boolean or null, as "<path>: <why>"; null when
// every value is allowed. The value itself is never named.
export function eventPayloadProblem(value: unknown, path = 'payload', depth = 0): string | null {
  if (value === null || typeof value === 'boolean') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? null : `${path}: not a finite number`;
  if (typeof value === 'string') {
    if (value === '' || UUID.test(value)) return null;
    if (value.length > MAX_CODE) return `${path}: a string longer than ${MAX_CODE} characters`;
    if (!CODE.test(value)) return `${path}: a string that is neither an id nor a code`;
    if (LONG_DIGITS.test(value)) return `${path}: a run of 9 digits or more`;
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
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined) continue;
      const problem = eventPayloadProblem(item, `${path}.${key}`, depth + 1);
      if (problem) return problem;
    }
    return null;
  }
  return `${path}: a ${typeof value}`;
}
