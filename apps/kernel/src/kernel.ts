// The composition root (plan Decision 12, ADR-0030). createKernel takes the configuration and one adapter per port
// and starts the server roles; it builds no adapter itself. main.ts wires the open-source defaults from
// configuration (defaultAdapters); a Crove Cloud entrypoint wires its own adapters into the same factory.
import { serve } from '@hono/node-server';
import { InvoiceExtractor, SocialWriter, type InvoiceReader } from '@crove/agent';
import {
  BlueskyPublisher,
  TelegramPublisher,
  DiscordPublisher,
  MastodonPublisher,
  WordPressPublisher,
  FacebookPageConnector,
  FacebookPagePublisher,
  InstagramConnector,
  InstagramPublisher,
  SandboxPublisher,
  LinkedInConnector,
  LinkedInPageConnector,
  LinkedInPagePublisher,
  TikTokConnector,
  TikTokPublisher,
  TikTokRefresher,
  YouTubeConnector,
  YouTubePublisher,
  YouTubeRefresher,
  GoogleBusinessConnector,
  GoogleBusinessPublisher,
  GoogleBusinessRefresher,
  LinkedInPublisher,
  XConnector,
  XPublisher,
  XRefresher,
  PinterestConnector,
  PinterestPublisher,
  PinterestRefresher,
  ThreadsConnector,
  ThreadsPublisher,
  ThreadsRefresher,
  ZaloOaConnector,
  ZaloOaPublisher,
  ZaloOaRefresher,
  CHANNEL_OPTIONS_CALL_TIMEOUT_MS,
  type OAuthConnector,
  type Publisher,
  type Refresher,
} from '@crove/channel';
import { createExtractClient } from '@crove/extract-contract';
import { assertRlsEnforced, assertSystemContextAccess, createDb, createPool, singleCell, type Db } from '@crove/db';
import { buildKernelCommands, kernelQueries, setMessageIdDomain, type OverviewContribution } from '@crove/kernel';
import {
  LocalDiskStore,
  egressFetch,
  Runtime,
  type BlobStore,
  readVerified,
  type CommandDef,
  type CredentialBroker,
  type QueryDef,
  type SessionStatusSource,
} from '@crove/kernel-runtime';
import { financeAgentPrograms, financeCommands, financeQueries } from '@crove/mod-finance';
import { socialAgentPrograms, socialCommands, socialOverviewContributions, socialQueries } from '@crove/mod-social';
import { crmAgentPrograms, crmCommands, crmQueries } from '@crove/mod-crm';
import { createAuthenticator, type Authenticate } from './auth.ts';
import { AVAILABLE_MODULES, assertExportKey, usageLimits, type Config, type ModuleId } from './config.ts';
import { createCredentialBroker, noCredentialBroker } from './credentials.ts';
import { rebindExports as rebindOrgExports } from './export-rebind.ts';
import { exportSealer } from './export-seal.ts';
import { webhookTarget, type WebhookTarget } from './alert.ts';
import type { SecurityThresholds } from './security-signals.ts';
import { orgPurgeCommand, runOrgPurge } from './org-purge.ts';
import { runUserDisable } from './user-disable.ts';
import { ConcurrencyLimiter, Semaphore } from './concurrency.ts';
import { createHttpApp, type StreamDeps } from './http.ts';
import { createLogProvider, createMailer, messageIdDomain, type MailProvider } from './mail.ts';
import { MAIL_TEMPLATES } from './mail-templates.ts';
import { createSessionRevoker, createSessionStatusSource, type SessionRevoker } from './sessions.ts';
import { createArchiveStore, createBlobStore } from './storage.ts';
import type { SocialDrafter } from './rpc.ts';
import { StreamHub, createDbTicketStore, createPgNotificationSource } from './stream.ts';
import { createPexels } from './stock-photos.ts';
import { createMediaUrls } from './media-urls.ts';
import { createTaxCodeLookup } from './tax-lookup.ts';
import { createPortalSync } from './portal-sync.ts';
import { createTaxPortalClient, testPortalAllowed } from './tax-portal.ts';
import { startWorker } from './worker.ts';
import { createPushSender, loadVapidKeys } from './web-push.ts';
import { WORKER_LAG_EXIT_MS, WORKER_LAG_SUSTAIN_MS, startLagWatchdog } from './back-pressure.ts';

// Identity (ADR-0027, ADR-0028): who the caller is and whether their session still holds. When
// sessions.liveCheckForR3 is true, the authenticator must set confirmLive on each user, or every R3 command fails
// closed with 503.
export interface IdentityPort {
  // Checked in the transaction of every user request; never "no check" in a server.
  readonly sessions: SessionStatusSource;
  // The API's request authenticator, bound to the API role's database.
  authenticator(db: Db): Authenticate;
  // Upstream sign-out after a Crove-side revoke; null keeps revocation in Crove only.
  readonly revoker: SessionRevoker | null;
}

export type { CredentialBroker } from '@crove/kernel-runtime';
export { noCredentialBroker } from './credentials.ts';

// A connector to an outside system (e-invoice issuing, banks). The core ships none; Crove Cloud adds its own.
export interface Connector {
  readonly id: string;
}

// Which module entitlements an org holds (plan Decision 10). Self-host grants every module.
export interface Billing {
  entitlements(orgId: string): Promise<readonly string[]>;
}

