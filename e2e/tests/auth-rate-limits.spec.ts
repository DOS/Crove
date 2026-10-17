// Supabase Auth's rate limits through the kernel's /auth/v1 proxy (issue #34). Supabase Auth keys its per-client
// limits on X-Real-IP (GOTRUE_RATE_LIMIT_HEADER), which the proxy sets from the client socket after dropping every
// client-supplied forwarding header. Sign-in, sign-up and recovery each allow a burst of 30 requests per client
// address; after that Supabase Auth answers 429 until the bucket refills (sign-in 150, sign-up and recovery 30 per
// 5 minutes). The limits count attempts, so wrong passwords and unknown addresses use them up too. In front of these,
// the proxy's own email budget (#190) allows 5 sign-ups and recoveries per client address an hour; compose.e2e.yml
// raises it so the test reaches Supabase Auth's limits (the proxy's budget has its own tests in apps/kernel).
// The limits live in Supabase Auth's memory and this runner is one client address for every spec, so the auth
// service is restarted before (a fresh bucket) and after (the other specs and the next run start from fresh limits).
import { type APIRequestContext, type APIResponse, type PlaywrightWorkerArgs, expect, test } from '@playwright/test';
import { compose } from '../lib/compose.ts';
import { PASSWORD, newEmail } from '../lib/session.ts';

const BURST = 30;
// Headers a client could send to pass as another address. None of them may reach a fresh bucket.
const SPOOFED = {
  'x-forwarded-for': '198.51.100.7',
  'x-real-ip': '198.51.100.7',
  'x-client-ip': '198.51.100.7',
  forwarded: 'for=198.51.100.7',
  'sb-forwarded-for': '198.51.100.7',
};

interface Endpoint {
  name: string;
  path: string;
  body: () => Record<string, string>;
  // The answer while the client is under the limit.
  status: number;
}

const ENDPOINTS: Endpoint[] = [
  {
    name: 'password sign-in',
    path: '/auth/v1/token?grant_type=password',
    body: () => ({ email: newEmail('rate-signin'), password: 'e2e-wrong-password' }),
    status: 400,
  },
  { name: 'sign-up', path: '/auth/v1/signup', body: () => ({ email: newEmail('rate-signup'), password: PASSWORD }), status: 200 },
  { name: 'password recovery', path: '/auth/v1/recover', body: () => ({ email: newEmail('rate-recover') }), status: 200 },
];

// Restarting Supabase Auth clears its in-memory limits; waits until it answers through the proxy again.
async function restartAuth(playwright: PlaywrightWorkerArgs['playwright'], baseURL = 'http://localhost:8080'): Promise<void> {
  compose(['restart', 'auth']);
  const api = await playwright.request.newContext({ baseURL });
  try {
    await expect.poll(async () => (await api.get('/auth/v1/health').catch(() => null))?.status(), { timeout: 60_000 }).toBe(200);
  } finally {
    await api.dispose();
  }
}

function post(request: APIRequestContext, endpoint: Endpoint, headers: Record<string, string> = {}): Promise<APIResponse> {
  return request.post(endpoint.path, { data: endpoint.body(), headers });
}

// The same request from another client address: Node inside the kernel container, which reaches the proxy over
// 127.0.0.1 instead of the address this runner comes from.
function statusFromAnotherClient(endpoint: Endpoint): number {
  const script =
    "fetch('http://127.0.0.1:8080' + process.argv[1], { method: 'POST', headers: { 'content-type': 'application/json' }, body: process.argv[2] })" +
    '.then((r) => console.log(r.status))';
  return Number(compose(['exec', '-T', 'crove', 'node', '-e', script, endpoint.path, JSON.stringify(endpoint.body())]).trim());
}

test.describe('Supabase Auth rate limits through /auth/v1', () => {
  test.beforeAll(async ({ playwright }, testInfo) => {
    await restartAuth(playwright, testInfo.project.use.baseURL);
  });

  test.afterAll(async ({ playwright }, testInfo) => {
    await restartAuth(playwright, testInfo.project.use.baseURL);
  });

  for (const endpoint of ENDPOINTS) {
    test(`${endpoint.name}: ${BURST} requests per client address, then 429 that spoofed headers do not lift`, async ({ request }) => {
      const statuses: number[] = [];
      let refused: APIResponse | undefined;
      // Room past the burst: the bucket refills slowly while the loop runs (sign-up: one request per 10 s).
      for (let i = 0; i < BURST + 10 && !refused; i += 1) {
        const response = await post(request, endpoint);
        statuses.push(response.status());
        if (response.status() === 429) refused = response;
      }
      expect(statuses.slice(0, BURST)).toEqual(Array<number>(BURST).fill(endpoint.status));
      expect(refused, `no 429 after ${statuses.length} requests: ${statuses.join(' ')}`).toBeDefined();
      expect(await refused?.json()).toMatchObject({ error_code: 'over_request_rate_limit' });

      // The proxy drops the client's forwarding headers, so they do not reach another bucket.
      expect((await post(request, endpoint, SPOOFED)).status()).toBe(429);
      // The limit is per client address, not one bucket for everyone.
      expect(statusFromAnotherClient(endpoint)).toBe(endpoint.status);
    });
  }
});
