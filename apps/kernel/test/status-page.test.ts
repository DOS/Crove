// The public status page (#678): the prober's file, the view drawn from it, the page, and the /status route.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BlobStore, Runtime } from '@crove/kernel-runtime';
import { memoryAlertGate } from '../src/alert-gate.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { EXIT, probeOnce, type HealthSnapshot, type ProberConfig } from '../src/prober.ts';
import { STATUS_STALE_SECONDS, probeStatus, readStatusFile, renderStatusPage, statusView, writeStatusFile } from '../src/status-page.ts';

const NOW = new Date('2026-10-20T12:00:00Z');
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000);
const states = (view: ReturnType<typeof statusView>) => Object.fromEntries(view.components.map((c) => [c.id, c.state]));

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'crove-status-'));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

describe('status view', () => {
  it('maps the failing checks to the functions a user sees', () => {
    expect(statusView(probeStatus(minutesAgo(1), []), NOW)).toMatchObject({ overall: 'ok', checkedAt: minutesAgo(1).toISOString() });
    expect(states(statusView(probeStatus(minutesAgo(1), ['inbound']), NOW))).toEqual({ database: 'ok', documents: 'ok', email: 'problem', updates: 'ok', signin: 'unknown' });
    // A worker that stopped holds up both the uploaded documents and the mail.
    const workerDown = statusView(probeStatus(minutesAgo(1), ['heartbeat']), NOW);
    expect(workerDown.overall).toBe('problem');
    expect(states(workerDown)).toEqual({ database: 'ok', documents: 'problem', email: 'problem', updates: 'ok', signin: 'unknown' });
    expect(states(statusView(probeStatus(minutesAgo(1), ['outbox', 'notify_queue']), NOW))).toMatchObject({ updates: 'problem', documents: 'ok' });
    // Supabase Auth not answering (#1994): signing in is down, nothing else; answering: fine. Without the check (off, or
    // an older prober), the line says nothing is known.
    expect(states(statusView(probeStatus(minutesAgo(1), ['auth'], true), NOW))).toEqual({ database: 'ok', documents: 'ok', email: 'ok', updates: 'ok', signin: 'problem' });
    expect(states(statusView(probeStatus(minutesAgo(1), [], true), NOW))).toMatchObject({ signin: 'ok' });
    expect(states(statusView(probeStatus(minutesAgo(1), []), NOW))).toMatchObject({ signin: 'unknown' });
  });

  it('shows the database down and every other function unknown when the probe could not read it', () => {
    const view = statusView(probeStatus(minutesAgo(1), null), NOW);
    expect(view.overall).toBe('problem');
    expect(states(view)).toEqual({ database: 'problem', documents: 'unknown', email: 'unknown', updates: 'unknown', signin: 'unknown' });
  });

  it('says nothing is known without a file, or with one older than the stale limit', () => {
    expect(statusView(null, NOW)).toMatchObject({ overall: 'unknown', checkedAt: null });
    const stale = statusView(probeStatus(new Date(NOW.getTime() - (STATUS_STALE_SECONDS + 1) * 1000), ['heartbeat']), NOW);
    expect(stale.overall).toBe('unknown');
    expect(new Set(Object.values(states(stale)))).toEqual(new Set(['unknown']));
    expect(statusView(probeStatus(new Date(NOW.getTime() - STATUS_STALE_SECONDS * 1000), []), NOW).overall).toBe('ok');
  });
});

describe('status file', () => {
  it('round-trips what the prober writes, and refuses anything else', async () => {
    const path = join(dir, 'nested', 'status.json');
    await writeStatusFile(path, probeStatus(NOW, ['job_age']));
    expect(await readStatusFile(path)).toEqual({ version: 1, checkedAt: NOW.toISOString(), databaseOk: true, failing: ['job_age'] });

    expect(await readStatusFile(join(dir, 'missing.json'))).toBeNull();
    const bad = join(dir, 'bad.json');
    for (const text of ['not json', '{}', JSON.stringify({ version: 1, checkedAt: NOW.toISOString(), databaseOk: true, failing: ['<script>'] }), 'x'.repeat(20_000)]) {
      await writeFile(bad, text);
      expect(await readStatusFile(bad), text.slice(0, 40)).toBeNull();
    }
  });

  it('reads a file from a newer prober, dropping the fields it does not know (an API rolled back first)', async () => {
    const path = join(dir, 'newer.json');
    await writeFile(path, JSON.stringify({ ...probeStatus(NOW, ['inbound'], true), someFutureField: { x: 1 } }));
    const read = await readStatusFile(path);
    expect(read).toEqual({ version: 1, checkedAt: NOW.toISOString(), databaseOk: true, failing: ['inbound'], authChecked: true });
    expect(states(statusView(read, NOW))).toEqual({ database: 'ok', documents: 'ok', email: 'problem', updates: 'ok', signin: 'ok' });
  });
});

describe('status page', () => {
  it('draws only its own texts and the time in Vietnam, with no script', () => {
    const html = renderStatusPage(statusView(probeStatus(new Date('2026-10-20T11:58:00Z'), ['inbound']), NOW));
    expect(html).toContain('Một số chức năng đang gặp sự cố');
    expect(html).toContain('20/10/2026 18:58 (giờ Việt Nam)');
    expect(html).toContain('<span>Nhận hóa đơn qua email</span><span class="state problem">Đang gặp sự cố</span>');
    expect(html).not.toMatch(/<script|inbound|\son\w+=/i);
    expect(renderStatusPage(statusView(null, NOW))).toContain('Chưa có kết quả kiểm tra gần đây');
  });
});

