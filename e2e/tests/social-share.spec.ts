// Sharing a page or a selection into a new Social draft (#1235): the installed app's share target and the bookmarklet
// both open the composer with the page's link and text filled in, the shared values leave the address bar, and no
// request after the share target's first GET carries them. Its own user, created confirmed without the sign-up form.
import { expect, test, type Page, type Request } from '@playwright/test';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

const TITLE = 'Giá cà phê tăng mạnh đầu vụ';
const TEXT = 'Đoạn đáng chú ý: tăng 2.000 đồng/kg & còn tăng';
const URL_SHARED = 'https://news.example/ca-phe?id=7';

// Text as HTML: every &, < and > escaped.
const html = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
// The bookmarklet's scheme.
const SCHEME = /^javascript:/;

// Every request the page makes from now on, with its Referer.
function recordRequests(page: Page): Array<{ url: string; referer: string }> {
  const seen: Array<{ url: string; referer: string }> = [];
  page.on('request', (r: Request) => seen.push({ url: r.url(), referer: r.headers()['referer'] ?? '' }));
  return seen;
}

test('a page shared to the installed app lands in a new draft, and the shared values leave the address', async ({ page }) => {
  await signInNewUser(page, newEmail('social-share'));
  const slug = await createOrg(page, 'Công ty Chia Sẻ');

  // The web app manifest offers a GET share target on /-/share.
  const manifest = await page.request.get('/assets/manifest.webmanifest');
  expect(manifest.ok()).toBe(true);
  expect(((await manifest.json()) as { share_target: unknown }).share_target).toEqual({ action: '/-/share', method: 'GET', params: { title: 'title', text: 'text', url: 'url' } });

  const requests = recordRequests(page);
  const query = new URLSearchParams({ title: TITLE, text: TEXT, url: URL_SHARED }).toString();
  await page.goto(`/-/share?${query}`);
  await expect(page).toHaveURL(new RegExp(`/o/${slug}/social/new$`));
  await expect(page.getByLabel('Nội dung chung')).toHaveValue(`${TITLE}\n\n${TEXT}`);
  await expect(page.getByLabel('Liên kết', { exact: true })).toHaveValue(URL_SHARED);
  await expect(page.getByText('Đã điền sẵn liên kết và nội dung bạn chia sẻ.')).toBeVisible();
  // The fragment is cleared, and the share target's query is in no history entry.
  expect(await page.evaluate(() => ({ search: location.search, hash: location.hash }))).toEqual({ search: '', hash: '' });

  // Only the share target's own GET carried the query; no later request, by its address or Referer, did.
  const carrying = requests.filter((r) => r.url.includes('news.example') || r.url.includes('title=') || r.referer.includes('news.example') || r.referer.includes('title='));
  expect(carrying.map((r) => new URL(r.url).pathname)).toEqual(['/-/share']);

  // The router's later navigations do not bring the fragment back: away to the channels page (past the composer's
  // question about the unsaved draft), back to the composer, then back to where the person was.
  page.on('dialog', (dialog) => void dialog.accept());
  await page.getByRole('main').getByRole('link', { name: 'Kết nối kênh', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/o/${slug}/social/channels$`));
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/o/${slug}/social/new$`));
  expect(await page.evaluate(() => location.hash)).toBe('');
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/o/${slug}/inbox$`));
});

test('the bookmarklet from the Social settings opens a draft with the page link, title and selection', async ({ page, context }) => {
  await signInNewUser(page, newEmail('social-bookmarklet'));
  const slug = await createOrg(page, 'Công ty Dấu Trang');
  await page.goto(`/o/${slug}/social/channels`);
  const code = await page.getByLabel('Mã nút chia sẻ').inputValue();
  expect(code).toMatch(SCHEME);
  expect(code).not.toMatch(/token|session/i);

  // A third-party page, served by the test: the bookmarklet runs there as a browser runs a javascript: bookmark.
  await page.route('https://news.example/**', (route) =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><head><title>${html(TITLE)}</title></head><body><p id="quote">${html(TEXT)}</p></body></html>` }),
  );
  await page.goto(URL_SHARED);
  await page.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.getElementById('quote') as HTMLElement);
    window.getSelection()?.addRange(range);
  });
  const popup = context.waitForEvent('page');
  await page.evaluate((source) => new Function(source)(), decodeURIComponent(code.replace(SCHEME, '')));
  const draft = await popup;
  await expect(draft).toHaveURL(new RegExp(`/o/${slug}/social/new$`));
  await expect(draft.getByLabel('Nội dung chung')).toHaveValue(`${TITLE}\n\n${TEXT}`);
  await expect(draft.getByLabel('Liên kết', { exact: true })).toHaveValue(URL_SHARED);
  expect(await draft.evaluate(() => ({ hash: location.hash, opener: window.opener === null }))).toEqual({ hash: '', opener: true });
});

test.describe('at phone width', () => {
  test.use({ viewport: { width: 360, height: 780 } });

  test('the share card and a shared draft fit 360px with no horizontal scroll', async ({ page }) => {
    await signInNewUser(page, newEmail('social-share-narrow'));
    const slug = await createOrg(page, 'Công ty Màn hình hẹp Chia Sẻ');
    await page.goto(`/o/${slug}/social/channels`);
    await expect(page.getByText('Chia sẻ trang vào bài nháp')).toBeVisible();
    const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
    expect(await fits()).toBe(true);
    await page.goto(`/-/share?${new URLSearchParams({ text: `${TEXT} ${URL_SHARED}` }).toString()}`);
    await expect(page.getByLabel('Liên kết', { exact: true })).toHaveValue(URL_SHARED);
    await expect(page.getByLabel('Nội dung chung')).toHaveValue(TEXT);
    expect(await fits()).toBe(true);
  });
});
