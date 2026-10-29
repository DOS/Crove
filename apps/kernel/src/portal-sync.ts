// The assisted purchase-invoice sync from the tax portal (issue #325, ADR-0036): the steps the RPC procedures
// portalSync.* run in the API process, one bounded request each.
//
// - captcha:   records the call, fetches the portal's CAPTCHA and answers its image with a sealed challenge (the
//              portal's CAPTCHA key and an expiry, bound to this org, user and period).
// - login:     opens the challenge, records the call (refused after repeated wrong passwords), logs in to the portal with
//              the org's tax code, the password and the answer the person typed, and answers a sealed session: the
//              portal's token and an expiry, bound to this org, user and period. The password is used for that one
//              request and dropped; it never reaches the database, a log, an audit row, an envelope or an answer.
// - fetchList: opens the session, fetches the period's purchase list, checks it with the rules of an uploaded Excel list
//              (checkPortalList), stores the portal's answers as a JSON import file (evidence, ADR-0013) and files it as
//              a list of the period; the worker records its rows with the same command as an uploaded list
//              (importPortalList, finance.portal_list.record).
// - fetchXml:  opens the session and downloads a few invoice XML files the list names and Crove lacks, each stored and
//              recorded as an uploaded document by this user (kernel.file.ingest): the worker reads it in the sandbox
//              and it reaches the Inbox like any upload. Files are deduplicated by content.
//
// The sealed values live only in the browser's memory between steps; the server keeps nothing between requests, so
// nothing needs discarding but what expires on its own. Each envelope is AES-256-GCM under the deployment's credential
// key with a binding no channel credential uses, so neither can be opened as the other.
import { randomUUID } from 'node:crypto';
import { DomainError, fileKey, putFile, sha256Hex, type BlobStore, type CredentialBroker, type Runtime, type UserActor } from '@crove/kernel-runtime';
import {
  MAX_IMPORT_BYTES,
  PORTAL_CHALLENGE_SECONDS,
  PORTAL_SESSION_SECONDS,
  PORTAL_XML_PER_REQUEST,
  type PortalCaptchaView,
  type PortalListResult,
  type PortalXmlResult,
} from '@crove/kernel-contract';
import { PORTAL_SYNC_CONTENT_TYPE, PortalListTooLarge, checkPortalList, normalizePortalInvoices, vatPeriod, type PortalCallError, type PortalXmlPlan } from '@crove/mod-finance';
import { ConcurrencyLimiter } from './concurrency.ts';
import { RateLimiter } from './rate-limit.ts';
import { safeFilename, sniffType } from './sniff.ts';
import { TaxPortalError, type TaxPortalClient } from './tax-portal.ts';

const CHALLENGE = 'gdt_einvoice_captcha';
const SESSION = 'gdt_einvoice_session';

export interface PortalSyncDeps {
  runtime: Runtime;
  store: BlobStore;
  broker: CredentialBroker;
  client: TaxPortalClient;
  now?: () => number;
  // Per minute in this process: CAPTCHA images, logins and list fetches, per person and per client, and for the whole
  // process per kind (tests lower or raise them).
  limits?: { captchaPerUser?: number; captchaPerOrg?: number; loginPerUser?: number; loginPerOrg?: number; listPerOrg?: number; captchaPerProcess?: number; loginPerProcess?: number; listPerProcess?: number };
  // One deadline for each fetchList or fetchXml step, shared by all its portal requests (TAX_PORTAL_STEP_SECONDS).
  stepMs?: number;
}

// The browser went away (the request's abort signal), passed from the RPC handler.
export interface StepOptions {
  signal?: AbortSignal;
}

export interface PortalSync {
  captcha(orgId: string, actor: UserActor, period: string): Promise<PortalCaptchaView>;
  login(orgId: string, actor: UserActor, input: { period: string; challenge: string; captcha: string; password: string; consent: true }): Promise<{ session: string; expiresInSeconds: number }>;
  fetchList(orgId: string, actor: UserActor, input: { period: string; session: string }, options?: StepOptions): Promise<PortalListResult>;
  fetchXml(orgId: string, actor: UserActor, input: { period: string; session: string; listId: string }, options?: StepOptions): Promise<PortalXmlResult>;
}

