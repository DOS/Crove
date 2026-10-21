# HTKK XML of the TT133 year-end financial statements (issue #920)

A company under the TT133 accounting regime files its year-end financial statements with GDT's HTKK software and the
eTax portal by the end of the third month after the year ends. Instead of retyping Crove's B01-DNN, B02-DNN and trial
balance into HTKK, the accountant downloads them as the XML file HTKK itself produces for the set "Bộ báo cáo tài chính
(B01a - DNN)", completes what Crove does not hold (notes, signers, the tax office), then files it.

- **Where:** "Sổ sách" screen, tab "Báo cáo tài chính", with a year picked: section "Báo cáo tài chính năm ... cho
  HTKK", button "Xuất XML cho HTKK" (`GET /api/export/statements-htkk.xml?year=2026`). The section first lists what the
  file would get wrong or leave out (`ledger.statementsHtkkCheck`, below); the file is still written. The route refuses
  an org without a tax code (422 `TAX_CODE_REQUIRED`) or a blank name (422 `TAXPAYER_NAME_REQUIRED`), and a year
  outside 2001-2099 (422; the previous year must be a ledger period too).
- **Who:** every member of the org (the roles of the statements), behind the Finance module switch. Each download
  writes one audit row (`finance.statements.export`, detail `{ period: "2026", format: "htkk_bctc_xml", warnings }`,
  never the figures); no row, no file. The response is `private, no-store`.