describe('prober', () => {
  const healthy: HealthSnapshot = {
    checked_at: '2026-10-20 12:00:00+00',
    outbox_pending: 0,
    outbox_oldest_age_seconds: null,
    inbound_pending: 0,
    inbound_oldest_age_seconds: null,
    jobs_schema_present: true,
    jobs_queued: 0,
    job_oldest_queued_age_seconds: null,
    dead_letter_count: 0,
    worker_heartbeat_age_seconds: 12,
    notify_queue_usage: 0,
    archive_verify_age_seconds: null,
    archive_lag_seconds: null,
  };
  const config = (overrides: Partial<ProberConfig> = {}): ProberConfig => ({
    databaseUrl: 'postgres://crove_prober:pw@db:5432/postgres',
    webhookUrl: undefined,
    webhookFormat: 'generic',
    telegramChatId: undefined,
    repeatSeconds: 3600,
    instance: 'crove.example.test',
    thresholds: { outboxAgeSeconds: 300, jobAgeSeconds: 900, heartbeatAgeSeconds: 120, deadLetters: 0, notifyQueuePercent: 50 },
    deadLetterWindowSeconds: 300,
    statusFile: join(dir, 'probe', 'status.json'),
    ...overrides,
  });
  const quiet = () => ({ log: () => {}, error: () => {}, gate: memoryAlertGate(3600), now: () => NOW });

  it('writes each probe to the status file: healthy, failing checks, or the database unreadable', async () => {
    const path = join(dir, 'probe', 'status.json');
    expect(await probeOnce(config(), { ...quiet(), readHealth: async () => healthy })).toBe(EXIT.ok);
    expect(await readStatusFile(path)).toEqual(probeStatus(NOW, []));

    const sick = { ...healthy, worker_heartbeat_age_seconds: 900 };
    expect(await probeOnce(config(), { ...quiet(), readHealth: async () => sick })).toBe(EXIT.unhealthy);
    expect(await readStatusFile(path)).toEqual(probeStatus(NOW, ['heartbeat']));

    await probeOnce(config(), {
      ...quiet(),
      readHealth: async () => {
        throw new Error('connection refused');
      },
    });
    expect(await readStatusFile(path)).toEqual(probeStatus(NOW, null));
  });

  it('writes nothing without PROBER_STATUS_FILE or a database URL, and a failed write only logs', async () => {
    const writes: string[] = [];
    const writeStatus = async (p: string) => void writes.push(p);
    await probeOnce(config({ statusFile: undefined }), { ...quiet(), readHealth: async () => healthy, writeStatus });
    await probeOnce(config({ databaseUrl: undefined }), { ...quiet(), writeStatus });
    expect(writes).toEqual([]);

    const errors: string[] = [];
    const failing = async () => {
      throw new Error('read-only file system');
    };
    const code = await probeOnce(config(), { ...quiet(), error: (l: string) => errors.push(l), readHealth: async () => healthy, writeStatus: failing });
    expect(code).toBe(EXIT.ok);
    expect(errors.join('\n')).toContain('read-only file system');
  });
});

describe('/status', () => {
  const base = { DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: 'x'.repeat(32), AUTH_ISSUER: 'crove-auth', WEB_DIST: '/nonexistent' };
  const app = (env: Record<string, string>) =>
    createHttpApp({
      config: loadConfig({ ...base, ...env }),
      runtime: { installed: () => true, modules: () => ['kernel'] } as unknown as Runtime,
      store: {} as BlobStore,
      authenticate: async () => {
        throw new Error('not used');
      },
      pool: {} as pg.Pool,
      aiEnabled: false,
    });

  it('serves the page from STATUS_FILE, without an account, behind a strict policy', async () => {
    const path = join(dir, 'served.json');
    await writeStatusFile(path, probeStatus(new Date(), ['dead_letters']));
    const res = await app({ STATUS_FILE: path }).request('/status');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    expect(res.headers.get('cache-control')).toBe('no-store');
    const html = await res.text();
    expect(html).toContain('<span>Xử lý chứng từ tải lên</span><span class="state problem">');
    expect(html).not.toContain('dead_letters');
  });

  it('is off without STATUS_FILE, and /api/config tells the app whether to link to it', async () => {
    const off = app({});
    expect((await off.request('/status')).status).toBe(404);
    expect(((await (await off.request('/api/config')).json()) as { statusPage: unknown }).statusPage).toBe(false);
    const on = app({ STATUS_FILE: join(dir, 'never-written.json') });
    expect(((await (await on.request('/api/config')).json()) as { statusPage: unknown }).statusPage).toBe(true);
    // Configured but the prober has written nothing yet: the page says so instead of failing.
    expect(await (await on.request('/status')).text()).toContain('Hệ thống giám sát chưa gửi kết quả nào.');
  });

  it('refuses a relative STATUS_FILE', () => {
    expect(() => loadConfig({ ...base, STATUS_FILE: 'status.json' })).toThrow(/STATUS_FILE/);
  });
});

