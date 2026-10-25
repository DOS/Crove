// No audit row, no download (issue #365): every file export of the finance module writes its audit row through an
// export command after the file is built, and only then answers with the file. Here the export commands fail as a
// failed audit write would, and each route must answer an error instead of a file: the journal, the MISA exports, the
// VAT working and its HTKK XML (finance.vat.export), the ledger reports (finance.ledger.export), the financial
// statements, also as HTKK XML (#920), and the register of fixed assets (#919). On a real PostgreSQL 17; the commands
// themselves are covered by the export tests of each report. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run
// creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { kernelCommands, kernelQueries } from '@crove/kernel';
import { DomainError, Runtime, defineCommand, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-export-audit-0123456789';
const ISSUER = 'crove-auth';
const EXPORT_COMMANDS = ['finance.journal.export', 'finance.vat.export', 'finance.ledger.export', 'finance.statements.export', 'finance.fixed_asset.export'];
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

class MemoryStore implements BlobStore {
  async put(_key: string, bytes: Uint8Array) {
    return `content:${sha256Hex(bytes)}`;
  }
  async get(): Promise<Uint8Array> {
    throw new Error('missing blob');
  }
  async delete() {}
}

// The export commands each route reached, so a 500 is known to come from the failed audit write and not from an
// earlier step (the report query, the file builder).
const reached: string[] = [];

// An export command whose audit write fails: the runtime refuses the command, as it would on a database error.
const failing = (name: string) =>
  defineCommand({
    name,
    input: z.object({}).passthrough(),
    risk: 'R0',
    access: ['owner', 'admin', 'member', 'viewer'],
    handler: async () => {
      reached.push(name);
      throw new DomainError('INTERNAL', 500, 'Lỗi hệ thống');
    },
  });

const suite = ADMIN ? describe : describe.skip;

suite('finance exports: no audit row, no download (#365)', () => {
  const dbName = `crove_test_export_audit_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let app: ReturnType<typeof createHttpApp>;
  let slug = '';
  let orgId = '';
  const owner = { subject: randomUUID(), email: 'owner@export-audit.test', session: randomUUID() };

  const token = () =>
    new SignJWT({ role: 'authenticated', email: owner.email, session_id: owner.session, aal: 'aal1', is_anonymous: false })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(owner.subject)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(SECRET));

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const appUrl = new URL(adminUrl);
    appUrl.username = 'crove_app';
    appUrl.password = 'test-app-pw';
    pool = createPool({ connectionString: appUrl.toString(), max: 4 });
    const db: Db = createDb(pool);
    // The finance module as deployed, but with its export commands replaced by failing ones of the same names.
    const runtime = new Runtime(db).register({
      commands: [...kernelCommands, ...financeCommands.filter((c) => !EXPORT_COMMANDS.includes(c.name)), ...EXPORT_COMMANDS.map(failing)],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
    });
    const config = loadConfig({
      DATABASE_URL: appUrl.toString(),
      AUTH_JWT_SECRET: SECRET,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
    });
    app = createHttpApp({ config, runtime, store: new MemoryStore(), authenticate: createAuthenticator(config, db), pool, aiEnabled: false });
    const created = await app.request('/api/rpc/org/create', {
      method: 'POST',
      headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ json: { name: 'Công ty Xuất file', idempotencyKey: randomUUID() } }),
    });
    expect(created.status).toBe(200);
    const body = (await created.json()) as { json: { slug: string; orgId: string } };
    slug = body.json.slug;
    orgId = body.json.orgId;
    // The HTKK XML needs the org's tax code; without it the route refuses before the export command runs.
    const taxCode = await app.request('/api/rpc/org/setTaxCode', {
      method: 'POST',
      headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json', 'x-crove-org': slug },
      body: JSON.stringify({ json: { taxCode: '0309876546' } }),
    });
    expect(taxCode.status).toBe(200);
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it.each([
    ['the journal', '/api/export/journal.xlsx?from=2026-09-01&to=2026-09-30', 'finance.journal.export'],
    ['MISA purchases', '/api/export/misa/purchases.xlsx?from=2026-09-01&to=2026-09-30', 'finance.journal.export'],
    ['MISA goods purchases', '/api/export/misa/goods-purchases.xlsx?from=2026-09-01&to=2026-09-30', 'finance.journal.export'],
    ['MISA sales', '/api/export/misa/sales.xlsx?from=2026-09-01&to=2026-09-30', 'finance.journal.export'],
    ['the VAT working', '/api/export/vat.xlsx?period=2026-09', 'finance.vat.export'],
    ['the VAT return as HTKK XML', '/api/export/vat-01gtgt.xml?period=2026-09', 'finance.vat.export'],
    ['the ledger reports', '/api/export/ledger.xlsx?period=2026-09', 'finance.ledger.export'],
    ['the financial statements', '/api/export/statements.xlsx?period=2026-09', 'finance.statements.export'],
    ['the financial statements as HTKK XML', '/api/export/statements-htkk.xml?year=2026', 'finance.statements.export'],
    ['the register of fixed assets', '/api/export/fixed-assets.xlsx', 'finance.fixed_asset.export'],
  ])('answers an error, not a file, for %s', async (_name, path, command) => {
    reached.length = 0;
    const response = await app.request(path, { headers: { authorization: `Bearer ${await token()}`, 'x-crove-org': slug } });
    expect(reached).toEqual([command]);
    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).not.toBe(XLSX);
    expect(response.headers.get('content-type') ?? '').not.toMatch(/^application\/xml/);
    expect(response.headers.get('content-disposition')).toBeNull();
    expect(await response.json()).toMatchObject({ code: 'INTERNAL' });
  });

  it('never records a failed export as done', async () => {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      const { rows } = await client.query<{ command: string; outcome: string }>(
        `SELECT command, outcome FROM crove_kernel.audit_event WHERE org_id = $1 AND command = ANY($2::text[])`,
        [orgId, EXPORT_COMMANDS],
      );
      expect(rows.filter((r) => r.outcome === 'ok')).toEqual([]);
    } finally {
      await client.end();
    }
  });
});