- **Code:** the layout and the values are `modules/finance/src/domain/statements-htkk-xml.ts` (`HTKK_BCTC` holds the
  form code, version and texts as data; `F01_ACCOUNTS` HTKK's account list); the queries are
  `modules/finance/src/statements-htkk.ts`; the route is in `apps/kernel/src/http.ts`. Tests:
  `modules/finance/test/statements-htkk-xml.test.ts` and the HTKK part of `apps/kernel/test/finance-ledger.db.test.ts`.

## Which form and version

| Fact | Status | Source |
|---|---|---|
| The TT133 set in HTKK is "Bộ báo cáo tài chính (B01a - DNN)(TT133/2016/TT-BTC)": form code `683`, XML version `2.3.2`, file `133_B01A_DNN_BCTC`, valid from 01/01/2017 with no end date | Confirmed in HTKK's menu (S1) | S1 `HTKK/Project/Menu.xml` |
| The same menu has B01b-DNN (`684`, the alternative statement for small companies), B01-DNNKLT (`685`, not going concern) and B01-DNSN (`686`, micro companies). Crove writes B01a, the going-concern form its B01 builder follows | Confirmed (S1) | S1 |
| The set's sheets: B01a in the main part (`CTieuTKhaiChinh`), B02 (`PLuc/PL_KQHDSXKD`), the cash flow statement by the direct and the indirect method (`PL_LCTTTT`, `PL_LCTTGT`) and F01 (`PL_CDTK`) as appendices | Confirmed (S1); the menu writes the B02 node `PL_KQHDXSKD`, the schema and the template `PL_KQHDSXKD`; Crove follows the schema | S1 menu, schema and templates |
| Every appendix is optional in the schema (`minOccurs="0"`). Crove writes B02 and F01 and leaves out the cash flow statement, which TT133 does not make compulsory for small and medium companies | Schema: confirmed. That B03-DNN is optional: unconfirmed, to ask the accountant | S1 schema |
| GDT's viewer (iTaxViewer) lists form 683 version 2.3.2 with the B02, cash flow and F01 appendices | Confirmed (S2) | S2 `DMucTKhai.xml` |
| HTKK's notices up to 5.8.1 (2026-10-16) do not change form 683 | Inferred: the 01/GTGT research (htkk-01gtgt-xml.md) read those notices and none names the TT133 statements | gdt.gov.vn, read for #332 |
| How HTKK writes the period of this form: Crove writes `kieuKy` `Y`, `kyKKhai` `2026` and the year's first and last day, as `TKhaiThue.xsd` documents a year. HTKK's template leaves the period empty with `kieuKy` `D`, and the viewer catalogue marks the form `kieuKyKKhai="M"` | **Unconfirmed**: both pass the schema; question 1 below | S1 template, S2 catalogue |

## Sources of the layout

GDT does not publish the schemas as a download. They ship inside the free HTKK installer; copies of an install
directory are on GitHub without a licence, so **the schema files are not vendored here**. The element order is written
out in the unit test, and the XSD check below was run locally against the copies.

| # | Source | What it gives |
|---|---|---|
| S1 | [thien0247/HTKK](https://github.com/thien0247/HTKK) (copy of an HTKK install, no licence): `HTKK/Project/Menu.xml`, `HTKK/InterfaceTemplates/Validate/133_B01A_DNN_BCTC_232.xsd` (redefines `TKhaiThue.xsd`), `HTKK/InterfaceTemplates/xml/133_B01A_01_THTC_xml_232.xml`, `..._02_SXKD_xml_232.xml`, `..._05_CDTK_xml_232.xml` | Form code, version, element names, order and types; F01's account list; namespace `http://kekhaithue.gdt.gov.vn/TKhaiThue` |
| S2 | [mrkent19999999x-gif/etaxview-patch](https://github.com/mrkent19999999x-gif/etaxview-patch) (GDT iTaxViewer files, no licence): `DMucTKhai.xml`, `XSLT 2.3.2/.../BCTC/TKhai_BCTC_133_B01a.xslt` | The viewer's entry for form 683 and how it shows the columns (Số cuối năm, Số đầu năm) |

Sources read on 2026-10-21.

## What the file holds

Root `HSoThueDTu` in GDT's namespace, `HSoKhaiThue id="ID_1"`, then:

- **`TTinChung`** (envelope), as for 01/GTGT: `TTinDVu` names Crove (`maDVu` `CROVE`); `maTKhai` 683, the form's title
  and legal basis, `pbanTKhaiXML` 2.3.2, `loaiTKhai` `C` (first filing; supplementary ones are out of scope), `soLan`
  0; the period (above); `ngayLapTKhai` and `ngayKy` the day of the download in Vietnam time. `NNT`: tax code, name and
  the address as one line in `dchiNNT` when the org has one. The tax office, signer, address parts and contacts are
  empty; no `DLyThue` block.
- **`CTieuTKhaiChinh`** (B01a-DNN): `bctcDaKiemToan` `0` (not audited: the schema types it `xs:boolean`, so it cannot
  be empty), the audit opinion empty, `ThuyetMinh` (the note reference of each line) empty, then `SoCuoiNam` (B01 at 31
  December of the year) and `SoDauNam` (B01 at 31 December of the previous year), codes 110 to 500. The preparer, chief
  accountant and legal representative are empty; `ngayLap` (an `xs:date`) is the day of the download.
- **`PLuc/PL_KQHDSXKD`** (B02-DNN): empty `ThuyetMinh`, `NamNay` (the year) and `NamTruoc` (the previous year), codes
  01 to 60.
- **`PLuc/PL_CDTK`** (F01-DNN): opening balances, the year's debits and credits, closing balances, each as `No` and `Co`
  rows for HTKK's 123 accounts of level 1 and 2, then `tongCong`.

Values:

- B01 and B02 come from the same builders as the screen and the Excel workbook (`domain/tt133-reports.ts`). Their
  mapping is a DRAFT the accountant has not verified yet (#154): the file carries the same figures, no more checked.
- Amounts are whole dong (`xs:long`). Each line read from accounts is rounded half up, then every total line is worked
  out again from the rounded lines with the form's formulas, so the file adds up exactly. An amount beyond HTKK's 14
  digits is refused (422).
- F01 takes each listed account's row of the year's trial balance (`ledger.period`), whose rows hold their
  sub-accounts: an org sub-account (`6422.DV`) is inside 6422 and 642. `tongCong` is the sum of the level-1 rows.
  Payables and receivables (131, 331) keep both sides per party, as on the trial balance.

## Warnings (`ledger.statementsHtkkCheck`)

| Code | When |
|---|---|
| `YEAR_NOT_CLOSED` | The year has no closing in force (#889): the result is still on classes 5 to 9 instead of 4212, and F01 shows them with balances |
| `B01_UNBALANCED` | B01 of the year or of the previous year does not balance (code 200 differs from 500) |
| `UNMAPPED_BALANCES` | Some balances are read by no line of B01 or B02 |
| `F01_UNCOVERED` | A top-level account with amounts is not in HTKK's list (an account outside TT133's chart), so F01 leaves it out; the accounts are named |

## Verification

- Unit tests: the values and totals (rounding before the totals), the F01 rows from a trial balance with an org
  sub-account, an uncovered account, the element order of S1's templates, escaping, and the refusals.
- Locally, the samples the unit test writes (with `HTKK_XML_OUT` set) validate against S1's
  `133_B01A_DNN_BCTC_232.xsd` with lxml, **after one fix to a copy of the schema**: it declares two element names with
  a trailing space (`name="PL_CDTK "` once, `name="ct156 "` six times, in the F01 lists). No document can match those
  names under a strict validator, while HTKK's own template and menu write `PL_CDTK` and `ct156`; HTKK's validator
  evidently ignores the space. With the spaces removed, both samples validate, and broken variants (a missing `ct500`,
  a fraction, an empty `bctcDaKiemToan`, a missing `tongCong`, a 5-digit tax code, a wrong `kieuKy`) are rejected.
- DB test: the route as a viewer, the audit row, the refusals, the check's warnings.
- Not verified: opening the file in HTKK and filing it on eTax. That is the acceptance step of #920 and needs the
  partner's accountant.

## Not in this file

- The notes, B09-DNN: written by the accountant in HTKK (follow-up issue, Icebox).
- The cash flow statement, B03-DNN (optional appendices `PL_LCTTTT`, `PL_LCTTGT`).
- B01b-DNN, B01-DNNKLT and B01-DNSN, a fiscal year that is not the calendar year, and a supplementary filing.

## Questions for the partner's accountant

1. Open the file in HTKK (the B01a-DNN set, "Bộ báo cáo tài chính (B01a - DNN)(TT133/2016/TT-BTC)"): does HTKK take it
   as the year 2026? If not, how does your HTKK write the period of this form (`kieuKy` `Y` with `kyKKhai` `2026`, or
   `D` with the year's first and last day)?
2. Is form 683, XML version 2.3.2 still what your HTKK 5.8.x writes for the TT133 statements?
3. Do your clients file the cash flow statement (B03-DNN) with the set? If so, by which method?
4. Do any of your clients file B01b-DNN (`684`) or the micro form B01-DNSN (`686`) instead of B01a?
5. Is `bctcDaKiemToan` `0` (not audited) right for your clients, and does eTax need the preparer, chief accountant and
   legal representative filled before it takes the file?
6. F01 shows 131 and 331 with both sides per party, as Crove's trial balance does. Is that what you file, or the net
   balance of each account?
