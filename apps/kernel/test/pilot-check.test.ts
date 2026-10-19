// Pilot readiness preflight (issue #308): the settings checks, the live probe with a fake fetch, and the exit codes.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { KNOWN_DEFAULTS, PILOT_EXIT, REQUIRED_SECRETS, checkEnv, parsePilotArgs, probeDeployment, runPilotCheck, type CheckResult, type Env, type Fetch } from '../src/pilot-check.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

// Stand-in secrets built at run time, so no literal looks like a leaked key to gitleaks.
const fake = (name: string, length = 20) => `${name}-`.padEnd(length, '7');

const READY: Env = {
  PUBLIC_URL: 'https://crove.example.com',
  POSTGRES_PASSWORD: fake('pg'),
  CROVE_APP_DB_PASSWORD: fake('app'),
  CROVE_WORKER_DB_PASSWORD: fake('worker'),
  CROVE_PROBER_DB_PASSWORD: fake('prober'),
  CROVE_REPORTER_DB_PASSWORD: fake('reporter'),
  AUTH_DB_PASSWORD: fake('auth'),
  AUTH_JWT_SECRET: fake('jwt', 40),
  EXPORT_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  AUTH_AUTOCONFIRM: 'false',
  AUTH_STEP_UP: 'required',
  AUTH_DISABLE_SIGNUP: 'true',
  SMTP_HOST: 'smtp.mailprovider.example',
  ALERT_WEBHOOK_URL: `https://alerts.example.com/hook/${fake('hook')}`,
  PROBER_HEARTBEAT_URL: `https://hc.example.com/ping/${fake('check')}`,
  COMPOSE_PROFILES: 'prober',
};

const failures = (results: readonly CheckResult[]) => results.filter((r) => r.status === 'fail');
const failing = (env: Env) => failures(checkEnv(env)).map((r) => `${r.item}: ${r.message}`);

