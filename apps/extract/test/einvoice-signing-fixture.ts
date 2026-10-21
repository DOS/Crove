// TEST ONLY. Keys and certificates for the e-invoice signature tests (#674), generated in memory at every run and
// never written to disk: a test root CA, a test intermediate CA, the seller's and the tax authority's signing
// certificates, and an unrelated CA for the "wrong certificate" cases. Every name says TEST ONLY; none of it is a
// real CA, company or tax authority. The certificates are encoded by hand (a minimal DER writer), since Node can
// verify X.509 certificates but not create them, and signed with node:crypto. Invoices are signed with xml-crypto
// the way Vietnamese e-invoice software signs them: Canonical XML 1.0, the enveloped-signature transform, RSA-SHA256,
// a reference to DLHDon by its Id and a signed SigningTime property.
import { createHash, generateKeyPairSync, randomBytes, sign, X509Certificate, type KeyObject } from 'node:crypto';
import { SignedXml } from 'xml-crypto';
import type { TrustStore } from '../src/einvoice-trust.ts';

// DER: tag, length, value.
function tlv(tag: number, value: Uint8Array): Buffer {
  const length = value.length;
  const header =
    length < 0x80 ? [length] : length < 0x100 ? [0x81, length] : length < 0x10000 ? [0x82, length >> 8, length & 0xff] : [0x83, length >> 16, (length >> 8) & 0xff, length & 0xff];
  return Buffer.concat([Buffer.from([tag, ...header]), value]);
}
const seq = (...items: Uint8Array[]) => tlv(0x30, Buffer.concat(items));
const set = (...items: Uint8Array[]) => tlv(0x31, Buffer.concat(items));
const explicit = (n: number, value: Uint8Array) => tlv(0xa0 + n, value);
const octets = (value: Uint8Array) => tlv(0x04, value);
const bits = (value: Uint8Array) => tlv(0x03, Buffer.concat([Buffer.from([0]), value]));
const bool = (value: boolean) => tlv(0x01, Buffer.from([value ? 0xff : 0]));
const nul = () => Buffer.from([0x05, 0x00]);
const utf8 = (text: string) => tlv(0x0c, Buffer.from(text, 'utf8'));
const printable = (text: string) => tlv(0x13, Buffer.from(text, 'ascii'));
const generalizedTime = (date: Date) => tlv(0x18, Buffer.from(`${date.toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z`, 'ascii'));

function integer(value: Uint8Array): Buffer {
  let bytes = Buffer.from(value);
  while (bytes.length > 1 && bytes[0] === 0 && (bytes[1] as number) < 0x80) bytes = bytes.subarray(1);
  return tlv(0x02, (bytes[0] as number) >= 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);
}

