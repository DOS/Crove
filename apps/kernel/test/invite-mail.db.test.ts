// Invite mail (issue #129) against a real PostgreSQL 17, through the HTTP API: one mail per created invite with the
// accept link, none when the invite is refused, the same mail whether or not the invitee has an account, a failed or
// missing mail server never failing the invite, and the raw token in no table and no log line. Each invite mail has a
// crove_kernel.mail_message row with its outcome, and an address the org stopped gets none (#538). Set
// CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { MAX_INVITES_PER_EMAIL_PER_DAY, kernelCommands, kernelQueries } from '@crove/kernel';
import { Runtime, type BlobStore } from '@crove/kernel-runtime';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { classifySmtpError, createLogProvider, type MailProvider, type OutboundMail } from '@crove/mail';
import { createSessionStatusSource } from '../src/sessions.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-invite-mail-0123456789';
const ISSUER = 'crove-auth';
const PUBLIC_URL = 'https://books.example.com';

const suite = ADMIN ? describe : describe.skip;

interface Account {
  subject: string;
  email: string;
  session: string;
  userId: string;
  name: string;
}

suite('invite mail on PostgreSQL', () => {
  const dbName = `crove_test_invite_mail_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let config: Config;
  let runtime: Runtime;
  // Everything the process printed during a test, to search for the token.
  let printed: string[] = [];

  const sent: OutboundMail[] = [];
  // Ids the capturing provider gave, across tests: a provider id belongs to one mail (#539).
  let captured = 0;
  // A provider that takes every mail and names it as an HTTP provider would (#539).
  const capturing: MailProvider = {
    name: 'capture',
    enabled: true,
    sendRetrySafety: 'never',
    async send(mail) {
      sent.push(mail);
      captured += 1;
      return { status: 'accepted', providerMessageId: `capture-${captured}` };
    },
  };
  function appWith(mailer?: MailProvider, overrides: Partial<Config> = {}) {
    const deps = { config: { ...config, PUBLIC_URL, ...overrides }, runtime, store: {} as BlobStore, authenticate: createAuthenticator(config, db), pool, aiEnabled: false };
    return createHttpApp(mailer ? { ...deps, mailer } : deps);
  }
  let app: ReturnType<typeof createHttpApp>;

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  async function tokenFor(who: Account, options: { mfa?: boolean } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const mfa = options.mfa ? { aal: 'aal2', amr: [{ method: 'totp', timestamp: now }] } : {};
    return new SignJWT({
      role: 'authenticated',
      email: who.email,
      session_id: who.session,
      aal: 'aal1',
      is_anonymous: false,
      user_metadata: { full_name: who.name },
      ...mfa,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(who.subject)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(SECRET));
  }

  async function rpc(path: string, token: string, input: unknown, org: string | null, via = app) {
    const response = await via.request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(org ? { 'x-crove-org': org } : {}) },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const body = (await response.json().catch(() => null)) as ({ json?: Record<string, unknown> } & Record<string, unknown>) | null;
    return { status: response.status, body: (body && 'json' in body ? body.json : body) as Record<string, any> | null };
  }

  async function signIn(name: string): Promise<Account> {
    const who: Account = { subject: randomUUID(), email: `user-${randomUUID().slice(0, 8)}@mail.test`, session: randomUUID(), userId: '', name };
    const me = await rpc('me/get', await tokenFor(who), undefined, null);
    expect(me.status).toBe(200);
    who.userId = String(me.body?.userId);
    return who;
  }

  async function orgOf(owner: Account) {
    const created = await rpc('org/create', await tokenFor(owner), { name: `Công ty ${randomUUID().slice(0, 6)}`, idempotencyKey: randomUUID() }, null);
    expect(created.status).toBe(200);
    return { slug: String(created.body?.slug), orgId: String(created.body?.orgId), name: String(created.body?.name) };
  }

  const tokenOf = (acceptPath: unknown) => String(acceptPath).split('#')[1] ?? '';

  // The mail_message row of an invite's mail (#538).
  async function mailRow(inviteId: unknown) {
    return admin(async (c) => {
      const { rows } = await c.query<{
        status: string;
        error_code: string | null;
        to_address: string;
        message_id_header: string;
        created_by: string;
        attempts: number;
        provider: string | null;
        provider_message_id: string | null;
      }>(
        `SELECT status, error_code, to_address, message_id_header, created_by::text, attempts, provider, provider_message_id FROM crove_kernel.mail_message
          WHERE source = 'kernel.member.invite.create' AND source_id = $1`,
        [inviteId],
      );
      expect(rows).toHaveLength(1);
      return rows[0];
    });
  }

  // Every row of every table outside the system schemas, as text, that contains `needle`.
  async function tablesContaining(needle: string): Promise<string[]> {
    return admin(async (c) => {
      const { rows: tables } = await c.query<{ name: string }>(
        `SELECT pg_catalog.format('%I.%I', table_schema, table_name) AS name FROM information_schema.tables
          WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema')`,
      );
      expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining(['crove_kernel.member_invite', 'crove_kernel.outbox_event']));
      const hits: string[] = [];
      for (const { name } of tables) {
        const { rows } = await c.query<{ n: number }>(`SELECT pg_catalog.count(*)::int AS n FROM ${name} t WHERE t::text LIKE '%' || $1 || '%'`, [needle]);
        if ((rows[0]?.n ?? 0) > 0) hits.push(name);
      }
      return hits;
    });
  }

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
    config = loadConfig({
      DATABASE_URL: appUrl.toString(),
      AUTH_JWT_SECRET: SECRET,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
    });
    runtime = new Runtime(db, { sessions: createSessionStatusSource('off'), stepUp: 'required' }).register({
      commands: kernelCommands,
      queries: kernelQueries({ inboundDomain: null }),
    });
    app = appWith(capturing);
  });

  beforeEach(() => {
    sent.length = 0;
    printed = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        printed.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
      });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('mails the invitee once, with the accept link, and stores the token nowhere', async () => {
    const owner = await signIn('Chủ Lan');
    const invitee = await signIn('Khách');
    const org = await orgOf(owner);

    const created = await rpc('org/invite', await tokenFor(owner, { mfa: true }), { email: invitee.email.toUpperCase(), role: 'member' }, org.slug);
    expect(created).toMatchObject({ status: 200, body: { email: invitee.email, role: 'member' } });
    // The answer is the one #125 defined: the mail adds nothing to it.
    expect(Object.keys(created.body ?? {}).sort()).toEqual(['acceptPath', 'email', 'expiresAt', 'inviteId', 'role']);
    const token = tokenOf(created.body?.acceptPath);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    expect(sent).toHaveLength(1);
    const [mail] = sent;
    expect(mail?.to).toBe(invitee.email);
    expect(mail?.subject).toBe(`Lời mời tham gia ${org.name} trên Ludy`);
    expect(mail?.text).toContain(`${PUBLIC_URL}/-/invite#${token}`);
    expect(mail?.text).toContain(`Chủ Lan (${owner.email}) mời bạn tham gia tổ chức "${org.name}" trên Ludy với vai trò thành viên.`);
    expect(mail?.html).toContain(`href="${PUBLIC_URL}/-/invite#${token}"`);
    // Its row: sent, by the owner, under the Message-ID the mail carried, with the provider that took it and the id
    // it gave it (#539: delivery events find the row by them); never the body.
    expect(await mailRow(created.body?.inviteId)).toEqual({
      status: 'sent',
      error_code: null,
      to_address: invitee.email,
      message_id_header: mail?.messageId,
      created_by: owner.userId,
      attempts: 1,
      provider: 'capture',
      provider_message_id: `capture-${captured}`,
    });
    expect(mail?.messageId).toMatch(/^<[0-9a-f-]{36}@crove\.invalid>$/);

    // The link works for the invitee.
    expect(await rpc('invites/accept', await tokenFor(invitee), { token }, null)).toMatchObject({ status: 200, body: { slug: org.slug } });
    expect(sent).toHaveLength(1);

    // The scan finds what is stored (the email, the token's hash), and not the token.
    expect(await tablesContaining(invitee.email)).toContain('crove_kernel.member_invite');
    const [{ hash } = { hash: '' }] = await admin(
      async (c) => (await c.query<{ hash: string }>('SELECT token_sha256 AS hash FROM crove_kernel.member_invite WHERE id = $1', [created.body?.inviteId])).rows,
    );
    expect(await tablesContaining(hash)).toEqual(['crove_kernel.member_invite']);
    expect(await tablesContaining(token)).toEqual([]);
    expect(printed.join('\n')).not.toContain(token);
  });

  it('sends nothing when the invite is refused', async () => {
    const owner = await signIn('owner');
    const org = await orgOf(owner);
    const admin_ = await signIn('admin');
    const viewer = await signIn('viewer');
    const ownerMfa = await tokenFor(owner, { mfa: true });
    for (const [who, role] of [
      [admin_, 'admin'],
      [viewer, 'viewer'],
    ] as const) {
      const invited = await rpc('org/invite', ownerMfa, { email: who.email, role }, org.slug);
      expect((await rpc('invites/accept', await tokenFor(who), { token: tokenOf(invited.body?.acceptPath) }, null)).status).toBe(200);
    }
    sent.length = 0;
    const email = `new-${randomUUID().slice(0, 8)}@mail.test`;

    // R3 without fresh MFA.
    expect(await rpc('org/invite', await tokenFor(owner), { email, role: 'member' }, org.slug)).toMatchObject({ status: 403 });
    // Already a member.
    expect(await rpc('org/invite', ownerMfa, { email: viewer.email, role: 'member' }, org.slug)).toMatchObject({
      status: 409,
      body: { code: 'ALREADY_MEMBER' },
    });
    // A viewer may not invite; an admin may not invite an admin.
    expect(await rpc('org/invite', await tokenFor(viewer, { mfa: true }), { email, role: 'member' }, org.slug)).toMatchObject({ status: 403 });
    expect(await rpc('org/invite', await tokenFor(admin_, { mfa: true }), { email, role: 'admin' }, org.slug)).toMatchObject({ status: 403 });
    // Not a member of the org at all.
    const stranger = await signIn('stranger');
    expect(await rpc('org/invite', await tokenFor(stranger, { mfa: true }), { email, role: 'member' }, org.slug)).toMatchObject({ status: 403 });
    // Invalid input never reaches the command.
    expect((await rpc('org/invite', ownerMfa, { email: 'not-an-email', role: 'member' }, org.slug)).status).toBe(400);
    expect(sent).toEqual([]);
    // Over the daily limit for one email: refused, and no mail.
    const again = `again-${randomUUID().slice(0, 8)}@mail.test`;
    for (let i = 0; i < MAX_INVITES_PER_EMAIL_PER_DAY; i++) expect((await rpc('org/invite', ownerMfa, { email: again, role: 'member' }, org.slug)).status).toBe(200);
    expect(sent).toHaveLength(MAX_INVITES_PER_EMAIL_PER_DAY);
    expect(await rpc('org/invite', ownerMfa, { email: again, role: 'member' }, org.slug)).toMatchObject({ status: 429, body: { code: 'INVITE_RATE_LIMITED' } });
    expect(sent).toHaveLength(MAX_INVITES_PER_EMAIL_PER_DAY);
  });

  it('sends the same mail whether or not the email has an account', async () => {
    const owner = await signIn('Chủ');
    const org = await orgOf(owner);
    const existing = await signIn('Có tài khoản');
    const unknown = `nobody-${randomUUID().slice(0, 8)}@mail.test`;
    const ownerMfa = await tokenFor(owner, { mfa: true });

    const a = await rpc('org/invite', ownerMfa, { email: existing.email, role: 'viewer' }, org.slug);
    const b = await rpc('org/invite', ownerMfa, { email: unknown, role: 'viewer' }, org.slug);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(Object.keys(a.body ?? {}).sort()).toEqual(Object.keys(b.body ?? {}).sort());
    expect(sent).toHaveLength(2);
    // Each mail has its own Message-ID; everything else is the same.
    const normalize = (mail: OutboundMail | undefined, email: string, token: string) =>
      JSON.stringify({ ...mail, messageId: '<id>' }).replaceAll(email, '<email>').replaceAll(token, '<token>');
    expect(normalize(sent[0], existing.email, tokenOf(a.body?.acceptPath))).toBe(normalize(sent[1], unknown, tokenOf(b.body?.acceptPath)));
  });

  it('keeps the invite when the mail server fails, and logs no token', async () => {
    const owner = await signIn('owner');
    const invitee = await signIn('invitee');
    const org = await orgOf(owner);
    let attempts = 0;
    const down: MailProvider = {
      name: 'smtp',
      enabled: true,
      sendRetrySafety: 'never',
      async send(mail) {
        attempts++;
        return classifySmtpError(Object.assign(new Error(`connect ECONNREFUSED while sending ${mail.text}`), { code: 'ECONNECTION' }));
      },
    };
    // Real backoff (0.5 s, then 2 s) within the 10 s deadline.
    const failing = appWith(down);
    const created = await rpc('org/invite', await tokenFor(owner, { mfa: true }), { email: invitee.email, role: 'member' }, org.slug, failing);
    expect(created).toMatchObject({ status: 200, body: { email: invitee.email } });
    expect(attempts).toBe(3);
    const token = tokenOf(created.body?.acceptPath);
    expect(printed).toContain('[mail] invite mail not sent after 3 attempt(s): ECONNECTION');
    expect(await mailRow(created.body?.inviteId)).toMatchObject({ status: 'failed', error_code: 'SEND_FAILED', provider: 'smtp', provider_message_id: null });

    // A mailer that throws before returning a promise (a bug) does not fail the invite either.
    const syncThrow: MailProvider = {
      name: 'smtp',
      enabled: true,
      sendRetrySafety: 'never',
      send: () => {
        throw Object.assign(new TypeError(`sync ${token}`), { code: 'EMESSAGE' });
      },
    };
    const again = await rpc('org/invite', await tokenFor(owner, { mfa: true }), { email: `x-${randomUUID().slice(0, 6)}@mail.test`, role: 'member' }, org.slug, appWith(syncThrow));
    expect(again).toMatchObject({ status: 200 });
    expect(printed).toContain('[mail] invite mail not sent after 1 attempt(s): EMESSAGE');
    // Nor does a template that cannot render (here: no PUBLIC_URL to build the link from): the API catches it.
    const odd = await rpc('org/invite', await tokenFor(owner, { mfa: true }), { email: `y-${randomUUID().slice(0, 6)}@mail.test`, role: 'member' }, org.slug, appWith(capturing, { PUBLIC_URL: undefined as unknown as string }));
    expect(odd).toMatchObject({ status: 200 });
    expect(printed).toContain('[mail] invite mail not sent: TypeError');
    expect(await mailRow(odd.body?.inviteId)).toMatchObject({ status: 'failed', error_code: 'SEND_ERROR' });

    // The one-time link still works.
    expect(await rpc('invites/accept', await tokenFor(invitee), { token }, null)).toMatchObject({ status: 200 });
    expect(printed.join('\n')).not.toContain(token);
    expect(printed.join('\n')).not.toContain(tokenOf(again.body?.acceptPath));
    expect(await tablesContaining(token)).toEqual([]);
  });

  it('logs one line and sends nothing without a mail server', async () => {
    const owner = await signIn('owner');
    const org = await orgOf(owner);
    const lines: string[] = [];
    const off = appWith(createLogProvider((l) => lines.push(l)));
    const created = await rpc('org/invite', await tokenFor(owner, { mfa: true }), { email: 'someone@mail.test', role: 'viewer' }, org.slug, off);
    expect(created).toMatchObject({ status: 200 });
    expect(lines).toEqual([`[mail] not sent, SMTP_HOST is not set: "Lời mời tham gia ${org.name} trên Ludy"`]);
    expect(lines.join('\n')).not.toContain(tokenOf(created.body?.acceptPath));
    // No sender at all (an embedder without mail) works too.
    const none = await rpc('org/invite', await tokenFor(owner, { mfa: true }), { email: 'other@mail.test', role: 'viewer' }, org.slug, appWith());
    expect(none).toMatchObject({ status: 200 });
    expect(sent).toEqual([]);
    expect(await mailRow(created.body?.inviteId)).toMatchObject({ status: 'failed', error_code: 'MAIL_OFF' });
    expect(await mailRow(none.body?.inviteId)).toMatchObject({ status: 'failed', error_code: 'MAIL_OFF' });

    // The app tells the inviter whether the server mails invites.
    const mailEnabled = async (via: ReturnType<typeof createHttpApp>) => ((await (await via.request('/api/config')).json()) as { mailEnabled: boolean }).mailEnabled;
    expect(await mailEnabled(off)).toBe(false);
    expect(await mailEnabled(appWith(capturing))).toBe(true);
    expect(await mailEnabled(appWith())).toBe(false);
  });

  it('shows each pending invite with what became of its mail (#539)', async () => {
    const owner = await signIn('owner');
    const org = await orgOf(owner);
    const ownerMfa = await tokenFor(owner, { mfa: true });
    const tag = randomUUID().slice(0, 6);
    const delivered = await rpc('org/invite', ownerMfa, { email: `sent-${tag}@mail.test`, role: 'member' }, org.slug);
    await runtime.execute('kernel.mail.suppression.add', { email: `stopped-${tag}@mail.test`, scope: 'all' }, { actor: { type: 'user', userId: owner.userId, aal: 'aal1', sessionId: owner.session }, orgId: org.orgId });
    const stopped = await rpc('org/invite', ownerMfa, { email: `stopped-${tag}@mail.test`, role: 'member' }, org.slug);
    const refusing: MailProvider = { name: 'smtp', enabled: true, sendRetrySafety: 'never', send: async () => ({ status: 'rejected', error: 'bad_request', code: 'EMESSAGE' }) };
    const failed = await rpc('org/invite', ownerMfa, { email: `failed-${tag}@mail.test`, role: 'viewer' }, org.slug, appWith(refusing));
    const listed = (await rpc('org/listInvites', await tokenFor(owner), undefined, org.slug)).body as unknown as Array<{ id: string; mail: string | null }>;
    const mailOf = (invite: { body: Record<string, unknown> | null }) => listed.find((i) => i.id === invite.body?.inviteId)?.mail;
    expect(mailOf(delivered)).toBe('sent');
    expect(mailOf(stopped)).toBe('suppressed');
    expect(mailOf(failed)).toBe('failed');
  });

  it('sends no mail to an address the org stopped, and still makes the invite (#538)', async () => {
    const owner = await signIn('owner');
    const org = await orgOf(owner);
    const ownerMfa = await tokenFor(owner, { mfa: true });
    const local = `ab${randomUUID().slice(0, 6)}`;
    const before = await rpc('org/invite', ownerMfa, { email: `${local}@gmail.com`, role: 'member' }, org.slug);
    expect(sent).toHaveLength(1);
    sent.length = 0;
    expect(await runtime.execute('kernel.mail.suppression.add', { email: `${local}@gmail.com`, scope: 'all' }, { actor: { type: 'user', userId: owner.userId, aal: 'aal1', sessionId: owner.session }, orgId: org.orgId })).toEqual({ added: true });

    // A spelling of the same inbox (case, dots, +tag at Gmail) is stopped too.
    const variant = `${local.slice(0, 1).toUpperCase()}.${local.slice(1)}+crove@GMAIL.com`;
    const invited = await rpc('org/invite', ownerMfa, { email: variant, role: 'member' }, org.slug);
    // The answer is the same as for any other address.
    expect(invited.status).toBe(200);
    expect(Object.keys(invited.body ?? {}).sort()).toEqual(Object.keys(before.body ?? {}).sort());
    expect(sent).toEqual([]);
    expect(printed.filter((line) => line.startsWith('[mail]'))).toEqual([]);
    expect(await mailRow(invited.body?.inviteId)).toMatchObject({ status: 'suppressed', error_code: null, attempts: 0 });
    // The invite itself is made, and its link works for the account with that email.
    expect(tokenOf(invited.body?.acceptPath)).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // Lifted, the address gets mail again.
    await runtime.execute(
      'kernel.mail.suppression.lift',
      { email: `${local}@gmail.com`, scope: 'all', reason: 'Đã sửa hộp thư' },
      { actor: { type: 'user', userId: owner.userId, aal: 'aal1', sessionId: owner.session }, orgId: org.orgId },
    );
    const again = await rpc('org/invite', ownerMfa, { email: variant, role: 'member' }, org.slug);
    expect(again.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(await mailRow(again.body?.inviteId)).toMatchObject({ status: 'sent' });
  });
});
