# HTKK XML of the VAT return 01/GTGT (issue #332)

The firm files the monthly or quarterly VAT return (form 01/GTGT, credit method) with GDT's HTKK software and the
eTax portal. Instead of typing the figures of Crove's VAT working (#316) into HTKK again, the accountant downloads
them as the XML file HTKK itself produces for that form, checks and completes it, then files it on eTax.

- **Where:** "Tờ khai GTGT" screen, button "Xuất XML cho HTKK" (`GET /api/export/vat-01gtgt.xml?period=2026-09` or
  `?period=2026-Q3`). The button waits for the org's tax code (Settings, #313); the route refuses an org without one
  (422 `TAX_CODE_REQUIRED`).
- **Who:** every member of the org (the roles of the VAT working). Each download writes one audit row
  (`finance.vat.export`, detail `{ period, documents, format: "htkk_01gtgt_xml" }`, never the figures); no row, no file.
  The response is `private, no-store`.
- **Code:** the layout and the values are `modules/finance/src/domain/vat-01gtgt-xml.ts` (`HTKK_01GTGT` holds the form
  code, version and fixed texts as data); the route is in `apps/kernel/src/http.ts`; tests are
  `modules/finance/test/vat-01gtgt-xml.test.ts` and the HTKK part of `apps/kernel/test/finance-vat.db.test.ts`, plus
  `e2e/tests/vat-xml.spec.ts`.

## Which form version