// What the person sees for each class of failure. Never the portal's own words.
function portalError(kind: PortalCallError): DomainError {
  switch (kind) {
    case 'WRONG_CAPTCHA':
      return new DomainError('PORTAL_WRONG_CAPTCHA', 422, 'Mã xác nhận chưa đúng hoặc đã hết hạn; hãy lấy mã mới và nhập lại');
    case 'WRONG_PASSWORD':
      return new DomainError('PORTAL_WRONG_PASSWORD', 422, 'Cổng thuế không chấp nhận mật khẩu này. Hãy kiểm tra lại với khách hàng: nhập sai nhiều lần, cổng thuế sẽ khóa tài khoản');
    case 'ACCOUNT_LOCKED':
      return new DomainError('PORTAL_ACCOUNT_LOCKED', 422, 'Tài khoản cổng thuế của khách hàng đang bị khóa; khách hàng cần mở khóa trên hoadondientu.gdt.gov.vn (mục Quên mật khẩu)');
    case 'RATE_LIMITED':
      return new DomainError('PORTAL_RATE_LIMITED', 429, 'Cổng thuế đang giới hạn số lần truy cập; hãy thử lại sau ít phút');
    case 'BLOCKED':
      return new DomainError('PORTAL_BLOCKED', 503, 'Cổng thuế đang chặn truy cập từ máy chủ này; hãy thử lại sau, hoặc xuất danh sách Excel từ cổng thuế rồi tải lên');
    case 'UNAVAILABLE':
      return new DomainError('PORTAL_UNAVAILABLE', 503, 'Không kết nối được tới cổng thuế; cổng thuế có thể đang quá tải hoặc bảo trì, hãy thử lại sau');
    case 'SESSION_EXPIRED':
      return new DomainError('PORTAL_SESSION_EXPIRED', 409, 'Phiên đăng nhập cổng thuế đã hết hạn; hãy đăng nhập lại');
    case 'TOO_LARGE':
      return new DomainError('PORTAL_LIST_TOO_LARGE', 422, 'Danh sách của kỳ này quá lớn để lấy một lần; hãy xuất danh sách Excel từ cổng thuế rồi tải lên');
    case 'TOO_SLOW':
      return new DomainError('PORTAL_STEP_TIMEOUT', 503, 'Cổng thuế trả lời chậm nên lượt lấy dữ liệu đã tạm dừng; hãy bấm lấy lại để tiếp tục');
    case 'BAD_ANSWER':
      return new DomainError('PORTAL_BAD_ANSWER', 503, 'Cổng thuế trả lời theo cách hệ thống chưa đọc được; hãy xuất danh sách Excel từ cổng thuế rồi tải lên');
  }
}

// The portal's answers as a list, or the finance domain's refusal of a list too large as the API's answer: 422
// PORTAL_LIST_TOO_LARGE with the domain's message (#1680).
function normalizeAnswers(...args: Parameters<typeof normalizePortalInvoices>): ReturnType<typeof normalizePortalInvoices> {
  try {
    return normalizePortalInvoices(...args);
  } catch (error) {
    if (error instanceof PortalListTooLarge) throw new DomainError(error.code, 422, error.message);
    throw error;
  }
}

// The period's first and last day; a period the contract let through but the calendar refuses is a bad request.
function vatPeriodRange(period: string): { from: string; to: string } {
  try {
    const p = vatPeriod(period);
    return { from: p.from, to: p.to };
  } catch {
    throw new DomainError('INVALID', 400, 'Kỳ không hợp lệ');
  }
}

const RETRYABLE: ReadonlySet<PortalCallError> = new Set(['RATE_LIMITED', 'BLOCKED', 'UNAVAILABLE', 'SESSION_EXPIRED', 'TOO_SLOW']);

const sessionInvalid = () => new DomainError('PORTAL_SESSION_INVALID', 409, 'Phiên lấy dữ liệu cổng thuế không hợp lệ; hãy đăng nhập lại');

