// Outbound mail in the kernel, step E1a (#538), on a real PostgreSQL 17: the keyed address hash and its folding, the
// suppression list (add, lift, complaints kept, scopes), the mail_message row a sending command writes, the narrow
// record of a mail the request sent itself, and the guards on both tables. Set CROVE_TEST_ADMIN_URL to a superuser URL;
// each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createMailMessage, createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { DomainError, Runtime, defineCommand, type UserActor } from '@crove/kernel-runtime';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));

const suite = ADMIN ? describe : describe.skip;

// A test-only command that writes a mail_message row the way a sending command does.
const sendTest = defineCommand({
  name: 'kernel.mail_test.send',
  input: z.object({ to: z.string(), stream: z.enum(['system', 'transactional', 'marketing']), sourceId: z.uuid().optional() }),
  risk: 'R1',
  access: ['owner', 'admin', 'member', 'viewer'],
  handler: async (ctx, input) =>
    createMailMessage(ctx, {
      stream: input.stream,
      source: 'kernel.mail_test.send',
      sourceId: input.sourceId ?? null,
      templateKey: 'kernel.mail_test',
      to: input.to,
      status: 'sending',
    }),
});

suite('outbound mail in the kernel (#538)', () => {
  const dbName = `crove_test_mail_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let runtime: Runtime;
  let orgId = '';
  let otherOrgId = '';
  const users: Record<'owner' | 'admin' | 'member' | 'viewer' | 'other', UserActor> = {} as never;

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  const actor = (userId: string, mfa = false): UserActor => ({
    type: 'user',
    userId,
    aal: mfa ? 'aal2' : 'aal1',
    sessionId: randomUUID(),
    mfaAt: mfa ? Math.floor(Date.now() / 1000) : null,
  });
  const run = (name: string, input: unknown, who: UserActor, org = orgId) => runtime.execute<any>(name, input, { actor: who, orgId: org });
  const refusal = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (error) {
      return error instanceof DomainError ? error.code : String(error);
    }
    return 'resolved';
  };
  const hashOf = async (address: string) =>
    admin(async (c) => (await c.query<{ h: string | null }>('SELECT crove_kernel.mail_address_hash($1) AS h', [address])).rows[0]?.h ?? null);

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
    const appUrl = new URL(adminUrl);
    appUrl.username = 'crove_app';
    appUrl.password = 'test-app-pw';
    pool = createPool({ connectionString: appUrl.toString(), max: 4 });
    db = createDb(pool);
    runtime = new Runtime(db).register({
      commands: [...kernelCommands, sendTest],
      queries: kernelQueries({ inboundDomain: null }),
    });

    const ids: Record<string, string> = {};
    for (const who of ['owner', 'admin', 'member', 'viewer', 'other'] as const) {
      ids[who] = await upsertIdentity(db, { issuer: 'mail-test', subject: `${who}-${randomUUID()}`, email: `${who}-${dbName}@mail.test`, name: null });
      users[who] = actor(ids[who] as string);
    }
    orgId = (await createOrg(runtime, users.owner, 'Công ty Thư')).orgId;
    otherOrgId = (await createOrg(runtime, users.other, 'Công ty Khác')).orgId;
    for (const who of ['admin', 'member', 'viewer'] as const) {
      const invite = await run('kernel.member.invite.create', { email: `${who}-${dbName}@mail.test`, role: who }, actor(ids.owner as string, true));
      await runtime.executeOrgless('kernel.member.invite.accept', { token: String(invite.acceptPath).split('#')[1] }, { actor: users[who] });
    }
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('hashes an address under a key no runtime role can read, folding the spellings of one inbox', async () => {
    // Synthetic Gmail addresses: Gmail issues no username with an underscore (#1640).
    const hash = await hashOf('Te.St_User+news@GMAIL.com ');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashOf('test_user@gmail.com')).toBe(hash);
    expect(await hashOf('test_user@googlemail.com')).toBe(hash);
    // Dots matter outside Gmail; another address is another hash; nothing is hashed for an empty address.
    expect(await hashOf('te.st_user@example.com')).not.toBe(await hashOf('test_user@example.com'));
    expect(await hashOf('')).toBeNull();
    // Keyed: not the plain SHA-256 of the folded address.
    const plain = await admin(async (c) => (await c.query<{ h: string }>("SELECT encode(sha256(convert_to('test_user@gmail.com', 'UTF8')), 'hex') AS h")).rows[0]?.h);
    expect(hash).not.toBe(plain);
    // The tenant role calls the hash; no runtime role reads the key.
    for (const role of ['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant']) {
      const can = await admin(
        async (c) =>
          (
            await c.query<{ sel: boolean; upd: boolean }>(
              `SELECT has_table_privilege($1, 'crove_kernel.mail_hash_key', 'SELECT') AS sel,
                      has_table_privilege($1, 'crove_kernel.mail_hash_key', 'UPDATE') AS upd`,
              [role],
            )
          ).rows[0],
      );
      expect(can, role).toEqual({ sel: false, upd: false });
    }
    expect(
      await admin(
        async (c) => (await c.query<{ x: boolean }>("SELECT has_function_privilege('crove_tenant', 'crove_kernel.mail_address_hash(text)', 'EXECUTE') AS x")).rows[0]?.x,
      ),
    ).toBe(true);
    const login = await pool.connect();
    try {
      await expect(login.query('SELECT * FROM crove_kernel.mail_hash_key')).rejects.toThrow(/permission denied/);
    } finally {
      login.release();
    }
  });

  it('suppresses by scope: all stops every stream, marketing only campaigns', async () => {
    const address = `stop-${randomUUID().slice(0, 6)}@mail.test`;
    expect((await run('kernel.mail_test.send', { to: address, stream: 'transactional' }, users.member)).status).toBe('sending');

    expect(await run('kernel.mail.suppression.add', { email: address, scope: 'marketing' }, users.admin)).toEqual({ added: true });
    expect((await run('kernel.mail_test.send', { to: address, stream: 'marketing' }, users.member)).status).toBe('suppressed');
    expect((await run('kernel.mail_test.send', { to: address, stream: 'transactional' }, users.member)).status).toBe('sending');
    expect((await run('kernel.mail_test.send', { to: address, stream: 'system' }, users.member)).status).toBe('sending');

    expect(await run('kernel.mail.suppression.add', { email: address.toUpperCase(), scope: 'all' }, users.owner)).toEqual({ added: true });
    for (const stream of ['system', 'transactional', 'marketing'] as const) {
      expect((await run('kernel.mail_test.send', { to: address, stream }, users.member)).status, stream).toBe('suppressed');
    }
    // Adding a live suppression again changes nothing.
    expect(await run('kernel.mail.suppression.add', { email: address, scope: 'all' }, users.admin)).toEqual({ added: false });
    // Another org's list is its own.
    expect((await run('kernel.mail_test.send', { to: address, stream: 'marketing' }, users.other, otherOrgId)).status).toBe('sending');

    // The row keeps the address (for the log) and its hash; a suppressed row was never attempted.
    const rows = await admin(
      async (c) =>
        (
          await c.query<{ status: string; to_address: string; to_hash: string; attempts: number; stream: string }>(
            `SELECT status, to_address, to_hash, attempts, stream FROM crove_kernel.mail_message WHERE org_id = $1 AND to_address = $2 ORDER BY created_at`,
            [orgId, address],
          )
        ).rows,
    );
    expect(rows.map((r) => `${r.stream}:${r.status}`)).toEqual([
      'transactional:sending',
      'marketing:suppressed',
      'transactional:sending',
      'system:sending',
      'system:suppressed',
      'transactional:suppressed',
      'marketing:suppressed',
    ]);
    expect(new Set(rows.map((r) => r.to_hash))).toEqual(new Set([await hashOf(address)]));
    expect(rows.every((r) => r.attempts === 0)).toBe(true);
  });

  it('lets owners and admins add and lift with a reason, never lifts a complaint, and keeps every row', async () => {
    const address = `lift-${randomUUID().slice(0, 6)}@mail.test`;
    for (const who of ['member', 'viewer'] as const) {
      expect(await refusal(run('kernel.mail.suppression.add', { email: address, scope: 'all' }, users[who])), who).toBe('FORBIDDEN');
    }
    expect(await refusal(run('kernel.mail.suppression.lift', { email: address, scope: 'all', reason: 'x' }, users.admin))).toBe('NOT_SUPPRESSED');
    await run('kernel.mail.suppression.add', { email: address, scope: 'all' }, users.admin);
    expect(await refusal(run('kernel.mail.suppression.lift', { email: address, scope: 'all', reason: 'x' }, users.member))).toBe('FORBIDDEN');
    expect(await refusal(run('kernel.mail.suppression.lift', { email: address, scope: 'all', reason: '   ' }, users.admin))).toBe('VALIDATION');
    expect(await run('kernel.mail.suppression.lift', { email: address, scope: 'all', reason: 'Khách xin nhận lại' }, users.admin)).toEqual({ lifted: true });
    expect((await run('kernel.mail_test.send', { to: address, stream: 'system' }, users.member)).status).toBe('sending');
    expect(await refusal(run('kernel.mail.suppression.lift', { email: address, scope: 'all', reason: 'x' }, users.admin))).toBe('NOT_SUPPRESSED');
    // Stopped again: a new live row; the lifted one stays as it was.
    expect(await run('kernel.mail.suppression.add', { email: address, scope: 'all' }, users.owner)).toEqual({ added: true });
    const rows = await admin(
      async (c) =>
        (
          await c.query<{ lifted: boolean; lift_reason: string | null; created_by: string; lifted_by: string | null }>(
            `SELECT lifted_at IS NOT NULL AS lifted, lift_reason, created_by::text, lifted_by::text FROM crove_kernel.mail_suppression
              WHERE org_id = $1 AND to_hash = $2 ORDER BY created_at`,
            [orgId, await hashOf(address)],
          )
        ).rows,
    );
    expect(rows).toEqual([
      { lifted: true, lift_reason: 'Khách xin nhận lại', created_by: users.admin.userId, lifted_by: users.admin.userId },
      { lifted: false, lift_reason: null, created_by: users.owner.userId, lifted_by: null },
    ]);

    // A complaint (written by the bounce handling of step E2) is never lifted by command.
    const complained = `complaint-${randomUUID().slice(0, 6)}@mail.test`;
    await admin((c) =>
      c.query(`INSERT INTO crove_kernel.mail_suppression (org_id, to_hash, scope, reason) VALUES ($1, crove_kernel.mail_address_hash($2), 'marketing', 'complaint')`, [
        orgId,
        complained,
      ]),
    );
    expect(await refusal(run('kernel.mail.suppression.lift', { email: complained, scope: 'marketing', reason: 'x' }, users.owner))).toBe('MAIL_COMPLAINT_LIFT');
  });

  it('reads back and records the outcome of a mail sent by the request only for its sender, once, while it is sending', async () => {
    const address = `direct-${randomUUID().slice(0, 6)}@mail.test`;
    const sourceId = randomUUID();
    const sent = await run('kernel.mail_test.send', { to: address, stream: 'system', sourceId }, users.member);
    // The request reads back the row its command wrote; another member, another org or another record reads nothing.
    const lookup = (who: UserActor, id = sourceId, org = orgId) =>
      runtime.query<unknown>('kernel.mail.direct.get', { source: 'kernel.mail_test.send', sourceId: id }, { actor: who, orgId: org });
    expect(await lookup(users.member)).toEqual({
      messageId: sent.id,
      status: 'sending',
      messageIdHeader: sent.messageIdHeader,
      // Its Return-Path token (#539): the id without dashes and a MAC of it.
      bounceToken: expect.stringMatching(new RegExp(`^${sent.id.replaceAll('-', '')}[0-9a-f]{16}$`)),
    });
    expect(await lookup(users.admin)).toBeNull();
    expect(await lookup(users.other, sourceId, otherOrgId)).toBeNull();
    expect(await lookup(users.member, randomUUID())).toBeNull();
    const record = (who: UserActor, input: Record<string, unknown> = {}, org = orgId) =>
      run('kernel.mail.record_direct', { messageId: sent.id, outcome: 'sent', ...input }, who, org);
    // Not another member, not from another org.
    expect(await refusal(record(users.admin))).toBe('NOT_FOUND');
    expect(await refusal(record(users.other, {}, otherOrgId))).toBe('NOT_FOUND');
    expect(await refusal(record(users.member, { errorCode: 'lower case' }))).toBe('VALIDATION');
    expect(await record(users.member)).toEqual({ messageId: sent.id, status: 'sent' });
    // Once.
    expect(await refusal(record(users.member, { outcome: 'failed' }))).toBe('NOT_FOUND');
    const row = await admin(
      async (c) =>
        (
          await c.query<{ status: string; attempts: number; sent: boolean; error_code: string | null }>(
            'SELECT status, attempts, sent_at IS NOT NULL AS sent, error_code FROM crove_kernel.mail_message WHERE org_id = $1 AND id = $2',
            [orgId, sent.id],
          )
        ).rows[0],
    );
    expect(row).toEqual({ status: 'sent', attempts: 1, sent: true, error_code: null });
    expect(await lookup(users.member)).toMatchObject({ messageId: sent.id, status: 'sent' });

    // A failure keeps its code; a suppressed mail has nothing to record.
    const failing = await run('kernel.mail_test.send', { to: address, stream: 'system' }, users.member);
    expect(await run('kernel.mail.record_direct', { messageId: failing.id, outcome: 'failed', errorCode: 'MAIL_OFF' }, users.member)).toEqual({
      messageId: failing.id,
      status: 'failed',
    });
    await run('kernel.mail.suppression.add', { email: address, scope: 'all' }, users.admin);
    const stopped = await run('kernel.mail_test.send', { to: address, stream: 'system' }, users.member);
    expect(stopped.status).toBe('suppressed');
    expect(await refusal(run('kernel.mail.record_direct', { messageId: stopped.id, outcome: 'sent' }, users.member))).toBe('NOT_FOUND');

    // Past the window, a mail left sending can no longer be recorded by the request.
    const late = await run('kernel.mail_test.send', { to: `late-${randomUUID().slice(0, 6)}@mail.test`, stream: 'system' }, users.member);
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query('ALTER TABLE crove_kernel.mail_message DISABLE TRIGGER mail_message_guard');
      await c.query("UPDATE crove_kernel.mail_message SET created_at = now() - interval '11 minutes' WHERE org_id = $1 AND id = $2", [orgId, late.id]);
      await c.query('ALTER TABLE crove_kernel.mail_message ENABLE TRIGGER mail_message_guard');
      await c.query('COMMIT');
    });
    expect(await refusal(run('kernel.mail.record_direct', { messageId: late.id, outcome: 'sent' }, users.member))).toBe('NOT_FOUND');
  });

  it('keeps the identity of a mail and of a suppression fixed, and the status moves legal', async () => {
    const sent = await run('kernel.mail_test.send', { to: `guard-${randomUUID().slice(0, 6)}@mail.test`, stream: 'transactional' }, users.member);
    const update = (set: string) =>
      admin((c) => c.query(`UPDATE crove_kernel.mail_message SET ${set} WHERE org_id = $1 AND id = $2`, [orgId, sent.id]));
    await expect(update("status = 'delivered'")).rejects.toThrow(/MAIL_MESSAGE_STATUS/);
    await expect(update("status = 'queued'")).rejects.toThrow(/MAIL_MESSAGE_STATUS/);
    await expect(update("to_address = 'someone@else.test'")).rejects.toThrow(/MAIL_MESSAGE_IMMUTABLE/);
    await expect(update(`to_hash = '${'0'.repeat(64)}'`)).rejects.toThrow(/MAIL_MESSAGE_IMMUTABLE/);
    await expect(update("source = 'kernel.other.source'")).rejects.toThrow(/MAIL_MESSAGE_IMMUTABLE/);
    await expect(update('attempts = 0, status = status')).resolves.toBeDefined();
    await update('attempts = 2');
    await expect(update('attempts = 1')).rejects.toThrow(/MAIL_MESSAGE_ATTEMPTS/);
    // A retention purge may drop the address and keep the hash.
    await update('to_address = NULL, subject = NULL');
    await update("status = 'sent', sent_at = now()");
    await expect(update("status = 'sending'")).rejects.toThrow(/MAIL_MESSAGE_STATUS/);
    await update("status = 'delivered'");
    await update("status = 'complained'");
    await expect(update("status = 'delivered'")).rejects.toThrow(/MAIL_MESSAGE_STATUS/);
    // Insert only as queued, sending or suppressed.
    await expect(
      admin((c) =>
        c.query(
          `INSERT INTO crove_kernel.mail_message (org_id, stream, source, template_key, to_hash, message_id_header, status)
           VALUES ($1, 'system', 'kernel.x.y', 'kernel.x', $2, '<a@b.c>', 'sent')`,
          [orgId, '1'.repeat(64)],
        ),
      ),
    ).rejects.toThrow(/MAIL_MESSAGE_INSERT|mail_message_sent/);

    // The tenant role updates only the status columns, and the recipient address, which the guard lets only be dropped
    // (a PDPL erasure, #923); it deletes nothing.
    const privileges = await admin(
      async (c) =>
        (
          await c.query<{ col: string; upd: boolean }>(
            `SELECT a.attname AS col, has_column_privilege('crove_tenant', 'crove_kernel.mail_message', a.attname, 'UPDATE') AS upd
               FROM pg_attribute a WHERE a.attrelid = 'crove_kernel.mail_message'::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attname`,
          )
        ).rows,
    );
    expect(privileges.filter((p) => p.upd).map((p) => p.col)).toEqual(['attempts', 'error_code', 'provider', 'provider_message_id', 'sent_at', 'status', 'to_address', 'updated_at']);
    expect(await admin(async (c) => (await c.query<{ d: boolean }>("SELECT has_table_privilege('crove_tenant', 'crove_kernel.mail_message', 'DELETE') AS d")).rows[0]?.d)).toBe(false);

    // A suppression: lifted once, then frozen; its identity never changes.
    const address = `frozen-${randomUUID().slice(0, 6)}@mail.test`;
    await run('kernel.mail.suppression.add', { email: address, scope: 'all' }, users.admin);
    const where = `org_id = '${orgId}' AND to_hash = crove_kernel.mail_address_hash('${address}')`;
    await expect(admin((c) => c.query(`UPDATE crove_kernel.mail_suppression SET reason = 'complaint' WHERE ${where}`))).rejects.toThrow(/MAIL_SUPPRESSION_IMMUTABLE/);
    await expect(admin((c) => c.query(`UPDATE crove_kernel.mail_suppression SET scope = 'marketing' WHERE ${where}`))).rejects.toThrow(/MAIL_SUPPRESSION_IMMUTABLE/);
    await run('kernel.mail.suppression.lift', { email: address, scope: 'all', reason: 'Đã sửa' }, users.admin);
    await expect(admin((c) => c.query(`UPDATE crove_kernel.mail_suppression SET lift_reason = 'Khác' WHERE ${where}`))).rejects.toThrow(/MAIL_SUPPRESSION_LIFTED/);
    await expect(
      admin((c) =>
        c.query(`INSERT INTO crove_kernel.mail_suppression (org_id, to_hash, scope, reason, lifted_at, lifted_by, lift_reason) VALUES ($1, $2, 'all', 'manual', now(), $3, 'x')`, [
          orgId,
          '2'.repeat(64),
          users.admin.userId,
        ]),
      ),
    ).rejects.toThrow(/MAIL_SUPPRESSION_INSERT/);
  });
});
