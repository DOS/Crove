# E-invoice signature trust data

The certificates crove-extract checks e-invoice signatures against (#674). The parser process has no network, so this data ships with the code and is read from disk.

- `roots.crt`: the trust anchors. The self-signed Vietnam National Root CA certificates run by the National Electronic Authentication Centre (NEAC): MIC National Root CA (SHA-1, 2008), Vietnam National Root CA (2014), Vietnam National Root CA G3 (2024), and the 2025 roots for USB token, remote signing and mobile PKI.
- `intermediates.crt`: the licensed public CAs (VNPT-CA, Viettel-CA, BkavCA, FPT-CA, MISA-CA and the others) issued by those roots. They only help build a chain from a signer's certificate to a root; none of them is trusted on its own.
- `tax-authority.crt`: the tax authority's signing certificates, pinned (#951). Only these exact certificates count for the signature in the tax authority's slot (`HDon/DSCKS/CQT`).
- `tax-authority-issuers.crt`: the Government CA of Ban Cơ yếu Chính phủ that issued them (`CA phục vụ các cơ quan Nhà nước G2` and `RootCA chuyên dùng Chính phủ G2`). Read only by the test, which checks that each pinned certificate was issued by it. It is never a trust anchor: that CA issues certificates to many state bodies.

## Source

Every certificate was downloaded from the national root CA's site, https://rootca.gov.vn, on 2026-10-20: the root CA page and each licensed CA's page link the `.p7b` or `.crt` files under `https://rootca.gov.vn/crt/`. Each certificate in the two files carries its subject, issuer, validity, SHA-256 fingerprint and the URLs it came from. `apps/extract/test/einvoice-trust.test.ts` checks every fingerprint, that the roots are self-signed CAs and that every intermediate was issued by a shipped root.

Left out on purpose: the timestamping root and the timestamping CAs (they sign timestamps, not invoices), and the 2026 EMA root with its ERD and LTA CAs (not used for signing documents).

## The tax authority's certificates (#951)

| Certificate | Valid | Where it comes from | Confidence |
|---|---|---|---|
| `CN=TỔNG CỤC THUẾ, O=BỘ TÀI CHÍNH` | 2021-11-17 to 2026-11-16 | The tax authority's signature on a genuine VAT e-invoice of 2024-01-16, from a public repository's history (the invoice is not copied here) | High. Crove's own verifier reports that invoice as `tax_authority_untrusted` without this certificate, and as `verified` with it. The seller's signature on the same invoice chains to the national root above. |
| `CN=CỤC THUẾ, O=BỘ TÀI CHÍNH` | 2025-03-13 to 2030-03-12 | The trusted signer store of the tax authority's iTaxViewer 2.7.3, as copied in a public repository | Medium-high. It is the successor after Tổng cục Thuế became Cục Thuế (March 2025), with the same issuer and the same key identifier of that issuer as the first. It has not yet been seen on an invoice. |

The tax authority rotates its certificate: an older `Tổng cục Thuế` certificate (2017 to 2027, the old Ministry of Finance CA) exists too, but no invoice signed with it was found, so it is not pinned. An invoice keeps verifying after its certificate expires, because the certificate must be valid when the invoice was signed, not today.

**Still to confirm:**
- A real invoice from after March 2025 from the pilot accountant (#61), to confirm that the `CỤC THUẾ` certificate is the one on invoices.
- The Government CA's two SHA-256 lines against https://ca.gov.vn. That site was not reachable from where these files were made.

When a new tax authority certificate appears (an invoice reported `tax_authority_untrusted` whose `CQT` signer is the tax authority), take it from a genuine invoice. Check that it was issued by the Government CA in `tax-authority-issuers.crt`, and add it with its comment block. `pnpm test` checks the fingerprint, the issuer and the subject.

## Known gaps

- **No revocation check.** Nothing is fetched from the sandbox, so neither CRLs nor OCSP are consulted: a certificate revoked after it was issued still verifies. The signing time is the signed `SigningTime` (or the invoice date), which the signer writes; there is no trusted timestamp.
- **SHA-1 is accepted.** The MIC National Root CA (2008) and the CAs it issued sign with SHA-1, and older invoices are signed with RSA-SHA1, so both are verified like SHA-256 ones; their certificates expired years ago, so only invoices signed while they were valid can pass.
- **Certificate profile.** The signer's key usage and extended key usage, and the path length and name constraints of the CAs on the way, are not checked yet (#952); a CA would have to misissue first.
- **Size.** A file beyond 30,000 elements or 2.5 million characters is not verified (`too_large`), so that verification never runs into the parser's time limit.

## Updating

Download the bundles again from https://rootca.gov.vn, convert them to PEM (`openssl pkcs7 -inform DER -print_certs`), and write each certificate with its comment block as the existing ones are. Run `pnpm test` to check the fingerprints and chains.