export interface KernelAdapters {
  identity: IdentityPort;
  // The AI invoice reader; null runs without AI (e-invoice XML still works, PDF and images do not).
  ai: InvoiceReader | null;
  // Drafts Social posts (Social plan S7) through the same endpoint; null runs without AI drafting.
  writer?: (Pick<SocialWriter, 'draft' | 'rewrite'> & Partial<Pick<SocialWriter, 'hashtags' | 'describeImage' | 'ideas' | 'summary'>>) | null;
  storage: BlobStore;
  // Outbound mail (member invites, issue #129); the default logs that nothing was sent.
  mail?: MailProvider;
  broker?: CredentialBroker;
  connectors?: readonly Connector[];
  billing?: Billing;
}

export type ResolvedAdapters = Required<KernelAdapters>;

export type ServerRole = 'api' | 'worker' | 'all';

export interface Kernel {
  readonly config: Config;
  // The modules this deployment registers (CROVE_MODULES; kernel always).
  readonly modules: readonly ModuleId[];
  readonly adapters: Readonly<ResolvedAdapters>;
  // Starts the role's servers and resolves to a function that stops them in reverse order.
  start(role: ServerRole): Promise<() => Promise<void>>;
  // After a restore into a new bucket: re-records each org's export with the restored object versions, as the worker
  // (issue #351, export-rebind.ts). Resolves to the exit code.
  rebindExports(orgIds: readonly string[]): Promise<number>;
  // The operator blocks (true) or unblocks a user account, as the worker (issue #985, user-disable.ts). Resolves to the
  // exit code.
  setUserStatus(disabled: boolean, argv: readonly string[]): Promise<number>;
  // The operator purges an offboarded org by its deletion map and closes it, as the worker (issue #1024,
  // org-purge.ts). Resolves to the exit code.
  purgeOrg(argv: readonly string[]): Promise<number>;
}

// No-op defaults for the optional ports: nothing can be bound, no connector is installed, every module is on.
export const selfHostBilling: Billing = { entitlements: async () => ['full'] };

const REQUIRED = ['identity', 'ai', 'storage'] as const;

export interface ModuleDefinitions {
  commands: CommandDef<any, any>[];
  queries: QueryDef<any, any>[];
}

// The figures each module adds to the multi-client home (#1261); a module without any is left out.
const OVERVIEW_CONTRIBUTIONS: Partial<Record<ModuleId, readonly OverviewContribution[]>> = { social: socialOverviewContributions };

// The overview contributions of the modules CROVE_MODULES enables, which kernel.org.overview runs in each org.
export function overviewContributions(config: Pick<Config, 'CROVE_MODULES'>): OverviewContribution[] {
  return config.CROVE_MODULES.flatMap((module) => OVERVIEW_CONTRIBUTIONS[module] ?? []);
}

// The commands and queries of the modules CROVE_MODULES enables (plan Decision 12, ADR-0031). A module left out has
// none registered, so its commands answer COMMAND_NOT_FOUND, a ctx.query into it answers not_installed (with the
// absentModules buildRuntime passes), and the
// routes and jobs that ask Runtime.installed() are not registered either.
export function moduleDefinitions(config: Config): ModuleDefinitions {
  // Mail a module queues (the scheduled report, #704) gets the deployment's Message-ID domain too.
  setMessageIdDomain(messageIdDomain(config));
  const all: Record<ModuleId, () => ModuleDefinitions> = {
    kernel: () => ({
      commands: buildKernelCommands({
        orgCreateLimits: { perDay: config.ORG_CREATE_LIMIT_PER_DAY, total: config.ORG_CREATE_LIMIT_TOTAL },
        inboundRotateLimits: { perDay: config.INBOUND_ROTATE_LIMIT_PER_DAY, total: config.INBOUND_ROTATE_LIMIT_TOTAL },
        uploadBeginLimits: { perMinute: config.UPLOAD_BEGIN_LIMIT_PER_MINUTE },
        inviteLimits: { perRecipientPerDay: config.INVITE_LIMIT_PER_RECIPIENT_PER_DAY },
        messageIdDomain: messageIdDomain(config),
      }),
      queries: kernelQueries({ inboundDomain: config.INBOUND_DOMAIN ?? null, overview: overviewContributions(config) }),
    }),
    finance: () => ({ commands: financeCommands, queries: financeQueries }),
    social: () => ({ commands: socialCommands, queries: socialQueries }),
    crm: () => ({ commands: crmCommands, queries: crmQueries }),
  };
  const enabled = config.CROVE_MODULES.map((module) => all[module]());
  return { commands: enabled.flatMap((m) => m.commands), queries: enabled.flatMap((m) => m.queries) };
}

