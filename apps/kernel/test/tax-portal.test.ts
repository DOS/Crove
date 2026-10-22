// The tax portal client (#325) against a fake portal on a local port (e2e/fake-tax-portal): never the real portal. The
// CAPTCHA, the login and its refusal classes, every list query and page, the XML download, and the failures the
// client must stop at (rate limit, block page, outage, oversized or malformed answers), without the portal's words,
// the password or the token in any error.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EgressOptions, EgressResponse, GuardedRequest } from '@crove/kernel-runtime';
import { FAKE_CAPTCHA_ANSWER, FAKE_PORTAL_PASSWORD, startFakeTaxPortal, type FakePortal } from '../../../e2e/fake-tax-portal/server.ts';
import { TAX_PORTAL_DEFAULT_URL, TaxPortalError, createTaxPortalClient, isOfficialPortal, monthRanges, parsePortalJson, portalBase, testPortalAllowed } from '../src/tax-portal.ts';

const BUYER = '0309876546';
const noWait = async () => {};

async function kindOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    expect(error).toBeInstanceOf(TaxPortalError);
    const message = (error as Error).message;
    expect(message).not.toContain(FAKE_PORTAL_PASSWORD);
    expect(message).not.toContain('captcha không đúng');
    return (error as TaxPortalError).kind;
  }
}

