// Verifies the digital signatures of a Vietnamese e-invoice XML (#674): the seller's XML-DSig signature in
// HDon/DSCKS/NBan and, when the invoice carries a tax authority code (MCCQT), the tax authority's in HDon/DSCKS/CQT
// (Decree 123/2020/ND-CP and its successors; the tax authority's data format, Decision 1450/QD-TCT and later). It
// runs only in a crove-extract parser process, with no network: certificates are checked against the national root
// CAs shipped in apps/extract/trust (einvoice-trust.ts), with no CRL or OCSP. XAdES properties beyond the signed
// SigningTime are not evaluated: the XML-DSig core (references and signature value) is what decides.
//
// The cryptography is xml-crypto (node-saml, MIT): Canonical XML 1.0 and exclusive C14N, the enveloped-signature
// transform, RSA with SHA-1, SHA-256 or SHA-512. It refuses a reference id held by more than one element and a
// Signature whose SignatureValue appears twice, never fetches a URI, and supports no XSLT or XPath transform.
//
// Signature wrapping: a valid signature over one element proves nothing about another. The invoice data the parser
// reads is HDon/DLHDon (and HDon/MCCQT for the tax authority code), found by name (einvoice-xml.ts). So a signature
// counts only when:
//   - the document has exactly one HDon, one DLHDon and at most one MCCQT, as children of that HDon, so the elements
//     the parser reads are these very elements, whatever wrapper or decoy surrounds them;
//   - the signature sits at its place (HDon/DSCKS/NBan or CQT), the only one there;
//   - one of its references names that DLHDon by its Id (or is URI="", the whole document), and the tax authority's
//     names the MCCQT too. xml-crypto then digests exactly that element, as ids are unique;
//   - there is no processing instruction inside HDon (the parser would read around it, Canonical XML keeps it).
// Comments inside a value are read the way Canonical XML without comments reads them (the text around them, joined),
// and DOCTYPE and ENTITY declarations never get this far (einvoice-xml.ts refuses them).
import { X509Certificate } from 'node:crypto';
import { DOMParser } from '@xmldom/xmldom';
import { SignedXml } from 'xml-crypto';
import type { InvoiceSignature, SignatureReason } from '@crove/l10n-vn';
import type { TrustStore } from './einvoice-trust.ts';

const DSIG = 'http://www.w3.org/2000/09/xmldsig#';
const ID_ATTRIBUTES = ['Id', 'ID', 'id'];
// Certificates read from one KeyInfo, and the longest chain built from them.
const MAX_KEYINFO_CERTS = 10;
const MAX_CHAIN = 6;
// Vietnam's offset, for a SigningTime or invoice date written without one.
const VN_OFFSET = '+07:00';

export interface SignatureFacts {
  // From the parsed invoice: the seller's tax code, the issue date, the series and whether it has a tax authority code.
  sellerTaxCode: string | null;
  issueDate: string;
  series: string;
  taxAuthorityCode: string | null;
}

type Outcome = { ok: true; leaf: X509Certificate; signedAt: Date } | { ok: false; reason: Fault; leaf: X509Certificate | null; signedAt: Date | null };
// What went wrong with one signature, before it is named for the seller or the tax authority.
type Fault = 'malformed' | 'not_covering' | 'digest_mismatch' | 'bad_signature' | 'unsupported_algorithm' | 'no_certificate' | 'untrusted_certificate' | 'certificate_expired';

class Malformed extends Error {}

function elementChildren(node: Element): Element[] {
  const out: Element[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) if (child.nodeType === 1) out.push(child as Element);
  return out;
}

function childrenNamed(node: Element, localName: string, namespace?: string): Element[] {
  return elementChildren(node).filter((e) => e.localName === localName && (namespace === undefined || e.namespaceURI === namespace));
}

function allNamed(doc: Document, localName: string): Element[] {
  return Array.from(doc.getElementsByTagNameNS('*', localName));
}

