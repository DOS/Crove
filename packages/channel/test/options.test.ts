// A channel's options as a list keeps them (#1120, #1131): at most 500 items, and within the byte cap of the CHECK on
// crove_social.channel_option.items, so a list of long Vietnamese names is cut short instead of refused when recorded.
import { describe, expect, it } from 'vitest';
import { CHANNEL_OPTIONS_BYTES_MAX, CHANNEL_OPTIONS_MAX, OptionList, PinterestPublisher, WordPressPublisher, YouTubePublisher, capOptions, optionBytes, type ChannelOption, type Fetch } from '../src/index.ts';

// The size PostgreSQL prints a jsonb array of these in: {"id": "1", "name": "x"}, items joined by ", ".
const printed = (options: readonly ChannelOption[]) =>
  Buffer.byteLength(`[${options.map((o) => `{${Object.entries(o).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(', ')}}`).join(', ')}]`, 'utf8');
// 500 options with 200-letter Vietnamese names (3 bytes each in UTF-8), far past the byte cap together.
const long = Array.from({ length: CHANNEL_OPTIONS_MAX }, (_, i) => ({ id: String(1000 + i), name: 'ệ'.repeat(200), taxonomy: 'category' as const }));

describe('channel option lists', () => {
  it('bounds each option at least at the size PostgreSQL prints it in', () => {
    for (const o of [{ id: '1', name: 'Tin tức' }, { id: 'PL0123456789abcdef', name: 'Khuyến mãi "tháng 10"' }, long[0] as ChannelOption]) {
      expect(optionBytes(o)).toBeGreaterThanOrEqual(printed([o]) - 2);
    }
    expect(printed(long)).toBeGreaterThan(CHANNEL_OPTIONS_BYTES_MAX);
  });

  it('stops a list before it would pass the byte cap, as it stops at 500 items', () => {
    const list = new OptionList();
    let added = 0;
    for (const o of long) {
      if (!list.add(o)) break;
      added += 1;
    }
    expect(added).toBeLessThan(CHANNEL_OPTIONS_MAX);
    expect(added).toBeGreaterThan(100);
    expect(list.isFull).toBe(true);
    expect(list.add({ id: '1', name: 'a' })).toBe(false);
    expect(printed(list.options)).toBeLessThanOrEqual(CHANNEL_OPTIONS_BYTES_MAX);
    expect(capOptions(long)).toEqual(list.options);
    // Short names: the 500 cap.
    const short = Array.from({ length: 600 }, (_, i) => ({ id: String(i), name: `S${i}` }));
    expect(capOptions(short)).toHaveLength(CHANNEL_OPTIONS_MAX);
  });
});

describe('channel option lists from the platforms (#1131)', () => {
  const GOOGLE = { clientId: '123456789012-abcdefgh12345678.apps.googleusercontent.com', clientSecret: 'test-google-secret-not-real' };
  const CHANNEL = 'UCabcdefghijklmnopqrstuv';
  const YT_SECRET = JSON.stringify({ accessToken: 'ya29.token-1', refreshToken: '1//refresh-1' });
  const WP_SECRET = JSON.stringify({ site: 'https://tiemcuaban.vn', username: 'chutiem', appPassword: 'testtesttesttesttesttest' });
  const PIN_SECRET = JSON.stringify({ accessToken: 'pina_access-1', refreshToken: 'pinr_refresh-1' });
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  // An answer that never comes: it waits until the request's signal aborts it.
  const slow: Fetch = (_input, init) =>
    new Promise((_, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });

  it('cuts a WordPress list of long names at the byte cap, asking no further page', async () => {
    const urls: string[] = [];
    const page = (n: number) => Array.from({ length: 100 }, (_, i) => ({ id: n * 100 + i + 1, name: `${'ệ'.repeat(195)} ${n * 100 + i}` }));
    const fetchImpl: Fetch = async (input) => {
      urls.push(input);
      return json(page(Number(new URL(input).searchParams.get('page')) - 1));
    };
    const answer = await new WordPressPublisher(fetchImpl).options({ externalAccountId: 'tiemcuaban.vn', secret: WP_SECRET, kind: 'wordpress_term' });
    const options = answer && 'options' in answer ? answer.options : [];
    expect(options.length).toBeGreaterThan(100);
    expect(options.length).toBeLessThan(300);
    expect(printed(options)).toBeLessThanOrEqual(CHANNEL_OPTIONS_BYTES_MAX);
    expect(urls.every((u) => u.includes('/wp/v2/categories'))).toBe(true);
    expect(urls).toHaveLength(Math.ceil(options.length / 100));
  });

  it('cuts a YouTube list of long titles at the byte cap', async () => {
    let n = 0;
    const fetchImpl: Fetch = async () => {
      const items = Array.from({ length: 50 }, () => ({ id: `PL${String((n += 1)).padStart(16, '0')}`, snippet: { title: 'ệ'.repeat(200) } }));
      return json({ items, nextPageToken: `p${n}` });
    };
    const answer = await new YouTubePublisher(GOOGLE, fetchImpl).options({ externalAccountId: CHANNEL, secret: YT_SECRET, kind: 'youtube_playlist' });
    const options = answer && 'options' in answer ? answer.options : [];
    expect(options.length).toBeGreaterThan(100);
    expect(options.length).toBeLessThan(CHANNEL_OPTIONS_MAX);
    expect(printed(options)).toBeLessThanOrEqual(CHANNEL_OPTIONS_BYTES_MAX);
  });

  it('answers no list once the deadline passes, for a slow answer, and asks no page after it', async () => {
    const deadline = () => AbortSignal.timeout(50);
    const started = Date.now();
    expect(await new YouTubePublisher(GOOGLE, slow).options({ externalAccountId: CHANNEL, secret: YT_SECRET, kind: 'youtube_playlist', signal: deadline() })).toBeNull();
    expect(await new PinterestPublisher({ appId: '1500001', appSecret: 'test-pinterest-secret-not-real' }, slow).options({ externalAccountId: '549755885175', secret: PIN_SECRET, kind: 'pinterest_section', signal: deadline() })).toBeNull();
    expect(await new WordPressPublisher(slow).options({ externalAccountId: 'tiemcuaban.vn', secret: WP_SECRET, kind: 'wordpress_term', signal: deadline() })).toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
    // A site whose first page comes just as the deadline passes: no second page is asked for.
    const passed = new AbortController();
    const urls: string[] = [];
    const lastMoment: Fetch = async (input) => {
      urls.push(input);
      passed.abort(new Error('deadline'));
      return json(Array.from({ length: 100 }, (_, i) => ({ id: i + 1, name: `Chuyên mục ${i}` })));
    };
    expect(await new WordPressPublisher(lastMoment).options({ externalAccountId: 'tiemcuaban.vn', secret: WP_SECRET, kind: 'wordpress_term', signal: passed.signal })).toBeNull();
    expect(urls).toHaveLength(1);
  });
});