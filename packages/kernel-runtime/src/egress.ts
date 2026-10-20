// The egress guard for URLs a tenant supplies (plan §7.7, first used by Social link previews, #641). A request goes
// only to a public address over HTTP or HTTPS on the default ports: the host is resolved first, every address it
// resolves to must be public (private, loopback, link-local, metadata, carrier-grade NAT, multicast, documentation and
// IPv6 translation ranges are refused), and the connection is pinned to the checked address, so a second DNS answer
// cannot point it elsewhere. Redirects are followed by hand, each checked the same way. One deadline covers the whole
// fetch, and the body is cut or refused at a byte limit. No cookies, credentials or compression.
import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';

// Two lists: BlockList also matches an IPv4 address against an IPv6 rule through its mapped form, so one list with the
// IPv4-mapped range would refuse every IPv4 address.
const BLOCKED_V4 = new BlockList();
const BLOCKED_V6 = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.31.196.0', 24],
  ['192.52.193.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['192.175.48.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  BLOCKED_V4.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  // Unspecified, loopback and the IPv4-compatible range.
  ['::', 96],
  // IPv4-mapped: an IPv4 address in IPv6 form is refused rather than checked twice.
  ['::ffff:0:0', 96],
  // NAT64 and local-use translation.
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  // IETF protocol assignments (Teredo among them), documentation, 6to4.
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
  // Unique local, link-local, site-local, multicast.
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  BLOCKED_V6.addSubnet(net, prefix, 'ipv6');
}

// A literal address a request may go to.
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !BLOCKED_V4.check(address, 'ipv4');
  if (family === 6) return !BLOCKED_V6.check(address, 'ipv6');
  return false;
}

export const EGRESS_ERROR_CODES = ['invalid_url', 'blocked', 'dns', 'timeout', 'too_large', 'redirects', 'encoding', 'network'] as const;
export type EgressErrorCode = (typeof EGRESS_ERROR_CODES)[number];

export class EgressError extends Error {
  readonly code: EgressErrorCode;
  constructor(code: EgressErrorCode, message: string) {
    super(message);
    this.name = 'EgressError';
    this.code = code;
  }
}

export interface EgressOptions {
  // For the whole fetch, redirects included.
  timeoutMs: number;
  maxBytes: number;
  // 'truncate': keep the first maxBytes and stop reading (enough for a page's head); 'fail': refuse the response.
  overLimit: 'truncate' | 'fail';
  maxRedirects?: number;
  accept?: string;
  userAgent?: string;
  // Tests only: the resolver, the address check, and any port (a local test server).
  resolve?: (host: string) => Promise<{ address: string; family: number }[]>;
  allowed?: (address: string) => boolean;
  anyPort?: boolean;
}

export interface EgressResponse {
  // The URL that answered, after redirects.
  url: string;
  status: number;
  contentType: string | null;
  body: Buffer;
  truncated: boolean;
}

const DEFAULT_PORTS: Record<string, string> = { 'http:': '80', 'https:': '443' };

// An absolute http(s) URL with no credentials, on the scheme's default port.
export function egressTarget(raw: string, anyPort = false): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new EgressError('invalid_url', 'not a URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new EgressError('invalid_url', 'only http and https');
  if (url.username || url.password) throw new EgressError('invalid_url', 'credentials in the URL');
  if (url.port && url.port !== DEFAULT_PORTS[url.protocol] && !anyPort) throw new EgressError('invalid_url', 'only the default port');
  if (!url.hostname) throw new EgressError('invalid_url', 'no host');
  return url;
}

function remaining(deadline: number): number {
  const left = deadline - Date.now();
  if (left <= 0) throw new EgressError('timeout', 'took too long');
  return left;
}

async function addressFor(url: URL, options: EgressOptions, deadline: number): Promise<{ address: string; family: number }> {
  const allowed = options.allowed ?? isPublicAddress;
  const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  const family = isIP(host);
  if (family !== 0) {
    if (!allowed(host)) throw new EgressError('blocked', 'not a public address');
    return { address: host, family };
  }
  const resolve = options.resolve ?? ((h: string) => lookup(h, { all: true, verbatim: true }));
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new EgressError('timeout', 'took too long')), remaining(deadline));
  });
  let answers: { address: string; family: number }[];
  try {
    answers = await Promise.race([resolve(host), timeout]);
  } catch (error) {
    if (error instanceof EgressError) throw error;
    throw new EgressError('dns', 'the host does not resolve');
  } finally {
    clearTimeout(timer);
  }
  if (answers.length === 0) throw new EgressError('dns', 'the host does not resolve');
  // Every answer, not only the first: a host that also points inside is refused.
  if (answers.some((a) => !allowed(a.address))) throw new EgressError('blocked', 'not a public address');
  return answers[0] as { address: string; family: number };
}

