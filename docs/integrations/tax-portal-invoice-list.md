# Tax portal invoice list: purchases (issue #465) and sales (issue #2141)

The tax authority's e-invoice portal ([hoadondientu.gdt.gov.vn](https://hoadondientu.gdt.gov.vn)) has no buyer API,
and an unattended login needs software CAPTCHA solving, which Crove does not do (spike #322, option 1). The
accountant can export the month's purchase invoices to Excel, though. Crove imports that file per client (org) and
VAT period and shows which invoices the tax authority has that Crove lacks, and the other way round.

- **Screen:** "Đối chiếu cổng thuế" (`/o/<org>/portal-invoices`). Pick the month or quarter, upload the `.xlsx`.
- **API:** upload with `POST /api/files` (or the staged upload) with `purpose=import`, then `portalList.import`
  (`finance.portal_list.import`, owners, admins and members, R1). The import takes only a file stored that way
  (source `import`, recorded as `.xlsx`); an uploaded or emailed document, even a ZIP, is refused. The same bytes are
  not both: a direct document upload of a file stored as an import is refused (`FILE_IS_IMPORT`, it would open the
  workbook's own parts as a ZIP of documents), and an import upload of a document's bytes is refused
  (`FILE_IS_NOT_IMPORT`); an emailed copy of an import stays a duplicate, so the message is not refused. The worker
  reads the file in `crove-extract` (kind `portal_invoice_list`), checks the answer again and records the rows
  (`finance.portal_list.record`, system only; the database also refuses the outcome and the rows from any context
  but the system one, #506). `portalList.reconcile` (every role) answers the period's lists and the comparison;
  `portalList.remove` takes a list out of its period (it is kept).
- **Load:** a period holds at most 50,000 rows of done lists (a list that would pass it is recorded as failed), and
  the reconciliation lists at most 500 items per outcome; the summary and the section titles count all of them, and
  the screen says when a section is cut short.
- **Purchases and sales.** The default is the purchase list ("mua vào"). The sales list ("bán ra", #2141) goes through
  the same import and screen, as its own tab, with `direction: 'sale'` (see "The sales list" below).

## How the accountant gets the file

1. Sign in to hoadondientu.gdt.gov.vn with the company's account (tax code, password, CAPTCHA), open **Tra cứu**,
   **Tra cứu hóa đơn**, **Tra cứu hóa đơn điện tử mua vào**.
2. Set the invoice date range (the portal searches about one month at a time) and click **Tìm kiếm**.
3. Click the **Xuất hóa đơn** icon. The file is `DANH SÁCH HÓA ĐƠN.xlsx`.
4. The **Hóa đơn điện tử** tab exports one **Kết quả kiểm tra** value at a time: once for "Đã cấp mã hóa đơn"
   (invoices with a tax authority code) and once for "Cục Thuế đã nhận không mã" (without one). Cash register
   invoices are on a separate tab, **Hóa đơn có mã khởi tạo từ máy tính tiền**, with its own export. A month can
   therefore take two or three files; each is imported into the same period (at most 12 per period), and an invoice
   on several lists counts once.

## The sales list (#2141)

The same screen has a second tab, "Hóa đơn bán ra". The accountant exports **Tra cứu hóa đơn điện tử bán ra** from the
portal the same way (the columns are the same; the seller is the org and the buyer is the customer) and uploads it
with `portalList.import` and `direction: 'sale'`. The comparison answers the question "is every sale the tax authority
has in the books, with the same VAT?", so output VAT is not understated. It writes nothing to the books: a person
books a missing sale as any other, from its XML in the Inbox.

- **Direction is fixed per list.** The period's purchase and sales lists never mix: each direction has its own
  limit of 12 lists and 50,000 rows, and `portalList.reconcile` takes `direction` (default `purchase`). Every other
  consumer of the purchase comparison (the missing-invoice request and reminder, the assisted sync) stays on purchases.
- **The worker checks the direction.** On a sales list the org (or one of its branches) must be the seller. Rows where
  the org is the buyer, or another company is the seller, are dropped and counted (the screen shows them next to the
  skipped rows); a list with nothing left is refused as "the purchase list" or as another company's. The line above the
  header is not used: the rows tell.
- **Same invoice:** a recorded sale does not say which branch issued it, so it meets a portal row on the series and
  number (and a template that does not contradict), when exactly one portal invoice of the period has them: the rule
  for an invoice without a tax code. Two branches' invoices of the same series and number are therefore flagged (each
  "missing", the booked one "not on the portal"), never merged into one. The screen does not repeat "matched without
  tax code" on sales. The customer's tax code (`buyer_tax_code` on the row) and the customer's name from the recorded
  sale are shown.
- **Flags:** "missing" (on the portal, not in the books), "amount_mismatch" (another total, VAT or currency; one dong
  of rounding is allowed), "void_in_crove" (cancelled or replaced on the portal but still booked), "not_on_portal"
  (booked in the period, on none of the lists). A sale on two lists of the period counts once, so importing the same
  list again (a second file with the same invoices) flags nothing new; the very same file is refused.
- **Notifications:** reading a sales list tells the importer and the owners and admins when sales are missing or
  differ, in words that name sales.

## Sources

| # | Source | What it gives | Kind |
|---|---|---|---|
| A | [NLHGiang/hoadondientu-auto-test, `last-test-report/responses`](https://github.com/NLHGiang/hoadondientu-auto-test/tree/main/last-test-report/responses), files 013 to 016 | The raw answers of the four export endpoints, recorded on 2026-09-16: title rows and header rows only, no invoice rows, so no taxpayer data. Content type `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`; written by Apache POI | Recorded portal output |
| B | The portal's own public JavaScript (the lookup screen chunk and `_app`, build-hashed) | The export endpoints, the download file name, the tab names, the status labels 1 to 6 | Portal code |
| C | [hoainxm/baseafood, `src/lib/einvoiceReconciliation.ts`](https://github.com/hoainxm/baseafood/blob/main/src/lib/einvoiceReconciliation.ts) | Reads the purchase export by header; a template that keeps the header on row 6; sample values | Third-party reader |
| D | [yunomix2834/eif, `internal/modules/hoadondientu.gdt.gov.vn`](https://github.com/yunomix2834/eif/tree/main/internal/modules/hoadondientu.gdt.gov.vn/internal) | Export client and xlsx reader: the headers, the two layouts, defensive handling of amounts as text and tax codes as numbers | Third-party reader |
| E | [BachNgoH/temporal-io-experiments, `gdt_excel_discovery.py`](https://github.com/BachNgoH/temporal-io-experiments/blob/main/temporal_app/activities/gdt_excel_discovery.py) | Header mapping; dates parsed as `%d/%m/%Y`; one export per Kết quả kiểm tra value | Third-party reader |
| F | [leolionart/naai-erp, `accounting-list-workbook.ts`](https://github.com/leolionart/naai-erp/blob/main/apps/api/src/report-exports/accounting-list-workbook.ts) | Reproduces the 19 headers | Third-party writer |
| G | [Trusaman/hoadon, `combine-excel/route.ts`](https://github.com/Trusaman/hoadon/blob/master/src/app/api/combine-excel/route.ts) | Saves the "có mã", "không mã" and "máy tính tiền" exports side by side | Third-party tool |
| H | [cuongccna/INVONESOURCE, `gdt-direct-api.service.ts`](https://github.com/cuongccna/INVONESOURCE/blob/main/bot/src/gdt-direct-api.service.ts) | The same endpoints | Third-party tool |

Sources read on 2026-10-19. Nobody logged in to a real portal for this. **Confirmed** below means the recorded
export (A) or the portal's code (B) shows it, or two independent readers agree; **unconfirmed** means one source or
an inference. A populated export from the design partner would settle the open points (section "Not confirmed").

## File layout

| Point | Status | Sources |
|---|---|---|
| `.xlsx` (OOXML zip), not Excel 97-2003 `.xls`; inline strings, no shared strings | Confirmed | A, D, E, G |
| File name `DANH SÁCH HÓA ĐƠN.xlsx`, the same for every tab | Confirmed | B |
| One sheet, named `sheet 1` | Confirmed for the 2026-09 files | A |
| Rows 1 and 2 empty; row 3 the title `DANH SÁCH HÓA ĐƠN` (`DANH SÁCH HÓA ĐƠN MÁY TÍNH TIỀN` on the cash register tab), merged across; row 4 `Từ ngày dd/mm/yyyy đến ngày dd/mm/yyyy`; row 5 empty; row 6 the header, one row, no merged cells | Confirmed | A, C |
| No line with the buyer's tax code or name above the header | Confirmed | A |
| The sheet's `<dimension>` says `A1` (Apache POI streaming), so a reader must not trust it | Confirmed (A); the effect on other readers is an inference | A |

### Header of the "Hóa đơn điện tử" tab (có mã and không mã): 19 columns

The purchase and the sales export have the same columns.

| Col | Header | Crove field | Status |
|---|---|---|---|
| A | STT | not read | Confirmed (A, C, F) |
| B | Ký hiệu mẫu số | `template` | Confirmed (A, C, D, E, F) |
| C | Ký hiệu hóa đơn | `series` (required) | Confirmed |
| D | Số hóa đơn | `number` (required) | Confirmed |
| E | Ngày lập | `issueDate` (required) | Confirmed |
| F | MST người bán/MST người xuất hàng | `sellerTaxCode` (required) | Confirmed |
| G | Tên người bán/Tên người xuất hàng | `sellerName` | Confirmed |
| H | MST người mua/MST người nhận hàng | `buyerTaxCode` | Confirmed |
| I | Tên người mua/Tên người nhận hàng | not read | Confirmed |
| J | Địa chỉ người mua | not read | Confirmed (A, C, F; not in D) |
| K | Tổng tiền chưa thuế | `subtotal` | Confirmed |
| L | Tổng tiền thuế | `vatAmount` | Confirmed |
| M | Tổng tiền chiết khấu thương mại | not read | Confirmed |
| N | Tổng tiền phí | not read | Confirmed |
| O | Tổng tiền thanh toán | `total` | Confirmed |
| P | Đơn vị tiền tệ | `currency` | Confirmed |
| Q | Tỷ giá | not read | Confirmed |
| R | Trạng thái hóa đơn | `status` | Confirmed |
| S | Kết quả kiểm tra hóa đơn | `checkResult` (shown, not used for matching) | Confirmed |

### Header of the "máy tính tiền" tab, purchase export: 17 columns

STT, Ký hiệu mẫu số, Ký hiệu hóa đơn, Số hóa đơn, Ngày lập, MST người bán/MST người xuất hàng, Tên người bán/Tên
người xuất hàng, **Địa chỉ người bán**, MST người mua/MST người nhận hàng, Tên người mua/Tên người nhận hàng,
**Căn cước công dân**, Tổng tiền chưa thuế, Tổng tiền thuế, Tổng tiền chiết khấu thương mại, Tổng tiền thanh toán,
Trạng thái hóa đơn, Kết quả kiểm tra hóa đơn. No fee, currency or exchange rate column (Crove then takes VND).
Confirmed by A only (files 014 and 016); D says the two layouts differ and merges them by header.

### Values

| Point | Status | Sources |
|---|---|---|
| Ngày lập is text `dd/mm/yyyy` | Strongly indicated, no populated sample | C, D, E, B (screen) |
| Amounts are number cells with the format `#,###.0#####` (shown as `2,092,593.0`) | Likely, from the styles of A; D also reads them as text with comma thousands | A, D |
| Tax codes may be number cells formatted `0000000000` (the leading zero lost in the value) | Unconfirmed | D |
| Template and series are separate columns; the series has no template digit (`C26TAA`, not `1C26TAA`) | Confirmed | A, C |
| Trạng thái hóa đơn: "Hóa đơn mới", "Hóa đơn thay thế", "Hóa đơn điều chỉnh", "Hóa đơn đã bị thay thế", "Hóa đơn đã bị điều chỉnh", "Hóa đơn đã bị hủy" (the portal's states 1 to 6) | Confirmed | B, D, C |
| Other wordings of the same states ("Hóa đơn bị thay thế", "Hoá đơn đã bị xoá/huỷ bỏ") | Seen in other tools and a portal screen | B, third-party tools |
| Kết quả kiểm tra wording: "Đã cấp mã hóa đơn", "Cục Thuế đã nhận không mã", "Cục Thuế đã nhận hóa đơn có mã khởi tạo từ máy tính tiền"; older files say "Tổng cục Thuế" | Unconfirmed for today's export | D, C, third-party tools |
| No column names the invoice a replacement or adjustment refers to | Confirmed | A |

## How Crove reads it

The reader is `apps/extract/src/portal-list.ts`, on top of a small `.xlsx` reader (`apps/extract/src/xlsx.ts`), and
runs only in the parsing sandbox like every untrusted file:

- **Time:** the sheet and the shared strings are read by a forward tokenizer: one pass over each part, and a missing
  closing tag refuses the file at once, so a hostile part cannot hold the sandbox's single slot.
- **Limits:** the file at most 10 MB (checked at upload, by the import command and by the sandbox), every inflated
  part at most 32 MB and 48 MB together, at most 20,000 invoice rows and 64 columns. DOCTYPE and ENTITY are refused in
  every part. An Excel 97-2003 file is refused with a hint to save it as `.xlsx`.
- **Header by its words, not by position:** the first 30 rows are searched for the row that names the series, the
  number, the date and the seller's tax code. Headers are compared without diacritics, case or punctuation, so
  "MST người bán/MST người xuất hàng", "Mã số thuế người bán", "mst nguoi ban" and the portal's JSON names
  (`nbmst`, `khhdon`, `shdon`, `tdlap`) all read. A header split over two rows (a "Thông tin người bán" group over
  "MST" and "Tên") reads too, though the portal's export has one row.
- **Unknown layout fails clearly:** a sheet without such a row is refused, naming the missing columns, so a wrong
  file (a MISA export, an edited copy, a balance sheet) never turns into an empty or wrong list. A header with buyer
  columns and no seller column is refused as a sales list.
- **Rows:** a row without number, series and tax code (blank, totals) is ignored; one with some of them but not all,
  an impossible date, an invalid tax code or an unreadable amount is listed by row number and reason, never guessed.
  The list keeps how many rows were skipped and the first 1000 of them, and the screen says the comparison is
  incomplete until the accountant fixes those rows and imports the list again; a list with no readable invoice fails.
  Amounts read as Excel numbers or as text with dot or comma thousands separators.
- **Tolerances for unconfirmed quirks:** a tax code stored as a number is padded back to 10 (or 12) digits. One
  source (C) reports that rows of the "không mã" export can carry one extra empty cell before the currency; such a
  row (wider than the header, with an empty currency cell) has its currency, status and check result read one
  column to the right.

The worker then checks the answer again (`checkPortalList` in `modules/finance/src/portal-list.ts`): a purchase list
is one where the org is the buyer, so the org's tax code must be set (the import refuses without it). Rows where the org is the seller (its sales) or another company is the buyer are
dropped and counted (the list keeps both counts and the screen shows them next to the skipped rows: a misread buyer
code would hide a purchase); a list with none left is recorded as failed, as the sales list or as another company's
list (the accountant picked the wrong client). An answer with an impossible date (an issue date or the file's own
range) or a row number given twice is refused with the reason, before anything is written.

## How Crove compares

`modules/finance/src/domain/portal-reconcile.ts`, for the period's lists (done, not removed) against the org's
purchase documents (not voided) and the purchase proposals waiting in the Inbox:

- **Same invoice:** the seller's tax code, the series and the number match (numbers without leading zeros, series in
  upper case, a template digit written into the series split off), and the templates do not contradict each other
  (either side may lack one). A Crove invoice without a seller tax code matches on series and number when exactly
  one portal invoice has them.
- **Amounts are a check:** total, VAT and currency, with one dong of rounding allowed. A difference is reported as
  "Số tiền không khớp", not as a missing invoice.
- **Status:** "đã bị thay thế" and "đã bị hủy" no longer count. Absent from Crove is right; present in Crove (booked or
  waiting) is reported so the accountant reverses or rejects it. An adjusted invoice still counts; the replacement
  and the adjustment are invoices of their own. An unknown status counts like a valid invoice.
- **Duplicates:** an invoice on several lists of the period counts once, by the same rule as a match (a row without a
  template joins the invoice its key names); a later cancellation wins. A second copy in Crove of a matched invoice is
  reported as not on the portal and marked as a duplicate.
- **Period:** Crove's invoices dated in the period that match nothing are reported as not on the portal. With no
  list for a period nothing is compared. A portal row dated outside the period is matched and marked.

## Not confirmed

- Data-row cell types (amounts, dates, tax codes, exchange rate as numbers or text): every recorded export is header
  only. The reader accepts both.
- Today's wording of Kết quả kiểm tra.
- Headers before 2026: every source found is from 2026.
- The extra cell in "không mã" rows (single source C).
- Foreign-currency invoices: C reports that the amounts are sometimes in the original currency and sometimes already
  in VND. Crove compares in the currency the row names, so such an invoice may show as an amount mismatch.

Ask the partner's accountant for one real export per tab (#61) to settle these.