// OAuth connectors of the providers this deployment has app credentials for (Social plan S6); a provider without
// them is not offered.
type ChannelConfig = Pick<Config, 'CHANNEL_SANDBOX' | 'CHANNEL_BLUESKY' | 'CHANNEL_TELEGRAM' | 'CHANNEL_MASTODON' | 'CHANNEL_DISCORD' | 'CHANNEL_WORDPRESS' | 'CHANNEL_THREADS_APP_ID' | 'CHANNEL_THREADS_APP_SECRET' | 'CHANNEL_LINKEDIN_CLIENT_ID' | 'CHANNEL_LINKEDIN_CLIENT_SECRET' | 'CHANNEL_GOOGLE_CLIENT_ID' | 'CHANNEL_GOOGLE_CLIENT_SECRET' | 'CHANNEL_GOOGLE_BUSINESS' | 'CHANNEL_TIKTOK_CLIENT_KEY' | 'CHANNEL_TIKTOK_CLIENT_SECRET' | 'CHANNEL_TIKTOK_VIDEO_LIST' | 'CHANNEL_TIKTOK_INBOX' | 'CHANNEL_X_CLIENT_ID' | 'CHANNEL_X_CLIENT_SECRET' | 'CHANNEL_PINTEREST_APP_ID' | 'CHANNEL_PINTEREST_APP_SECRET' | 'CHANNEL_META_APP_ID' | 'CHANNEL_META_APP_SECRET' | 'CHANNEL_META_GRAPH_VERSION' | 'CHANNEL_ZALO_APP_ID' | 'CHANNEL_ZALO_APP_SECRET'> &
  Partial<Pick<Config, 'CHANNEL_X_METRICS' | 'CHANNEL_LINKEDIN_ANALYTICS' | 'CHANNEL_LINKEDIN_ORGANIZATIONS' | 'CHANNEL_LINKEDIN_PAGE_CLIENT_ID' | 'CHANNEL_LINKEDIN_PAGE_CLIENT_SECRET' | 'BRAND_NAME'>>;
// The LinkedIn app, for Company Pages too once it has the Community Management API (#1077).
// The Company Pages app: its own when set (LinkedIn grants the Community Management API only to an app with no other
// product), the member app otherwise.
const linkedinPagesApp = (config: Pick<Config, 'CHANNEL_LINKEDIN_CLIENT_ID' | 'CHANNEL_LINKEDIN_CLIENT_SECRET'> & Partial<Pick<Config, 'CHANNEL_LINKEDIN_ORGANIZATIONS' | 'CHANNEL_LINKEDIN_PAGE_CLIENT_ID' | 'CHANNEL_LINKEDIN_PAGE_CLIENT_SECRET'>>) => {
  if (config.CHANNEL_LINKEDIN_ORGANIZATIONS !== 'true') return null;
  if (config.CHANNEL_LINKEDIN_PAGE_CLIENT_ID && config.CHANNEL_LINKEDIN_PAGE_CLIENT_SECRET) return { clientId: config.CHANNEL_LINKEDIN_PAGE_CLIENT_ID, clientSecret: config.CHANNEL_LINKEDIN_PAGE_CLIENT_SECRET };
  return config.CHANNEL_LINKEDIN_CLIENT_ID && config.CHANNEL_LINKEDIN_CLIENT_SECRET ? { clientId: config.CHANNEL_LINKEDIN_CLIENT_ID, clientSecret: config.CHANNEL_LINKEDIN_CLIENT_SECRET } : null;
};
const xApp = (config: Pick<Config, 'CHANNEL_X_CLIENT_ID' | 'CHANNEL_X_CLIENT_SECRET'>) => (config.CHANNEL_X_CLIENT_ID && config.CHANNEL_X_CLIENT_SECRET ? { clientId: config.CHANNEL_X_CLIENT_ID, clientSecret: config.CHANNEL_X_CLIENT_SECRET } : null);
const pinterestApp = (config: Pick<Config, 'CHANNEL_PINTEREST_APP_ID' | 'CHANNEL_PINTEREST_APP_SECRET'>) =>
  config.CHANNEL_PINTEREST_APP_ID && config.CHANNEL_PINTEREST_APP_SECRET ? { appId: config.CHANNEL_PINTEREST_APP_ID, appSecret: config.CHANNEL_PINTEREST_APP_SECRET } : null;
const zaloApp = (config: Pick<Config, 'CHANNEL_ZALO_APP_ID' | 'CHANNEL_ZALO_APP_SECRET'>) => (config.CHANNEL_ZALO_APP_ID && config.CHANNEL_ZALO_APP_SECRET ? { appId: config.CHANNEL_ZALO_APP_ID, appSecret: config.CHANNEL_ZALO_APP_SECRET } : null);

