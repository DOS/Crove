// Kernel error codes the SPA words in every locale (issue #215). The kernel's sources are read as text: a new code,
// or a new rate limit rule, fails here until it gets SPA messages or is named below as one the SPA never shows.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/messages/en.ts';
import { vi } from '../src/i18n/messages/vi.ts';
import { KERNEL_ERROR_CODES, KERNEL_ERROR_RULES } from '../src/lib/kernel-errors.ts';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

// Codes the SPA never receives, so it keeps the kernel's message for them.
const NOT_SHOWN: Record<string, string> = {
  // AI agents: codes only the worker and agent runs get; the agents screens (issue #258) word the others.
  AGENT_PROGRAM_MISSING: 'agents',
  AGENT_RUN_NOT_LIVE: 'agents',
  AGENT_FORBIDDEN: 'agents',
  AGENT_CONTEXT_WORKER_ONLY: 'agents',
  AGENT_NO_POSITION: 'agents',
  AGENT_TASK_FIELD: 'agents',
  AGENT_TASK_CLOSED: 'agents',
  AGENT_TASK_KIND: 'agents',
  AGENT_DELEGATION_SUBTREE: 'agents',
  AGENT_ESCALATION_TARGET: 'agents',
  NOT_PROPOSABLE: 'agents',
  PROPOSAL_NOT_TASK: 'agents',
  AGENT_NOT_ELIGIBLE: 'agents',
  KILL_SWITCH_ON: 'agents',
  BUDGET_EXHAUSTED: 'agents',
  LEASE_LOST: 'agents',
  TASK_CHECKED_OUT: 'agents',
  TASK_CLOSED: 'agents',
  OUTSIDE_SUBTREE: 'agents',
  DEPTH_LIMIT: 'agents',
  // The inbound mail endpoint answers the mail relay, not a browser.
  EMPTY_MESSAGE: 'inbound mail',
  UNKNOWN_RECIPIENT: 'inbound mail',
  UNREADABLE_MESSAGE: 'inbound mail',
  INBOUND_BLOB_MISMATCH: 'inbound mail',
  // The invalidation stream (issue #69): the stream client (lib/stream.ts) handles these silently, backs off and
  // keeps polling; nothing is shown to the user. METHOD_NOT_ALLOWED answers a HEAD on /api/stream, never sent by the SPA.
  STREAM_BUSY: 'stream',
  STREAM_TICKET_INVALID: 'stream',
  STREAM_UNAVAILABLE: 'stream',
  METHOD_NOT_ALLOWED: 'stream',
  // A bug in the caller or the worker, never a user's mistake: the kernel's message is enough for a bug report.
  COMMAND_NOT_FOUND: 'bug',
  QUERY_NOT_FOUND: 'bug',
  STREAM_ONLY: 'bug',
  NOT_STREAMED: 'bug',
  INVALID_STORAGE_KEY: 'bug',
  INVALID_GENERATION: 'bug',
  // Bulk intake (#314): only the worker records an opened archive.
  NOT_ARCHIVE: 'bug',
};

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (name === 'node_modules' || name === 'test' || name === 'dist') continue;
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

const KERNEL_SOURCES = [
  ...['packages', 'modules'].flatMap((group) =>
    readdirSync(join(ROOT, group))
      .map((name) => join(ROOT, group, name, 'src'))
      .filter((dir) => statSync(dir, { throwIfNoEntry: false })?.isDirectory()),
  ),
  join(ROOT, 'apps', 'kernel', 'src'),
]
  .flatMap(sources)
  .map((path) => ({ path, text: readFileSync(path, 'utf8') }));

