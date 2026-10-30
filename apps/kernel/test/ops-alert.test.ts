// SPDX-License-Identifier: AGPL-3.0-only
// Operational ALERT lines (#1993): logged, and posted to the alert webhook once a window per kind; every ALERT line in
// the kernel's source goes through them, but those that already reach the prober or have their own sink.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Delivery, WebhookTarget } from '../src/alert.ts';
import { alertKind, configureOpsAlerts, opsAlert } from '../src/ops-alert.ts';

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
    configureOpsAlerts({ target: over.target === undefined ? target : over.target, repeatSeconds: 3600, post, now: () => clock });
    return { error, post, tick: (seconds: number) => (clock += seconds * 1000) };
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('logs the line with its error, and posts the line alone to the webhook', async () => {
    const { error, post } = setup();
    const cause = new Error('connection refused to s3.internal');
    opsAlert('[org-export] ALERT export of org 0b0d6f1e-3c1a-4d2e-9f00-0123456789ab failed after 4 attempts', cause);
    await settle();
    expect(error).toHaveBeenCalledWith('[org-export] ALERT export of org 0b0d6f1e-3c1a-4d2e-9f00-0123456789ab failed after 4 attempts', cause);
    expect(post).toHaveBeenCalledOnce();
    const [message, options] = post.mock.calls[0] as unknown as [{ text: string; crove: Record<string, unknown> }, { webhookUrl: string }];
    expect(message.text).toBe('[Crove] pilot.example.com: [org-export] ALERT export of org 0b0d6f1e-3c1a-4d2e-9f00-0123456789ab failed after 4 attempts');
    expect(message.text).not.toContain('connection refused');
    expect(message.crove).toMatchObject({ kind: 'ops_alert', instance: 'pilot.example.com' });
    expect(options.webhookUrl).toBe(target.webhookUrl);
  });

  it('posts one kind once a window, whatever org or count it names, and again after the window', async () => {
    const { post, tick } = setup();
    opsAlert('[org-export] ALERT export of org 0b0d6f1e-3c1a-4d2e-9f00-0123456789ab failed after 4 attempts');
    opsAlert('[org-export] ALERT export of org 1c1d6f1e-3c1a-4d2e-9f00-0123456789ab failed after 2 attempts');
    opsAlert('[retention] ALERT mail purge cleared 0 rows while old ones remain: mail_event');
    expect(post).toHaveBeenCalledTimes(2);
    tick(3599);
    opsAlert('[org-export] ALERT export of org 2c1d6f1e-3c1a-4d2e-9f00-0123456789ab failed after 4 attempts');
    expect(post).toHaveBeenCalledTimes(2);
    tick(1);
    opsAlert('[org-export] ALERT export of org 2c1d6f1e-3c1a-4d2e-9f00-0123456789ab failed after 4 attempts');
    expect(post).toHaveBeenCalledTimes(3);
    await settle();
  });

  it('only logs without a webhook, or unconfigured', () => {
    const { error, post } = setup({ target: { ...target, webhookUrl: undefined } });
    opsAlert('[inbox-prune] ALERT more than 1000 orgs to prune');
    expect(post).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith('[inbox-prune] ALERT more than 1000 orgs to prune');
    configureOpsAlerts(null);
    opsAlert('[inbox-prune] ALERT more than 1000 orgs to prune');
    expect(error).toHaveBeenCalledTimes(2);
  });

  it('logs a webhook that fails, and never throws to the caller', async () => {
    const { error } = setup({ ok: false });
    expect(() => opsAlert('[http] ALERT evidence integrity: org/x/y')).not.toThrow();
    await settle();
    expect(error).toHaveBeenCalledWith('[ops-alert] could not post the alert: webhook hooks.example.com failed: HTTP 500');
  });

  it('takes ids and numbers out of the kind', () => {
    expect(alertKind('[year-archive] ALERT archive of org 0b0d6f1e-3c1a-4d2e-9f00-0123456789ab year 2025 failed after 3 attempts')).toBe(
      '[year-archive] ALERT archive of org <id> year # failed after # attempts',
    );
  });
});

// Every ALERT line the kernel's source logs goes through opsAlert, but these: the prober's own and the security
// alerts (they have their sink), and the two nightly checks that throw to pg-boss after logging, whose dead letter the
// prober alerts on.
const OWN_SINK: ReadonlyArray<[file: string, prefix: string]> = [
  ['kernel.ts', '[security] ALERT'],
  ['security-signals.ts', '[security] ALERT'],
  ['worker.ts', '[archive] ALERT'],
  ['worker.ts', '[period-balance] ALERT'],
];

describe('ALERT lines of the kernel (#1993)', () => {
  it('go through opsAlert, but those with their own way to the owner', () => {
    const dir = join(import.meta.dirname, '..', 'src');
    const found: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const lines = readFileSync(join(dir, file), 'utf8').split('\n');
      lines.forEach((line, i) => {
        const m = /(console\.(?:error|warn|log)|\blog(?:\.error)?)\(\s*[`'"](\[[a-z-]+\] ALERT)/.exec(line);
        if (!m) return;
        if (OWN_SINK.some(([f, prefix]) => f === file && prefix === m[2])) return;
        found.push(`${file}:${i + 1} ${m[2]}`);
      });
    }
    expect(found).toEqual([]);
  });
});