export function channelConnectors(config: Omit<ChannelConfig, 'CHANNEL_SANDBOX'>): Partial<Record<string, OAuthConnector>> {
  const connectors: Partial<Record<string, OAuthConnector>> = {};
  if (config.CHANNEL_META_APP_ID && config.CHANNEL_META_APP_SECRET) {
    const app = { appId: config.CHANNEL_META_APP_ID, appSecret: config.CHANNEL_META_APP_SECRET, graphVersion: config.CHANNEL_META_GRAPH_VERSION };
    connectors.facebook_page = new FacebookPageConnector(app);
    // Instagram professional accounts linked to the user's Pages, through the same Meta app (S6.3).
    connectors.instagram = new InstagramConnector(app);
  }
  const zalo = zaloApp(config);
  if (zalo) connectors.zalo_oa = new ZaloOaConnector(zalo);
  if (config.CHANNEL_THREADS_APP_ID && config.CHANNEL_THREADS_APP_SECRET) connectors.threads = new ThreadsConnector({ appId: config.CHANNEL_THREADS_APP_ID, appSecret: config.CHANNEL_THREADS_APP_SECRET });
  if (config.CHANNEL_LINKEDIN_CLIENT_ID && config.CHANNEL_LINKEDIN_CLIENT_SECRET) connectors.linkedin = new LinkedInConnector({ clientId: config.CHANNEL_LINKEDIN_CLIENT_ID, clientSecret: config.CHANNEL_LINKEDIN_CLIENT_SECRET, analytics: config.CHANNEL_LINKEDIN_ANALYTICS === 'true' });
  const linkedinPages = linkedinPagesApp(config);
  if (linkedinPages) connectors.linkedin_page = new LinkedInPageConnector(linkedinPages);
  if (config.CHANNEL_TIKTOK_CLIENT_KEY && config.CHANNEL_TIKTOK_CLIENT_SECRET) connectors.tiktok = new TikTokConnector({ clientKey: config.CHANNEL_TIKTOK_CLIENT_KEY, clientSecret: config.CHANNEL_TIKTOK_CLIENT_SECRET, videoList: config.CHANNEL_TIKTOK_VIDEO_LIST === 'true', inbox: config.CHANNEL_TIKTOK_INBOX === 'true' });
  if (config.CHANNEL_GOOGLE_CLIENT_ID && config.CHANNEL_GOOGLE_CLIENT_SECRET) connectors.youtube = new YouTubeConnector({ clientId: config.CHANNEL_GOOGLE_CLIENT_ID, clientSecret: config.CHANNEL_GOOGLE_CLIENT_SECRET });
  if (config.CHANNEL_GOOGLE_BUSINESS === 'true' && config.CHANNEL_GOOGLE_CLIENT_ID && config.CHANNEL_GOOGLE_CLIENT_SECRET) connectors.google_business = new GoogleBusinessConnector({ clientId: config.CHANNEL_GOOGLE_CLIENT_ID, clientSecret: config.CHANNEL_GOOGLE_CLIENT_SECRET });
  const x = xApp(config);
  if (x) connectors.x = new XConnector(x);
  const pinterest = pinterestApp(config);
  if (pinterest) connectors.pinterest = new PinterestConnector(pinterest);
  return connectors;
}

// The providers the worker publishes to: the sandbox when it is on, and each platform with app credentials.
export function channelPublishers(config: ChannelConfig): Record<string, Publisher> {
  const publishers: Record<string, Publisher> = {};
  if (config.CHANNEL_SANDBOX === 'true') publishers.sandbox = new SandboxPublisher();
  // An account on its own PDS (#792) is called through the egress guard; images go up to 1 MB each.
  if (config.CHANNEL_BLUESKY === 'true') publishers.bluesky = new BlueskyPublisher(undefined, egressFetch({ timeoutMs: 30_000, maxBytes: 2_000_000, overLimit: 'fail' }));
  if (config.CHANNEL_TELEGRAM === 'true') publishers.telegram = new TelegramPublisher();
  if (config.CHANNEL_DISCORD === 'true') publishers.discord = new DiscordPublisher();
  // An instance is the tenant's to name: its calls go through the egress guard, never a plain fetch.
  if (config.CHANNEL_MASTODON === 'true') publishers.mastodon = new MastodonPublisher(egressFetch({ timeoutMs: 300_000, maxBytes: 2_000_000, overLimit: 'fail' }));
  // A WordPress site is the tenant's to name too (#833); each call, an image upload among them, gets two minutes. A page
  // of the composer's list of its categories and tags (#1131) gets CHANNEL_OPTIONS_CALL_TIMEOUT_MS, so a slow site cannot
  // hold the option queue every org shares.
  if (config.CHANNEL_WORDPRESS === 'true') {
    publishers.wordpress = new WordPressPublisher(egressFetch({ timeoutMs: 120_000, maxBytes: 2_000_000, overLimit: 'fail' }), egressFetch({ timeoutMs: CHANNEL_OPTIONS_CALL_TIMEOUT_MS, maxBytes: 2_000_000, overLimit: 'fail' }));
  }
  if (config.CHANNEL_META_APP_ID && config.CHANNEL_META_APP_SECRET) {
    publishers.facebook_page = new FacebookPagePublisher({ appSecret: config.CHANNEL_META_APP_SECRET, graphVersion: config.CHANNEL_META_GRAPH_VERSION });
    publishers.instagram = new InstagramPublisher({ appSecret: config.CHANNEL_META_APP_SECRET, graphVersion: config.CHANNEL_META_GRAPH_VERSION });
  }
  const zalo = zaloApp(config);
  if (zalo) publishers.zalo_oa = new ZaloOaPublisher({ ...zalo, ...(config.BRAND_NAME ? { defaultAuthor: config.BRAND_NAME } : {}) });
  if (config.CHANNEL_THREADS_APP_ID && config.CHANNEL_THREADS_APP_SECRET) publishers.threads = new ThreadsPublisher();
  if (config.CHANNEL_LINKEDIN_CLIENT_ID && config.CHANNEL_LINKEDIN_CLIENT_SECRET) publishers.linkedin = new LinkedInPublisher({ analytics: config.CHANNEL_LINKEDIN_ANALYTICS === 'true' });
  if (linkedinPagesApp(config)) publishers.linkedin_page = new LinkedInPagePublisher();
  if (config.CHANNEL_TIKTOK_CLIENT_KEY && config.CHANNEL_TIKTOK_CLIENT_SECRET) publishers.tiktok = new TikTokPublisher({ clientKey: config.CHANNEL_TIKTOK_CLIENT_KEY, clientSecret: config.CHANNEL_TIKTOK_CLIENT_SECRET, videoList: config.CHANNEL_TIKTOK_VIDEO_LIST === 'true', inbox: config.CHANNEL_TIKTOK_INBOX === 'true' });
  if (config.CHANNEL_GOOGLE_CLIENT_ID && config.CHANNEL_GOOGLE_CLIENT_SECRET) publishers.youtube = new YouTubePublisher({ clientId: config.CHANNEL_GOOGLE_CLIENT_ID, clientSecret: config.CHANNEL_GOOGLE_CLIENT_SECRET });
  if (config.CHANNEL_GOOGLE_BUSINESS === 'true' && config.CHANNEL_GOOGLE_CLIENT_ID && config.CHANNEL_GOOGLE_CLIENT_SECRET) publishers.google_business = new GoogleBusinessPublisher({ clientId: config.CHANNEL_GOOGLE_CLIENT_ID, clientSecret: config.CHANNEL_GOOGLE_CLIENT_SECRET });
  const x = xApp(config);
  if (x) publishers.x = new XPublisher(x, undefined, {}, { metrics: config.CHANNEL_X_METRICS === 'true' });
  const pinterest = pinterestApp(config);
  if (pinterest) publishers.pinterest = new PinterestPublisher(pinterest);
  return publishers;
}