function idOf(element: Element): string | null {
  for (const attr of Array.from(element.attributes)) if (ID_ATTRIBUTES.includes(attr.localName)) return attr.value;
  return null;
}

function hasProcessingInstruction(node: Node): boolean {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 7) return true;
    if (child.nodeType === 1 && hasProcessingInstruction(child)) return true;
  }
  return false;
}

// A strict DOM parse: xmldom repairs some broken markup with only a warning (an unclosed element), which would let
// it and the invoice parser see different trees. Any warning or error refuses the document.
function parseDom(xml: string): Document {
  const fail = (message: string) => {
    throw new Malformed(message);
  };
  const doc = new DOMParser({ errorHandler: { warning: fail, error: fail, fatalError: fail } }).parseFromString(xml, 'text/xml');
  if (!doc.documentElement) throw new Malformed('no document element');
  return doc;
}

function commonName(dn: string): string | null {
  const line = dn.split('\n').find((l) => l.startsWith('CN='));
  return line ? line.slice(3).slice(0, 300) : null;
}

// The tax code a Vietnamese CA writes in a certificate subject, as UID=MST:0101234567 (an organization) or
// MST:0101234567-001 (a branch). Personal certificates carry CMND, CCCD or HC instead, and give no tax code.
function subjectTaxCode(cert: X509Certificate): string | null {
  return /\bMST\s*[:=]\s*(\d{10})/i.exec(cert.subject)?.[1] ?? null;
}

// A date-time from the XML: with an offset as written, without one in Vietnam's time. A bare date is noon that day.
export function xmlDateTime(value: string): Date | null {
  const text = value.trim();
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?))?(Z|[+-]\d{2}:\d{2})?$/.exec(text);
  if (!m) return null;
  const time = m[2] ?? '12:00:00';
  const date = new Date(`${m[1]}T${time.length === 5 ? `${time}:00` : time}${m[3] ?? VN_OFFSET}`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function validAt(cert: X509Certificate, at: Date): boolean {
  return cert.validFromDate.getTime() <= at.getTime() && at.getTime() <= cert.validToDate.getTime();
}

function issues(issuer: X509Certificate, subject: X509Certificate): boolean {
  return issuer.ca && subject.checkIssued(issuer) && subject.verify(issuer.publicKey);
}

// Walks from the signer's certificate to a shipped root: each step must be issued (name, key identifiers and
// signature) by a CA certificate, and every certificate on the way valid at the signing time. Certificates from the
// document's KeyInfo only help build the path; trust comes from the roots alone.
export function chainTo(leaf: X509Certificate, extra: readonly X509Certificate[], trust: TrustStore, at: Date): 'ok' | 'untrusted_certificate' | 'certificate_expired' {
  const pool = [...extra.filter((c) => c.ca), ...trust.intermediates];
  let current = leaf;
  let expired = !validAt(leaf, at);
  for (let depth = 0; depth < MAX_CHAIN; depth++) {
    const roots = trust.roots.filter((r) => issues(r, current));
    if (roots.length > 0) return expired || !roots.some((r) => validAt(r, at)) ? 'certificate_expired' : 'ok';
    // Prefer an issuer valid at the signing time: a CA re-issued with the same key has several certificates.
    const candidates = pool.filter((c) => c !== current && c.fingerprint256 !== current.fingerprint256 && issues(c, current));
    const next = candidates.find((c) => validAt(c, at)) ?? candidates[0];
    if (!next) return 'untrusted_certificate';
    if (!validAt(next, at)) expired = true;
    current = next;
  }
  return 'untrusted_certificate';
}

function keyInfoCertificates(signature: Element): X509Certificate[] {
  const certs: X509Certificate[] = [];
  for (const keyInfo of childrenNamed(signature, 'KeyInfo', DSIG)) {
    for (const data of childrenNamed(keyInfo, 'X509Data', DSIG)) {
      for (const node of childrenNamed(data, 'X509Certificate', DSIG)) {
        if (certs.length >= MAX_KEYINFO_CERTS) return certs;
        const base64 = (node.textContent ?? '').replace(/\s+/g, '');
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) continue;
        try {
          certs.push(new X509Certificate(Buffer.from(base64, 'base64')));
        } catch {
          // Not a certificate: skipped, so a signature with no readable certificate is reported as such.
        }
      }
    }
  }
  return certs;
}