describe('pilot-check settings', () => {
  it('passes a ready deployment and leaves the human items as manual', () => {
    const results = checkEnv(READY);
    expect(failures(results)).toEqual([]);
    expect(results.filter((r) => r.status === 'manual').map((r) => r.item)).toEqual(['Alerts', 'Extraction sandbox', 'RLS matrix', 'Backups', 'Owner sign-off']);
    expect(results.find((r) => r.item === 'Alerts' && r.status === 'pass')?.message).toBe('alerts go to alerts.example.com, from the prober the compose profile starts');
  });

  it('requires alerts on an https webhook the prober accepts (M1-9, issue #309)', () => {
    expect(failing({ ...READY, ALERT_WEBHOOK_URL: undefined })).toEqual([expect.stringContaining('ALERT_WEBHOOK_URL is unset')]);
    expect(failing({ ...READY, ALERT_WEBHOOK_URL: 'http://alerts.example.com/hook' })).toEqual([expect.stringContaining('ALERT_WEBHOOK_URL is not https')]);
    expect(failing({ ...READY, ALERT_WEBHOOK_URL: 'not a url' })).toEqual([expect.stringContaining('ALERT_WEBHOOK_URL is not a URL')]);
    expect(failing({ ...READY, PROBER_HEARTBEAT_URL: 'http://hc.example.com/ping/x' })).toEqual([expect.stringContaining('PROBER_HEARTBEAT_URL is not https')]);
    // The prober's own rules: a Telegram webhook needs the chat id.
    const telegram = { ...READY, ALERT_WEBHOOK_URL: `https://api.telegram.org/bot${fake('token')}/sendMessage` };
    expect(failing(telegram)).toEqual([expect.stringContaining('ALERT_TELEGRAM_CHAT_ID')]);
    expect(failing({ ...telegram, ALERT_TELEGRAM_CHAT_ID: '-1001234567890' })).toEqual([]);
  });

  it('asks to confirm the prober cron and the heartbeat when the settings do not show them', () => {
    const manual = (env: Env) => checkEnv(env).filter((r) => r.item === 'Alerts' && r.status === 'manual').map((r) => r.message);
    expect(manual(READY)).toEqual([expect.stringContaining('PUBLIC_URL/healthz every 5 minutes')]);
    const bare = manual({ ...READY, COMPOSE_PROFILES: undefined, PROBER_HEARTBEAT_URL: undefined });
    expect(bare).toEqual([expect.stringContaining('healthz'), expect.stringContaining('COMPOSE_PROFILES does not include prober'), expect.stringContaining('PROBER_HEARTBEAT_URL is unset')]);
    expect(manual({ ...READY, COMPOSE_PROFILES: 'tools, prober' })).toHaveLength(1);
  });

  it('fails an empty .env: docker compose would run every local default', () => {
    const problems = failing({});
    expect(problems.some((p) => p.startsWith('TLS: PUBLIC_URL is unset'))).toBe(true);
    for (const name of REQUIRED_SECRETS) expect(problems.some((p) => p.startsWith(`Secrets: ${name} is unset`)), name).toBe(true);
    expect(problems.some((p) => p.includes('AUTH_AUTOCONFIRM is unset'))).toBe(true);
    expect(problems.some((p) => p.includes('SMTP_HOST is unset'))).toBe(true);
    expect(problems.some((p) => p.startsWith('Sign-up limited: AUTH_DISABLE_SIGNUP is unset'))).toBe(true);
  });

  it('requires https on the public URLs browsers open', () => {
    expect(failing({ ...READY, PUBLIC_URL: 'http://crove.example.com' })).toEqual([expect.stringContaining('PUBLIC_URL is http://crove.example.com')]);
    expect(failing({ ...READY, PUBLIC_URL: 'https://localhost:8080' })).toEqual([expect.stringContaining('loopback')]);
    expect(failing({ ...READY, PUBLIC_URL: 'not a url' })).toEqual([expect.stringContaining('not a URL')]);
    expect(failing({ ...READY, PUBLIC_AUTH_URL: 'http://auth.example.com/auth/v1' })).toEqual([expect.stringContaining('PUBLIC_AUTH_URL')]);
    const s3 = { ...READY, STORAGE: 's3', S3_ENDPOINT: 'http://minio:9000' };
    expect(failing(s3)).toEqual([expect.stringContaining('S3_ENDPOINT')]);
    expect(failing({ ...s3, S3_PUBLIC_ENDPOINT: 'https://files.example.com' })).toEqual([]);
    expect(failing({ ...s3, S3_PUBLIC_ENDPOINT: 'http://files.example.com' })).toEqual([expect.stringContaining('S3_PUBLIC_ENDPOINT')]);
    // Transfers through the kernel never send the browser to the bucket.
    expect(failing({ ...s3, S3_PRESIGNED_URLS: 'false' })).toEqual([]);
  });

  it('refuses sample, short and malformed secrets', () => {
    expect(failing({ ...READY, POSTGRES_PASSWORD: 'change-me-postgres' })).toEqual([expect.stringContaining('POSTGRES_PASSWORD still has a sample value')]);
    expect(failing({ ...READY, AUTH_DB_PASSWORD: 'my-own-Change-Me-pass' })).toEqual([expect.stringContaining('AUTH_DB_PASSWORD still has a sample value')]);
    expect(failing({ ...READY, CROVE_APP_DB_PASSWORD: 'short' })).toEqual([expect.stringContaining('shorter than 16')]);
    expect(failing({ ...READY, AUTH_JWT_SECRET: 'x'.repeat(31) })).toEqual([expect.stringContaining('shorter than 32')]);
    expect(failing({ ...READY, EXPORT_ENCRYPTION_KEY: 'not-a-key' })).toEqual([expect.stringContaining('EXPORT_ENCRYPTION_KEY is not 32 bytes')]);
    expect(failing({ ...READY, INBOUND_DOMAIN: 'in.example.com' })).toEqual([expect.stringContaining('INBOUND_SECRET is unset')]);
    expect(failing({ ...READY, INBOUND_DOMAIN: 'in.example.com', INBOUND_SECRET: 'z'.repeat(40) })).toEqual([]);
    expect(failing({ ...READY, S3_SECRET_ACCESS_KEY: 'crove-split-minio-secret' })).toEqual([expect.stringContaining('S3_SECRET_ACCESS_KEY still has a sample value')]);
  });

  it('requires email confirmation with a real SMTP server and MFA step-up', () => {
    expect(failing({ ...READY, AUTH_AUTOCONFIRM: 'true' })).toEqual([expect.stringContaining('AUTH_AUTOCONFIRM=true')]);
    expect(failing({ ...READY, AUTH_AUTOCONFIRM: undefined })).toEqual([expect.stringContaining('AUTH_AUTOCONFIRM is unset')]);
    expect(failing({ ...READY, SMTP_HOST: 'smtp.example.com' })).toEqual([expect.stringContaining('SMTP_HOST is smtp.example.com')]);
    expect(failing({ ...READY, SMTP_HOST: 'mailpit' })).toEqual([expect.stringContaining('SMTP_HOST is mailpit')]);
    expect(failing({ ...READY, SMTP_HOST: '127.0.0.1' })).toEqual([expect.stringContaining('SMTP_HOST is 127.0.0.1')]);
    expect(failing({ ...READY, AUTH_STEP_UP: 'off' })).toEqual([expect.stringContaining('AUTH_STEP_UP=off')]);
    // Unset is the kernel's and docker compose's default, required.
    expect(failing({ ...READY, AUTH_STEP_UP: undefined })).toEqual([]);
  });

  it('requires sign-up to be closed', () => {
    expect(failing({ ...READY, AUTH_DISABLE_SIGNUP: 'false' })).toEqual([expect.stringContaining('AUTH_DISABLE_SIGNUP is false')]);
    expect(failing({ ...READY, AUTH_DISABLE_SIGNUP: undefined })).toEqual([expect.stringContaining('AUTH_DISABLE_SIGNUP is unset')]);
  });

  it('knows every secret value this repository ships in .env.example and the compose files', () => {
    const secrets = new Set<string>([...REQUIRED_SECRETS, 'INBOUND_SECRET', 'S3_SECRET_ACCESS_KEY']);
    const shipped: string[] = [];
    for (const line of readFileSync(`${ROOT}.env.example`, 'utf8').split('\n')) {
      const match = /^([A-Z0-9_]+)=(.+)$/.exec(line.trim());
      if (match && secrets.has(match[1]!)) shipped.push(match[2]!);
    }
    for (const file of ['docker-compose.yml', 'docker-compose.split.yml']) {
      const text = readFileSync(`${ROOT}${file}`, 'utf8');
      for (const match of text.matchAll(/\$\{([A-Z0-9_]+):-([^}]+)\}/g)) if (secrets.has(match[1]!)) shipped.push(match[2]!);
      for (const match of text.matchAll(/^\s+([A-Z0-9_]+): ([^${\s][^\s]*)$/gm)) if (secrets.has(match[1]!)) shipped.push(match[2]!.replace(/^'|'$/g, ''));
    }
    expect(shipped.length).toBeGreaterThan(10);
    for (const value of shipped) expect(KNOWN_DEFAULTS.has(value), value).toBe(true);
  });
});

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;

