// Sharing a page or a selection into a new Social draft (#1235): the share target's query becomes the fragment before
// the app starts, the fragment gives the composer its link and text, a share waits in this tab while the person signs
// in, and the bookmarklet opens the share page with the page's address, title and selection and nothing else.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PENDING_SHARE_TTL_MS,
  SHARE_PATH,
  SHARE_TEXT_MAX,
  bookmarklet,
  forgetShare,
  fromShareParams,
  moveShareQueryToFragment,
  pendingShare,
  readShareFragment,
  readShareOrg,
  rememberShare,
  shareFragment,
} from '../src/lib/social-share.ts';

const app = join(import.meta.dirname, '..');

describe('a share target query', () => {
  it('keeps the url as the link and the title and text as the text', () => {
    expect(fromShareParams({ title: 'Giá cà phê tăng', text: 'Đoạn đáng chú ý', url: 'https://bao.example/ca-phe' })).toEqual({ link: 'https://bao.example/ca-phe', text: 'Giá cà phê tăng\n\nĐoạn đáng chú ý' });
  });

  it('takes the link out of the text when the url is empty, as Android apps send it', () => {
    expect(fromShareParams({ title: '', text: 'Xem bài này https://bao.example/a?b=1.', url: '' })).toEqual({ link: 'https://bao.example/a?b=1', text: 'Xem bài này' });
    expect(fromShareParams({ text: 'https://bao.example/only' })).toEqual({ link: 'https://bao.example/only', text: '' });
  });

  it('says a title once when the text repeats it', () => {
    expect(fromShareParams({ title: 'Tiêu đề', text: 'Tiêu đề', url: 'https://a.example/' })?.text).toBe('Tiêu đề');
  });

  it('drops a link with a user name or password, or one that is not http(s)', () => {
    expect(fromShareParams({ url: 'https://user:secret@a.example/', text: 'x' })).toEqual({ link: null, text: 'x' });
    expect(fromShareParams({ url: 'javascript:alert(1)', text: '' })).toBeNull();
    expect(fromShareParams({ url: 'ftp://a.example/file' })).toBeNull();
  });

  it('is nothing when it carries nothing', () => {
    expect(fromShareParams({})).toBeNull();
    expect(fromShareParams({ title: '  ', text: '\n', url: '' })).toBeNull();
  });

  it('caps the text, never inside a surrogate pair', () => {
    const long = `${'a'.repeat(SHARE_TEXT_MAX - 1)}😀tail`;
    const text = fromShareParams({ text: long })?.text ?? '';
    expect(text).toBe('a'.repeat(SHARE_TEXT_MAX - 1));
  });
});

describe('the boot step', () => {
  const win = (pathname: string, search: string) => {
    const replaceState = vi.fn();
    return { w: { location: { pathname, search }, history: { state: { key: 'k' }, replaceState } }, replaceState };
  };

  it('moves the share target query into the fragment, in place', () => {
    const { w, replaceState } = win(SHARE_PATH, `?title=${encodeURIComponent('Tiêu đề')}&text=&url=${encodeURIComponent('https://a.example/x')}`);
    moveShareQueryToFragment(w);
    expect(replaceState).toHaveBeenCalledOnce();
    const [state, , url] = replaceState.mock.calls[0] as [unknown, string, string];
    expect(state).toEqual({ key: 'k' });
    expect(url.startsWith(`${SHARE_PATH}#`)).toBe(true);
    expect(url).not.toContain('?');
    expect(readShareFragment(new URL(url, 'https://app.example').hash)).toEqual({ link: 'https://a.example/x', text: 'Tiêu đề' });
  });

  it('drops a query that carries nothing, and leaves every other page alone', () => {
    const empty = win(SHARE_PATH, '?title=&text=&url=');
    moveShareQueryToFragment(empty.w);
    expect(empty.replaceState).toHaveBeenCalledWith({ key: 'k' }, '', SHARE_PATH);
    const other = win('/o/acme/social/new', '?title=x');
    moveShareQueryToFragment(other.w);
    expect(other.replaceState).not.toHaveBeenCalled();
    const bare = win(SHARE_PATH, '');
    moveShareQueryToFragment(bare.w);
    expect(bare.replaceState).not.toHaveBeenCalled();
  });

  it('runs before the rest of the app: main.tsx imports it first', () => {
    const main = readFileSync(join(app, 'src', 'main.tsx'), 'utf8');
    expect(main.split('\n')[0]?.trim()).toBe("import './share-boot.ts';");
  });
});

