// The secret scan of the built web app (#1518): names come from the kernel's config, a name in prose passes, and a
// planted secret fails. The planted values are joined at run time so the source itself holds no secret-shaped string
// for gitleaks to flag.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MIN_NAMES, sampleSecrets, scanDir, scanText, secretNames } from '../ci/spa-secrets.mjs';

const config = readFileSync(new URL('../../apps/kernel/src/config.ts', import.meta.url), 'utf8');
const names = secretNames(config);
const samples = sampleSecrets(config);
const jwt = ['eyJ', 'hbGciOiJIUzI1NiJ9', '.', 'eyJ', 'zdWIiOiJ0ZXN0In0', '.', 'c2lnbmF0dXJlLXZhbHVl'].join('');
const awsKeyId = ['AK', 'IA', 'ABCDEFGHIJKLMNOP'].join('');

describe('SPA secret scan', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crove-spa-secrets-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reads the secret names from the kernel config, not the public ones', () => {
    expect(names).toEqual(expect.arrayContaining(['AUTH_JWT_SECRET', 'DATABASE_URL', 'CREDENTIAL_KEY', 'S3_SECRET_ACCESS_KEY', 'SMTP_PASS', 'SUPABASE_SERVICE_ROLE']));
    for (const pub of ['PUBLIC_AUTH_ANON_KEY', 'PUBLIC_AUTH_URL', 'TURNSTILE_SITE_KEY', 'VAPID_PUBLIC_KEY', 'PORT']) expect(names).not.toContain(pub);
    expect(names.length).toBeGreaterThan(MIN_NAMES);
    expect(samples.length).toBeGreaterThan(0);
  });

  it('keeps reading the config after a reformat (indentation, quote style)', () => {
    const reformatted = 'const schema = z.object({\n\tAUTH_JWT_SECRET: optional,\n    SMTP_PASS: optional,\n});\nconst SAMPLE_SECRETS = new Set(["a-sample", \'b-sample\']);';
    expect(secretNames(reformatted)).toEqual(expect.arrayContaining(['AUTH_JWT_SECRET', 'SMTP_PASS']));
    expect(sampleSecrets(reformatted)).toEqual(['a-sample', 'b-sample']);
  });

  it('passes a name in a sentence for the operator', () => {
    expect(scanText('unencrypted:`This server has no export encryption key (EXPORT_ENCRYPTION_KEY), so...`', names, samples)).toEqual([]);
  });

  it('fails a secret name used as code', () => {
    for (const code of ['const k = env.AUTH_JWT_SECRET;', '{"CREDENTIAL_KEY":"x"}', 'SUPABASE_SERVICE_ROLE_KEY=abc', 'read("DATABASE_URL")', 'const { AUTH_JWT_SECRET } = cfg', 'f({a, SMTP_PASS})']) {
      expect(scanText(code, names, samples).length, code).toBeGreaterThan(0);
    }
  });

  it('fails secret-shaped values and the kernel sample secrets, and masks them in the finding', () => {
    const found = scanText(`a="${jwt}";b="${awsKeyId}";c="${samples[0]}"`, names, samples);
    expect(found.map((f) => f.kind).sort()).toEqual(['AWS access key id', 'JWT', 'sample secret']);
    for (const f of found) expect(f.excerpt).toMatch(/\*\*\*$/);
  });

  it('scans every file of a build directory', () => {
    mkdirSync(join(dir, 'assets'), { recursive: true });
    writeFileSync(join(dir, 'index.html'), '<script src="/assets/index.js"></script>');
    writeFileSync(join(dir, 'assets', 'index.js'), 'console.log("ok")');
    expect(scanDir(dir, config)).toEqual([]);
    // Images and fonts are not text: skipped, whatever bytes they hold.
    writeFileSync(join(dir, 'assets', 'logo.png'), `binary ${jwt}`);
    expect(scanDir(dir, config)).toEqual([]);
    writeFileSync(join(dir, 'assets', 'chunk.js'), `const t = "${jwt}";`);
    expect(scanDir(dir, config)).toEqual([{ file: join('assets', 'chunk.js'), kind: 'JWT', excerpt: 'eyJh***' }]);
  });
});