function fakeFetch(routes: Record<string, Route>): Fetch {
  return async (input, init) => {
    const route = routes[input];
    if (!route) throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
    return route(input, init);
  };
}

const json = (body: unknown) => () => Response.json(body);
const healthy = {
  'https://crove.example.com/healthz': json({ ok: true }),
  'https://crove.example.com/api/config': json({ authUrl: 'https://crove.example.com/auth/v1', authAnonKey: null }),
  'https://crove.example.com/auth/v1/settings': json({ disable_signup: true, mailer_autoconfirm: false }),
};

describe('pilot-check probe', () => {
  it('passes a deployment with valid TLS, closed plain http and closed sign-up', async () => {
    const results = await probeDeployment('https://crove.example.com', fakeFetch(healthy));
    expect(failures(results)).toEqual([]);
    expect(results.map((r) => r.item)).toEqual(['TLS', 'TLS', 'Sign-up limited', 'Email confirmation and MFA step-up']);
  });

  it('accepts a plain-http redirect to https on the same host and refuses plain-http service', async () => {
    const redirectTo = (location: string) => ({ ...healthy, 'http://crove.example.com/healthz': () => new Response(null, { status: 301, headers: { location } }) });
    expect(failures(await probeDeployment('https://crove.example.com', fakeFetch(redirectTo('https://crove.example.com/healthz'))))).toEqual([]);
    for (const location of ['https://elsewhere.example.net/', 'http://crove.example.com/', 'not a url']) {
      expect(failures(await probeDeployment('https://crove.example.com', fakeFetch(redirectTo(location)))).map((r) => r.message), location).toEqual([
        expect.stringContaining('over plain http'),
      ]);
    }
    const served = { ...healthy, 'http://crove.example.com/healthz': json({ ok: true }) };
    expect(failures(await probeDeployment('https://crove.example.com', fakeFetch(served))).map((r) => r.message)).toEqual([expect.stringContaining('over plain http')]);
  });

  it('passes closed plain http only on a refused connection, not on a timeout', async () => {
    const timeout: Fetch = async (input, init) => {
      if (input.startsWith('http:')) throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      return fakeFetch(healthy)(input, init);
    };
    expect(failures(await probeDeployment('https://crove.example.com', timeout)).map((r) => r.message)).toEqual([expect.stringContaining('could not tell whether http://crove.example.com')]);
  });

  it('probes port 80 for plain http whatever port the https URL uses', async () => {
    const seen: string[] = [];
    const record: Fetch = async (input, init) => {
      seen.push(input);
      return fakeFetch({ 'https://crove.example.com:8443/healthz': json({ ok: true }) })(input, init);
    };
    await probeDeployment('https://crove.example.com:8443', record);
    expect(seen).toContain('http://crove.example.com/healthz');
  });

  it('reports a certificate error and an http origin', async () => {
    const badCert: Fetch = async (input, init) => {
      if (input.endsWith('/healthz') && input.startsWith('https:')) throw new TypeError('fetch failed', { cause: Object.assign(new Error('certificate has expired'), { code: 'CERT_HAS_EXPIRED' }) });
      return fakeFetch(healthy)(input, init);
    };
    expect(failures(await probeDeployment('https://crove.example.com', badCert)).map((r) => r.message)).toEqual([expect.stringContaining('CERT_HAS_EXPIRED')]);
    expect(failures(await probeDeployment('http://crove.example.com', fakeFetch({}))).map((r) => r.message)).toEqual([
      'http://crove.example.com is not https',
      expect.stringContaining('could not read the Supabase Auth settings'),
      expect.stringContaining('could not read the Supabase Auth settings'),
    ]);
  });

  it('reads what the running Supabase Auth does', async () => {
    const open = { ...healthy, 'https://crove.example.com/auth/v1/settings': json({ disable_signup: false, mailer_autoconfirm: true }) };
    expect(failures(await probeDeployment('https://crove.example.com', fakeFetch(open))).map((r) => r.item)).toEqual(['Sign-up limited', 'Email confirmation and MFA step-up']);
    // Every fetch refuses redirects, except the ones that inspect them.
    const modes: (RequestRedirect | undefined)[] = [];
    const record: Fetch = async (input, init) => {
      modes.push(init?.redirect);
      return fakeFetch(healthy)(input, init);
    };
    await probeDeployment('https://crove.example.com', record);
    expect(modes).toEqual(['manual', 'manual', 'error', 'error']);
  });

  it('never fetches an Auth URL the instance names on another origin', async () => {
    for (const authUrl of ['https://auth.example.net/auth/v1', 'http://crove.example.com/auth/v1', 'http://169.254.169.254/latest', 'http://localhost:8080/auth/v1', 'nope']) {
      const seen: string[] = [];
      const record: Fetch = async (input, init) => {
        seen.push(input);
        return fakeFetch({ ...healthy, 'https://crove.example.com/api/config': json({ authUrl }) })(input, init);
      };
      const failed = failures(await probeDeployment('https://crove.example.com', record));
      expect(failed.map((r) => r.item), authUrl).toEqual(['Sign-up limited', 'Email confirmation and MFA step-up']);
      expect(seen.filter((u) => u.endsWith('/settings')), authUrl).toEqual([]);
    }
  });
});

