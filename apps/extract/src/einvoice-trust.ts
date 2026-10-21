// The certificates e-invoice signatures are checked against (#674), shipped as data in apps/extract/trust: the
// self-signed Vietnam National Root CA certificates (roots.crt, the only trust anchors) and the licensed public CAs
// under them (intermediates.crt, used only to build a chain, never trusted on their own). The parser process has no
// network, so nothing is fetched: no AIA download, no CRL and no OCSP. Revocation is not checked (trust/README.md).
// tax-authority.crt pins the tax authority's signing certificates; it is empty until one is taken from an official
// source, and until then the tax authority's signature is reported as not verified (tax_authority_untrusted).
// The files are read once per parser process; the permission model lets it read apps/extract (sandbox.ts).
import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';

export interface TrustStore {
  roots: readonly X509Certificate[];
  intermediates: readonly X509Certificate[];
  // The tax authority's own signing certificates, pinned (tax-authority.crt). A signature in the tax authority's slot
  // counts only from one of these: any company can hold a certificate from a licensed CA, and a name is not proof.
  taxAuthorities: readonly X509Certificate[];
}

// Every certificate in a PEM bundle, in order. Text outside the BEGIN/END lines (the # provenance comments) is ignored.
export function readPemBundle(text: string): X509Certificate[] {
  return (text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []).map((pem) => new X509Certificate(pem));
}

let shipped: TrustStore | null = null;

export function shippedTrustStore(): TrustStore {
  if (!shipped) {
    const read = (name: string) => readPemBundle(readFileSync(new URL(`../trust/${name}`, import.meta.url), 'utf8'));
    shipped = { roots: read('roots.crt'), intermediates: read('intermediates.crt'), taxAuthorities: read('tax-authority.crt') };
  }
  return shipped;
}
