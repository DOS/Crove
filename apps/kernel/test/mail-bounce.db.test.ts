// Bounces of plain SMTP mail, Email E2 step 3 (#539), on a real PostgreSQL 17 with the real parser process: each
// mail's VERP token, a bounce report to bounce+<token>@INBOUND_DOMAIN parsed in crove-extract and recorded as the
// mail's delivery event (a hard bounce suppresses the address), and reports with an altered token, about another
// mail or that are not reports dropped. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its
// own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import pg from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import type { ExtractClient } from '@crove/extract-contract';
import { createMailMessage, createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { DomainError, Runtime, defineCommand, defineQuery, inboundKey, newInboundBlobId, sha256Hex, type BlobStore, type UserActor } from '@crove/kernel-runtime';
import { acceptInboundEmail, processInboundEmail } from '../src/inbound.ts';
import { inProcessExtract } from './extract-service.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const DOMAIN = 'in.test';

const suite = ADMIN ? describe : describe.skip;

class MemoryStore implements BlobStore {
  readonly blobs = new Map<string, Uint8Array>();
  async put(key: string, bytes: Uint8Array) {
    this.blobs.set(key, bytes);
    return `content:${sha256Hex(bytes)}`;
  }
  async get(key: string) {
    const bytes = this.blobs.get(key);
    if (!bytes) throw new Error(`missing ${key}`);
    return bytes;
  }
  async delete(key: string) {
    this.blobs.delete(key);
  }
}

const sendTest = defineCommand({
  sideEffect: 'none',
  name: 'kernel.mail_test.send',
  input: z.object({ to: z.string(), stream: z.enum(['system', 'transactional', 'marketing']), sourceId: z.string().uuid().optional() }),
  risk: 'R1',
  access: ['owner', 'admin', 'member', 'viewer'],
  handler: async (ctx, input) =>
    createMailMessage(ctx, { stream: input.stream, source: 'kernel.mail_test.send', sourceId: input.sourceId ?? randomUUID(), templateKey: 'kernel.mail_test', to: input.to, status: 'sending' }),
});

// The bounce token of any mail id, as the org in context asks for it.
const tokenOf = defineQuery({
  name: 'kernel.mail_test.token',
  input: z.object({ messageId: z.string().uuid() }),
  access: ['owner', 'admin', 'member', 'viewer'],
  handler: async (ctx, input) => (await sql<{ token: string | null }>`SELECT crove_kernel.mail_bounce_token(${input.messageId}::uuid) AS token`.execute(ctx.trx)).rows[0]?.token ?? null,
});

const report = (token: string, status: string, options: { action?: string; messageId?: string } = {}) =>
  new TextEncoder().encode(
    [
      'From: Mail Delivery System <MAILER-DAEMON@mx.example.net>',
      `To: bounce+${token}@${DOMAIN}`,
      'Subject: Undelivered Mail Returned to Sender',
      'MIME-Version: 1.0',
      `Message-ID: <${randomUUID()}@mx.example.net>`,
      'Content-Type: multipart/report; report-type=delivery-status; boundary="B"',
      '',
      '--B',
      'Content-Type: text/plain',
      '',
      'Delivery failed.',
      '--B',
      'Content-Type: message/delivery-status',
      '',
      'Reporting-MTA: dns; mx.example.net',
      '',
      'Final-Recipient: rfc822; khach@example.test',
      `Action: ${options.action ?? 'failed'}`,
      `Status: ${status}`,
      '',
      '--B',
      'Content-Type: text/rfc822-headers',
      '',
      ...(options.messageId ? [`Message-ID: ${options.messageId}`] : []),
      'Subject: Loi moi',
      '',
      '--B--',
      '',
    ].join('\r\n'),
  );

suite('bounces of SMTP mail (#539)', () => {
  const dbName = `crove_test_mail_bounce_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let runtime: Runtime;
  let workerRuntime: Runtime;
  let extract: ExtractClient;
  const store = new MemoryStore();
  let orgId = '';
  let otherOrgId = '';
  let owner: UserActor;
  let other: UserActor;

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
  const actor = (userId: string): UserActor => ({ type: 'user', userId, aal: 'aal1', sessionId: randomUUID(), mfaAt: null });
  const run = (name: string, input: unknown, who: UserActor, org = orgId) => runtime.execute<any>(name, input, { actor: who, orgId: org });

  // A mail the org sent over SMTP, with its bounce token as the request that sent it reads it back.
  async function sentMail(to: string, who = owner, org = orgId) {
    const sourceId = randomUUID();
    const mail = await run('kernel.mail_test.send', { to, stream: 'transactional', sourceId }, who, org);
    const direct = await runtime.query<any>('kernel.mail.direct.get', { source: 'kernel.mail_test.send', sourceId }, { actor: who, orgId: org });
    await run('kernel.mail.record_direct', { messageId: mail.id, outcome: 'sent', provider: 'smtp' }, who, org);
    return { id: String(mail.id), header: String(mail.messageIdHeader), token: String(direct.bounceToken) };
  }
  async function deliverReport(raw: Uint8Array, recipient: string) {
    const blobId = newInboundBlobId();
    await store.put(inboundKey(blobId), raw);
    return processInboundEmail({ runtime: workerRuntime, store, domain: DOMAIN, extract }, { blobId, sha256: sha256Hex(raw), sizeBytes: raw.byteLength, recipient });
  }
  const refusal = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (error) {
      return error instanceof DomainError ? error.code : String(error);
    }
    return 'resolved';
  };
  const mailState = (id: string) =>
    admin(async (c) => ({
      status: (await c.query<{ status: string }>('SELECT status FROM crove_kernel.mail_message WHERE id = $1', [id])).rows[0]?.status,
      events: (await c.query<{ kind: string; provider: string }>('SELECT kind, provider FROM crove_kernel.mail_event WHERE message_id = $1 ORDER BY created_at', [id])).rows,
      suppressions: (await c.query<{ scope: string; reason: string }>('SELECT scope, reason FROM crove_kernel.mail_suppression WHERE source_message_id = $1', [id])).rows,
    }));

  beforeAll(async () => {
    const base = new URL(ADMIN as string);
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const login = (user: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = user;
      url.password = password;
      return url.toString();
    };
    pool = createPool({ connectionString: login('crove_app', 'test-app-pw'), max: 4 });
    workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 2 });
    db = createDb(pool);
    const registry = { commands: [...kernelCommands, sendTest], queries: [...kernelQueries({ inboundDomain: DOMAIN }), tokenOf] };
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register(registry);
    workerRuntime = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register(registry);
    extract = inProcessExtract();
    owner = actor(await upsertIdentity(db, { issuer: 'mail-bounce', subject: `owner-${randomUUID()}`, email: `owner-${dbName}@mail.test`, name: null }));
    other = actor(await upsertIdentity(db, { issuer: 'mail-bounce', subject: `other-${randomUUID()}`, email: `other-${dbName}@mail.test`, name: null }));
    orgId = (await createOrg(runtime, owner, 'Công ty Thư')).orgId;
    otherOrgId = (await createOrg(runtime, other, 'Công ty Khác')).orgId;
  });

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('gives each mail a bounce token only its own org can get', async () => {
    const mail = await sentMail('token@mail.test');
    expect(mail.token).toMatch(/^[0-9a-f]{48}$/);
    expect(mail.token.slice(0, 32)).toBe(mail.id.replaceAll('-', ''));
    expect(await runtime.query('kernel.mail_test.token', { messageId: mail.id }, { actor: owner, orgId })).toBe(mail.token);
    // Another org's context gets nothing for this mail.
    expect(await runtime.query('kernel.mail_test.token', { messageId: mail.id }, { actor: other, orgId: otherOrgId })).toBeNull();
    // The API role cannot resolve a token; only the worker can.
    await expect(sql`SELECT * FROM crove_kernel.mail_message_by_bounce_token(${mail.token})`.execute(db)).rejects.toThrow(/permission denied/);
  });

  it('accepts a bounce report at the API and records a hard bounce on its mail', async () => {
    const mail = await sentMail('hard@mail.test');
    const raw = report(mail.token, '5.1.1', { messageId: mail.header });
    // The API stores and queues it like any inbound mail.
    await expect(acceptInboundEmail({ runtime, store, domain: DOMAIN }, raw, `bounce+${mail.token}@${DOMAIN}`)).resolves.toMatchObject({ accepted: true });
    expect(await deliverReport(raw, `bounce+${mail.token}@${DOMAIN}`)).toEqual({ duplicate: false, fileIds: [], bounce: 'bounce_hard' });
    expect(await mailState(mail.id)).toEqual({ status: 'bounced', events: [{ kind: 'bounce_hard', provider: 'smtp' }], suppressions: [{ scope: 'all', reason: 'hard_bounce' }] });
    expect((await run('kernel.mail_test.send', { to: 'hard@mail.test', stream: 'system' }, owner)).status).toBe('suppressed');
    // The same report delivered again changes nothing.
    await deliverReport(raw, `bounce+${mail.token}@${DOMAIN}`);
    expect((await mailState(mail.id)).events).toHaveLength(1);
  });

  it('records a temporary failure as a soft bounce and a delay as deferred, and nothing for a relay', async () => {
    const soft = await sentMail('soft@mail.test');
    // A relay that changed the case of the quoted Message-ID still names the same mail.
    expect(await deliverReport(report(soft.token, '4.2.2', { messageId: soft.header.toUpperCase() }), `bounce+${soft.token}@${DOMAIN}`)).toMatchObject({ bounce: 'bounce_soft' });
    expect(await mailState(soft.id)).toEqual({ status: 'sent', events: [{ kind: 'bounce_soft', provider: 'smtp' }], suppressions: [] });
    const late = await sentMail('late@mail.test');
    expect(await deliverReport(report(late.token, '4.4.7', { action: 'delayed' }), `bounce+${late.token}@${DOMAIN}`)).toMatchObject({ bounce: 'deferred' });
    // A relay that passed the mail on says nothing about the mailbox.
    const relayed = await sentMail('relayed@mail.test');
    expect(await refusal(deliverReport(report(relayed.token, '2.0.0', { action: 'relayed' }), `bounce+${relayed.token}@${DOMAIN}`))).toBe('UNREADABLE_BOUNCE');
    expect((await mailState(relayed.id)).events).toEqual([]);
  });

  it('drops a report with an altered token, about another mail, or that is not a report', async () => {
    const mail = await sentMail('drop@mail.test');
    const altered = `${mail.token.slice(0, 47)}${mail.token.endsWith('0') ? '1' : '0'}`;
    expect(await refusal(deliverReport(report(altered, '5.1.1'), `bounce+${altered}@${DOMAIN}`))).toBe('UNKNOWN_BOUNCE');
    const unknown = `${randomUUID().replaceAll('-', '')}${mail.token.slice(32)}`;
    expect(await refusal(deliverReport(report(unknown, '5.1.1'), `bounce+${unknown}@${DOMAIN}`))).toBe('UNKNOWN_BOUNCE');
    expect(await refusal(deliverReport(report(mail.token, '5.1.1', { messageId: '<someone-else@mail.example.com>' }), `bounce+${mail.token}@${DOMAIN}`))).toBe('BOUNCE_MISMATCH');
    const reply = new TextEncoder().encode(`From: a@example.test\r\nTo: bounce+${mail.token}@${DOMAIN}\r\nSubject: hi\r\n\r\nNot a report.\r\n`);
    expect(await refusal(deliverReport(reply, `bounce+${mail.token}@${DOMAIN}`))).toBe('UNREADABLE_BOUNCE');
    expect(await mailState(mail.id)).toEqual({ status: 'sent', events: [], suppressions: [] });
    // At the API, a bounce address that cannot be a token is refused before anything is stored.
    expect(await refusal(acceptInboundEmail({ runtime, store, domain: DOMAIN }, reply, `bounce+abc@${DOMAIN}`))).toBe('UNKNOWN_RECIPIENT');
  });
});