type Hop = { redirect: string } | { response: EgressResponse };

function once(url: URL, target: { address: string; family: number }, options: EgressOptions, deadline: number): Promise<Hop> {
  const client = url.protocol === 'https:' ? https : http;
  const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  // Before the request exists: a deadline already past throws here, with nothing to clean up.
  const ms = remaining(deadline);
  return new Promise<Hop>((resolve, reject) => {
    let settled = false;
    // Every way out (an answer, a redirect, a refusal, the deadline) closes the socket: a server that keeps a
    // connection open after a redirect, or after the byte limit, holds nothing of ours.
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      fn();
    };
    const req = client.request(
      {
        protocol: url.protocol,
        hostname: host,
        port: url.port || DEFAULT_PORTS[url.protocol],
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        agent: false,
        // The checked address, whatever the resolver would say now; the TLS name stays the host's.
        lookup: (_name, opts, cb) => {
          if ((opts as { all?: boolean }).all) (cb as (e: null, a: { address: string; family: number }[]) => void)(null, [target]);
          else (cb as (e: null, a: string, f: number) => void)(null, target.address, target.family);
        },
        ...(isIP(host) === 0 ? { servername: host } : {}),
        headers: {
          accept: options.accept ?? '*/*',
          'accept-encoding': 'identity',
          'user-agent': options.userAgent ?? 'Crove/1.0 (+https://github.com/DOS/Crove)',
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location) {
          finish(() => resolve({ redirect: location }));
          return;
        }
        const encoding = res.headers['content-encoding'];
        if (encoding && encoding !== 'identity') {
          res.destroy();
          finish(() => reject(new EgressError('encoding', 'the response is compressed')));
          return;
        }
        const declared = Number(res.headers['content-length']);
        if (options.overLimit === 'fail' && Number.isFinite(declared) && declared > options.maxBytes) {
          res.destroy();
          finish(() => reject(new EgressError('too_large', 'the response is too large')));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        const done = (truncated: boolean) =>
          finish(() =>
            resolve({ response: { url: url.toString(), status, contentType: typeof res.headers['content-type'] === 'string' ? res.headers['content-type'] : null, body: Buffer.concat(chunks), truncated } }),
          );
        res.on('data', (chunk: Buffer) => {
          if (settled) return;
          const room = options.maxBytes - size;
          if (chunk.length > room) {
            if (options.overLimit === 'fail') {
              res.destroy();
              finish(() => reject(new EgressError('too_large', 'the response is too large')));
              return;
            }
            chunks.push(chunk.subarray(0, room));
            size += room;
            res.destroy();
            done(true);
            return;
          }
          chunks.push(chunk);
          size += chunk.length;
        });
        res.on('end', () => done(false));
        res.on('error', () => finish(() => reject(new EgressError('network', 'the connection failed'))));
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      finish(() => reject(new EgressError('timeout', 'took too long')));
    }, ms);
    req.on('error', () => finish(() => reject(new EgressError('network', 'the connection failed'))));
    req.end();
  });
}

// GET a tenant-supplied URL through the guard.
export async function guardedFetch(raw: string, options: EgressOptions): Promise<EgressResponse> {
  const deadline = Date.now() + options.timeoutMs;
  const maxRedirects = options.maxRedirects ?? 3;
  let url = egressTarget(raw, options.anyPort);
  for (let hop = 0; ; hop++) {
    const target = await addressFor(url, options, deadline);
    const result = await once(url, target, options, deadline);
    if ('response' in result) return result.response;
    if (hop >= maxRedirects) throw new EgressError('redirects', 'too many redirects');
    let next: string;
    try {
      next = new URL(result.redirect, url).toString();
    } catch {
      throw new EgressError('invalid_url', 'a redirect to something that is not a URL');
    }
    url = egressTarget(next, options.anyPort);
  }
}