describe('the composer fragment', () => {
  it('round-trips a link and a text, whatever they hold', () => {
    const shared = { link: 'https://a.example/p?q=1&r=2#frag', text: 'Dòng 1 & dòng 2\n\n100% =+ #tag' };
    expect(readShareFragment(`#${shareFragment(shared)}`)).toEqual(shared);
    expect(readShareFragment(shareFragment({ link: null, text: 'chỉ chữ' }))).toEqual({ link: null, text: 'chỉ chữ' });
  });

  it('ignores a fragment that is not a share, and drops a bad link', () => {
    expect(readShareFragment('')).toBeNull();
    expect(readShareFragment('#')).toBeNull();
    expect(readShareFragment('#access_token=abc')).toBeNull();
    expect(readShareFragment('#link=javascript%3Aalert(1)&text=hi')).toEqual({ link: null, text: 'hi' });
    expect(readShareFragment('#link=%E0%A4%A')).toBeNull();
  });

  it('reads the org a bookmarklet names, when it reads as a slug', () => {
    expect(readShareOrg('#org=cong-ty-a&link=x')).toBe('cong-ty-a');
    expect(readShareOrg('#org=..%2Fadmin')).toBeNull();
    expect(readShareOrg('#link=x')).toBeNull();
  });
});

class MemoryStorage {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, String(value));
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
}