// Providers whose tokens the worker renews ahead of expiry (S6.4).
export function channelRefreshers(config: ChannelConfig): Record<string, Refresher> {
  const zalo = zaloApp(config);
  const refreshers: Record<string, Refresher> = {};
  if (zalo) refreshers.zalo_oa = new ZaloOaRefresher(zalo);
  if (config.CHANNEL_THREADS_APP_ID && config.CHANNEL_THREADS_APP_SECRET) refreshers.threads = new ThreadsRefresher();
  if (config.CHANNEL_TIKTOK_CLIENT_KEY && config.CHANNEL_TIKTOK_CLIENT_SECRET) refreshers.tiktok = new TikTokRefresher({ clientKey: config.CHANNEL_TIKTOK_CLIENT_KEY, clientSecret: config.CHANNEL_TIKTOK_CLIENT_SECRET });
  if (config.CHANNEL_GOOGLE_CLIENT_ID && config.CHANNEL_GOOGLE_CLIENT_SECRET) refreshers.youtube = new YouTubeRefresher({ clientId: config.CHANNEL_GOOGLE_CLIENT_ID, clientSecret: config.CHANNEL_GOOGLE_CLIENT_SECRET });
  if (config.CHANNEL_GOOGLE_BUSINESS === 'true' && config.CHANNEL_GOOGLE_CLIENT_ID && config.CHANNEL_GOOGLE_CLIENT_SECRET) refreshers.google_business = new GoogleBusinessRefresher({ clientId: config.CHANNEL_GOOGLE_CLIENT_ID, clientSecret: config.CHANNEL_GOOGLE_CLIENT_SECRET });
  const x = xApp(config);
  if (x) refreshers.x = new XRefresher(x);
  const pinterest = pinterestApp(config);
  if (pinterest) refreshers.pinterest = new PinterestRefresher(pinterest);
  return refreshers;
}