describe('tax portal client', () => {
  let portal: FakePortal;
  beforeAll(async () => {
    portal = await startFakeTaxPortal();
  });
  afterAll(async () => {
    await portal.close();
  });

  const client = () => createTaxPortalClient({ baseUrl: portal.url, gapMs: 0, sleep: noWait });

  it('logs in with what the person typed and reads every query of the period', async () => {
    const c = client();
    const captcha = await c.captcha();
    expect(captcha.svg).toMatch(/^<svg/);
    const token = await c.login(BUYER, FAKE_PORTAL_PASSWORD, { key: captcha.key, answer: FAKE_CAPTCHA_ANSWER });
    expect(token).toMatch(/^fake\./);
    const answers = await c.purchaseInvoices(token, '2026-09-01', '2026-09-30');
    expect(answers.map((a) => [a.query, a.rows.length])).toEqual([
      ['purchase_5', 3],
      ['purchase_6', 1],
      ['purchase_8', 0],
      ['sco', 1],
    ]);
    // Numbers stay the text the portal sent.
    expect((answers[0]?.rows[0] as { tgtttbso: unknown } | undefined)?.tgtttbso).toBe('1980000');
    const xml = await c.invoiceXml(token, { sellerTaxCode: '0101234564', template: '1', series: 'C26TAB', number: '9101' });
    expect(Buffer.from(xml.subarray(0, 4)).toString('latin1')).toBe('PK\u0003\u0004');
    // An invoice without a tax authority code has no XML: the portal answers 500, which fails that invoice only.
    expect(await kindOf(c.invoiceXml(token, { sellerTaxCode: '0100109107', template: '1', series: 'K26TBB', number: '78' }))).toBe('BAD_ANSWER');
  });

  it('pages through a list and cuts a quarter into months', async () => {
    const c = createTaxPortalClient({ baseUrl: portal.url, gapMs: 0, sleep: noWait, pageSize: 2 });
    const captcha = await c.captcha();
    const token = await c.login(BUYER, FAKE_PORTAL_PASSWORD, { key: captcha.key, answer: FAKE_CAPTCHA_ANSWER });
    const before = portal.state.requests.length;
    const answers = await c.purchaseInvoices(token, '2026-07-01', '2026-09-30');
    expect(answers[0]?.rows).toHaveLength(9);
    // Per month: purchase_5 in two pages, the others in one.
    expect(portal.state.requests.length - before).toBe(3 * 5);
    expect(monthRanges('2026-07-01', '2026-09-30')).toEqual([
      { from: '2026-07-01', to: '2026-07-31' },
      { from: '2026-08-01', to: '2026-08-31' },
      { from: '2026-09-01', to: '2026-09-30' },
    ]);
  });

  it('tells a wrong CAPTCHA from a wrong password, and never retries a login', async () => {
    const c = client();
    const first = await c.captcha();
    const logins = portal.state.logins.length;
    expect(await kindOf(c.login(BUYER, FAKE_PORTAL_PASSWORD, { key: first.key, answer: 'WRONG' }))).toBe('WRONG_CAPTCHA');
    const second = await c.captcha();
    expect(await kindOf(c.login(BUYER, 'not-the-password', { key: second.key, answer: FAKE_CAPTCHA_ANSWER }))).toBe('WRONG_PASSWORD');
    expect(portal.state.logins.length - logins).toBe(2);
  });

  it('reads an expired session from an answer without one', async () => {
    expect(await kindOf(client().purchaseInvoices('fake.not-a-session-token-1234', '2026-09-01', '2026-09-30'))).toBe('SESSION_EXPIRED');
  });

  it('stops at a rate limit, a block page or an outage', async () => {
    for (const [outage, kind] of [
      [{ status: 429, body: '{}', contentType: 'application/json' }, 'RATE_LIMITED'],
      [{ status: 403, body: '<html>blocked</html>', contentType: 'text/html' }, 'BLOCKED'],
      [{ status: 200, body: '<!DOCTYPE html><html>Request Rejected</html>', contentType: 'text/html' }, 'BLOCKED'],
      [{ status: 503, body: 'down', contentType: 'text/plain' }, 'UNAVAILABLE'],
      [{ status: 200, body: '{"key":"k1","content":"<script>alert(1)</script>"}', contentType: 'application/json' }, 'BAD_ANSWER'],
    ] as const) {
      portal.options.outage = outage;
      expect(await kindOf(client().captcha()), outage.body).toBe(kind);
    }
    portal.options.outage = null;
  });

  it('refuses an oversized answer and an unreachable portal', async () => {
    portal.options.outage = { status: 200, body: JSON.stringify({ key: 'k1', content: `<svg>${'x'.repeat(300 * 1024)}</svg>` }), contentType: 'application/json' };
    expect(await kindOf(client().captcha())).toBe('TOO_LARGE');
    portal.options.outage = null;
    expect(await kindOf(createTaxPortalClient({ baseUrl: 'http://127.0.0.1:1/api', timeoutMs: 2000, sleep: noWait }).captcha())).toBe('UNAVAILABLE');
  });

  it('reaches the real portal over https only, on public addresses', () => {
    let seen: EgressOptions | null = null;
    const spy = (_url: string, _req: GuardedRequest, options: EgressOptions): Promise<EgressResponse> => {
      seen = options;
      return Promise.reject(new Error('stop'));
    };
    void createTaxPortalClient({ request: spy, sleep: noWait })
      .captcha()
      .catch(() => {});
    expect(seen).not.toBeNull();
    // No address override: the egress guard keeps the official origin on public addresses.
    expect((seen as unknown as EgressOptions).allowed).toBeUndefined();
    expect(new URL(TAX_PORTAL_DEFAULT_URL).host).toBe('hoadondientu.gdt.gov.vn');
    expect(new URL(TAX_PORTAL_DEFAULT_URL).protocol).toBe('https:');
  });

  it('tells the real portal by its exact host, and keeps look-alikes and other addresses to local test deployments', () => {
    expect(isOfficialPortal(new URL('https://hoadondientu.gdt.gov.vn/api'))).toBe(true);
    expect(isOfficialPortal(new URL('https://HOADONDIENTU.gdt.gov.vn:30000/api'))).toBe(true);
    expect(isOfficialPortal(new URL('https://hoadondientu.gdt.gov.vn.evil.test/api'))).toBe(false);
    expect(isOfficialPortal(new URL('https://evil.test/hoadondientu.gdt.gov.vn/api'))).toBe(false);
    expect(isOfficialPortal(new URL('https://hoadondientu.gdt.gov.vn@evil.test/api'))).toBe(false);
    // Credentials, a query or a fragment in the configured URL are refused outright.
    expect(() => portalBase('https://hoadondientu.gdt.gov.vn@evil.test/api')).toThrow(/credentials/);
    expect(() => portalBase('https://user:pass@hoadondientu.gdt.gov.vn/api')).toThrow(/credentials/);
    expect(() => portalBase('https://hoadondientu.gdt.gov.vn/api?next=https://evil.test')).toThrow();
    expect(() => portalBase('ftp://hoadondientu.gdt.gov.vn/api')).toThrow();
    // The real portal over plain http is refused; a look-alike is a test portal, never trusted as the real one.
    expect(() => createTaxPortalClient({ baseUrl: 'http://hoadondientu.gdt.gov.vn/api' })).toThrow(/https/);
    // A test portal only on a deployment served locally.
    expect(testPortalAllowed('https://hoadondientu.gdt.gov.vn/api', 'https://crove.example.vn')).toBe(true);
    expect(testPortalAllowed('http://tax-portal:30000/api', 'http://localhost:8080')).toBe(true);
    expect(testPortalAllowed('http://tax-portal:30000/api', 'https://crove.example.vn')).toBe(false);
    expect(testPortalAllowed('https://hoadondientu.gdt.gov.vn.evil.test/api', 'https://crove.example.vn')).toBe(false);
    expect(testPortalAllowed('https://hoadondientu.gdt.gov.vn.evil.test/api', 'https://localhost.evil.example')).toBe(false);
  });

  it('counts a refusal that names the password as a wrong password, even when it asks for a new CAPTCHA', async () => {
    const answer = (body: string) => async (): Promise<EgressResponse> => ({ url: 'x', status: 400, contentType: 'application/json', body: Buffer.from(body), truncated: false });
    const login = (body: string) => createTaxPortalClient({ baseUrl: portal.url, request: answer(body), sleep: noWait }).login(BUYER, 'x', { key: 'k', answer: 'a' });
    expect(await kindOf(login('{"message":"Tên đăng nhập hoặc mật khẩu không đúng, vui lòng nhập lại mã captcha"}'))).toBe('WRONG_PASSWORD');
    expect(await kindOf(login('{"message":"Mã captcha không đúng."}'))).toBe('WRONG_CAPTCHA');
    expect(await kindOf(login('{"message":"Tài khoản đã bị khóa"}'))).toBe('ACCOUNT_LOCKED');
    expect(await kindOf(login('{"message":"Lỗi"}'))).toBe('WRONG_PASSWORD');
  });

  it('stops a step at its deadline or when the caller goes away, before the next request', async () => {
    const c = client();
    const captcha = await c.captcha();
    const token = await c.login(BUYER, FAKE_PORTAL_PASSWORD, { key: captcha.key, answer: FAKE_CAPTCHA_ANSWER });
    const before = portal.state.requests.length;
    expect(await kindOf(c.purchaseInvoices(token, '2026-09-01', '2026-09-30', { deadline: Date.now() - 1 }))).toBe('TOO_SLOW');
    const gone = new AbortController();
    gone.abort();
    expect(await kindOf(c.invoiceXml(token, { sellerTaxCode: '0101234564', template: '1', series: 'C26TAB', number: '9101' }, { deadline: Date.now() + 60_000, signal: gone.signal }))).toBe('TOO_SLOW');
    expect(portal.state.requests.length).toBe(before);
    // A request in flight gets only the time the step has left.
    let given = 0;
    const spy = (_url: string, _req: GuardedRequest, options: EgressOptions): Promise<EgressResponse> => {
      given = options.timeoutMs;
      return Promise.reject(new Error('stop'));
    };
    await kindOf(createTaxPortalClient({ baseUrl: portal.url, request: spy, sleep: noWait }).purchaseInvoices(token, '2026-09-01', '2026-09-30', { deadline: Date.now() + 3000 }));
    expect(given).toBeGreaterThan(0);
    expect(given).toBeLessThanOrEqual(3000);
  });

  it('parses JSON with numbers as text and refuses what is not JSON', () => {
    expect(parsePortalJson(Buffer.from('{"a":12345678901234567890.25}'))).toEqual({ a: '12345678901234567890.25' });
    expect(() => parsePortalJson(Buffer.from('<html>'))).toThrow(TaxPortalError);
  });
});