function referenceUris(signature: Element): string[] {
  const signedInfo = childrenNamed(signature, 'SignedInfo', DSIG);
  if (signedInfo.length !== 1) throw new Malformed('one SignedInfo expected');
  return childrenNamed(signedInfo[0] as Element, 'Reference', DSIG).map((r) => r.getAttribute('URI') ?? '');
}

function covers(uris: readonly string[], element: Element): boolean {
  const id = idOf(element);
  return uris.some((uri) => uri === '' || (id !== null && id !== '' && uri === `#${id}`));
}

// The signed SigningTime of the signature, if a reference covers the Object or property that holds it.
function signedSigningTime(signature: Element, uris: readonly string[]): Date | null {
  for (const object of childrenNamed(signature, 'Object', DSIG)) {
    for (const time of Array.from(object.getElementsByTagNameNS('*', 'SigningTime'))) {
      let covered = false;
      for (let node: Node | null = time; node && node !== signature; node = node.parentNode) {
        if (node.nodeType === 1 && covers(uris.filter((u) => u !== ''), node as Element)) covered = true;
      }
      const at = covered ? xmlDateTime(time.textContent ?? '') : null;
      if (at) return at;
    }
  }
  return null;
}

function verifyOne(xml: string, signature: Element, mustCover: readonly Element[], trust: TrustStore, fallbackTime: Date): Outcome {
  let uris: string[];
  try {
    uris = referenceUris(signature);
  } catch {
    return { ok: false, reason: 'malformed', leaf: null, signedAt: null };
  }
  if (uris.length === 0) return { ok: false, reason: 'malformed', leaf: null, signedAt: null };
  if (!mustCover.every((element) => covers(uris, element))) return { ok: false, reason: 'not_covering', leaf: null, signedAt: null };
  const signedAt = signedSigningTime(signature, uris) ?? fallbackTime;

  const certs = keyInfoCertificates(signature);
  // The signer's certificate is the end-entity one; any CA certificates beside it only help build the chain.
  const leaf = certs.find((c) => !c.ca);
  if (!leaf) return { ok: false, reason: 'no_certificate', leaf: null, signedAt };

  // The key comes from the certificate read above, never from xml-crypto's own KeyInfo lookup.
  const signed = new SignedXml({ publicCert: leaf.toString(), getCertFromKeyInfo: () => null });
  try {
    signed.loadSignature(signature);
    if (!signed.checkSignature(xml)) return { ok: false, reason: 'digest_mismatch', leaf, signedAt };
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/signature value .* is incorrect/i.test(message)) return { ok: false, reason: 'bad_signature', leaf, signedAt };
    if (/algorithm/i.test(message)) return { ok: false, reason: 'unsupported_algorithm', leaf, signedAt };
    return { ok: false, reason: 'malformed', leaf, signedAt };
  }
  const chain = chainTo(leaf, certs, trust, signedAt);
  if (chain !== 'ok') return { ok: false, reason: chain, leaf, signedAt };
  return { ok: true, leaf, signedAt };
}

// The tax authority's certificate names it: Tổng cục Thuế, since 2025 Cục Thuế (diacritics and case aside).
function namesTaxAuthority(cert: X509Certificate): boolean {
  const subject = cert.subject.normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/gi, 'd').toUpperCase();
  return /\bTHUE\b|\bTAX\b/.test(subject);
}

function result(status: InvoiceSignature['status'], reason: SignatureReason | null, leaf: X509Certificate | null, signedAt: Date | null): InvoiceSignature {
  return {
    status,
    reason,
    signer: leaf ? commonName(leaf.subject) : null,
    issuer: leaf ? commonName(leaf.issuer) : null,
    signedAt: signedAt ? signedAt.toISOString() : null,
  };
}