export function createKernel(config: Config, adapters: KernelAdapters): Kernel {
  // Typed callers cannot omit a port, but an entrypoint assembled at runtime can: fail at boot, not on first use.
  // ai may be null (explicitly no AI), never undefined.
  const given = adapters as Partial<KernelAdapters>;
  const missing: string[] = REQUIRED.filter((port) => given[port] === undefined);
  // A Runtime without a session source skips the ADR-0028 check, so the identity port must carry all three parts.
  const identity = given.identity as Partial<IdentityPort> | undefined;
  if (identity) {
    if (typeof identity.sessions?.check !== 'function') missing.push('identity.sessions');
    if (typeof identity.authenticator !== 'function') missing.push('identity.authenticator');
    if (identity.revoker === undefined) missing.push('identity.revoker');
  }
  if (missing.length > 0) throw new Error(`createKernel: missing adapter(s) ${missing.join(', ')}`);
  const resolved: ResolvedAdapters = {
    identity: adapters.identity,
    ai: adapters.ai,
    writer: adapters.writer ?? null,
    storage: adapters.storage,
    mail: adapters.mail ?? createLogProvider(),
    broker: adapters.broker ?? noCredentialBroker,
    connectors: adapters.connectors ?? [],
    billing: adapters.billing ?? selfHostBilling,
  };

  function buildRuntime(connectionString: string, applicationName: string) {
    const pool = createPool({ connectionString, applicationName, max: 10, resetOnRelease: config.DB_RESET_ON_RELEASE === 'true' });
    const db = createDb(pool);
    // Modules this build ships that CROVE_MODULES leaves out (ADR-0031).
    const absentModules = AVAILABLE_MODULES.filter((module) => !config.CROVE_MODULES.includes(module));
    // One database is the control plane and the only cell (Decision 14, plan §3.6).
    const runtime = new Runtime(singleCell(db), {
      // ctx.query into one of them answers not_installed; any other unknown query is QUERY_NOT_FOUND.
      absentModules,
      // Every user request is checked against its session (ADR-0028); the identity port never resolves to "no check".
      sessions: resolved.identity.sessions,
      stepUp: config.AUTH_STEP_UP,
      refusalAudit: {
        perActor: config.REFUSAL_AUDIT_LIMIT_PER_ACTOR,
        perOrg: config.REFUSAL_AUDIT_LIMIT_PER_ORG,
        reserve: config.REFUSAL_AUDIT_RESERVE_PER_ACTOR,
        windowSeconds: config.REFUSAL_AUDIT_WINDOW_SECONDS,
      },
    }).register(moduleDefinitions(config));
    // A command registry that does not fit together (a reviser naming no proposal command, two revisers for one
    // command) fails the boot (#216). Revisers of commands in modules this deployment leaves out are not checked.
    runtime.validate({ absentModules });
    return { pool, db, runtime };
  }

  async function start(role: ServerRole): Promise<() => Promise<void>> {
    const api = role === 'api' || role === 'all';
    const worker = role === 'worker' || role === 'all';
    // Both roles handle org exports (the worker seals them, the API opens them for download).
    assertExportKey(config);
    // Browser push (#1238): both roles or neither; a partial or mismatched key set stops the start.
    const vapid = loadVapidKeys(config);
    // The worker alone enters system context, so it never shares the API's login role (External-tenant gate T5).
    const workerUrl = config.WORKER_DATABASE_URL;
    if (worker && !workerUrl) throw new Error('WORKER_DATABASE_URL is required for the worker; connect it as crove_worker');
    // Files and emails are parsed only in the sandbox (External-tenant gate T12); the worker always passes this client.
    const extractUrl = config.EXTRACT_URL;
    if (worker && !extractUrl) throw new Error('EXTRACT_URL is required for the worker; point it at the crove-extract service');

    const store = resolved.storage;
    if (store instanceof LocalDiskStore) {
      // Temporary files a crashed write left behind; a fresh one may belong to a write in another process.
      const removed = await store.sweepTempFiles();
      if (removed > 0) console.log(`[storage] removed ${removed} stale temporary file(s)`);
    }
    const stops: Array<() => Promise<void>> = [];
    // Safe to call twice (SIGTERM then SIGINT): the second call finds nothing left to stop.
    const stopAll = async () => {
      const pending = stops.splice(0).reverse();
      for (const stop of pending) await stop().catch((e) => console.error(e));
    };

    try {
      if (api) {
        const { pool, db, runtime } = buildRuntime(config.DATABASE_URL, 'crove-api');
        stops.push(() => pool.end());
        await assertRlsEnforced(pool);
        await assertSystemContextAccess(pool, 'denied');
        const authenticate = resolved.identity.authenticator(db);
        // Realtime invalidation (issue #69): one LISTEN connection per process; STREAM_MAX_CONNECTIONS=0 turns it off.
        let stream: StreamDeps | undefined;
        if (config.STREAM_MAX_CONNECTIONS > 0) {
          const listenUrl = config.DATABASE_LISTEN_URL ?? config.DATABASE_URL;
          const hub = new StreamHub(createPgNotificationSource({ connectionString: listenUrl }));
          stream = {
            hub,
            tickets: createDbTicketStore(pool),
            slots: new ConcurrencyLimiter({ total: config.STREAM_MAX_CONNECTIONS, perKey: config.STREAM_MAX_PER_USER }),
            recheckSeconds: config.STREAM_RECHECK_SECONDS,
            rechecks: new Semaphore(config.STREAM_RECHECK_CONCURRENCY),
          };
        }
        // The tax portal sync seals the portal's session for the browser; without the credential key it cannot run.
        if (config.TAX_PORTAL_SYNC === 'true' && resolved.broker.id === 'none') throw new Error('TAX_PORTAL_SYNC=true needs the credential key (CREDENTIAL_KEY or CREDENTIAL_KEY_FILE)');
        if (config.TAX_PORTAL_SYNC === 'true' && config.TAX_PORTAL_URL && !testPortalAllowed(config.TAX_PORTAL_URL, config.PUBLIC_URL)) {
          throw new Error('TAX_PORTAL_URL points the tax portal sync away from https://hoadondientu.gdt.gov.vn: allowed only for a test deployment on localhost or a .test name');
        }
        if (config.TAX_PORTAL_SYNC === 'true' && config.TAX_PORTAL_URL) console.warn(`[api] TAX_PORTAL_URL points the tax portal sync at ${new URL(config.TAX_PORTAL_URL).origin}, not the real portal`);
        const app = createHttpApp({
          config,
          runtime,
          store,
          authenticate,
          pool,
          aiEnabled: resolved.ai !== null,
          ...(resolved.writer ? { socialWriter: socialDrafter(resolved.writer, config.AI_VISION === 'true' ? store : null) } : {}),
          ...(config.TAX_CODE_LOOKUP_URL ? { taxLookup: createTaxCodeLookup(config.TAX_CODE_LOOKUP_URL) } : {}),
          ...(config.TAX_PORTAL_SYNC === 'true' ? { portalSync: createPortalSync({ runtime, store, broker: resolved.broker, stepMs: config.TAX_PORTAL_STEP_SECONDS * 1000, client: createTaxPortalClient(config.TAX_PORTAL_URL ? { baseUrl: config.TAX_PORTAL_URL } : {}) }) } : {}),
          mailer: resolved.mail,
          channels: { broker: resolved.broker, sandbox: config.CHANNEL_SANDBOX === 'true', bluesky: config.CHANNEL_BLUESKY === 'true', telegram: config.CHANNEL_TELEGRAM === 'true', mastodon: config.CHANNEL_MASTODON === 'true', discord: config.CHANNEL_DISCORD === 'true', wordpress: config.CHANNEL_WORDPRESS === 'true', connectors: channelConnectors(config), publicUrl: config.PUBLIC_URL, ...(config.MEDIA_PEXELS_API_KEY ? { stockPhotos: createPexels({ apiKey: config.MEDIA_PEXELS_API_KEY, store }) } : {}), mediaUrls: createMediaUrls({ store }), ...(vapid ? { push: { publicKey: vapid.publicKey } } : {}) },
          ...(stream ? { stream } : {}),
        });
        const server = serve({ fetch: app.fetch, port: config.PORT, hostname: config.HOST });
        console.log(`[api] listening on ${config.HOST}:${config.PORT}`);
        stops.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
        // Stopped before the server (stops run in reverse): open streams would keep server.close() waiting.
        const hub = stream?.hub;
        if (hub) {
          stops.push(() => hub.stop());
          hub.start();
        }
      }

      if (worker && workerUrl && extractUrl) {
        console.log(`[extract] parsing in crove-extract at ${new URL(extractUrl).host}`);
        const { pool, db, runtime } = buildRuntime(workerUrl, 'crove-worker');
        stops.push(() => pool.end());
        await assertRlsEnforced(pool);
        await assertSystemContextAccess(pool, 'granted');
        // The WORM archive (#891): an S3 archive without Object Lock stops the worker before it writes anything.
        const archiveStore = createArchiveStore(config);
        await archiveStore.assertObjectLock?.();
        console.log(`[archive] ${archiveStore.describe()}`);
        stops.push(
          await startWorker({
            connectionString: workerUrl,
            workerDb: db,
            runtime,
            store,
            extractor: resolved.ai,
            extract: createExtractClient({ url: extractUrl }),
            inboundDomain: config.INBOUND_DOMAIN ?? null,
            revoker: resolved.identity.revoker,
            refusalTallyRetentionDays: config.REFUSAL_TALLY_RETENTION_DAYS,
            agentPrograms: { ...financeAgentPrograms, ...socialAgentPrograms, ...crmAgentPrograms },
            exportSealer: exportSealer(config),
            exportRetentionDays: config.EXPORT_RETENTION_DAYS,
            evidenceLockDays: config.EVIDENCE_LOCK_DAYS,
            channels: { broker: resolved.broker, publishers: channelPublishers(config), refreshers: channelRefreshers(config) },
            publicUrl: config.PUBLIC_URL,
            brand: config.BRAND_NAME,
            // Bounce reports reach this deployment only with both inbound settings (as for the invite mail).
            mail: { mailer: resolved.mail, templates: MAIL_TEMPLATES, brand: config.BRAND_NAME, bounceDomain: config.INBOUND_DOMAIN && config.INBOUND_SECRET ? config.INBOUND_DOMAIN : null },
            archive: { store: archiveStore, lagSeconds: config.ARCHIVE_LAG_SECONDS },
            usageLimits: usageLimits(config),
            securityAlerts: securityAlerts(config),
            aiPrice: { inputPerMTok: config.AI_PRICE_INPUT_PER_MTOK, outputPerMTok: config.AI_PRICE_OUTPUT_PER_MTOK },
            outboxLagPauseSeconds: config.OUTBOX_LAG_PAUSE_SECONDS,
            ...(vapid ? { push: { sender: createPushSender(vapid), brand: config.BRAND_NAME } } : {}),
          }),
        );
        // The worker watchdog (#894, plan §4.9): a loop blocked over 5 s for 30 s exits the process, which restarts.
        const stopWatchdog = startLagWatchdog({ thresholdMs: WORKER_LAG_EXIT_MS, sustainMs: WORKER_LAG_SUSTAIN_MS, exit: (code) => process.exit(code) });
        stops.push(async () => stopWatchdog());
      }
    } catch (error) {
      await stopAll();
      throw error;
    }
    return stopAll;
  }

  async function rebindExports(orgIds: readonly string[]): Promise<number> {
    // System commands need system context, which only the worker's login role may enter (External-tenant gate T5).
    const workerUrl = config.WORKER_DATABASE_URL;
    if (!workerUrl) throw new Error('WORKER_DATABASE_URL is required for exports-rebind; run it in the worker container');
    const { pool, runtime } = buildRuntime(workerUrl, 'crove-restore');
    try {
      await assertRlsEnforced(pool);
      await assertSystemContextAccess(pool, 'granted');
      return await rebindOrgExports({ runtime, store: resolved.storage }, orgIds);
    } finally {
      await pool.end();
    }
  }

  // The operator's user-disable and user-enable roles (#985): the worker login is the only role that may execute
  // crove_kernel.user_set_disabled and enter the system context the audit notes run in.
  async function setUserStatus(disabled: boolean, argv: readonly string[]): Promise<number> {
    const workerUrl = config.WORKER_DATABASE_URL;
    if (!workerUrl) throw new Error(`WORKER_DATABASE_URL is required for ${disabled ? 'user-disable' : 'user-enable'}; run it in the worker container`);
    const { pool, runtime } = buildRuntime(workerUrl, 'crove-operator');
    try {
      await assertRlsEnforced(pool);
      await assertSystemContextAccess(pool, 'granted');
      return await runUserDisable({ runtime }, disabled, argv);
    } finally {
      // Best effort: a failure to close never hides the run's own outcome.
      await pool.end().catch((error: unknown) => console.error('[user-status] could not close the pool', error));
    }
  }

  // The operator's org-purge role (#1024): the worker login is the only role that may execute crove_kernel.org_purge
  // and enter the system context the purge runs in. Its command deletes blobs, so only this runtime registers it.
  async function purgeOrg(argv: readonly string[]): Promise<number> {
    const workerUrl = config.WORKER_DATABASE_URL;
    if (!workerUrl) throw new Error('WORKER_DATABASE_URL is required for org-purge; run it in the worker container');
    const { pool, runtime } = buildRuntime(workerUrl, 'crove-operator');
    runtime.register({ commands: [orgPurgeCommand({ store: resolved.storage })] });
    try {
      await assertRlsEnforced(pool);
      await assertSystemContextAccess(pool, 'granted');
      return await runOrgPurge({ runtime, minDays: config.ORG_PURGE_MIN_DAYS }, argv);
    } finally {
      // Best effort: a failure to close never hides the run's own outcome.
      await pool.end().catch((error: unknown) => console.error('[org-purge] could not close the pool', error));
    }
  }

  return { config, modules: config.CROVE_MODULES, adapters: resolved, start, rebindExports, setUserStatus, purgeOrg };
}

