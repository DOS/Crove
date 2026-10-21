// The national root CA data shipped in apps/extract/trust (#674): every certificate matches the SHA-256 written above
// it, the roots are self-signed CA certificates, and every intermediate is a CA issued by one of the shipped roots.
import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { shippedTrustStore } from '../src/einvoice-trust.ts';

const read = (name: string) => readFileSync(new URL(`../trust/${name}`, import.meta.url), 'utf8');

// Each certificate with the SHA-256 and source lines of its comment block.
function annotated(text: string): { cert: X509Certificate; sha256: string | undefined; sources: string[] }[] {
  return text
    .split(/(?=^# Subject: )/m)
    .filter((block) => block.includes('-----BEGIN CERTIFICATE-----'))
    .map((block) => ({
      cert: new X509Certificate(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(block)?.[0] ?? ''),
      sha256: /^# SHA-256: ([0-9a-f]{64})$/m.exec(block)?.[1],
      sources: [...block.matchAll(/^# Source: (\S+)$/gm)].map((m) => m[1] as string),
    }));
}

const fingerprint = (cert: X509Certificate) => cert.fingerprint256.replaceAll(':', '').toLowerCase();

describe('shipped e-invoice trust data', () => {
  const roots = annotated(read('roots.crt'));
  const intermediates = annotated(read('intermediates.crt'));

  it('matches every certificate to the fingerprint and official source written above it', () => {
    expect(roots.length).toBeGreaterThan(0);
    for (const entry of [...roots, ...intermediates]) {
      expect(entry.sha256).toBe(fingerprint(entry.cert));
      expect(entry.sources.length).toBeGreaterThan(0);
      for (const source of entry.sources) expect(source).toMatch(/^https:\/\/rootca\.gov\.vn\/crt\//);
    }
    const store = shippedTrustStore();
    expect(store.roots.map(fingerprint)).toEqual(roots.map((r) => fingerprint(r.cert)));
    expect(store.intermediates.map(fingerprint)).toEqual(intermediates.map((i) => fingerprint(i.cert)));
  });

  it('holds only self-signed root CAs as anchors, and only CAs those roots issued beside them', () => {
    for (const { cert } of roots) {
      expect(cert.ca).toBe(true);
      expect(cert.subject).toBe(cert.issuer);
      expect(cert.verify(cert.publicKey)).toBe(true);
    }
    for (const { cert } of intermediates) {
      expect(cert.ca).toBe(true);
      const issuer = roots.find((r) => cert.checkIssued(r.cert) && cert.verify(r.cert.publicKey));
      expect(issuer, cert.subject).toBeDefined();
    }
    // No timestamping CA: its certificates sign timestamps, not invoices.
    expect([...roots, ...intermediates].filter(({ cert }) => /timestamp|TSA/i.test(cert.subject))).toEqual([]);
  });
});
