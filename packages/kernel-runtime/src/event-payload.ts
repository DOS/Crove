// What an outbox event may carry (#1949, ADR-0017 section 1): ids and codes only. An event row is append-only, and the
// outbox archive keeps every payload as plain JSON for 400 days under Object Lock, so no erasure can reach a value once
// it is emitted. ctx.emit reduces the codes a provider gave (normalizeEventPayload) and refuses a payload that still
// breaks the rule (eventPayloadProblem), so every test that emits checks it; the database holds every insert into
// crove_kernel.outbox_event to the same rule (crove_kernel.event_payload_problem, #1970), so a definer that writes an
// event directly is held too. A test keeps the two in step. What it can tell is the shape: free text,
// a name, an email (anything with a space, an @ or a letter outside ASCII) and any value under a key that names
// personal data. A phone number or a tax code under another key looks like any other run of digits (an account code),
// so keep them out by review.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A code: a command or event name, an enum value, an account code, a period, a date or time, a decimal. No space, no @,
// ASCII only.
const CODE = /^[A-Za-z0-9+-][A-Za-z0-9_.:/+=,-]*$/;
// A key that names personal data: its value is refused whatever its shape.
const PERSONAL_KEY = /(email|phone|address|taxcode|nationalid|idnumber|recipient|personname|fullname|displayname|birthdate)s?$/;
// Keys whose value is a code a provider or a caller gave, which may come with a space or a bracket: reduced to a code
// before the check, never refused.
const CODE_KEYS = new Set(['code', 'reason', 'error', 'errorCode', 'error_code']);
const MAX_CODE = 200;
const MAX_DEPTH = 8;

// The task titles an event may hand to the agents' task maker (agent_task.title, packages/kernel/src/agents.ts), one
// template per event type and nothing else (#1970): the module's fixed words and a count, never a value an org or a
// person wrote. The database holds the same list (crove_kernel.event_payload_problem).
const TASK_TITLES: Record<string, RegExp> = {
  'social.post.submitted': /^Rà soát bài gửi duyệt: [0-9]{1,4} kênh$/,
  'crm.booking.cancelled': /^Khách hủy lịch hẹn$/,
};

// A code made of `value`: only its leading word of letters and underscores, at most 60 characters, `other` when there
// is none. Nothing after it is kept: a provider's message may go on to name an account ("refused for <email>"), and
// turning the rest into a code would keep it.
export function eventCode(value: string): string {
  const code = /^\s*([A-Za-z_]+)/.exec(value)?.[1]?.slice(0, 60) ?? '';
  return code === '' ? 'other' : code;
}

// A copy of the payload with every string under a CODE_KEYS key that is not code-shaped reduced to one (eventCode).
export function normalizeEventPayload(value: unknown, key = '', depth = 0): unknown {
  if (typeof value === 'string') return CODE_KEYS.has(key) && value !== '' && !UUID.test(value) && !CODE.test(value) ? eventCode(value) : value;
  if (depth >= MAX_DEPTH || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => normalizeEventPayload(item, key, depth + 1));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, item]) => [k, normalizeEventPayload(item, k, depth + 1)]));
}

// The first value of the payload of an event of `type` that is not an id, a code, a number, a boolean or null (or the
// type's task title), as "<path>: <why>"; null when every value is allowed. The value itself is never named.
export function eventPayloadProblem(value: unknown, type = ''): string | null {
  return walk(value, 'payload', 0, TASK_TITLES[type] ?? null);
}

function walk(value: unknown, path: string, depth: number, title: RegExp | null): string | null {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  const key = path.slice(path.lastIndexOf('.') + 1).replace(/\[\d+\]$/, '');
  if (PERSONAL_KEY.test(key.toLowerCase().replace(/[^a-z]/g, ''))) return `${path}: a key that names personal data`;
  if (typeof value === 'number') return Number.isFinite(value) ? null : `${path}: not a finite number`;
  if (typeof value === 'string') {
    if (value === '' || UUID.test(value)) return null;
    if (path === 'payload.agent_task.title' && title?.test(value)) return null;
    if (value.length > MAX_CODE) return `${path}: a string longer than ${MAX_CODE} characters`;
    if (!CODE.test(value)) return `${path}: a string that is neither an id nor a code`;
    return null;
  }
  if (depth >= MAX_DEPTH) return `${path}: nested deeper than ${MAX_DEPTH}`;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const problem = walk(value[i], `${path}[${i}]`, depth + 1, title);
      if (problem) return problem;
    }
    return null;
  }
  if (typeof value === 'object') {
    for (const [k, item] of Object.entries(value as Record<string, unknown>)) {
      const problem = walk(item, `${path}.${k}`, depth + 1, title);
      if (problem) return problem;
    }
    return null;
  }
  return `${path}: a ${typeof value}`;
}