// The Social writer as the API uses it: drafts, rewrites, hashtags, post ideas (#1181) and period summaries (#1237) as
// they are, and with an image-capable model (AI_VISION) an image's alt text from its stored bytes, read and checked
// like a download (#817), never more of them than the file row records (#1126), and a draft from the post's photos
// (#1191), each read the same way, one after another, before the one model call.
export function socialDrafter(writer: NonNullable<KernelAdapters['writer']>, store: BlobStore | null): SocialDrafter {
  const describe = writer.describeImage?.bind(writer);
  return {
    draft: (request) => writer.draft(request),
    rewrite: (request) => writer.rewrite(request),
    ...(writer.hashtags ? { hashtags: writer.hashtags.bind(writer) } : {}),
    ...(writer.ideas ? { ideas: writer.ideas.bind(writer) } : {}),
    ...(writer.summary ? { summary: writer.summary.bind(writer) } : {}),
    ...(store && describe
      ? { describeStored: async (file, mime, language, maxChars) => describe({ image: await readVerified(store, file, file.sizeBytes), mime, language, maxChars: maxChars ?? null }) }
      : {}),
    ...(store
      ? {
          draftStored: async (request, images) => {
            const read: { image: Uint8Array; mime: string }[] = [];
            for (const i of images) read.push({ image: await readVerified(store, i.file, i.file.sizeBytes), mime: i.mime });
            return writer.draft({ ...request, images: read });
          },
        }
      : {}),
  };
}

