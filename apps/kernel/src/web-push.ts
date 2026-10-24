// Web Push for Social notifications (#1238), with Node's own crypto and no library: the message is encrypted for the
// browser as RFC 8291 says (ECDH on P-256 with the browser's key, HKDF with its auth secret, one aes128gcm record of
// RFC 8188), and the request carries a VAPID token (RFC 8292: an ES256 JWT for the push service's origin, signed with
// the deployment's key). Posts go through the egress guard: the endpoint is a URL a member's browser gave, so only a
// public address over https on the default port, the connection pinned to the checked address, no redirect followed.
//
// The keys come from VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT. Without them the API offers no push and
// the worker sends nothing; a partial or mismatched set refuses to start, so a typo never turns push quietly off.
// Logs carry outcomes and status codes only: never an endpoint, a key or the payload.
import { createECDH, createPrivateKey, createCipheriv, hkdfSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { guardedRequest, type EgressOptions, type EgressResponse, type GuardedRequest } from '@crove/kernel-runtime';
import type { Runtime } from '@crove/kernel-runtime';

const RECORD_SIZE = 4096;
// How long a push service keeps a message for a browser that is offline: a day.
export const PUSH_TTL_SECONDS = 86_400;
// A VAPID token lives 12 hours (RFC 8292 allows at most 24).
const JWT_LIFETIME_SECONDS = 12 * 3600;
const SEND_TIMEOUT_MS = 10_000;
// A push message must fit one record; the payload stays far below.
export const PUSH_PAYLOAD_MAX = 3000;
const ACTOR = { type: 'system' as const, component: 'social.push' };

export interface VapidKeys {
  // The uncompressed P-256 point, base64url: what browsers subscribe with (applicationServerKey).
  publicKey: string;
  subject: string;
  privateKey: KeyObject;
}

const b64 = (value: string) => Buffer.from(value, 'base64url');

// The deployment's VAPID keys, or null when none is set. Throws on a partial set, a key that is not P-256, a private
// key that does not match the public one, or a subject that is neither mailto: nor https:.
export function loadVapidKeys(env: { VAPID_PUBLIC_KEY?: string | undefined; VAPID_PRIVATE_KEY?: string | undefined; VAPID_SUBJECT?: string | undefined }): VapidKeys | null {
  const set = [env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY, env.VAPID_SUBJECT].filter((v) => v !== undefined && v !== '');
  if (set.length === 0) return null;
  if (set.length !== 3) throw new Error('set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT together, or none of them');
  const pub = b64(env.VAPID_PUBLIC_KEY as string);
  const priv = b64(env.VAPID_PRIVATE_KEY as string);
  if (pub.length !== 65 || pub[0] !== 0x04 || priv.length !== 32) throw new Error('VAPID_PUBLIC_KEY is an uncompressed P-256 point and VAPID_PRIVATE_KEY its 32-byte private key, both base64url');
  const ecdh = createECDH('prime256v1');
  try {
    ecdh.setPrivateKey(priv);
  } catch {
    throw new Error('VAPID_PRIVATE_KEY is not a P-256 private key');
  }
  if (!ecdh.getPublicKey().equals(pub)) throw new Error('VAPID_PRIVATE_KEY does not match VAPID_PUBLIC_KEY');
  const subject = env.VAPID_SUBJECT as string;
  if (!/^mailto:[^\s@]+@[^\s@]+$/.test(subject) && !(URL.canParse(subject) && new URL(subject).protocol === 'https:')) throw new Error('VAPID_SUBJECT is a mailto: address or an https: URL');
  const privateKey = createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: priv.toString('base64url'), x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
  return { publicKey: pub.toString('base64url'), subject, privateKey };
}

// A fresh key pair, for an operator setting up push (the vapid-keys role of main.ts).
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const priv = ecdh.getPrivateKey();
  return { publicKey: ecdh.getPublicKey().toString('base64url'), privateKey: Buffer.concat([Buffer.alloc(32 - priv.length), priv]).toString('base64url') };
}