export function createPortalSync(deps: PortalSyncDeps): PortalSync {
  const { runtime, store, broker, client } = deps;
  const now = deps.now ?? Date.now;
  // In this process (rate-limit.ts): CAPTCHA images and logins per person and per client, and one step at a time per
  // client, so two accountants never drive the same client's portal account at once from this server.
  const limits = deps.limits ?? {};
  // Per person in one org, per person across every org (one account with many orgs), per client, and for the whole
  // process: every portal request leaves from this server's address, and a block there stops the feature for everyone.
  const limiter = (perMinute: number) => new RateLimiter({ perMinute, now });
  // Each kind has its own process budget, so CAPTCHA images never use up the logins.
  const captchas = { user: limiter(limits.captchaPerUser ?? 10), person: limiter((limits.captchaPerUser ?? 10) * 2), org: limiter(limits.captchaPerOrg ?? 20), process: limiter(limits.captchaPerProcess ?? 60) };
  const logins = { user: limiter(limits.loginPerUser ?? 3), person: limiter((limits.loginPerUser ?? 3) * 2), org: limiter(limits.loginPerOrg ?? 5), process: limiter(limits.loginPerProcess ?? 30) };
  const lists = { user: limiter(limits.listPerOrg ?? 4), person: limiter((limits.listPerOrg ?? 4) * 2), org: limiter(limits.listPerOrg ?? 4), process: limiter(limits.listPerProcess ?? 30) };
  const stepMs = deps.stepMs ?? 90_000;
  const busy = new ConcurrencyLimiter({ total: 8, perKey: 1 });

  type Limits = { user: RateLimiter; person: RateLimiter; org: RateLimiter; process: RateLimiter };
  const take = (group: Limits, orgId: string, userId: string) => {
    const checks: Array<[RateLimiter, string]> = [
      [group.user, `${orgId}:${userId}`],
      [group.person, userId],
      [group.org, orgId],
      [group.process, 'all'],
    ];
    // Every budget is looked at before any is spent.
    for (const [limiter, key] of checks) {
      const seen = limiter.peek(key);
      if (!seen.allowed) throw new DomainError('RATE_LIMITED', 429, 'Đã thử nhiều lần trong phút này; hãy đợi một lát rồi thử lại', { retryAfterSeconds: seen.retryAfterSeconds });
    }
    for (const [limiter, key] of checks) limiter.take(key);
  };

  // The member may run the sync and the org has a tax code: checked before any budget is spent, so refused calls (a
  // viewer, a client without a tax code) never use up anyone's budget.
  const authorize = (orgId: string, actor: UserActor) => runtime.query<{ taxCode: string }>('finance.portal_sync.check', {}, { actor, orgId });

  async function exclusive<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
    const release = busy.tryAcquire(orgId);
    if (!release) throw new DomainError('PORTAL_SYNC_BUSY', 409, 'Đang có một lượt lấy dữ liệu từ cổng thuế cho khách hàng này; hãy đợi lượt đó xong');
    try {
      return await fn();
    } finally {
      release();
    }
  }

  const binding = (orgId: string, provider: string, userId: string, period: string) => ({ orgId, provider, externalAccountId: `${userId}:${period}` });
  function seal(value: Record<string, unknown>, orgId: string, provider: string, userId: string, period: string): string {
    const sealed = broker.seal(JSON.stringify(value), binding(orgId, provider, userId, period));
    return `${sealed.keyId}.${sealed.envelope.toString('base64url')}`;
  }
  function open(text: string, orgId: string, provider: string, userId: string, period: string): Record<string, unknown> {
    const dot = text.indexOf('.');
    if (dot <= 0) throw sessionInvalid();
    try {
      const plain = broker.open({ keyId: text.slice(0, dot), envelope: Buffer.from(text.slice(dot + 1), 'base64url') }, binding(orgId, provider, userId, period));
      const value = JSON.parse(plain) as unknown;
      if (!value || typeof value !== 'object') throw new Error('not an object');
      return value as Record<string, unknown>;
    } catch {
      // Another user's, another org's or period's envelope, a damaged one, or one sealed with a retired key.
      throw sessionInvalid();
    }
  }
  // The session of this org, user and period, for the tax code it was opened with (an org whose tax code changed since
  // logs in again).
  function openSession(text: string, orgId: string, actor: UserActor, period: string, taxCode: string): { token: string; exp: number } {
    const value = open(text, orgId, SESSION, actor.userId, period);
    if (typeof value.token !== 'string' || typeof value.exp !== 'number' || value.taxCode !== taxCode) throw sessionInvalid();
    if (value.exp <= now()) throw portalError('SESSION_EXPIRED');
    return { token: value.token, exp: value.exp };
  }

  // One call to the portal, recorded before and after it is made (external_call): the outcome class only.
  async function call<T>(orgId: string, actor: UserActor, begin: Record<string, unknown>, fn: (taxCode: string) => Promise<T>, ref?: (result: T) => string | undefined): Promise<T> {
    const opts = { actor, orgId };
    const { key, taxCode } = await runtime.execute<{ key: string; taxCode: string }>('finance.portal_sync.call', begin, opts);
    let result: T;
    try {
      result = await fn(taxCode);
    } catch (error) {
      const kind: PortalCallError = error instanceof TaxPortalError ? error.kind : 'BAD_ANSWER';
      // A portal that did not answer this time leaves the call open to be made again (an XML download is keyed per list
      // and invoice); a refusal or an unreadable answer closes it.
      const outcome = RETRYABLE.has(kind) ? 'retry' : 'failed';
      await runtime.execute('finance.portal_sync.call_end', { key, outcome, error: kind }, opts);
      if (error instanceof TaxPortalError) throw portalError(error.kind);
      throw error;
    }
    const externalRef = ref?.(result);
    await runtime.execute('finance.portal_sync.call_end', { key, outcome: 'succeeded', ...(externalRef ? { externalRef } : {}) }, opts);
    return result;
  }

  // Stores bytes the API holds and records the file as this user (as the upload route does).
  async function storeFile(orgId: string, actor: UserActor, name: string, bytes: Uint8Array, contentType: string, source: 'upload' | 'import') {
    const sha256 = sha256Hex(bytes);
    const storageKey = fileKey(orgId, sha256);
    const generation = await putFile(store, storageKey, bytes, contentType, sha256);
    return runtime.execute<{ fileId: string; duplicate: boolean }>(
      'kernel.file.ingest',
      { filename: name, contentType, sizeBytes: bytes.byteLength, sha256, storageKey, generation, source },
      { actor, orgId },
    );
  }

  return {
    async captcha(orgId, actor, period) {
      vatPeriodRange(period);
      await authorize(orgId, actor);
      take(captchas, orgId, actor.userId);
      return exclusive(orgId, async () => {
        let username = '';
        const image = await call(orgId, actor, { step: 'captcha', period }, async (taxCode) => {
          username = taxCode;
          return client.captcha();
        });
        const challenge = seal({ key: image.key, exp: now() + PORTAL_CHALLENGE_SECONDS * 1000, nonce: randomUUID() }, orgId, CHALLENGE, actor.userId, period);
        return { challenge, image: `data:image/svg+xml;base64,${Buffer.from(image.svg, 'utf8').toString('base64')}`, username, expiresInSeconds: PORTAL_CHALLENGE_SECONDS };
      });
    },

    async login(orgId, actor, input) {
      vatPeriodRange(input.period);
      const challenge = (() => {
        try {
          return open(input.challenge, orgId, CHALLENGE, actor.userId, input.period);
        } catch {
          throw new DomainError('PORTAL_CHALLENGE_INVALID', 400, 'Mã xác nhận không còn dùng được; hãy lấy mã mới');
        }
      })();
      if (typeof challenge.key !== 'string' || typeof challenge.exp !== 'number' || challenge.exp <= now()) {
        throw new DomainError('PORTAL_CHALLENGE_INVALID', 400, 'Mã xác nhận đã hết hạn; hãy lấy mã mới');
      }
      await authorize(orgId, actor);
      take(logins, orgId, actor.userId);
      return exclusive(orgId, async () => {
        const captchaKey = challenge.key as string;
        let loginTaxCode = '';
        const token = await call(orgId, actor, { step: 'login', period: input.period, consent: true }, (taxCode) => {
          loginTaxCode = taxCode;
          return client.login(taxCode, input.password, { key: captchaKey, answer: input.captcha });
        });
        const session = seal({ token, exp: now() + PORTAL_SESSION_SECONDS * 1000, taxCode: loginTaxCode, nonce: randomUUID() }, orgId, SESSION, actor.userId, input.period);
        return { session, expiresInSeconds: PORTAL_SESSION_SECONDS };
      });
    },

    async fetchList(orgId, actor, input, options = {}) {
      const range = vatPeriodRange(input.period);
      const { taxCode: current } = await authorize(orgId, actor);
      const { token, exp } = openSession(input.session, orgId, actor, input.period, current);
      take(lists, orgId, actor.userId);
      return exclusive(orgId, async () => {
        const opts = { actor, orgId };
        let orgTaxCode = '';
        const answers = await call(
          orgId,
          actor,
          { step: 'list', period: input.period },
          async (taxCode) => {
            orgTaxCode = taxCode;
            // One deadline for the whole list, never past the session's own expiry.
            return client.purchaseInvoices(token, range.from, range.to, { deadline: Math.min(now() + stepMs, exp), ...(options.signal ? { signal: options.signal } : {}) });
          },
          (a) => String(a.reduce((n, q) => n + q.rows.length, 0)),
        );
        // Normalized and checked before anything is stored: a list Crove cannot use is said at once, and nothing is
        // filed. The worker reads the stored answer again with the same rules when it records the list.
        const normalized = normalizeAnswers(answers, range);
        const checked = checkPortalList(normalized.list, orgTaxCode);
        if (!checked.ok) throw new DomainError('PORTAL_LIST_UNUSABLE', 422, checked.error);
        // The evidence: what the portal answered, without a time stamp, so the same answer is the same file.
        const evidence = Buffer.from(JSON.stringify({ source: client.origin, period: input.period, from: range.from, to: range.to, answers }), 'utf8');
        if (evidence.byteLength > MAX_IMPORT_BYTES) throw portalError('TOO_LARGE');
        const { fileId } = await storeFile(orgId, actor, `cong-thue-${input.period}.json`, evidence, PORTAL_SYNC_CONTENT_TYPE, 'import');
        const filed = await runtime.execute<{ listId: string; unchanged: boolean }>('finance.portal_sync.list', { period: input.period, fileId }, opts);
        const withXml = checked.rows.filter((r) => normalized.withXml.has(r.rowNo)).length;
        return { listId: filed.listId, unchanged: filed.unchanged, rows: checked.rows.length, skipped: normalized.list.skippedCount, ownSales: checked.ownSales, otherBuyers: checked.otherBuyers, withXml };
      });
    },

    async fetchXml(orgId, actor, input, options = {}) {
      vatPeriodRange(input.period);
      const { taxCode: current } = await authorize(orgId, actor);
      const { token, exp } = openSession(input.session, orgId, actor, input.period, current);
      // One deadline for the whole batch, never past the session's own expiry.
      const step = { deadline: Math.min(now() + stepMs, exp), ...(options.signal ? { signal: options.signal } : {}) };
      return exclusive(orgId, async () => {
        const opts = { actor, orgId };
        const plan = await runtime.query<PortalXmlPlan>('finance.portal_sync.xml_plan', { listId: input.listId, period: input.period, limit: PORTAL_XML_PER_REQUEST }, opts);
        // The worker has not recorded the list yet: nothing to download, ask again in a moment.
        if (plan.status === 'pending') return { downloaded: 0, duplicates: 0, failed: 0, remaining: 0, done: false, waiting: true };
        let downloaded = 0;
        let duplicates = 0;
        let failed = 0;
        for (const invoice of plan.pending) {
          // Out of time, the session about to expire, or the browser gone: stop here; the next call goes on.
          if (now() >= step.deadline || step.signal?.aborted) break;
          try {
            await call(
              orgId,
              actor,
              { step: 'xml', listId: input.listId, invoice },
              async () => {
                const bytes = await client.invoiceXml(token, invoice, step);
                const type = sniffType(bytes);
                // A ZIP holding the XML (the worker opens it in the sandbox) or the XML itself; anything else is not an
                // invoice file.
                if (type !== 'application/zip' && type !== 'application/xml') throw new TaxPortalError('BAD_ANSWER');
                const stored = await storeFile(orgId, actor, safeFilename(`hd-${invoice.sellerTaxCode}-${invoice.series}-${invoice.number}`, type), bytes, type, 'upload');
                if (stored.duplicate) duplicates += 1;
                else downloaded += 1;
                return stored;
              },
              (stored) => stored.fileId,
            );
          } catch (error) {
            // The session or the portal stopped answering: stop here, the next sync goes on from this invoice.
            if (error instanceof DomainError && ['PORTAL_SESSION_EXPIRED', 'PORTAL_RATE_LIMITED', 'PORTAL_BLOCKED', 'PORTAL_UNAVAILABLE'].includes(error.code)) throw error;
            // The step's deadline passed during this download: what is done stays, the next call goes on.
            if (error instanceof DomainError && error.code === 'PORTAL_STEP_TIMEOUT') break;
            if (error instanceof DomainError && error.code === 'PORTAL_CALL_DONE') continue;
            // The member lost the right to do this (removed or made a viewer): stop.
            if (error instanceof DomainError && (error.status === 403 || error.code === 'NOT_A_MEMBER')) throw error;
            // Anything else is this invoice's failure (an unreadable answer, a file Crove refuses): the others go on.
            if (error instanceof DomainError) {
              failed += 1;
              continue;
            }
            throw error;
          }
        }
        const after = await runtime.query<PortalXmlPlan>('finance.portal_sync.xml_plan', { listId: input.listId, period: input.period, limit: 0 }, opts);
        return { downloaded, duplicates, failed, remaining: after.remaining, done: after.remaining === 0, waiting: false };
      });
    },
  };
}
