// Reference mail relay for inbound email (#684): a Cloudflare Email Worker that posts each message it receives, as raw
// MIME, to the kernel's POST /api/inbound/email (apps/kernel/src/inbound.ts). No dependencies and no build step: paste
// the file into the Cloudflare dashboard, or deploy it with wrangler. Any other mail service that runs a script per
// message can call relay() the same way.
//
// Settings, from the worker's variables and secrets only:
//   KERNEL_URL      the deployment's PUBLIC_URL, such as https://crove.example.com (https, or http on loopback for tests)
//   INBOUND_SECRET  the same value as the kernel's INBOUND_SECRET (a secret, never a plain variable)
//
// The kernel's answer decides what happens to the message:
//   2xx                        accepted (stored and queued; the kernel's worker files it later)
//   401, 408, 429, 3xx, 5xx    a fault on our side or a busy kernel: throw, so the sending server retries later
//   any other 4xx              the message itself is refused (unknown recipient, empty, too large): reject it with a reason
// A network error throws too. A wrong secret is not the sender's fault, so it never bounces mail.

const PATH = '/api/inbound/email';
const RETRY_STATUSES = new Set([401, 408, 429]);

// The reason given to the sending server, in plain ASCII (an SMTP reply line); the kernel's own messages are Vietnamese.
const REASONS = {
  UNKNOWN_RECIPIENT: 'Unknown recipient',
  EMPTY_MESSAGE: 'Empty message',
  TOO_LARGE: 'Message too large (40 MB limit)',
};

/**
 * @typedef {{ to: string, raw: ReadableStream<Uint8Array>, setReject(reason: string): void }} InboundMessage
 * @typedef {{ KERNEL_URL?: string, INBOUND_SECRET?: string }} RelayEnv
 */

/** @param {RelayEnv} env */
function endpoint(env) {
  if (!env.KERNEL_URL || !env.INBOUND_SECRET) throw new Error('KERNEL_URL and INBOUND_SECRET must be set on the mail worker');
  const url = new URL(PATH, env.KERNEL_URL);
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  // The secret must never cross the internet in clear text.
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error('KERNEL_URL must be an https URL');
  return url;
}

/**
 * Posts one message to the kernel. Resolves when the kernel accepted it or the message was rejected; throws to have
 * the sender retry.
 * @param {InboundMessage} message
 * @param {RelayEnv} env
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<'accepted' | 'rejected'>}
 */
export async function relay(message, env, fetchImpl = fetch) {
  const url = endpoint(env);
  const body = new Uint8Array(await new Response(message.raw).arrayBuffer());
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.INBOUND_SECRET}`,
      'content-type': 'message/rfc822',
      // The envelope recipient, <token>@ or bounce+<token>@INBOUND_DOMAIN: the kernel's worker routes by it.
      'x-crove-recipient': message.to,
    },
    body,
    // A redirect (http to https, a moved host) is a wrong KERNEL_URL: never follow it with the secret.
    redirect: 'manual',
  });
  if (response.ok) {
    await response.body?.cancel();
    return 'accepted';
  }
  const answer = await response.json().catch(() => null);
  const code = answer && typeof answer.code === 'string' ? answer.code : `HTTP_${response.status}`;
  if (response.status >= 400 && response.status < 500 && !RETRY_STATUSES.has(response.status)) {
    message.setReject(REASONS[/** @type {keyof typeof REASONS} */ (code)] ?? `Refused by Crove (${code})`);
    return 'rejected';
  }
  throw new Error(`Crove did not accept the message: ${response.status} ${code}`);
}

export default {
  /**
   * @param {InboundMessage} message
   * @param {RelayEnv} env
   */
  async email(message, env) {
    await relay(message, env);
  },
};