// The VAPID token for a push service's origin (RFC 8292 section 2): ES256 over the header and claims, the signature
// as r || s.
export function vapidToken(keys: Pick<VapidKeys, 'privateKey' | 'subject'>, audience: string, nowSeconds: number): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const input = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud: audience, exp: nowSeconds + JWT_LIFETIME_SECONDS, sub: keys.subject })}`;
  const signature = sign('sha256', Buffer.from(input), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' });
  return `${input}.${signature.toString('base64url')}`;
}

// The aes128gcm body of one push message for a browser (RFC 8291 section 3.4, RFC 8188 section 2): salt, record size,
// the sender's ephemeral public key, then the plaintext with its 0x02 delimiter, encrypted. `sender` and `salt` are
// fresh for every message; tests pass them to check the RFC's example.
export function encryptPush(plaintext: Buffer, ua: { p256dh: string; auth: string }, fixed?: { senderPrivateKey: Buffer; salt: Buffer }): Buffer {
  const uaPublic = b64(ua.p256dh);
  const authSecret = b64(ua.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04 || authSecret.length !== 16) throw new Error('invalid subscription keys');
  const sender = createECDH('prime256v1');
  if (fixed) sender.setPrivateKey(fixed.senderPrivateKey);
  else sender.generateKeys();
  const asPublic = sender.getPublicKey();
  const ecdhSecret = sender.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32));
  const salt = fixed?.salt ?? randomBytes(16);
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([0x02])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, ciphertext]);
}

export type PushOutcome = 'sent' | 'gone' | 'failed';
export type PushRequest = (url: string, request: GuardedRequest, options: EgressOptions) => Promise<EgressResponse>;

export interface PushSender {
  publicKey: string;
  send(subscription: { endpoint: string; p256dh: string; auth: string }, payload: string): Promise<{ outcome: PushOutcome; status: number | null }>;
}

// What a push service's answer means for the subscription: delivered (201, or any 2xx), gone (404 or 410: the browser
// unsubscribed or the subscription expired), or failed (a rate limit, a server error, a refused token or payload).
export function outcomeOf(status: number): PushOutcome {
  if (status >= 200 && status < 300) return 'sent';
  if (status === 404 || status === 410) return 'gone';
  return 'failed';
}

export function createPushSender(keys: VapidKeys, deps: { request?: PushRequest; now?: () => number; timeoutMs?: number; egress?: Partial<EgressOptions> } = {}): PushSender {
  const request = deps.request ?? guardedRequest;
  const now = deps.now ?? (() => Date.now());
  // One token per push service origin while it is valid for at least another hour.
  const tokens = new Map<string, { token: string; until: number }>();
  const tokenFor = (audience: string) => {
    const seconds = Math.floor(now() / 1000);
    const cached = tokens.get(audience);
    if (cached && cached.until > seconds + 3600) return cached.token;
    const token = vapidToken(keys, audience, seconds);
    tokens.set(audience, { token, until: seconds + JWT_LIFETIME_SECONDS });
    return token;
  };
  return {
    publicKey: keys.publicKey,
    async send(subscription, payload) {
      const body = Buffer.from(payload, 'utf8');
      if (body.length > PUSH_PAYLOAD_MAX) throw new Error('push payload too large');
      let url: URL;
      try {
        url = new URL(subscription.endpoint);
      } catch {
        return { outcome: 'gone', status: null };
      }
      if (url.protocol !== 'https:') return { outcome: 'gone', status: null };
      // Keys that are not a P-256 point and a 16-byte secret never work: the subscription goes.
      let encrypted: Buffer;
      try {
        encrypted = encryptPush(body, subscription);
      } catch {
        return { outcome: 'gone', status: null };
      }
      const headers: Record<string, string> = {
        authorization: `vapid t=${tokenFor(url.origin)}, k=${keys.publicKey}`,
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        ttl: String(PUSH_TTL_SECONDS),
        urgency: 'normal',
      };
      try {
        const answer = await request(
          subscription.endpoint,
          { method: 'POST', headers, body: encrypted },
          { timeoutMs: deps.timeoutMs ?? SEND_TIMEOUT_MS, maxBytes: 4096, overLimit: 'truncate', ...deps.egress },
        );
        return { outcome: outcomeOf(answer.status), status: answer.status };
      } catch (error) {
        // An address the guard refuses (private, loopback, another port) will never work: the subscription goes.
        const code = (error as { code?: unknown }).code;
        if (code === 'blocked' || code === 'invalid_url') return { outcome: 'gone', status: null };
        return { outcome: 'failed', status: null };
      }
    },
  };
}

// The push job of one notification: what to send and to whom (social.push.targets), one post per subscription, and
// the answers recorded (social.push.record). Never retried as a whole: a subscription that failed counts it, and the
// next notification tries it again.
export async function runPushJob(deps: { runtime: Runtime; sender: PushSender; brand: string }, job: { orgId: string; notificationId: string }): Promise<{ sent: number; gone: number; failed: number }> {
  const ctx = { actor: ACTOR, orgId: job.orgId };
  const targets = await deps.runtime.query<{ subscriptions: { id: string; endpoint: string; p256dh: string; auth: string }[]; line: string; path: string; tag: string } | null>('social.push.targets', { notificationId: job.notificationId }, ctx);
  if (!targets) return { sent: 0, gone: 0, failed: 0 };
  // No post text: the brand, the kind's line and the path the notification opens.
  const payload = JSON.stringify({ title: deps.brand, body: targets.line, url: targets.path, tag: targets.tag });
  const results = await Promise.all(
    targets.subscriptions.map(async (s) => {
      const done = await deps.sender.send(s, payload).catch(() => ({ outcome: 'failed' as const, status: null }));
      return { id: s.id, outcome: done.outcome };
    }),
  );
  if (results.length > 0) await deps.runtime.execute('social.push.record', { results }, ctx);
  const count = (o: PushOutcome) => results.filter((r) => r.outcome === o).length;
  return { sent: count('sent'), gone: count('gone'), failed: count('failed') };
}
