# MISA SME import templates (issues #317, #657)

Firms keep their system of record (decision D10). For firms on MISA SME, Crove exports vouchers as Excel files in
the layout of MISA SME's own import templates, so the accountant imports them with **Tệp > Nhập khẩu từ Excel**
instead of typing them again.

- **Purchase vouchers:** Journal screen, button "Xuất chứng từ mua vào cho MISA" (`GET /api/export/misa/purchases.xlsx?from=&to=`).
  One file for the date range (journal entry date), one row per invoice line.
- **Sales vouchers:** Journal screen, button "Xuất chứng từ bán hàng cho MISA" (`GET /api/export/misa/sales.xlsx?from=&to=`,
  #313). The recorded sales e-invoices (`finance.vouchers.sales`), one row per invoice line, posted as Crove posts
  them: Nợ 131, Có each line's revenue account, Có 3331.
- **Cash receipts and payments (phiếu thu, phiếu chi):** "Thu chi" screen, buttons "Xuất phiếu thu cho MISA" and
  "Xuất phiếu chi cho MISA" (`GET /api/export/misa/receipts.xlsx?from=&to=` and `payments.xlsx`, #657). The posted
  vouchers of the date range (voucher date), one file per type since an import file holds vouchers of one type (S1), one
  row per voucher line. A voucher whose entry was reversed is left out.
- **Bank vouchers (giấy báo Có, giấy báo Nợ)** are not exported yet: MISA imports them with its own deposit templates
  (Tiền gửi > Thu tiền / Chi tiền), whose headers no source here gives. See the open questions.

The column mapping is one array per template in `modules/finance/src/misa.ts` (`MISA_SME_PURCHASE_SERVICE.columns`,
`MISA_SME_SALES.columns`, `MISA_SME_CASH_RECEIPT.columns`, `MISA_SME_CASH_PAYMENT.columns`): header text, order and the rule that fills each column. When the partner's real template
differs, edit that array and the golden header list in `modules/finance/test/misa.test.ts`; nothing else needs to change.

## Template versions and sources

MISA does not publish the SME voucher templates as downloads: the software ships them and offers them under
**Tải tệp mẫu** in the import wizard. The headers below therefore come from copies of those shipped files, checked
against each other where possible.

| # | Source | What it gives | Kind |
|---|---|---|---|
| S1 | [MISA SME 2023 help: import categories, balances and vouchers from Excel](https://helpsme.misa.vn/2023/kb/html_10050000/) | One file holds many vouchers of one type; a voucher with several goods or service lines is several rows with the general columns repeated; columns marked required must be matched | MISA official |
| S2 | [MISA SME 2023 help: a column missing from the template](https://helpsme.misa.vn/2023/kb/toi-nhap-khau-tu-excel-nhung-thong-tin-can-nhap-khau-khong-co-cot-san-tren-file-excel-lam-the-nao/) | The wizard matches a file column to a field automatically when the header equals the field name; otherwise the accountant picks it by hand | MISA official |
| S3 | [MISA forum: importing vouchers from Excel (MISA SME.NET 2019 section)](https://forum.misa.vn/threads/huong-dan-nhap-khau-chung-tu-tu-excel.44457/) | Columns marked `(*)` are required; the template comes from the "Tải tệp dữ liệu mẫu" button | MISA forum |
| S4 | [MISA AMIS help, release R29: KHAC and KKKNT added to the voucher import templates](https://helpact.misa.vn/?p=20146) | The VAT rate codes KHAC and KKKNT exist in MISA import templates (AMIS Kế toán, same vendor) | MISA official, sibling product |
| S5 | [MISA SME.NET 2017 help: importing sales invoices](https://helpsme.misa.vn/2017/nhapkhau_hoadonbanhang_tuexcel.htm) | Sales invoices can be imported; not when MISA itself manages invoice issuing ("Sử dụng phần mềm để quản lý phát hành hóa đơn") | MISA official, old version |
| S6 | `lib/misa-export/Ban_hang_template.xls`, `template_notes.json`, `phieu_chi_notes.json`, `phieu_thu_notes.json` in [duynguyen1105/tt-station-hub](https://github.com/duynguyen1105/tt-station-hub/tree/6cafe35bc3d7faa10137f86d8ae512f2449dd19b/lib/misa-export) | A blank MISA SME.NET "Chứng từ bán hàng" template (sheet `Chứng từ bán hàng`, 49 headers in row 1). We read the file: its cell notes are titled "MISA SME.NET" (51 notes) and give the value codes. The notes of the MISA SME.NET "Phiếu chi" template give the purchase side VAT codes. The notes of the "Phiếu thu" (sheet `Phiếu thu`, 18 columns) and "Phiếu chi" (sheet `Phiếu chi`, 32 columns) templates give their headers, in column order, with value codes and length limits (read on 2026-10-20) | Third-party copy of the MISA file |
| S7 | `MISA-AUDIT-FULL-V12.md` in [NachaFromMars/supercitadel](https://github.com/NachaFromMars/supercitadel/blob/8f64f35186ebc90587d301fd8e92ff7f6269baa4/MISA-AUDIT-FULL-V12.md) | Header rows of the files in `Template/ImportExcel` of a **MISA SME 2026** installation, including `Ban_hang_VND.xls` and `Chung_tu_mua_dich_vu_chua_thanh_toan_VND.xls` | Third-party listing of the MISA files |
| S8 | `converter/fixtures/templates/purchase_service.xls` in [dataiyeumenh/ez-format](https://github.com/dataiyeumenh/ez-format/tree/bb01c85f8aaac01c930f14b51bd20a9394f1bb7b/converter/fixtures/templates) | The **MISA AMIS** (not SME) "mua dịch vụ" template, with a sample row: dates `31/01/2020`, `% thuế GTGT` as the number `10` | Third-party copy, other product |

Sources read on 2026-10-17. Target version: **MISA SME 2026** (S7), with the sales headers matching an older
MISA SME.NET copy (S6) column for column.

## Purchase vouchers: `Chung_tu_mua_dich_vu_chua_thanh_toan_VND.xls`

Crove posts an approved purchase invoice as Nợ expense or asset accounts, Nợ 1331 or 1332, Có 331. In MISA that is a
**Chứng từ mua dịch vụ, chưa thanh toán** (a purchase not paid yet, not received into a warehouse). The `_VND`
variant is the one without currency and exchange rate columns; Crove records VND purchases only.

Sheet `Chứng từ mua dịch vụ`, headers in row 1, 33 columns. Header text is **unconfirmed** against a template file:
it comes from one listing (S7). Headers marked "also in S6" are spelled the same in the confirmed SME templates.

| Header | Crove fills | Header status |
|---|---|---|
| Hiển thị trên sổ | blank (both books, per S6 notes) | also in S6 |
| Phương thức thanh toán | blank (meaning "not paid" is unconfirmed for this template) | also in S6 |
| Là CP mua hàng | blank | S7 only |
| Ngày hạch toán (*) | journal entry date | also in S6 |
| Ngày chứng từ (*) | journal entry date | also in S6 |
| Số chứng từ (*) | `CRMDV` + last 12 hex digits of the journal entry id (max 20 characters, per S6 notes) | also in S6 |
| Mã nhà cung cấp | blank (MISA catalog code) | also in S6 |
| Tên nhà cung cấp | vendor name (max 128) | also in S6 |
| Địa chỉ | vendor address (max 255) | also in S6 |
| Diễn giải/Lý do chi/Nội dung thanh toán | journal entry description (max 255) | S7 only |
| NV mua hàng | blank | S7 only |
| Mã dịch vụ (*) | **blank**: a MISA catalog code the accountant fills before importing | S7 only |
| Tên dịch vụ | line description (max 255) | S7 only |
| TK chi phí/TK kho | line debit account | S7 only |
| TK công nợ/TK tiền | 331 | S7 only |
| Đối tượng | blank | S7 only |
| ĐVT | blank (MISA unit catalog) | also in S6 |
| Số lượng | line quantity, exact | also in S6 |
| Đơn giá | line unit price, exact | also in S6 |
| Thành tiền | line amount before VAT, exact, negative for a discount line | also in S6 |
| % thuế GTGT | 0, 5, 8, 10 as numbers; KCT, KKKNT, KHAC as text | also in S6 |
| Tỷ lệ tính thuế (Thuế suất KHAC) | the rate, only with KHAC | also in S6 |
| Tiền thuế GTGT | the line's share of the invoice VAT (below) | also in S6 |
| TK thuế GTGT | 1331, or 1332 for a fixed asset line (211) | also in S6 |
| Mẫu số HĐ | blank (Crove does not store the invoice form number) | S7 only |
| Ký hiệu HĐ | invoice series | S7 only |
| Số hóa đơn | invoice number (MISA allows 25 characters; never cut: a cut number could make two invoices look the same, so a longer one is left for MISA to flag) | also in S6 |
| Ngày hóa đơn | invoice date | also in S6 |
| Nhóm HHDV mua vào | blank (MISA group code) | S7, and in the S6 "Phiếu chi" notes |
| Mã NCC | blank | S7 only |
| Tên NCC | vendor name (max 128) | S7 only |
| Mã số thuế NCC | vendor tax code (max 20, per the S6 "Phiếu chi" note on the same field) | S7 only |
| Địa chỉ NCC | vendor address (max 255) | S7 only |

Left out on purpose: voided purchase documents (their entry was reversed, #165) and reversal entries.

## Sales vouchers: `Ban_hang_VND.xls`

Sheet `Chứng từ bán hàng`, headers in row 1, 49 columns. **Confirmed**: the same 49 headers, in the same order, in
the MISA SME.NET file (S6) and in the MISA SME 2026 listing (S7). Value codes come from the file's own cell notes (S6).

| Header | Crove fills |
|---|---|
| Hiển thị trên sổ, Hình thức bán hàng, Phương thức thanh toán | blank: both books, domestic sale, not collected yet (S6 notes) |
| Kiêm phiếu xuất kho | 0: no warehouse issue (blank would mean 1) |
| XK vào khu phi thuế quan và các TH được coi như XK | blank |
| Lập kèm hóa đơn | 1 |
| Đã lập hóa đơn | 1: the e-invoice is already issued (by Crove's provider, #313) |
| Ngày hạch toán (*), Ngày chứng từ (*) | journal entry date |
| Số chứng từ (*) | `CRBH` + last 12 hex digits of the journal entry id |
| Số phiếu xuất, Lý do xuất | blank |
| Số hóa đơn (never cut), Ngày hóa đơn | the e-invoice number and date |
| Mã khách hàng | blank (MISA catalog code) |
| Tên khách hàng (max 128), Địa chỉ (max 255), Mã số thuế (max 50) | the buyer |
| Diễn giải | journal entry description (max 255) |
| Nộp vào TK, NV bán hàng | blank |
| Mã hàng (*) | **blank**: a MISA catalog code the accountant fills before importing |
| Tên hàng | line description (max 255) |
| Hàng khuyến mại | blank |
| TK Tiền/Chi phí/Nợ (*) | receivable account (131) |
| TK Doanh thu/Có (*) | line revenue account (511) |
| ĐVT, Đơn giá sau thuế | blank |
| Số lượng, Đơn giá, Thành tiền | line quantity, unit price, amount before VAT |
| Tỷ lệ CK (%), Tiền chiết khấu, TK chiết khấu, export tax columns | blank |
| % thuế GTGT, Tỷ lệ tính thuế (Thuế suất KHAC), Tiền thuế GTGT, TK thuế GTGT | as for purchases; account 3331 |
| HH không TH trên tờ khai thuế GTGT, Kho, TK giá vốn, TK Kho, Đơn giá vốn, Tiền vốn, Hàng hóa giữ hộ/bán hộ | blank |

`Ban_hang_VND.xls` has no "Ký hiệu HĐ" or "Mẫu số HĐ" column (the non-VND `Ban_hang.xls` has both, S7), so the sales
file carries the invoice number and date but not the series.

Sales come from the e-invoices the org issued (#313): an invoice whose seller has the org's tax code (Settings) is
recorded as a sale. The export records an audit row like the purchase one, with `format: 'misa_sme_sales'`. Left out
on purpose: voided sales documents and reversal entries.

## Cash receipts and payments: `Phiếu thu`, `Phiếu chi`

Sheets `Phiếu thu` (18 columns) and `Phiếu chi` (32 columns), headers in row 1. **From one source**: the cell notes
of the MISA SME.NET templates (S6), one note per column, in column order. No MISA SME 2026 listing of these two files
was found, so check the headers against the partner's own template first (open question 9).

| Header | Crove fills |
|---|---|
| Hiển thị trên sổ | blank: both books |
| Ngày hạch toán (*), Ngày chứng từ (*) | voucher date |
| Số chứng từ (*) | `CR` + Crove's voucher code: `CRPT00001`, `CRPC00001` (the firm's MISA numbers its own vouchers PT00001, PC00001 ...) |
| Mã đối tượng, Đối tượng | blank (MISA catalog codes) |
| Tên đối tượng (max 128), Địa chỉ (max 255) | the voucher's party, when it has one |
| Lý do nộp / Lý do chi | blank: MISA reads 13 (Thu khác) / 23 (Chi khác) |
| Diễn giải lý do nộp / Diễn giải lý do chi (max 255) | the voucher's reason |
| Người nộp / Người nhận (max 255) | the person named on the voucher |
| Nhân viên thu / Nhân viên, Kèm theo | blank |
| Diễn giải (max 255) | the line's memo, else the voucher's reason |
| TK Nợ (*), TK Có (*) | phiếu thu: the cash account (111x) and the line's account; phiếu chi: the line's account and the cash account |
| Số tiền | the line's amount |
| TK ngân hàng | blank |
| Phiếu chi only: the VAT and invoice columns, from "Diễn giải (Thuế)" to "Mã số thuế nhà cung cấp" | blank: a purchase invoice reaches the books as a purchase voucher, and the phiếu chi only settles it (Nợ 331) |

The exports record an audit row like the others, with `format: 'misa_sme_cash_receipts'` or
`'misa_sme_cash_payments'`.

## Value rules

- **Multi-line vouchers:** one row per invoice line; the voucher columns repeat on every row (S1).
- **Dates:** real Excel dates with the format `dd/mm/yyyy`, never text, so no locale reads 01/02 as 2 January.
- **Amounts:** exact. A number cell when Excel can hold the amount exactly (15 significant digits), otherwise the
  exact decimal as text, as in the journal export. VND amounts are whole numbers in practice.
- **VAT rate codes:** from the S6 notes ("Nhập 0: 0%, Nhập 5: 5%, Nhập 8: 8%, Nhập 10: 10%, Nhập KCT, Nhập KKKNT,
  Nhập KHAC: Thuế suất khác", with the ratio in "Tỷ lệ tính thuế (Thuế suất KHAC)", above 0 up to 100). Invoice
  rates `10%`, `KCT`, `KHAC:5.26%` map to `10`, `KCT`, `KHAC` + `5.26`. A rate Crove cannot read is left blank;
  per the S6 "Phiếu chi" note MISA then assumes **10%**, so such rows need a look before importing.
- **VAT per line:** Crove stores the invoice VAT per document, not per line. The export gives each line its amount
  times its rate, rounded to whole VND, and puts the rounding difference on the largest taxed line, so the lines
  add up to the invoice VAT exactly. For purchases, VAT is first split between 1331 and 1332 with the rule the
  journal uses, so MISA posts the same VAT accounts and amounts.
- **Text:** written as text cells, never formulas; cut to MISA's length limits from the S6 notes, where known.
- **Voucher numbers:** derived from the journal entry id, so the same entry always gets the same number. Importing a
  period twice should then be refused by MISA as a duplicate number rather than create the voucher twice
  (inference, not tested in MISA).

## Importing in MISA SME (for the accountant)

1. In Crove, Journal screen: pick the date range, click "Xuất chứng từ mua vào cho MISA".
2. In the file, fill **Mã dịch vụ (*)** with the service code the firm uses in MISA (one code down the column is
   enough for most firms), and check any row whose "% thuế GTGT" is blank.
3. In MISA SME: Tệp > Nhập khẩu từ Excel > Chứng từ > Mua hàng > Chứng từ mua dịch vụ; choose the file, sheet
   `Chứng từ mua dịch vụ`, header row 1; the columns match by name (S2); import as new vouchers.
4. Imported vouchers are not posted yet: review and post them (Ghi sổ) in MISA.
5. Sales: the same steps with "Xuất chứng từ bán hàng cho MISA", filling **Mã hàng (*)**, and in MISA Tệp > Nhập khẩu
   từ Excel > Chứng từ > Bán hàng > Chứng từ bán hàng, sheet `Chứng từ bán hàng`.
6. Cash: on the "Thu chi" screen, pick the dates, click "Xuất phiếu thu cho MISA" or "Xuất phiếu chi cho MISA"; in
   MISA, Tiền mặt > Thu tiền (or Chi tiền) > Nhập từ Excel, sheet `Phiếu thu` (or `Phiếu chi`).

## Open questions (to settle with the partner's template and one real import)

1. **Template check:** compare the partner's own downloaded template (Tải tệp mẫu) with the purchase headers above,
   which come from one listing (S7). Which purchase voucher type does the firm use for invoices of goods that go to
   stock (152, 153, 156)? Those belong in MISA's goods purchase template with a warehouse, which Crove does not
   produce yet.
2. **Catalog codes:** `Mã dịch vụ (*)` and `Mã hàng (*)` are required and must exist in MISA. Is one generic
   service code per firm acceptable, or should Crove keep a per-vendor or per-account item code? Should Crove fill
   `Mã nhà cung cấp` / `Mã khách hàng` (for example with the tax code, if the firm codes partners that way)?
3. **Payable object:** MISA may require a vendor object on account 331 when posting. If so, vendor codes (question 2)
   become required.
4. **Payment method:** does a blank "Phương thức thanh toán" mean "not paid" in this template, as in the sales one?
5. **Nhóm HHDV mua vào:** which group code does the firm use for its VAT input listing (usually group 1)?
6. **Discount lines:** does MISA accept a negative "Thành tiền" for a trade discount line, or should it go to a
   discount column?
7. **Sales flags:** with the e-invoice issued outside MISA, are "Lập kèm hóa đơn" = 1 and "Đã lập hóa đơn" = 1 right,
   and how does the firm record the invoice series that the VND sales template has no column for?
8. **Voucher numbering:** is `CRMDV…` / `CRBH…` acceptable, or does the firm want its own number series?
9. **Cash templates:** compare the partner's own "Phiếu thu" and "Phiếu chi" templates (Tiền mặt > Nhập từ Excel >
   Tải tệp mẫu) with the headers above, which come from one source (S6). Should "Lý do nộp" / "Lý do chi" carry a
   code (12 Thu hoàn ứng, 21 Tạm ứng nhân viên ...) instead of the default "khác"? Is `CRPT…` / `CRPC…` acceptable?
10. **Bank vouchers:** to export giấy báo Có and giấy báo Nợ, Crove needs the headers of MISA's deposit templates
    (Tiền gửi > Thu tiền / Chi tiền > Nhập từ Excel > Tải tệp mẫu). A blank copy of each, with no data, is enough.
