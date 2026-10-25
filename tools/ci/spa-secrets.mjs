// Secret scan of the built web app (kernel plan §9: "CI fails if the SPA build contains SUPABASE_SERVICE_ROLE or any
// kernel secret"; issue #1518). The SPA is static files every browser downloads, so a kernel secret that reaches the
// bundle (a config module imported by mistake, an env var inlined by the bundler) is public. gitleaks scans the source;
// this scans what ships.
//
// Two checks over every file of the build:
// - kernel secret names used as code: `env.NAME`, `"NAME":`, `NAME=` or the bare string "NAME". The names are read
//   from the kernel's config schema (apps/kernel/src/config.ts), so a new secret is covered without a list to keep.
//   A name in a sentence for the operator ("no key to seal credentials (CREDENTIAL_KEY)") is not code and passes.
// - secret-shaped values: a JWT, a PEM private key, an AWS access key id, a Resend or Stripe live key, a webhook
//   signing secret, and the sample secrets the kernel refuses to boot with.
//
// Usage: node tools/ci/spa-secrets.mjs [dist-dir] [config-file]
//   Defaults: apps/app/dist and apps/kernel/src/config.ts. Exits 1 and names each finding (file, kind, a short
//   excerpt with the value masked).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

// A config key is a secret when its name says so. PUBLIC_* keys and Turnstile's site key are meant for browsers, and
// VAPID's public key is published to push services.
const SECRET_NAME = /(SECRET|PASSWORD|_KEY$|_KEY_|KEY_ID|TOKEN|DATABASE_URL)/;
const PUBLIC_NAME = /^PUBLIC_|_SITE_KEY$|^VAPID_PUBLIC_KEY$/;
// Never in the kernel's config, but named by the plan: Supabase's service role key bypasses row-level security.
const ALWAYS = ['SUPABASE_SERVICE_ROLE', 'SUPABASE_SERVICE_ROLE_KEY'];

export function secretNames(configSource) {
  const keys = [...configSource.matchAll(/^ {2}([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]);
  return [...new Set([...keys.filter((k) => SECRET_NAME.test(k) && !PUBLIC_NAME.test(k)), ...ALWAYS])].sort();
}

// The sample values the kernel refuses (SAMPLE_SECRETS in config.ts), read from the same file.
export function sampleSecrets(configSource) {
  const set = /const SAMPLE_SECRETS = new Set\(\[([^\]]*)\]\)/.exec(configSource)?.[1] ?? '';
  return [...set.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

const SHAPES = [
  { kind: 'JWT', pattern: /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { kind: 'PEM private key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { kind: 'AWS access key id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'Resend API key', pattern: /\bre_[A-Za-z0-9]{8}_[A-Za-z0-9]{16,}\b/g },
  { kind: 'Stripe live key', pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/g },
  { kind: 'webhook signing secret', pattern: /\bwhsec_[A-Za-z0-9+/=]{24,}/g },
];

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The findings in one file's text: { kind, excerpt }, the excerpt masked so a log never repeats a leaked value.
export function scanText(text, names, samples) {
  const findings = [];
  const mask = (s) => (s.length <= 8 ? '***' : `${s.slice(0, 4)}***`);
  for (const name of names) {
    const n = escape(name);
    const asCode = new RegExp(`(?:\\.${n}\\b|["'\`]${n}["'\`]|\\b${n}\\s*[:=])`, 'g');
    for (const m of text.matchAll(asCode)) findings.push({ kind: `secret name ${name}`, excerpt: m[0] });
  }
  for (const value of samples) {
    if (text.includes(value)) findings.push({ kind: 'sample secret', excerpt: mask(value) });
  }
  for (const { kind, pattern } of SHAPES) {
    for (const m of text.matchAll(pattern)) findings.push({ kind, excerpt: mask(m[0]) });
  }
  return findings;
}

function filesOf(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? filesOf(path) : [path];
  });
}

// Every finding in a build directory, by file.
export function scanDir(dir, configSource) {
  const names = secretNames(configSource);
  const samples = sampleSecrets(configSource);
  return filesOf(dir).flatMap((file) => scanText(readFileSync(file, 'latin1'), names, samples).map((f) => ({ file: relative(dir, file), ...f })));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const dir = process.argv[2] ?? 'apps/app/dist';
  const config = readFileSync(process.argv[3] ?? 'apps/kernel/src/config.ts', 'utf8');
  const findings = scanDir(dir, config);
  if (findings.length > 0) {
    for (const f of findings) console.error(`spa-secrets: ${f.file}: ${f.kind} (${f.excerpt})`);
    console.error(`spa-secrets: ${findings.length} finding(s) in ${dir}; a kernel secret must never reach the browser bundle`);
    process.exit(1);
  }
  console.log(`spa-secrets: ${dir} holds no kernel secret (${secretNames(config).length} names, ${SHAPES.length} value shapes)`);
}