// Every code the kernel can answer with: DomainError and ORPCError codes, the JSON refusals of the HTTP edge, and the
// agent refusals the database raises by name.
function kernelCodes(): Set<string> {
  const codes = new Set<string>();
  for (const { text } of KERNEL_SOURCES) {
    for (const m of text.matchAll(/\b(?:DomainError|ORPCError)\(\s*'([A-Z][A-Z0-9_]+)'/g)) codes.add(m[1] as string);
    for (const m of text.matchAll(/c\.json\(\s*\{\s*code:\s*'([A-Z][A-Z0-9_]+)'/g)) codes.add(m[1] as string);
    const agentRefusals = /AGENT_REFUSALS = new Set\(\[([^\]]*)\]/.exec(text)?.[1];
    for (const m of agentRefusals?.matchAll(/'([A-Z][A-Z0-9_]+)'/g) ?? []) codes.add(m[1] as string);
  }
  return codes;
}

// The `details.rule` values of the kernel's rate limit refusals, in the sources that raise them.
function kernelRules(): Set<string> {
  const rules = new Set<string>();
  for (const { text } of KERNEL_SOURCES.filter((source) => /'(?:INVITE_)?RATE_LIMITED'/.test(source.text))) {
    for (const m of text.matchAll(/\brule(?:\s*===\s*|:\s*)'([a-z][a-z0-9]*_[a-z0-9_]+)'/g)) rules.add(m[1] as string);
    const inviteRules = /RATE_LIMIT_MESSAGES: Record<string, string> = \{([^}]*)\}/.exec(text)?.[1];
    for (const m of inviteRules?.matchAll(/^\s*([a-z][a-z0-9_]+):/gm) ?? []) rules.add(m[1] as string);
  }
  return rules;
}

describe('kernel error codes', () => {
  it('reads codes from the kernel sources', () => {
    const codes = kernelCodes();
    // A sanity check of the scan itself: well-known codes from each kind of source.
    for (const code of ['FORBIDDEN', 'STEP_UP_REQUIRED', 'INVITE_EMAIL_MISMATCH', 'ALREADY_REVERSED', 'UPLOAD_BUSY', 'AUTH_UNAVAILABLE', 'KILL_SWITCH_ON']) {
      expect(codes, code).toContain(code);
    }
  });

  it('words every code the kernel raises, or names it as one the SPA never shows', () => {
    const listed = new Set<string>([...KERNEL_ERROR_CODES, ...Object.keys(NOT_SHOWN)]);
    expect([...kernelCodes()].filter((code) => !listed.has(code)).sort()).toEqual([]);
  });

  it('keeps no stale entries', () => {
    const codes = kernelCodes();
    // oRPC answers these itself (input validation, an unexpected failure); they appear in no kernel source.
    const library = new Set(['BAD_REQUEST', 'INTERNAL_SERVER_ERROR']);
    expect(KERNEL_ERROR_CODES.filter((code) => !codes.has(code) && !library.has(code))).toEqual([]);
    expect(Object.keys(NOT_SHOWN).filter((code) => !codes.has(code))).toEqual([]);
    expect(KERNEL_ERROR_CODES.filter((code) => code in NOT_SHOWN)).toEqual([]);
  });

  it('has a Vietnamese and an English message for every code and rule', () => {
    for (const code of KERNEL_ERROR_CODES) {
      expect(vi.kernelErrors.codes[code], `vi ${code}`).toBeTruthy();
      expect(en.kernelErrors.codes[code], `en ${code}`).toBeTruthy();
    }
    for (const rule of Object.keys(KERNEL_ERROR_RULES) as Array<keyof typeof KERNEL_ERROR_RULES>) {
      expect(vi.kernelErrors.rules[rule], `vi ${rule}`).toBeTruthy();
      expect(en.kernelErrors.rules[rule], `en ${rule}`).toBeTruthy();
    }
    expect(Object.keys(vi.kernelErrors.codes).sort()).toEqual([...KERNEL_ERROR_CODES].sort());
    expect(Object.keys(vi.kernelErrors.rules).sort()).toEqual(Object.keys(KERNEL_ERROR_RULES).sort());
  });

  it('words every rate limit rule the kernel sends', () => {
    expect(kernelRules()).toContain('org_create_busy');
    expect(kernelRules()).toContain('invite_recipient_per_day');
    expect([...kernelRules()].filter((rule) => !Object.hasOwn(KERNEL_ERROR_RULES, rule)).sort()).toEqual([]);
  });
});