| Fact | Status | Source |
|---|---|---|
| Circular 89/2026/TT-BTC (issued 2026-06-30, in force 2026-07-01) guides the Law on Tax Administration 108/2025/QH15 and repeals Circular 80/2021, among others | Confirmed (secondary sources, one a provincial government site) | [MISA AMIS](https://amis.misa.vn/282299/), [Cần Thơ legal education portal: "10 thông tư bị bãi bỏ"](https://pbgdpl.cantho.gov.vn) |
| Circular 89 has a new 01/GTGT in its Appendix I: it adds [32b] (sales not in the VAT base) and [34a] (sales outside the scope of the VAT law), so [27] = [29] + [30] + [32] + [32a] - [32b] and [34] = [26] + [27] + [34a], and renames some rows | Unconfirmed: secondary sources agree, the circular's own text was not read | mva.vn, ags-vina, ceo.acac.vn summaries |
| Its Article 100: electronic tax data keeps the current forms and methods until the tax authority announces new ones | Confirmed (secondary) | [luatvietnam.vn](https://luatvietnam.vn/tin-van-ban-moi/tu-01-7-2026-10-thong-tu-ve-thue-het-hieu-luc-thi-hanh-186-110487-article.html) |
| GDT's HTKK releases 5.7.2 to 5.8.1 (2026-07-10 to 2026-10-16) upgrade other forms to Circular 89 (corporate income tax, foreign contractor, fees, 06/TNCN, ...) but not 01/GTGT; 5.7.5 was read only through a third-party summary | Confirmed for the notices read on gdt.gov.vn | [GDT: Hỗ trợ kê khai](https://gdt.gov.vn/wps/portal/home/hotrokekhai) |
| The 01/GTGT XML HTKK writes today: form code `842`, XML version `2.8.3`, the Circular 80 form | Confirmed for HTKK 5.6.1 (03/2026) and a return GDT sent back for Q4/2025 (01/2026); inferred still current in 5.8.1, since no notice changes it | S1, S3 below |

So Crove writes the **Circular 80 form, XML version 2.8.3**, the one HTKK writes today, for every period. [32b] and
[34a] do not exist in that version; Crove has no data for them anyway (`form01Indicators` reports none). When GDT
releases the Circular 89 XML, `HTKK_01GTGT` and the element list change; that is a new task.

## Sources of the layout

GDT does not publish the schemas as a download that could be found. They ship inside the free HTKK installer
(`InterfaceTemplates/TKhaiThue.xsd`, `InterfaceTemplates/Validate/01_GTGT_TT80_283.xsd`, the serialization template
`InterfaceTemplates/xml/01_GTGT_TT80_xml_283.xml`). Copies of an HTKK install directory are on GitHub without a
licence, so **the schema files are not vendored here**: the element order is written out in the unit test, and the
XSD check below was run locally against the copies.

| # | Source | What it gives |
|---|---|---|
| S1 | [thien0247/HTKK](https://github.com/thien0247/HTKK) (copy of an HTKK install, no licence): `HTKK/InterfaceTemplates/Validate/01_GTGT_TT80_283.xsd`, `HTKK/InterfaceTemplates/TKhaiThue.xsd`, `HTKK/InterfaceTemplates/xml/01_GTGT_TT80_xml_283.xml`, `HTKK/Project/Menu.xml` (`MaToKhai="842"`, `VersionXML="2.8.3"`), `HTKK/InterfaceIni/ConvertVersion.xml` (versions 2.5.1, 2.6.8, 2.7.4, 2.8.3) | Element names, order, types and patterns; namespace `http://kekhaithue.gdt.gov.vn/TKhaiThue` |
| S2 | [mrkent19999999x-gif/etaxview-patch](https://github.com/mrkent19999999x-gif/etaxview-patch) (GDT iTaxViewer files, no licence): `XSLT 2.8.3/.../TKhai_GTGT_01_TT80.xslt`, `DMucTKhai.xml` | Row labels and formulas of each indicator; form 842 with XML versions up to 2.8.3 |
| S3 | A 01/GTGT return for Q4/2025 sent back by GDT, signed (in a public repository; only its structure was used) | `pbanTKhaiXML` 2.8.3; a quarter written `kyKKhai` `4/2025` with `kyKKhaiTuThang` `10/2025` and `kyKKhaiDenThang` `12/2025`; another service (`maDVu` "TTGQ TTHC") named in `TTinDVu`; the signature `CKyDTu` added at filing |
| S4 | An HTKK 5.6.1 export for 03/2026 (in a public repository; authenticity not established) | Same structure; `maDVu` "HTKK" |

Sources read on 2026-10-19.

## What the file holds

Root `HSoThueDTu` in GDT's namespace, `HSoKhaiThue id="ID_1"`, then:

- **`TTinChung`** (envelope): `TTinDVu` names Crove (`maDVu` `CROVE`), not HTKK. `TKhaiThue`: `maTKhai` 842, the form's
  title and legal basis, `pbanTKhaiXML` 2.8.3, `loaiTKhai` `C` (first return; supplementary returns are out of
  scope), `soLan` 0. `KyKKhaiThue`: a month is `kieuKy` `M`, `kyKKhai` `MM/YYYY` (as the schema notes say); a quarter is
  `kieuKy` `Q`, `kyKKhai` `Q/YYYY` with its first and last month (as S3); the first and last day as `DD/MM/YYYY`.
  `ngayLapTKhai` and `ngayKy` are the day of the download in Vietnam time, `YYYY-MM-DD` (`ngayKy` is an `xs:date`).
  The tax office, the signer and the line of business are empty. `NNT`: the org's tax code and name; address and
  contacts empty (Crove does not hold them). No `DLyThue` (tax agent) block.
- **`CTieuTKhaiChinh`**: `ma_NganhNghe` `00` (ordinary business), `tieuMucHachToan` `1701` (domestic VAT), an empty
  `Header` ([09] to [11c]), then every indicator from [21] to [43], all numbers (the schema types them `xs:long`,
  `xs:nonNegativeInteger` for [22], [40a], [40] and [41], and `xs:boolean` for [21]; an empty number would fail it).
- No `PLuc` (appendices): the reduced-rate appendix of Decree 174/2025 is not generated.

| Indicator | Value |
|---|---|
| [21] no activity in the period | `0` (not ticked); the accountant ticks it |
| [22] VAT carried forward from the previous period | 0 |
| [23], [24] purchases and their VAT | Crove: all purchase invoices of the period |
| [23a], [24a] of which imports | 0 (import declarations are not in Crove) |
| [25] deductible input VAT | **0**; the accountant enters it |
| [26] to [35] sales | Crove: `form01Indicators` (8% sales in [32] and [33] with 10%) |
| [36] = [35] - [25] | worked out, so equal to [35] until [25] is entered |
| [37], [38], [39a], [40b], [42] | 0 |
| [40a], [41] | worked out from x = [36] - [22] + [37] - [38] - [39a]: [40a] = x when x >= 0, else [41] = -x |
| [40] = [40a] - [40b], [43] = [41] - [42] | worked out |

Amounts are whole dong: each computed indicator is rounded half up, then the sums are worked out from the rounded
values so the file obeys the form's formulas exactly. An amount beyond HTKK's 14 digits is refused.

## Verification

- Unit tests: values and formulas, month and quarter, the element order of S1's template, escaping (an org name with
  `<`, `&`, quotes, a line break and a control character).
- Locally, the four samples the unit test writes (with `HTKK_XML_OUT` set) validate against S1's
  `01_GTGT_TT80_283.xsd` (which redefines `TKhaiThue.xsd`) with lxml; broken variants (a missing [25], a negative
  [40a], a wrong budget sub-item, a missing [43], a 5-digit tax code) are rejected. Re-run it against the XSDs of a
  current HTKK install when the version changes.
- Not verified: an import into HTKK and an upload on eTax. That is the acceptance step of #332 and needs the partner's
  accountant.

## Questions for the partner's accountant

1. Is form code 842, XML version 2.8.3 (Circular 80) what your HTKK 5.8.x writes for 01/GTGT of a period from 07/2026,
   and does eTax accept it for those periods? Or has your HTKK moved to a Circular 89 version (with [32b] and [34a])?
2. How do you load the file: through HTKK, or by uploading it on eTax directly? Does either refuse `maDVu` `CROVE`
   (the software name) or the empty `ttinNhaCCapDVu`?
3. Month periods: HTKK writes `kyKKhai` as `09/2026` or `9/2026`?
4. [25] is 0 in the file, so the payable VAT ([36], [40]) counts no deduction until you enter it. Would you rather
   Crove put [24] (all input VAT) in [25] and let you reduce it?
5. Which of [21], [22], [23a]/[24a], [37], [38], [39a], [40b], [42] do your clients use, and from where should Crove
   take them later (the previous return for [22], import declarations for [23a]/[24a])?
6. Does the file need the tax office (`maCQTNoiNop`), the signer and the address filled before HTKK or eTax takes it?
7. Do you need the reduced-rate appendix (Decree 174/2025) in the same file, or do you prepare it in HTKK?