// The open-source defaults, built from configuration: Supabase Auth identity (ADR-0028), any OpenAI-compatible
// endpoint for AI, local disk or S3-compatible storage, SMTP for mail. No DOS service.
export function defaultAdapters(config: Config): KernelAdapters {
  const aiConfig =
    config.AI_BASE_URL && config.AI_MODEL
      ? { baseURL: config.AI_BASE_URL, apiKey: config.AI_API_KEY ?? null, model: config.AI_MODEL, supportsStructuredOutputs: config.AI_STRUCTURED_OUTPUTS === 'true' }
      : null;
  return {
    identity: {
      sessions: createSessionStatusSource(config.AUTH_SESSION_CHECK),
      authenticator: (db) => createAuthenticator(config, db),
      revoker: createSessionRevoker(config),
    },
    ai: aiConfig ? new InvoiceExtractor(aiConfig) : null,
    writer: aiConfig ? new SocialWriter(aiConfig) : null,
    // API and worker build the same store from config; with STORAGE=s3 they share no volume (T7).
    storage: createBlobStore(config),
    // SMTP from SMTP_*; without SMTP_HOST, the log fallback.
    mail: createMailer(config),
    // crove-local: the vault keyed by CREDENTIAL_KEY or CREDENTIAL_KEY_FILE; none without a key (ADR-0025).
    broker: createCredentialBroker(config),
  };
}

// The worker's detective security alerts (#996): the thresholds, and the prober's webhook when it is set. A webhook the
// prober would refuse (a Telegram one without its chat id) is reported once and the alerts stay in the log.
function securityAlerts(config: Config): { target: WebhookTarget | null; thresholds: SecurityThresholds } {
  const thresholds: SecurityThresholds = {
    windowSeconds: config.SECURITY_ALERT_WINDOW_SECONDS,
    orgThreshold: config.SECURITY_ALERT_ORG_THRESHOLD,
    refusalThreshold: config.SECURITY_ALERT_REFUSAL_THRESHOLD,
    repeatSeconds: config.SECURITY_ALERT_REPEAT_MINUTES * 60,
  };
  try {
    const target = webhookTarget(
      {
        ALERT_WEBHOOK_URL: config.ALERT_WEBHOOK_URL,
        ALERT_WEBHOOK_FORMAT: config.ALERT_WEBHOOK_FORMAT,
        ALERT_TELEGRAM_CHAT_ID: config.ALERT_TELEGRAM_CHAT_ID,
        ALERT_INSTANCE: config.ALERT_INSTANCE,
        PUBLIC_URL: config.PUBLIC_URL,
      },
      'security alerts',
    );
    return { target, thresholds };
  } catch (error) {
    console.error(`[security] ALERT ${error instanceof Error ? error.message : String(error)}; security alerts go to the log only`);
    return { target: null, thresholds };
  }
}
