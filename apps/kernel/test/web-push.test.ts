// Web Push with Node's crypto (#1238): the message encryption against RFC 8291's own example (section 5 and appendix
// A), the browser's side decrypting what the sender made, the VAPID token (RFC 8292) verified with the public key,
// the key settings refused when partial or mismatched, and the push service's answers.
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EgressError } from '@crove/kernel-runtime';
import { createPushSender, encryptPush, generateVapidKeys, loadVapidKeys, outcomeOf, vapidToken } from '../src/web-push.ts';

const b64 = (s: string) => Buffer.from(s.replace(/\s+/g, ''), 'base64url');

// RFC 8291 section 5 and appendix A.
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  // The authentication secret of the example's user agent.
  uaShared: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: `DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
         mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT
         pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN`,
};

// The browser's side (RFC 8291 section 3.4, read backwards): what a user agent does with a push message.
function decrypt(body: Buffer, uaPrivate: Buffer, auth: Buffer): Buffer {
  const salt = body.subarray(0, 16);
  const idlen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idlen);
  const ua = createECDH('prime256v1');
  ua.setPrivateKey(uaPrivate);
  const secret = ua.computeSecret(asPublic);
  const ikm = Buffer.from(hkdfSync('sha256', secret, auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic]), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const data = body.subarray(21 + idlen);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(data.subarray(data.length - 16));
  const padded = Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]);
  expect(padded.at(-1)).toBe(0x02);
  return padded.subarray(0, -1);
}