function oid(dotted: string): Buffer {
  const [a, b, ...rest] = dotted.split('.').map(Number) as [number, number, ...number[]];
  const out = [40 * a + b];
  for (const n of rest) {
    const chunk = [n & 0x7f];
    for (let v = n >> 7; v > 0; v >>= 7) chunk.unshift((v & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

const OID = {
  sha256WithRSA: '1.2.840.113549.1.1.11',
  country: '2.5.4.6',
  organization: '2.5.4.10',
  commonName: '2.5.4.3',
  uid: '0.9.2342.19200300.100.1.1',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  subjectKeyId: '2.5.29.14',
  authorityKeyId: '2.5.29.35',
};

export interface Subject {
  commonName: string;
  organization?: string;
  // The UID attribute Vietnamese CAs use for the tax code, for example "MST:0101234564".
  uid?: string;
}

function name(subject: Subject): Buffer {
  const rdn = (type: string, value: Buffer) => set(seq(oid(type), value));
  return seq(
    rdn(OID.country, printable('VN')),
    ...(subject.organization ? [rdn(OID.organization, utf8(subject.organization))] : []),
    ...(subject.uid ? [rdn(OID.uid, utf8(subject.uid))] : []),
    rdn(OID.commonName, utf8(subject.commonName)),
  );
}

export interface TestIdentity {
  subject: Subject;
  key: KeyObject;
  cert: X509Certificate;
  der: Buffer;
}

interface IssueOptions {
  subject: Subject;
  issuer?: TestIdentity;
  ca: boolean;
  notBefore?: Date;
  notAfter?: Date;
}

const keyId = (key: KeyObject) => createHash('sha1').update(key.export({ type: 'spki', format: 'der' })).digest();

// A certificate for a fresh RSA key, signed by the issuer (or by itself without one).
export function issue(options: IssueOptions): TestIdentity {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const signer = options.issuer ?? { subject: options.subject, key: privateKey };
  const issuerPublic = options.issuer ? options.issuer.cert.publicKey : publicKey;
  const algorithm = seq(oid(OID.sha256WithRSA), nul());
  const extension = (type: string, critical: boolean, value: Buffer) => seq(oid(type), ...(critical ? [bool(true)] : []), octets(value));
  // digitalSignature + nonRepudiation for a signer, keyCertSign + cRLSign for a CA.
  const usage = options.ca ? Buffer.from([0x01, 0x06]) : Buffer.from([0x06, 0xc0]);
  const extensions = seq(
    extension(OID.basicConstraints, true, options.ca ? seq(bool(true)) : seq()),
    extension(OID.keyUsage, true, tlv(0x03, usage)),
    extension(OID.subjectKeyId, false, octets(keyId(publicKey))),
    extension(OID.authorityKeyId, false, seq(tlv(0x80, keyId(issuerPublic)))),
  );
  const tbs = seq(
    explicit(0, integer(Buffer.from([2]))),
    integer(randomBytes(16)),
    algorithm,
    name(signer.subject),
    seq(generalizedTime(options.notBefore ?? new Date('2020-01-01T00:00:00Z')), generalizedTime(options.notAfter ?? new Date('2045-01-01T00:00:00Z'))),
    name(options.subject),
    publicKey.export({ type: 'spki', format: 'der' }),
    explicit(3, extensions),
  );
  const der = seq(tbs, algorithm, bits(sign('sha256', tbs, signer.key)));
  return { subject: options.subject, key: privateKey, cert: new X509Certificate(der), der };
}

export interface TestPki {
  root: TestIdentity;
  intermediate: TestIdentity;
  seller: TestIdentity;
  taxAuthority: TestIdentity;
  // An unrelated CA and a seller certificate it issued: the wrong-certificate cases.
  otherRoot: TestIdentity;
  otherSeller: TestIdentity;
  trust: TrustStore;
}

export const TEST_SELLER_TAX_CODE = '0101234564';

let cached: TestPki | null = null;

// The test PKI, generated once per test file (RSA key generation takes a moment).
export function testPki(): TestPki {
  if (cached) return cached;
  const root = issue({ subject: { commonName: 'TEST ONLY Root CA', organization: 'Crove test fixtures' }, ca: true });
  const intermediate = issue({ subject: { commonName: 'TEST ONLY Signing CA', organization: 'Crove test fixtures' }, issuer: root, ca: true });
  const seller = issue({
    subject: { commonName: 'TEST ONLY CÔNG TY TNHH DỊCH VỤ MẪU', uid: `MST:${TEST_SELLER_TAX_CODE}` },
    issuer: intermediate,
    ca: false,
  });
  const taxAuthority = issue({ subject: { commonName: 'TEST ONLY CỤC THUẾ', organization: 'TEST ONLY BỘ TÀI CHÍNH' }, issuer: intermediate, ca: false });
  const otherRoot = issue({ subject: { commonName: 'TEST ONLY Untrusted CA', organization: 'Crove test fixtures' }, ca: true });
  const otherSeller = issue({ subject: { commonName: 'TEST ONLY Untrusted seller', uid: `MST:${TEST_SELLER_TAX_CODE}` }, issuer: otherRoot, ca: false });
  // The test tax authority's certificate is pinned, as trust/tax-authority.crt pins the real one.
  const trust = { roots: [root.cert], intermediates: [intermediate.cert], taxAuthorities: [taxAuthority.cert] };
  cached = { root, intermediate, seller, taxAuthority, otherRoot, otherSeller, trust };
  return cached;
}

const C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';
const ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature';

export interface SignOptions {
  // Where the signature goes: the seller's slot (HDon/DSCKS/NBan) or the tax authority's (HDon/DSCKS/CQT).
  slot: 'NBan' | 'CQT';
  // The ids of the elements it signs (by default DLHDon's, "data").
  references?: string[];
  // The certificates written into KeyInfo (by default the signer's alone).
  keyInfo?: X509Certificate[];
  signingTime?: string;
}

// Signs an invoice XML the way e-invoice software does and returns the signed XML. The slot element must exist.
export function signInvoice(xml: string, signer: TestIdentity, options: SignOptions): string {
  const objectId = `SigningTime-${options.slot}`;
  const certs = options.keyInfo ?? [signer.cert];
  const signed = new SignedXml({
    privateKey: signer.key.export({ type: 'pkcs8', format: 'pem' }),
    canonicalizationAlgorithm: C14N,
    signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
    getKeyInfoContent: () =>
      `<X509Data><X509SubjectName>${signer.cert.subject.replaceAll('\n', ', ')}</X509SubjectName>${certs
        .map((c) => `<X509Certificate>${c.raw.toString('base64')}</X509Certificate>`)
        .join('')}</X509Data>`,
    objects: [
      {
        content: `<SignatureProperties><SignatureProperty Target="#sig-${options.slot}"><SigningTime>${options.signingTime ?? '2026-09-15T10:00:00'}</SigningTime></SignatureProperty></SignatureProperties>`,
        attributes: { Id: objectId },
      },
    ],
  });
  for (const id of options.references ?? ['data']) {
    signed.addReference({ xpath: `//*[@Id='${id}']`, transforms: [ENVELOPED, C14N], digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256' });
  }
  signed.addReference({ xpath: `//*[@Id='${objectId}']`, transforms: [C14N], digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256' });
  signed.computeSignature(xml, {
    attrs: { Id: `sig-${options.slot}` },
    location: { reference: `//*[local-name(.)='DSCKS']/*[local-name(.)='${options.slot}']`, action: 'append' },
  });
  return signed.getSignedXml();
}
