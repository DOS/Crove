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
    // The tax authority's pinned certificates (#951), each with its comment block.
    const pinned = annotated(read('tax-authority.crt'));
    expect(pinned.length).toBeGreaterThan(0);
    expect(store.taxAuthorities.map(fingerprint)).toEqual(pinned.map((p) => fingerprint(p.cert)));
    for (const entry of pinned) {
      expect(entry.sha256).toBe(fingerprint(entry.cert));
      expect(entry.sources.length).toBeGreaterThan(0);
    }
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

  it('pins only end-entity certificates of the tax authority, each issued by the Government CA it names (#951)', () => {
    const pinned = annotated(read('tax-authority.crt'));
    const issuers = annotated(read('tax-authority-issuers.crt'));
    for (const entry of issuers) expect(entry.sha256).toBe(fingerprint(entry.cert));
    const [subCa, root] = issuers.map((i) => i.cert) as [X509Certificate, X509Certificate];
    // The root is self-signed and issued the sub-CA; both are CAs.
    expect(root.ca && subCa.ca).toBe(true);
    expect(root.subject).toBe(root.issuer);
    expect(root.verify(root.publicKey)).toBe(true);
    expect(subCa.checkIssued(root) && subCa.verify(root.publicKey)).toBe(true);
    for (const { cert } of pinned) {
      expect(cert.ca, cert.subject).toBe(false);
      expect(cert.subject).toMatch(/^O=BỘ TÀI CHÍNH$/m);
      expect(cert.subject).toMatch(/^CN=(TỔNG )?CỤC THUẾ$/m);
      expect(cert.checkIssued(subCa) && cert.verify(subCa.publicKey), cert.subject).toBe(true);
    }
    // Neither Government CA certificate is a trust anchor or a chain helper for invoice signatures.
    const store = shippedTrustStore();
    const shippedCas = [...store.roots, ...store.intermediates].map(fingerprint);
    for (const { cert } of issuers) expect(shippedCas).not.toContain(fingerprint(cert));
  });
});
