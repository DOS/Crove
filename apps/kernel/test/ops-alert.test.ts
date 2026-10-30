// SPDX-License-Identifier: AGPL-3.0-only
// Operational ALERT lines (#1993): logged, and posted to the alert webhook once a window per kind, by the process's
// flush rather than the caller; every ALERT line in the kernel's source goes through them, but those that already reach
// the prober or have their own sink.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Delivery, WebhookTarget } from '../src/alert.ts';
import { alertKind, configureOpsAlerts, flushOpsAlerts, opsAlert } from '../src/ops-alert.ts';

const target: WebhookTarget = { webhookUrl: 'https://hooks.example.com/abc', webhookFormat: 'generic', telegramChatId: undefined, instance: 'pilot.example.com' };

describe('opsAlert (#1993)', () => {
  afterEach(() => {
    configureOpsAlerts(null);
    vi.restoreAllMocks();
  });

  const setup = (over: { target?: WebhookTarget | null; ok?: boolean } = {}) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    let clock = 1_000_000;
    const post = vi.fn(async (): Promise<Delivery> => (over.ok === false ? { channel: 'webhook', ok: false, error: 'webhook hooks.example.com failed: HTTP 500' } : { channel: 'webhook', ok: true }));
    configureOpsAlerts({ target: over.target === undefined ? target : over.target, repeatSeconds: 3600, post, now: () => clock, flushMs: 0 });
    return { error, post, tick: (seconds: number) => (clock += seconds * 1000) };
  };
  const texts = (post: ReturnType<typeof setup>['post']) => post.mock.calls.map((c) => (c as unknown as [{ text: string }])[0].text);

  it('logs the line with its error, and posts the line alone when the process flushes, never from the caller', async () => {
    const { error, post } = setup();
    const cause = new Error('connection refused to s3.internal');
    opsAlert('[org-export] ALERT export of org 0b0d6f1e-3c1a-4d2e-9f00-0123456789ab failed after 4 attempts', cause);
    expect(error).toHaveBeenCalledWith('[org-export] ALERT export of org 0b0d6f1e-3c1a-4d2e-9f00-0123456789ab failed after 4 attempts', cause);
    expect(post).not.toHaveBeenCalled();
    await flushOpsAlerts();
    expect(post).toHaveBeenCalledOnce();
    const [message, options] = post.mock.calls[0] as unknown as [{ text: string; crove: Record<string, unknown> }, { webhookUrl: string }];
    expect(message.text).toBe('[Crove] pilot.example.com: [org-export] ALERT export of org 0b0d6f1e-3c1a-4d2e-9f00-0123456789ab failed after 4 attempts');
    expect(message.text).not.toContain('connection refused');
    expect(message.crove).toMatchObject({ kind: 'ops_alert', instance: 'pilot.example.com' });
    expect(options.webhookUrl).toBe(target.webhookUrl);
  });

  it('posts one kind once a window, whatever org, session or count it names, and again after the window', async () => {
    const { post, tick } = setup();
    opsAlert('[org-export] ALERT export of org 0b0d6f1e-3c1a-4d2e-9f00-0123456789ab failed after 4 attempts');
    opsAlert('[org-export] ALERT export of org 1c1d6f1e-3c1a-4d2e-9f00-0123456789ab failed after 2 attempts');
    // A Supabase Auth outage fails every sign-out: their sessions' prefixes make no new kind.
    opsAlert('[signout] ALERT user sign-out of session 3fa9b2c1: Supabase Auth sign-out failed after 5 attempts; revoked in Crove only');
    opsAlert('[signout] ALERT user sign-out of session c2ad398c: Supabase Auth sign-out failed after 5 attempts; revoked in Crove only');
    opsAlert('[retention] ALERT mail purge cleared 0 rows while old ones remain: mail_event');
    await flushOpsAlerts();
    expect(post).toHaveBeenCalledTimes(3);
    tick(3599);
    opsAlert('[org-export] ALERT export of org 2c1d6f1e-3c1a-4d2e-9f00-0123456789ab failed after 4 attempts');
    await flushOpsAlerts();
    expect(post).toHaveBeenCalledTimes(3);
    tick(1);
    opsAlert('[org-export] ALERT export of org 2c1d6f1e-3c1a-4d2e-9f00-0123456789ab failed after 4 attempts');
    await flushOpsAlerts();
    expect(post).toHaveBeenCalledTimes(4);
  });

  it('keeps at most 50 alerts waiting, and says how many more went to the log only', async () => {
    const { post } = setup();
    for (let i = 0; i < 60; i++) opsAlert(`[retention] ALERT sweep ${'abcdefghij'[i % 10]}${String.fromCharCode(97 + Math.floor(i / 10))} failed`);
    await flushOpsAlerts();
    expect(post).toHaveBeenCalledTimes(51);
    expect(texts(post).at(-1)).toBe('[Crove] pilot.example.com: 10 more operational alert(s) are in the log only');
  });

  it('only logs without a webhook, or unconfigured', async () => {
    const { error, post } = setup({ target: { ...target, webhookUrl: undefined } });
    opsAlert('[inbox-prune] ALERT more than 1000 orgs to prune');
    await flushOpsAlerts();
    expect(post).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith('[inbox-prune] ALERT more than 1000 orgs to prune');
    configureOpsAlerts(null);
    opsAlert('[inbox-prune] ALERT more than 1000 orgs to prune');
    expect(error).toHaveBeenCalledTimes(2);
  });

  it('logs a webhook that fails or throws, and never throws itself', async () => {
    const { error, post } = setup({ ok: false });
    expect(() => opsAlert('[http] ALERT evidence integrity: a stored file does not match its recorded sha256')).not.toThrow();
    await flushOpsAlerts();
    expect(error).toHaveBeenCalledWith('[ops-alert] could not post the alert: webhook hooks.example.com failed: HTTP 500');
    post.mockRejectedValueOnce(new Error('boom'));
    opsAlert('[inbox-prune] ALERT more than 1000 orgs to prune');
    await expect(flushOpsAlerts()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith('[ops-alert] could not post the alert: boom');
  });

  it('posts at most 300 characters of a line, the whole line in the log', async () => {
    const { error, post } = setup();
    const long = `[retention] ALERT ${'x'.repeat(400)}`;
    opsAlert(long);
    await flushOpsAlerts();
    expect(error).toHaveBeenCalledWith(long);
    expect(texts(post)[0]).toBe(`[Crove] pilot.example.com: ${long.slice(0, 299)}…`);
  });

  it('stops posting at the deadline of a stop, and says what is left in the log', async () => {
    const { error, post } = setup();
    post.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { channel: 'webhook', ok: true };
    });
    opsAlert('[retention] ALERT staging sweep failed after deleting 0');
    opsAlert('[inbox-prune] ALERT more than 1000 orgs to prune');
    opsAlert('[org-export] ALERT export of org 0b0d6f1e-3c1a-4d2e-9f00-0123456789ab failed after 4 attempts');
    await flushOpsAlerts(20);
    expect(post).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith('[ops-alert] 2 alert(s) not posted before the deadline; they are in the log');
    // Each post gets no longer than what is left.
    expect((post.mock.calls[0] as unknown as [unknown, { timeoutMs: number }])[1].timeoutMs).toBeLessThanOrEqual(20);
  });

  it('takes ids, hashes and numbers out of the kind', () => {
    expect(alertKind('[year-archive] ALERT archive of org 0b0d6f1e-3c1a-4d2e-9f00-0123456789ab year 2025 failed after 3 attempts')).toBe(
      '[year-archive] ALERT archive of org <id> year # failed after # attempts',
    );
    expect(alertKind('[signout] ALERT user sign-out of session 3fa9b2c1: failed')).toBe(alertKind('[signout] ALERT user sign-out of session e9ab540d: failed'));
    expect(alertKind(`key org/0b0d6f1e-3c1a-4d2e-9f00-0123456789ab/${'ab12'.repeat(16)} (generation 7)`)).toBe('key org/<id>/<id> (generation #)');
  });
});

