# E-invoice signature trust data

The certificates crove-extract checks e-invoice signatures against (#674). The parser process has no network, so this data ships with the code and is read from disk.

- `roots.crt`: the trust anchors. The self-signed Vietnam National Root CA certificates run by the National Electronic Authentication Centre (NEAC): MIC National Root CA (SHA-1, 2008), Vietnam National Root CA (2014), Vietnam National Root CA G3 (2024), and the 2025 roots for USB token, remote signing and mobile PKI.
- `intermediates.crt`: the licensed public CAs (VNPT-CA, Viettel-CA, BkavCA, FPT-CA, MISA-CA and the others) issued by those roots. They only help build a chain from a signer's certificate to a root; none of them is trusted on its own.

## Source

Every certificate was downloaded from the national root CA's site, https://rootca.gov.vn, on 2026-10-20: the root CA page and each licensed CA's page link the `.p7b` or `.crt` files under `https://rootca.gov.vn/crt/`. Each certificate in the two files carries its subject, issuer, validity, SHA-256 fingerprint and the URLs it came from. `apps/extract/test/einvoice-trust.test.ts` checks every fingerprint, that the roots are self-signed CAs and that every intermediate was issued by a shipped root.

Left out on purpose: the timestamping root and the timestamping CAs (they sign timestamps, not invoices), and the 2026 EMA root with its ERD and LTA CAs (not used for signing documents).

## Known gaps

- **No revocation check.** Nothing is fetched from the sandbox, so neither CRLs nor OCSP are consulted: a certificate revoked after it was issued still verifies. The signing time is the signed `SigningTime` (or the invoice date), which the signer writes; there is no trusted timestamp.
- **The tax authority's certificate.** Invoices with a tax authority code also carry the tax authority's signature. If its certificate chains to the Government CA (Ban Cơ yếu Chính phủ) rather than to the national root CA, that root is not shipped here yet, and such invoices show as unverified with the reason `tax_authority_untrusted`. Adding the root to `roots.crt`, with its source, fixes it.

## Updating

Download the bundles again from https://rootca.gov.vn, convert them to PEM (`openssl pkcs7 -inform DER -print_certs`), and write each certificate with its comment block as the existing ones are. Run `pnpm test` to check the fingerprints and chains.
