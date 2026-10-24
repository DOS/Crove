// Browser push on the notification settings (#1238). The e2e stack has no VAPID keys, so the option is hidden there;
// the second test answers the push status as a deployment with keys would and stands in for the browser's push
// service (headless Chromium has none), so the real service worker registers under the real CSP through the crove-sw
// Trusted Types policy, the subscription reaches the API and turning it off removes it. The sending side (encryption,
// VAPID, the worker job) is covered by apps/kernel/test/web-push.test.ts and social-push.db.test.ts.
import { expect, test, type Page, type Route } from '@playwright/test';
import { collectCspViolations } from '../lib/csp.ts';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

// A P-256 public key (RFC 8291's example sender), as the deployment's VAPID key.
const PUBLIC_KEY = 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8';
const ENDPOINT = 'https://push.example/e2e-device';
// The browser's 16-byte auth secret, base64url.
const UA_SHARED = Buffer.from('e2e push secret!').toString('base64url');

const json = (route: Route, body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ json: body }) });
const input = (route: Route) => (route.request().postDataJSON() as { json: Record<string, unknown> }).json;

test('the push option is hidden on a deployment without VAPID keys', async ({ page }) => {
  await signInNewUser(page, newEmail('social-push-off'));
  const slug = await createOrg(page, 'Công ty Không Đẩy');
  await page.goto(`/o/${slug}/social/notifications`);
  await expect(page.getByText('Bản tin hằng tuần')).toBeVisible();
  await expect(page.getByText('Thông báo đẩy trên thiết bị này')).toHaveCount(0);
});

// The browser's push service and permission prompt, in the page: subscribe() and getSubscription() answer a fixed
// subscription, and notifications are allowed.
async function fakePushService(page: Page) {
  await page.addInitScript(
    ({ endpoint, shared }) => {
      // Kept across reloads of the tab, as a browser keeps its subscription.
      const KEY = 'e2e-fake-push';
      const make = () => ({
        endpoint,
        options: { applicationServerKey: null },
        toJSON: () => ({ endpoint, keys: { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: shared } }),
        unsubscribe: async () => (sessionStorage.removeItem(KEY), true),
      });
      // The permission prompt answered yes (the headless shell keeps notifications denied whatever is granted).
      Object.defineProperty(Notification, 'permission', { get: () => 'granted' });
      Notification.requestPermission = async () => 'granted';
      PushManager.prototype.subscribe = async function () {
        sessionStorage.setItem(KEY, '1');
        return make() as unknown as PushSubscription;
      };
      PushManager.prototype.getSubscription = async function () {
        return (sessionStorage.getItem(KEY) ? make() : null) as unknown as PushSubscription | null;
      };
    },
    { endpoint: ENDPOINT, shared: UA_SHARED },
  );
}

test('a member turns push on for this device and off again; the worker registers through the crove-sw policy', async ({ page, context }) => {
  const violations = await collectCspViolations(page);
  await signInNewUser(page, newEmail('social-push-on'));
  const slug = await createOrg(page, 'Công ty Đẩy');
  await context.grantPermissions(['notifications']);
  await fakePushService(page);
  // The API as with keys: the device list follows what the page subscribed and removed.
  let device: { label: string | null } | null = null;
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  await page.route('**/api/rpc/social/notifications/push/*', async (route) => {
    const name = new URL(route.request().url()).pathname.split('/').pop() ?? '';
    const body = input(route);
    calls.push({ name, input: body });
    if (name === 'status') {
      const current = device !== null && body.endpoint === ENDPOINT;
      return json(route, { enabled: true, publicKey: PUBLIC_KEY, subscribed: current, devices: device ? [{ id: '0193b3a0-1c2d-7e4f-8a9b-0c1d2e3f4a5b', label: device.label, createdAt: new Date().toISOString(), lastUsedAt: null, current }] : [] });
    }
    if (name === 'subscribe') {
      device = { label: typeof body.label === 'string' ? body.label : null };
      return json(route, { id: '0193b3a0-1c2d-7e4f-8a9b-0c1d2e3f4a5b' });
    }
    device = null;
    return json(route, { removed: 1 });
  });

  await page.goto(`/o/${slug}/social/notifications`);
  const toggle = page.getByRole('checkbox', { name: /Thông báo đẩy trên thiết bị này/ });
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  // Once saved, the device is listed as this one.
  await expect(page.getByText(/\(thiết bị này\)/)).toBeVisible();
  await expect(page.getByText('Các thiết bị đang nhận thông báo đẩy')).toBeVisible();
  await expect(toggle).toBeChecked();
  const subscribed = calls.find((c) => c.name === 'subscribe')?.input;
  expect(subscribed).toEqual({ endpoint: ENDPOINT, p256dh: expect.stringMatching(/^B[\w-]{86}$/), auth: UA_SHARED, label: expect.stringMatching(/ trên /) });

  // The real worker, registered under the CSP's one policy, controls no page.
  const registration = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration('/assets/');
    return { scope: reg?.scope ?? null, script: reg?.active?.scriptURL ?? null, controlled: navigator.serviceWorker.controller !== null };
  });
  expect(registration).toEqual({ scope: new URL('/assets/', page.url()).href, script: new URL('/assets/sw.js', page.url()).href, controlled: false });
  // The app made its policy: a second one of that name is refused (no duplicates), and so is any other name.
  expect(
    await page.evaluate(() => {
      const tt = (window as unknown as { trustedTypes: { createPolicy(name: string, rules: object): unknown } }).trustedTypes;
      return ['crove-sw', 'other'].map((name) => {
        try {
          tt.createPolicy(name, {});
          return 'created';
        } catch (error) {
          return (error as Error).name;
        }
      });
    }),
  ).toEqual(['TypeError', 'TypeError']);

  // On again after a reload: the browser's subscription is the listed device.
  await page.reload();
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(page.getByText('Các thiết bị đang nhận thông báo đẩy')).toHaveCount(0);
  await expect(toggle).not.toBeChecked();
  expect(calls.filter((c) => c.name === 'unsubscribe').map((c) => c.input)).toEqual([{ endpoint: ENDPOINT }]);
  // No violation but the two policies this test was refused on purpose.
  expect((await violations()).filter((v) => !v.startsWith('trusted-types'))).toEqual([]);
});
