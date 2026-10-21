// Signature verification of e-invoice XML (#674). Every key and certificate here is generated per run by the TEST
// ONLY fixture (einvoice-signing-fixture.ts); no real invoice, company or CA is used. The parser is called with the
// test trust store, except where a test checks the national roots shipped in apps/extract/trust.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkInvoice, SIGNATURE_REASONS as L10N_REASONS, SIGNATURE_STATUSES as L10N_STATUSES } from '@crove/l10n-vn';
import { SIGNATURE_REASONS, SIGNATURE_STATUSES, zExtractedInvoice } from '@crove/extract-contract';
import { parseEInvoiceXml } from '../src/einvoice-xml.ts';
import { chainTo, xmlDateTime } from '../src/einvoice-signature.ts';
import { issue, signInvoice, testPki, TEST_SELLER_TAX_CODE } from './einvoice-signing-fixture.ts';

const pki = testPki();
const fixture = readFileSync(new URL('./fixtures/einvoice-basic.xml', import.meta.url), 'utf8');
// The fixture with empty signature slots, as e-invoice software lays them out before signing.
const unsigned = fixture.replace(/<DSCKS>[\s\S]*<\/DSCKS>/, '<DSCKS><NBan></NBan><NMua></NMua><CQT></CQT><CCKSKhac></CCKSKhac></DSCKS>');
const sellerSigned = signInvoice(unsigned, pki.seller, { slot: 'NBan' });
// The tax authority signs the invoice data and its code (MCCQT Id="tax") after the seller.
const fullySigned = signInvoice(sellerSigned, pki.taxAuthority, { slot: 'CQT', references: ['data', 'tax'] });

const bytes = (xml: string) => new TextEncoder().encode(xml);
function verify(xml: string, trust = pki.trust) {
  const { signature } = parseEInvoiceXml(bytes(xml), { trust });
  if (!signature) throw new Error('the parser always verifies');
  return signature;
}