describe('RFC 8291 message encryption', () => {
  it("produces the RFC's example message from its keys and salt", () => {
    const body = encryptPush(Buffer.from(RFC.plaintext), { p256dh: RFC.uaPublic, auth: RFC.uaShared }, { senderPrivateKey: b64(RFC.asPrivate), salt: b64(RFC.salt) });
    expect(body.toString('base64url')).toBe(RFC.body.replace(/\s+/g, ''));
    // The header: salt, record size 4096, the sender's public key.
    expect(body.subarray(0, 16)).toEqual(b64(RFC.salt));
    expect(body.readUInt32BE(16)).toBe(4096);
    expect(body.subarray(21, 86)).toEqual(b64(RFC.asPublic));
  });

  it('makes a message the browser decrypts, with a fresh key and salt each time', () => {
    const ua = createECDH('prime256v1');
    ua.generateKeys();
    const auth = randomBytes(16);
    const keys = { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') };
    const payload = Buffer.from(JSON.stringify({ title: 'Crove', body: 'Có bài đang chờ bạn duyệt', url: '/o/acme/social/channels' }));
    const a = encryptPush(payload, keys);
    const b = encryptPush(payload, keys);
    expect(a.equals(b)).toBe(false);
    expect(decrypt(a, ua.getPrivateKey(), auth)).toEqual(payload);
    expect(decrypt(b, ua.getPrivateKey(), auth)).toEqual(payload);
    // The RFC's receiver decrypts the RFC's message too.
    expect(decrypt(b64(RFC.body), b64(RFC.uaPrivate), b64(RFC.uaShared)).toString()).toBe(RFC.plaintext);
  });

  it('refuses keys that are not a P-256 point and a 16-byte secret', () => {
    expect(() => encryptPush(Buffer.from('x'), { p256dh: randomBytes(65).toString('base64url'), auth: RFC.uaShared })).toThrow();
    expect(() => encryptPush(Buffer.from('x'), { p256dh: RFC.uaPublic, auth: randomBytes(8).toString('base64url') })).toThrow('invalid subscription keys');
  });
});

describe('VAPID (RFC 8292)', () => {
  const pair = generateVapidKeys();
  const env = { VAPID_PUBLIC_KEY: pair.publicKey, VAPID_PRIVATE_KEY: pair.privateKey, VAPID_SUBJECT: 'mailto:ops@crove.test' };

  it('signs an ES256 token for the push service origin that the public key verifies', () => {
    const keys = loadVapidKeys(env);
    if (!keys) throw new Error('no keys');
    const token = vapidToken(keys, 'https://fcm.googleapis.com', 1_800_000_000);
    const [header, claims, signature] = token.split('.') as [string, string, string];
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toEqual({ aud: 'https://fcm.googleapis.com', exp: 1_800_000_000 + 12 * 3600, sub: 'mailto:ops@crove.test' });
    const raw = b64(pair.publicKey);
    const pub = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
    expect(b64(signature)).toHaveLength(64);
    expect(verify('sha256', Buffer.from(`${header}.${claims}`), { key: pub, dsaEncoding: 'ieee-p1363' }, b64(signature))).toBe(true);
    expect(verify('sha256', Buffer.from(`${header}.${claims}x`), { key: pub, dsaEncoding: 'ieee-p1363' }, b64(signature))).toBe(false);
  });

  it('is off with no keys, and refuses a partial set, a mismatched pair or a bad subject', () => {
    expect(loadVapidKeys({})).toBeNull();
    expect(loadVapidKeys({ VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '', VAPID_SUBJECT: '' })).toBeNull();
    expect(() => loadVapidKeys({ VAPID_PUBLIC_KEY: pair.publicKey })).toThrow('together');
    expect(() => loadVapidKeys({ ...env, VAPID_PRIVATE_KEY: generateVapidKeys().privateKey })).toThrow('does not match');
    expect(() => loadVapidKeys({ ...env, VAPID_PUBLIC_KEY: randomBytes(65).toString('base64url') })).toThrow();
    expect(() => loadVapidKeys({ ...env, VAPID_SUBJECT: 'ops@crove.test' })).toThrow('VAPID_SUBJECT');
    expect(() => loadVapidKeys({ ...env, VAPID_SUBJECT: 'http://crove.test' })).toThrow('VAPID_SUBJECT');
    expect(loadVapidKeys({ ...env, VAPID_SUBJECT: 'https://crove.test/contact' })?.publicKey).toBe(pair.publicKey);
  });
});

describe('the push sender', () => {
  const pair = generateVapidKeys();
  const keys = loadVapidKeys({ VAPID_PUBLIC_KEY: pair.publicKey, VAPID_PRIVATE_KEY: pair.privateKey, VAPID_SUBJECT: 'mailto:ops@crove.test' });
  if (!keys) throw new Error('no keys');
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  const auth = randomBytes(16);
  const sub = { endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/abc', p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') };

  it('posts the encrypted message with the VAPID header and reads the answer', async () => {
    const seen: { url: string; method: string; headers: Record<string, string>; body: Buffer }[] = [];
    const sender = createPushSender(keys, {
      request: async (url, request) => {
        seen.push({ url, method: request.method, headers: { ...request.headers }, body: request.body ?? Buffer.alloc(0) });
        return { url, status: 201, contentType: null, body: Buffer.alloc(0), truncated: false };
      },
    });
    expect(await sender.send(sub, '{"title":"Crove"}')).toEqual({ outcome: 'sent', status: 201 });
    const [req] = seen;
    expect(req?.method).toBe('POST');
    expect(req?.headers).toMatchObject({ 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: '86400', urgency: 'normal' });
    expect(req?.headers.authorization).toMatch(new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${pair.publicKey}$`));
    const claims = JSON.parse(Buffer.from(req?.headers.authorization?.split('.')[1] ?? '', 'base64url').toString());
    expect(claims.aud).toBe('https://updates.push.services.mozilla.com');
    expect(decrypt(req?.body ?? Buffer.alloc(0), ua.getPrivateKey(), auth).toString()).toBe('{"title":"Crove"}');
  });

  it('reads 404 and 410 as gone, a refused address as gone, and anything else as failed', async () => {
    expect([200, 201, 202, 404, 410, 400, 401, 403, 413, 429, 500, 503].map(outcomeOf)).toEqual(['sent', 'sent', 'sent', 'gone', 'gone', 'failed', 'failed', 'failed', 'failed', 'failed', 'failed', 'failed']);
    const refusing = (error: Error) => createPushSender(keys, { request: async () => Promise.reject(error) });
    expect(await refusing(new EgressError('blocked', 'private address')).send(sub, '{}')).toEqual({ outcome: 'gone', status: null });
    expect(await refusing(new EgressError('timeout', 'slow')).send(sub, '{}')).toEqual({ outcome: 'failed', status: null });
    expect(await createPushSender(keys, { request: async () => Promise.reject(new Error('unused')) }).send({ ...sub, endpoint: 'http://push.test/x' }, '{}')).toEqual({ outcome: 'gone', status: null });
    await expect(createPushSender(keys).send(sub, 'x'.repeat(4000))).rejects.toThrow('too large');
  });
});