describe('a share waiting for sign-in', () => {
  let storage: MemoryStorage;
  beforeEach(() => {
    storage = new MemoryStorage();
    vi.stubGlobal('sessionStorage', storage);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('is kept in this tab for an hour at most, then removed', () => {
    const now = 1_800_000_000_000;
    rememberShare({ link: 'https://a.example/', text: 'x', org: 'acme' }, now);
    expect(pendingShare(now)).toEqual({ link: 'https://a.example/', text: 'x', org: 'acme' });
    expect(pendingShare(now + PENDING_SHARE_TTL_MS - 1)).not.toBeNull();
    expect(pendingShare(now + PENDING_SHARE_TTL_MS)).toBeNull();
    expect(storage.items.size).toBe(0);
  });

  it('drops an entry saved in the future, a malformed one, and a bad link or org', () => {
    const now = 1_800_000_000_000;
    rememberShare({ link: 'https://a.example/', text: 'x', org: null }, now + 1);
    expect(pendingShare(now)).toBeNull();
    storage.setItem('crove-pending-share', '{not json');
    expect(pendingShare(now)).toBeNull();
    storage.setItem('crove-pending-share', JSON.stringify({ link: 'javascript:x', text: 'y', org: '../x', savedAt: now }));
    expect(pendingShare(now)).toEqual({ link: null, text: 'y', org: null });
    forgetShare();
    expect(storage.items.size).toBe(0);
  });
});

// The bookmarklet's scheme, and its code once a browser percent-decodes the address.
const SCHEME = /^javascript:/;
const sourceOf = (code: string) => decodeURIComponent(code.replace(SCHEME, ''));

describe('the bookmarklet', () => {
  // Runs the bookmarklet as a browser would: the javascript: address percent-decoded, on a page with this address,
  // title and selection. Returns what it asked window.open for.
  function run(code: string, page: { href: string; title: string; selection: string }): { url: string; target: string; features: string } {
    expect(code).toMatch(SCHEME);
    const source = sourceOf(code);
    const open = vi.fn();
    const fakeWindow = { getSelection: () => ({ toString: () => page.selection }), open };
    new Function('window', 'document', 'location', source)(fakeWindow, { title: page.title }, { href: page.href });
    expect(open).toHaveBeenCalledOnce();
    const [url, target, features] = open.mock.calls[0] as [string, string, string];
    return { url, target, features };
  }

  it('opens the share page of the org with the page address, title and selection in the fragment', () => {
    const code = bookmarklet('https://app.example/o/acme/social/channels', 'acme');
    const page = { href: 'https://bao.example/bai-viet?id=7#doan-2', title: 'Giá cà phê 100% tăng', selection: '  Đoạn trích có # và % và &  ' };
    const opened = run(code, page);
    const url = new URL(opened.url);
    expect(url.origin).toBe('https://app.example');
    expect(url.pathname).toBe(SHARE_PATH);
    expect(url.search).toBe('');
    expect(readShareOrg(url.hash)).toBe('acme');
    expect(readShareFragment(url.hash)).toEqual({ link: page.href, text: 'Giá cà phê 100% tăng\n\nĐoạn trích có # và % và &' });
    expect(opened.target).toBe('_blank');
    expect(opened.features).toBe('noopener');
  });

  it('works with no selection and with no title', () => {
    const code = bookmarklet('https://app.example', 'acme');
    expect(readShareFragment(new URL(run(code, { href: 'https://a.example/', title: 'Chỉ tiêu đề', selection: '' }).url).hash)).toEqual({ link: 'https://a.example/', text: 'Chỉ tiêu đề' });
    expect(readShareFragment(new URL(run(code, { href: 'https://a.example/', title: '', selection: 'Chỉ đoạn chọn' }).url).hash)).toEqual({ link: 'https://a.example/', text: 'Chỉ đoạn chọn' });
  });

  it('caps a long selection without breaking on half of a surrogate pair', () => {
    const code = bookmarklet('https://app.example', 'acme');
    const selection = `${'a'.repeat(SHARE_TEXT_MAX - 1)}😀`;
    const text = readShareFragment(new URL(run(code, { href: 'https://a.example/', title: '', selection }).url).hash)?.text;
    expect(text).toBe('a'.repeat(SHARE_TEXT_MAX - 1));
  });

  it('carries no token, session or anything of the app but its address and the org', () => {
    const code = sourceOf(bookmarklet('https://app.example/some/page?x=1', 'acme'));
    expect(code).not.toMatch(/token|session|cookie|localStorage|sessionStorage|fetch|XMLHttpRequest/i);
    expect(code).toContain('"https://app.example/-/share#org=acme&"');
    expect(code).not.toContain('x=1');
  });

  it('escapes what a javascript: address would decode or cut', () => {
    const code = bookmarklet('https://app.example', 'acme');
    expect(code.replace(SCHEME, '')).not.toMatch(/#|%(?!25|23)/);
  });
});

describe('the web app manifest', () => {
  const manifest = JSON.parse(readFileSync(join(app, 'public', 'assets', 'manifest.webmanifest'), 'utf8')) as {
    start_url: string;
    scope: string;
    display: string;
    icons: Array<{ src: string }>;
    share_target: { action: string; method: string; params: Record<string, string> };
  };

  it('has a GET share target on the share page with title, text and url', () => {
    expect(manifest.share_target).toEqual({ action: SHARE_PATH, method: 'GET', params: { title: 'title', text: 'text', url: 'url' } });
    expect(manifest.start_url).toBe('/');
    expect(manifest.scope).toBe('/');
    expect(manifest.display).toBe('standalone');
  });

  it('uses icons the app ships, and is linked from index.html under /assets, which the kernel serves', () => {
    for (const icon of manifest.icons) expect(existsSync(join(app, 'public', icon.src))).toBe(true);
    expect(readFileSync(join(app, 'index.html'), 'utf8')).toContain('<link rel="manifest" href="/assets/manifest.webmanifest" />');
  });
});