describe('e-invoice signature verification', () => {
  it('verifies the seller and the tax authority signatures of a valid invoice', () => {
    const invoice = parseEInvoiceXml(bytes(fullySigned), { trust: pki.trust });
    expect(invoice.signature).toEqual({
      status: 'verified',
      reason: null,
      signer: 'TEST ONLY CÔNG TY TNHH DỊCH VỤ MẪU',
      issuer: 'TEST ONLY Signing CA',
      signedAt: '2026-09-15T03:00:00.000Z',
    });
    // The answer passes the wire contract, and the check passes.
    expect(zExtractedInvoice.safeParse(invoice).success).toBe(true);
    expect(checkInvoice(invoice, '2026-10-20').find((c) => c.id === 'signature')).toMatchObject({ status: 'pass' });
    // The invoice itself reads as before signing.
    const { signature: _a, hasSignature: _b, ...signedData } = invoice;
    const { signature: _c, hasSignature: _d, ...plainData } = parseEInvoiceXml(bytes(unsigned), { trust: pki.trust });
    expect(signedData).toEqual(plainData);
  });

  it('marks an edited amount as not matching the signature, and still reads the invoice', () => {
    const tampered = fullySigned.replace('<TgTTTBSo>1980000</TgTTTBSo>', '<TgTTTBSo>9980000</TgTTTBSo>');
    const invoice = parseEInvoiceXml(bytes(tampered), { trust: pki.trust });
    expect(invoice.total).toBe('9980000');
    expect(invoice.signature).toMatchObject({ status: 'unverified', reason: 'digest_mismatch', signer: 'TEST ONLY CÔNG TY TNHH DỊCH VỤ MẪU' });
    // A warning, never a failed check: an unverified invoice is not blocked.
    expect(checkInvoice(invoice, '2026-10-20').find((c) => c.id === 'signature')).toEqual({
      id: 'signature',
      status: 'warn',
      code: 'signature.digest_mismatch',
      message: 'Nội dung hóa đơn không khớp chữ ký số (có thể đã bị sửa sau khi ký)',
    });
  });

  it('refuses a certificate outside the trusted roots, a swapped certificate and another tax code', () => {
    expect(verify(signInvoice(unsigned, pki.otherSeller, { slot: 'NBan' }))).toMatchObject({ status: 'unverified', reason: 'untrusted_certificate' });
    // Signed with the seller's key, but KeyInfo shows another certificate: the signature does not match its key.
    expect(verify(signInvoice(unsigned, pki.seller, { slot: 'NBan', keyInfo: [pki.otherSeller.cert] }))).toMatchObject({ status: 'unverified', reason: 'bad_signature' });
    const stranger = issue({ subject: { commonName: 'TEST ONLY other company', uid: 'MST:0309876546' }, issuer: pki.intermediate, ca: false });
    expect(verify(signInvoice(unsigned, stranger, { slot: 'NBan' }))).toMatchObject({ status: 'unverified', reason: 'signer_mismatch' });
    // A person's certificate, or one that names nobody, does not sign for the company.
    const person = issue({ subject: { commonName: 'TEST ONLY NGUYEN VAN A', uid: 'CCCD:001234567890' }, issuer: pki.intermediate, ca: false });
    expect(verify(signInvoice(unsigned, person, { slot: 'NBan' })).reason).toBe('signer_mismatch');
    const nobody = issue({ subject: { commonName: `TEST ONLY MST:${TEST_SELLER_TAX_CODE}` }, issuer: pki.intermediate, ca: false });
    expect(verify(signInvoice(unsigned, nobody, { slot: 'NBan' })).reason).toBe('signer_mismatch');
    // The seller's tax code must be a tax code: not a longer string that starts with the certificate's.
    expect(verify(signInvoice(unsigned.replace(`<MST>${TEST_SELLER_TAX_CODE}</MST>`, `<MST>${TEST_SELLER_TAX_CODE}-0309876546</MST>`), pki.seller, { slot: 'NBan' })).reason).toBe(
      'signer_mismatch',
    );
    // A CA certificate sent alongside does not make an untrusted chain trusted.
    expect(verify(signInvoice(unsigned, pki.otherSeller, { slot: 'NBan', keyInfo: [pki.otherSeller.cert, pki.otherRoot.cert] }))).toMatchObject({
      reason: 'untrusted_certificate',
    });
  });

  it('refuses a certificate that was not valid when the invoice was signed', () => {
    const lapsed = issue({
      subject: { commonName: 'TEST ONLY lapsed seller', uid: `MST:${TEST_SELLER_TAX_CODE}` },
      issuer: pki.intermediate,
      ca: false,
      notBefore: new Date('2020-01-01T00:00:00Z'),
      notAfter: new Date('2025-01-01T00:00:00Z'),
    });
    expect(verify(signInvoice(unsigned, lapsed, { slot: 'NBan' }))).toMatchObject({ status: 'unverified', reason: 'certificate_expired' });
    expect(verify(signInvoice(unsigned, lapsed, { slot: 'NBan', signingTime: '2024-06-01T09:00:00+07:00' })).reason).toBe('tax_authority_missing');
  });

  it('reports a missing or unreadable signature, and lets an unsigned cash register invoice through', () => {
    expect(verify(unsigned)).toMatchObject({ status: 'unverified', reason: 'missing', signer: null });
    expect(verify(unsigned.replace(/<DSCKS>[\s\S]*<\/DSCKS>/, ''))).toMatchObject({ status: 'unverified', reason: 'missing' });
    // The old fixture's placeholder is not an XML-DSig signature.
    expect(verify(fixture)).toMatchObject({ status: 'unverified', reason: 'malformed' });
    const cashRegister = unsigned.replace('<KHHDon>C26TAB</KHHDon>', '<KHHDon>C26MAB</KHHDon>');
    expect(verify(cashRegister)).toEqual({ status: 'not_applicable', reason: 'cash_register', signer: null, issuer: null, signedAt: null });
  });

  it('checks the tax authority signature on an invoice with a tax authority code', () => {
    expect(verify(sellerSigned)).toMatchObject({ status: 'unverified', reason: 'tax_authority_missing', signer: 'TEST ONLY CÔNG TY TNHH DỊCH VỤ MẪU' });
    // Signed by a certificate from a trusted CA that is not the pinned tax authority certificate, even one naming it.
    expect(verify(signInvoice(sellerSigned, pki.seller, { slot: 'CQT', references: ['data', 'tax'] })).reason).toBe('tax_authority_untrusted');
    const agent = issue({ subject: { commonName: 'TEST ONLY CÔNG TY TNHH ĐẠI LÝ THUẾ ABC', uid: 'MST:0109999999' }, issuer: pki.intermediate, ca: false });
    expect(verify(signInvoice(sellerSigned, agent, { slot: 'CQT', references: ['data', 'tax'] })).reason).toBe('tax_authority_untrusted');
    // With no pinned certificate (the shipped state today), the tax authority's signature is never verified.
    expect(verify(fullySigned, { ...pki.trust, taxAuthorities: [] }).reason).toBe('tax_authority_untrusted');
    // Covering the code but not the invoice data.
    expect(verify(signInvoice(sellerSigned, pki.taxAuthority, { slot: 'CQT', references: ['tax'] })).reason).toBe('tax_authority_invalid');
    const otherAuthority = issue({ subject: { commonName: 'TEST ONLY CỤC THUẾ giả' }, issuer: pki.otherRoot, ca: false });
    expect(verify(signInvoice(sellerSigned, otherAuthority, { slot: 'CQT', references: ['data', 'tax'] })).reason).toBe('tax_authority_untrusted');
    // An edited tax authority code breaks its signature.
    expect(verify(fullySigned.replace('M2-26-ABCDE-00001234567', 'M2-26-ABCDE-00009999999')).reason).toBe('tax_authority_invalid');
    // A series without a code (K) asks nothing of the tax authority; a series with one (C) must carry it.
    const withoutCode = unsigned.replace(/<MCCQT[^>]*>[^<]*<\/MCCQT>/, '');
    expect(verify(signInvoice(withoutCode.replace('<KHHDon>C26TAB</KHHDon>', '<KHHDon>K26TAB</KHHDon>'), pki.seller, { slot: 'NBan' }))).toMatchObject({ status: 'verified' });
    expect(verify(signInvoice(withoutCode, pki.seller, { slot: 'NBan' })).reason).toBe('tax_authority_missing');
    // A cash register invoice (type M) carries a code its seller's system made, with no tax authority signature.
    const cashRegister = unsigned.replace('<KHHDon>C26TAB</KHHDon>', '<KHHDon>C26MAB</KHHDon>');
    expect(verify(signInvoice(cashRegister, pki.seller, { slot: 'NBan' }))).toMatchObject({ status: 'verified' });
  });

  describe('signature wrapping', () => {
    const signedData = /<DLHDon Id="data">[\s\S]*<\/DLHDon>/.exec(fullySigned)?.[0] ?? '';
    // xml-crypto writes the empty slot as <CCKSKhac/>.
    const EMPTY_OTHER = /<CCKSKhac\s*\/>|<CCKSKhac><\/CCKSKhac>/;
    const forged = signedData.replace('<TgTTTBSo>1980000</TgTTTBSo>', '<TgTTTBSo>9980000</TgTTTBSo>').replace(' Id="data"', '');

    it('refuses a forged DLHDon read beside the signed one moved out of the way', () => {
      // The signed DLHDon moves into another slot; a forged one, without the id, takes its place.
      const moved = fullySigned.replace(signedData, forged).replace(EMPTY_OTHER, `<CCKSKhac>${signedData}</CCKSKhac>`);
      const invoice = parseEInvoiceXml(bytes(moved), { trust: pki.trust });
      expect(invoice.total).toBe('9980000');
      expect(invoice.signature).toMatchObject({ status: 'unverified', reason: 'ambiguous' });
    });

    it('refuses a forged DLHDon carrying the signed id', () => {
      const twin = fullySigned.replace(signedData, forged.replace('<DLHDon', '<DLHDon Id="data"')).replace(EMPTY_OTHER, `<CCKSKhac><X>${signedData}</X></CCKSKhac>`);
      expect(verify(twin)).toMatchObject({ status: 'unverified', reason: 'ambiguous' });
    });

    it('refuses the signed invoice wrapped inside a forged one', () => {
      const outer = `<?xml version="1.0" encoding="UTF-8"?><TDiep><DLieu>${unsigned.replace('<?xml version="1.0" encoding="UTF-8"?>', '').replace(/<TgTTTBSo>1980000<\/TgTTTBSo>/, '<TgTTTBSo>9980000</TgTTTBSo>')}<Kem>${fullySigned.replace('<?xml version="1.0" encoding="UTF-8"?>', '')}</Kem></DLieu></TDiep>`;
      expect(verify(outer)).toMatchObject({ status: 'unverified', reason: 'ambiguous' });
    });

    it('accepts the signed invoice inside an envelope when it is the only invoice there', () => {
      const envelope = `<?xml version="1.0" encoding="UTF-8"?><TDiep><DLieu>${fullySigned.replace('<?xml version="1.0" encoding="UTF-8"?>', '')}</DLieu></TDiep>`;
      expect(verify(envelope)).toMatchObject({ status: 'verified' });
    });

    it('refuses a signature that does not reference the invoice data', () => {
      const onlyTime = signInvoice(unsigned, pki.seller, { slot: 'NBan', references: [] });
      expect(verify(onlyTime)).toMatchObject({ status: 'unverified', reason: 'not_covering' });
      // A reference to something outside the document is never fetched and covers nothing.
      const external = sellerSigned.replace('URI="#data"', 'URI="https://example.com/invoice.xml"');
      expect(verify(external).reason).toBe('not_covering');
    });

    it('refuses a second seller signature and a processing instruction inside the invoice', () => {
      const sellerSignature = /<Signature[\s\S]*?<\/Signature>/.exec(sellerSigned)?.[0] ?? '';
      // The seller's slot is the NBan inside DSCKS (the NBan inside DLHDon is the seller's details).
      const twice = fullySigned.replace(/(<DSCKS><NBan>)/, `$1${sellerSignature.replace('Id="sig-NBan"', 'Id="sig-NBan-2"')}`);
      expect(twice).not.toBe(fullySigned);
      expect(verify(twice).reason).toBe('ambiguous');
      expect(verify(fullySigned.replace('<TgTTTBSo>1980000</TgTTTBSo>', '<TgTTTBSo>1980000<?x y?></TgTTTBSo>')).reason).toBe('ambiguous');
    });

    it('reads character references the way the signature does', () => {
      // Canonical XML decodes &#49; to 1 before digesting; the parser decodes it too, so both read invoice 1234.
      const referenced = fullySigned.replace('<SHDon>1234</SHDon>', '<SHDon>&#49;234</SHDon>').replace('M2-26-ABCDE', '&#77;2-26-ABCDE');
      const invoice = parseEInvoiceXml(bytes(referenced), { trust: pki.trust });
      expect(invoice.number).toBe('1234');
      expect(invoice.taxAuthorityCode).toBe('M2-26-ABCDE-00001234567');
      expect(invoice.signature?.status).toBe('verified');
      // An HTML entity is not XML: the parser reads it, the signature check refuses the file.
      expect(verify(fullySigned.replace('<SHDon>1234</SHDon>', '<SHDon>12&nbsp;34</SHDon>')).reason).toBe('malformed');
    });

    it('refuses a SignedInfo with too many references before digesting them', () => {
      const reference = /<Reference URI="#data">[\s\S]*?<\/Reference>/.exec(sellerSigned)?.[0] ?? '';
      expect(reference).not.toBe('');
      const many = sellerSigned.replace(reference, reference.repeat(400));
      const started = performance.now();
      expect(verify(many).reason).toBe('malformed');
      expect(performance.now() - started).toBeLessThan(2000);
    });

    it('reads a comment inside a signed value the way the signature does', () => {
      // Canonical XML without comments drops the comment; the parser joins the text around it. Both read 1980000.
      const commented = fullySigned.replace('<TgTTTBSo>1980000</TgTTTBSo>', '<TgTTTBSo>198<!-- x -->0000</TgTTTBSo>');
      const invoice = parseEInvoiceXml(bytes(commented), { trust: pki.trust });
      expect(invoice.total).toBe('1980000');
      expect(invoice.signature?.status).toBe('verified');
    });

    it('refuses XML that its two parsers could read differently', () => {
      // A repeated attribute: the invoice parser ignores attributes, the DOM parser refuses it.
      expect(verify(fullySigned.replace('<THDon>', '<THDon a="1" a="2">'))).toMatchObject({ status: 'unverified', reason: 'malformed' });
    });
  });

  it('trusts only the national roots shipped with Crove by default', () => {
    expect(parseEInvoiceXml(bytes(fullySigned)).signature).toMatchObject({ status: 'unverified', reason: 'untrusted_certificate' });
    // The committed TEST ONLY signed fixture the container smoke test sends: intact, but from an untrusted test CA.
    // A Windows checkout may turn its line ends into CRLF; the signature was made over LF.
    const committed = readFileSync(new URL('./fixtures/einvoice-signed-test-only.xml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    expect(parseEInvoiceXml(bytes(committed)).signature).toMatchObject({ status: 'unverified', reason: 'untrusted_certificate', signer: 'TEST ONLY CÔNG TY TNHH DỊCH VỤ MẪU' });
  });

  it('builds the chain from the roots, prefers an issuer valid at the signing time and stops at expired ones', () => {
    const at = new Date('2026-09-15T00:00:00Z');
    expect(chainTo(pki.seller.cert, [], pki.trust, at)).toBe('ok');
    expect(chainTo(pki.seller.cert, [], { roots: [pki.root.cert], intermediates: [], taxAuthorities: [] }, at)).toBe('untrusted_certificate');
    // The intermediate may come from the document instead of the shipped list.
    expect(chainTo(pki.seller.cert, [pki.intermediate.cert], { roots: [pki.root.cert], intermediates: [], taxAuthorities: [] }, at)).toBe('ok');
    expect(chainTo(pki.seller.cert, [], pki.trust, new Date('2050-01-01T00:00:00Z'))).toBe('certificate_expired');
    expect(chainTo(pki.otherSeller.cert, [pki.otherRoot.cert], pki.trust, at)).toBe('untrusted_certificate');
  });

  it('reads XML date-times with and without an offset', () => {
    expect(xmlDateTime('2026-09-15T10:00:00')?.toISOString()).toBe('2026-09-15T03:00:00.000Z');
    expect(xmlDateTime('2026-09-15T10:00:00Z')?.toISOString()).toBe('2026-09-15T10:00:00.000Z');
    expect(xmlDateTime('2026-09-15')?.toISOString()).toBe('2026-09-15T05:00:00.000Z');
    expect(xmlDateTime('15/09/2026')).toBeNull();
  });

  it('keeps the status and reason lists of the contract and @crove/l10n-vn the same', () => {
    expect([...SIGNATURE_STATUSES]).toEqual([...L10N_STATUSES]);
    expect([...SIGNATURE_REASONS]).toEqual([...L10N_REASONS]);
  });
});