describe('pilot-check command', () => {
  it('parses --url to an origin and refuses anything else', () => {
    expect(parsePilotArgs([])).toEqual({ url: null });
    expect(parsePilotArgs(['--', '--url', 'https://crove.example.com/inbox'])).toEqual({ url: 'https://crove.example.com' });
    for (const argv of [['--url'], ['--url', 'nope'], ['--url', 'ftp://x.example.com'], ['--env']]) expect(() => parsePilotArgs(argv), argv.join(' ')).toThrow();
  });

  it('exits 0 when ready, 1 on a failed check, 2 on bad arguments', async () => {
    const lines: string[] = [];
    const print = (line: string) => lines.push(line);
    expect(await runPilotCheck([], READY, fakeFetch({}), print)).toBe(PILOT_EXIT.ok);
    expect(lines.join('\n')).toContain('Automatic checks passed. Confirm the 5 manual item(s)');
    expect(await runPilotCheck(['--url', 'https://crove.example.com'], READY, fakeFetch(healthy), print)).toBe(PILOT_EXIT.ok);
    lines.length = 0;
    expect(await runPilotCheck([], { ...READY, AUTH_DISABLE_SIGNUP: 'false' }, fakeFetch({}), print)).toBe(PILOT_EXIT.failed);
    expect(lines.join('\n')).toMatch(/^FAIL +Sign-up limited/m);
    expect(lines.join('\n')).toContain('NOT READY: 1 check(s) failed');
    expect(await runPilotCheck(['--bogus'], READY, fakeFetch({}), print)).toBe(PILOT_EXIT.error);
  });
});
