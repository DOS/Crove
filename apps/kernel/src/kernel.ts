// The composition root (plan Decision 12, ADR-0030). createKernel takes the configuration and one adapter per port
// and starts the server roles; it builds no adapter itself. main.ts wires the open-source defaults from
// configuration (defaultAdapters); a Crove Cloud entrypoint wires its own adapters into the same factory.
import { serve } from '@hono/node-server';
import { InvoiceExtractor, type InvoiceReader } from '@crove/agent';
import { createExtractClient } from '@crove/extract-contract';
import { assertRlsEnforced, assertSystemContextAccess, createDb, createPool, singleCell, type Db } from '@crove/db';
import { buildKernelCommands, kernelQueries } from '@crove/kernel';
import {
  LocalDiskStore,
  Runtime,
  type BlobStore,
  type CommandDef,
  type CredentialBroker,
  type QueryDef,
  type SessionStatusSource,
} from '@crove/kernel-runtime';
import { financeAgentPrograms, financeCommands, financeQueries } from '@crove/mod-finance';
import { createAuthenticator, type Authenticate } from './auth.ts';
import { AVAILABLE_MODULES, assertExportKey, type Config, type ModuleId } from './config.ts';
import { createCredentialBroker, noCredentialBroker } from './credentials.ts';
import { exportSealer } from './export-seal.ts';
import { ConcurrencyLimiter, Semaphore } from './concurrency.ts';
import { createHttpApp, type StreamDeps } from './http.ts';
import { createLogMailer, createMailer, type Mailer } from './mail.ts';
import { createSessionRevoker, createSessionStatusSource, type SessionRevoker } from './sessions.ts';
import { createBlobStore } from './storage.ts';
import { StreamHub, createDbTicketStore, createPgNotificationSource } from './stream.ts';
import { startWorker } from './worker.ts';

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
  storage: BlobStore;
  // Outbound mail (member invites, issue #129); the default logs that nothing was sent.
  mail?: Mailer;
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
}

// No-op defaults for the optional ports: nothing can be bound, no connector is installed, every module is on.
export const selfHostBilling: Billing = { entitlements: async () => ['full'] };

const REQUIRED = ['identity', 'ai', 'storage'] as const;

export interface ModuleDefinitions {
  commands: CommandDef<any, any>[];
  queries: QueryDef<any, any>[];
}

// The commands and queries of the modules CROVE_MODULES enables (plan Decision 12, ADR-0031). A module left out has
// none registered, so its commands answer COMMAND_NOT_FOUND, a ctx.query into it answers not_installed (with the
// absentModules buildRuntime passes), and the
// routes and jobs that ask Runtime.installed() are not registered either.
export function moduleDefinitions(config: Config): ModuleDefinitions {
  const all: Record<ModuleId, () => ModuleDefinitions> = {
    kernel: () => ({
      commands: buildKernelCommands({
        orgCreateLimits: { perDay: config.ORG_CREATE_LIMIT_PER_DAY, total: config.ORG_CREATE_LIMIT_TOTAL },
        inboundRotateLimits: { perDay: config.INBOUND_ROTATE_LIMIT_PER_DAY, total: config.INBOUND_ROTATE_LIMIT_TOTAL },
        uploadBeginLimits: { perMinute: config.UPLOAD_BEGIN_LIMIT_PER_MINUTE },
        inviteLimits: { perRecipientPerDay: config.INVITE_LIMIT_PER_RECIPIENT_PER_DAY },
      }),
      queries: kernelQueries({ inboundDomain: config.INBOUND_DOMAIN ?? null }),
    }),
    finance: () => ({ commands: financeCommands, queries: financeQueries }),
  };
  const enabled = config.CROVE_MODULES.map((module) => all[module]());
  return { commands: enabled.flatMap((m) => m.commands), queries: enabled.flatMap((m) => m.queries) };
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
    storage: adapters.storage,
    mail: adapters.mail ?? createLogMailer(),
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
        const app = createHttpApp({
          config,
          runtime,
          store,
          authenticate,
          pool,
          aiEnabled: resolved.ai !== null,
          mailer: resolved.mail,
          channels: { broker: resolved.broker, sandbox: config.CHANNEL_SANDBOX === 'true' },
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
            agentPrograms: financeAgentPrograms,
            exportSealer: exportSealer(config),
            exportRetentionDays: config.EXPORT_RETENTION_DAYS,
          }),
        );
      }
    } catch (error) {
      await stopAll();
      throw error;
    }
    return stopAll;
  }

  return { config, modules: config.CROVE_MODULES, adapters: resolved, start };
}

// The open-source defaults, built from configuration: Supabase Auth identity (ADR-0028), any OpenAI-compatible
// endpoint for AI, local disk or S3-compatible storage, SMTP for mail. No DOS service.
export function defaultAdapters(config: Config): KernelAdapters {
  return {
    identity: {
      sessions: createSessionStatusSource(config.AUTH_SESSION_CHECK),
      authenticator: (db) => createAuthenticator(config, db),
      revoker: createSessionRevoker(config),
    },
    ai:
      config.AI_BASE_URL && config.AI_MODEL
        ? new InvoiceExtractor({
            baseURL: config.AI_BASE_URL,
            apiKey: config.AI_API_KEY ?? null,
            model: config.AI_MODEL,
            supportsStructuredOutputs: config.AI_STRUCTURED_OUTPUTS === 'true',
          })
        : null,
    // API and worker build the same store from config; with STORAGE=s3 they share no volume (T7).
    storage: createBlobStore(config),
    // SMTP from SMTP_*; without SMTP_HOST, the log fallback.
    mail: createMailer(config),
    // crove-local: the vault keyed by CREDENTIAL_KEY or CREDENTIAL_KEY_FILE; none without a key (ADR-0025).
    broker: createCredentialBroker(config),
  };
}