// Every ALERT literal in the kernel's source goes through opsAlert (directly, or retention's alertTo), but these, by
// file, prefix and how many: the security alerts (their own sink), and the two nightly checks that throw to pg-boss
// after logging, whose dead letter the prober alerts on. A new one of these anywhere else fails here.
const OWN_SINK: Readonly<Record<string, number>> = {
  'kernel.ts [security] ALERT': 1,
  'security-signals.ts [security] ALERT': 1,
  'worker.ts [archive] ALERT': 1,
  'worker.ts [period-balance] ALERT': 1,
  // Not a log line: the preflight's text tells the operator to look for this one in the worker log.
  'pilot-check.ts [evidence-hold] ALERT': 1,
};

describe('ALERT lines of the kernel (#1993)', () => {
  it('go through opsAlert, but those with their own way to the owner', () => {
    const dir = join(import.meta.dirname, '..', 'src');
    const other: Record<string, number> = {};
    const unrouted: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts') && f !== 'ops-alert.ts')) {
      const text = readFileSync(join(dir, file), 'utf8');
      for (const m of text.matchAll(/[`'"](\[[A-Za-z0-9_-]+\] ALERT)\b/g)) {
        // The call the literal is the first argument of, across line breaks.
        const before = text.slice(0, m.index).replace(/\s+$/, '');
        if (/\bopsAlert\($/.test(before) || /\balertTo\((?:options\.)?log\)\($/.test(before)) continue;
        // The prober's own headline ('[Crove] ALERT on <instance>: ...') is a posted alert, not a log line.
        if (m[1] === '[Crove] ALERT') continue;
        const key = `${file} ${m[1]}`;
        if (key in OWN_SINK) other[key] = (other[key] ?? 0) + 1;
        else unrouted.push(`${file}:${text.slice(0, m.index).split('\n').length} ${m[1]}`);
      }
    }
    expect(unrouted).toEqual([]);
    expect(other).toEqual(OWN_SINK);
  });
});