const unverified = (reason: SignatureReason, leaf: X509Certificate | null = null, signedAt: Date | null = null) => result('unverified', reason, leaf, signedAt);

export function verifyEInvoiceSignatures(xml: string, facts: SignatureFacts, trust: TrustStore): InvoiceSignature {
  let doc: Document;
  try {
    doc = parseDom(xml);
  } catch {
    return unverified('malformed');
  }

  const hdons = allNamed(doc, 'HDon');
  const data = allNamed(doc, 'DLHDon');
  const codes = allNamed(doc, 'MCCQT');
  const hdon = hdons[0];
  const dlhdon = data[0];
  if (hdons.length !== 1 || !hdon || data.length !== 1 || !dlhdon || dlhdon.parentNode !== hdon || codes.length > 1 || codes.some((c) => c.parentNode !== hdon)) {
    return unverified('ambiguous');
  }
  if (hasProcessingInstruction(hdon)) return unverified('ambiguous');

  const dscks = childrenNamed(hdon, 'DSCKS');
  if (dscks.length > 1) return unverified('ambiguous');
  const slot = (name: string) => (dscks[0] ? childrenNamed(dscks[0], name) : []);
  const sellerSlots = slot('NBan');
  if (sellerSlots.length > 1) return unverified('ambiguous');
  const sellerSignatures = sellerSlots[0] ? childrenNamed(sellerSlots[0], 'Signature', DSIG) : [];
  if (sellerSignatures.length > 1) return unverified('ambiguous');
  const sellerSignature = sellerSignatures[0];

  const fallbackTime = xmlDateTime(facts.issueDate) ?? new Date(0);
  if (!sellerSignature) {
    // A cash register invoice (series type M, the 4th character of KHHDon) need not carry a digital signature.
    if (facts.series.charAt(3).toUpperCase() === 'M') return result('not_applicable', 'cash_register', null, null);
    // Something sits where the seller signs but is not an XML-DSig Signature.
    return unverified(sellerSlots[0] && elementChildren(sellerSlots[0]).length > 0 ? 'malformed' : 'missing');
  }

  const seller = verifyOne(xml, sellerSignature, [dlhdon], trust, fallbackTime);
  if (!seller.ok) return unverified(seller.reason, seller.leaf, seller.signedAt);
  const certTaxCode = subjectTaxCode(seller.leaf);
  const invoiceTaxCode = facts.sellerTaxCode?.replace(/\D/g, '').slice(0, 10) ?? null;
  if (certTaxCode && invoiceTaxCode && certTaxCode !== invoiceTaxCode) return unverified('signer_mismatch', seller.leaf, seller.signedAt);

  // An invoice with a tax authority code: the tax authority signs the invoice data and the code.
  const code = codes[0];
  if (facts.taxAuthorityCode && code) {
    const authoritySlots = slot('CQT');
    const authoritySignatures = authoritySlots.length === 1 && authoritySlots[0] ? childrenNamed(authoritySlots[0], 'Signature', DSIG) : [];
    if (authoritySlots.length > 1 || authoritySignatures.length > 1) return unverified('ambiguous', seller.leaf, seller.signedAt);
    const authoritySignature = authoritySignatures[0];
    if (!authoritySignature) return unverified('tax_authority_missing', seller.leaf, seller.signedAt);
    const authority = verifyOne(xml, authoritySignature, [dlhdon, code], trust, seller.signedAt);
    if (!authority.ok) {
      const reason = authority.reason === 'untrusted_certificate' ? 'tax_authority_untrusted' : 'tax_authority_invalid';
      return unverified(reason, seller.leaf, seller.signedAt);
    }
    if (!namesTaxAuthority(authority.leaf)) return unverified('tax_authority_invalid', seller.leaf, seller.signedAt);
  }
  return result('verified', null, seller.leaf, seller.signedAt);
}
