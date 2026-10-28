# Household businesses in 2026: should Crove serve them?

> Spike decision note for [#330](https://github.com/DOS/Ludy/issues/330) (backlog review item M3-8), input to owner decision D1 in [backlog-review-2026-10-17.md](../plan/backlog-review-2026-10-17.md) (section 6). Desk research on 2026-10-18 from government news pages, legal-summary sites and vendor help pages. The official gazette texts could not be opened from the research environment, so every legal point carries the source it came from and must be confirmed by the partner's accountant (#61) before anything is built on it. Vendor pages are vendor claims. **Inference** marks a conclusion drawn from the sources rather than stated by them; **unverified** marks a point no source confirmed. Not legal advice. Vietnamese summary for the owner: [household-business-2026.vi.html](household-business-2026.vi.html).

## 1. Summary

- **The rules settled into four revenue groups during 2026.** Lump-sum tax ended on 2026-01-01; Decree 68/2026/ND-CP (2026-03-05) set the new regime, and Decree 141/2026/ND-CP raised the tax-free line from 500 million to 1 billion VND of yearly revenue, back to 2026-01-01 (section 2). At or below 1 billion VND a household business owes no VAT or PIT, keeps the simplest book (S1a-HKD) and reports its revenue once a year; e-invoices are optional. Above it, it declares quarterly, must use coded or cash-register e-invoices, and keeps more books as revenue grows (section 3).
- **About 0.5 million of roughly 3.08 million household businesses owe tax** (an inference from two sources, section 2.3). The other 2.5 million or so need nothing a paid product sells: the state's eTax Mobile app covers their yearly revenue report.
- **The tax-paying half is already served for free or cheap by the tools they sell through.** MISA eShop, Sapo, KiotViet and EasyPOS build the Circular 152/2025 books from the day's sales, and Sapo drafts the quarterly 01/CNKD return as XML (section 4). They own the till and the e-invoice, which is where the data starts. Crove has neither and is not going to (backlog review section 2: no POS, not an e-invoice provider).
- **Where Crove would add something real:** the households above 3 billion VND pay PIT on income (revenue minus documented costs), so their costs need evidence, their stock and cash need books (S2c to S2e), and many hand that to an accounting firm. That is the job Crove already does for companies: documents in, AI-read, checked, approved, in the books, exported (section 5).
- **Recommendation: no-go for a product sold to household businesses directly; go, later and small, for household clients inside the firm product.** Keep D1 as decided (accounting firms first). Add a "household business" kind of client to the firm's workspace once the partner confirms it keeps such clients (the M0 interview, #57): Circular 152 books built from the documents and bank lines Crove already has, and the 01/CNKD figures as a worksheet. Thresholds and form versions are data, because they changed four times in 2026 (section 6).

## 2. The 2026 rules

### 2.1 What changed

| Date | Text | What it did |
|---|---|---|
| 2025-05-17 | Resolution 198/2025/QH15 (follows Resolution 68-NQ/TW) | No lump-sum tax from 2026-01-01: every household business declares on its real revenue ([thuvienphapluat](https://thuvienphapluat.vn/ma-so-thue/phap-luat-thue/bo-thue-khoan-tu-nam-2026-che-do-nop-thue-ho-kinh-doanh-se-thay-doi-nhu-the-nao-va-ho-kinh-doanh-na-412857-212378.html)) |
| 2025-12-10 | Law on Personal Income Tax (amended), in force 2026-07-01, applies to business income from tax year 2026 | Tax-free revenue raised from 200 to 500 million VND a year, deducted before the rate applies; revenue above that and up to 3 billion may choose the revenue or the income method ([baochinhphu.vn](https://baochinhphu.vn/thong-qua-luat-thue-thu-nhap-ca-nhan-sua-doi-ho-kinh-doanh-thu-duoi-500-trieu-dong-nam-duoc-mien-thue-10225121011144591.htm), [xaydungchinhsach.chinhphu.vn](https://xaydungchinhsach.chinhphu.vn/thong-nhat-ho-kinh-doanh-co-doanh-thu-den-500-trieu-dong-nam-khong-phai-nop-thue-119251210100204058.htm)) |
| 2025 (late) | Circular 152/2025/TT-BTC, in force 2026-01-01 | Bookkeeping for household and individual businesses; replaces Circular 88/2021 ([luatvietnam](https://luatvietnam.vn/ke-toan/thong-tu-152-2025-tt-btc-huong-dan-ke-toan-cho-ho-kinh-doanh-ca-nhan-kinh-doanh-423164-d1.html), [thuvienphapluat](https://thuvienphapluat.vn/van-ban/Ke-toan-Kiem-toan/Thong-tu-152-2025-TT-BTC-huong-dan-ke-toan-cho-cac-ho-kinh-doanh-680351.aspx)) |
| 2026-03-05 | Decree 68/2026/ND-CP | Tax policy and administration for household businesses: VAT and PIT by revenue group, quarterly filing, draft returns prefilled from e-invoice data, platforms withholding for their sellers ([thuvienphapluat](https://thuvienphapluat.vn/van-ban/Doanh-nghiep/Nghi-dinh-68-2026-ND-CP-chinh-sach-thue-va-quan-ly-thue-doi-voi-ho-kinh-doanh-ca-nhan-kinh-doanh-685358.aspx), [vov2](https://vov2.vov.vn/phap-luat/nghi-dinh-682026-siet-quan-ly-thue-ho-kinh-doanh-tren-nen-tang-so-57445.vov2)) |
| 2026 | Circular 18/2026/TT-BTC, amended by Circular 50/2026/TT-BTC (2026-05-13) | The forms, among them return 01/CNKD and the revenue report 01/TKN-CNKD (**unverified** beyond legal-summary sites: [thuvienphapluat](https://thuvienphapluat.vn/phap-luat-doanh-nghiep/bai-viet/chinh-thuc-mau-to-khai-thue-ho-kinh-doanh-2026-moi-nhat-mau-01-cnkd-18434.html), [truepos](https://truepos.vn/tin-tuc/mau-so-01-tkn-cnkd)) |
| 2026 (May) | Decree 141/2026/ND-CP, applied from 2026-01-01 | Replaces "500 million" with "1 billion" VND in the VAT, PIT and administration articles of Decree 68 ([full text, xaydungchinhsach.chinhphu.vn](https://xaydungchinhsach.chinhphu.vn/toan-van-nghi-dinh-so-141-2026-nd-cp-nang-nguong-doanh-thu-khong-phai-chiu-thue-len-1-ty-dong-119260504154326455.htm), [luatvietnam](https://luatvietnam.vn/tin-van-ban-moi/chinh-thuc-nang-nguong-doanh-thu-len-1-ty-dong-doi-voi-ho-kinh-doanh-tu-2026-186-108719-article.html)) |
| 2026-07-01 | Decree 254/2026/ND-CP and Circular 91/2026/TT-BTC | Replace Decree 123/2020, Decree 70/2025 and Circular 32/2025 on e-invoices (see [tax-portal-invoice-sync.md](tax-portal-invoice-sync.md) section 2.3) |

Decree 70/2025 had already required cash-register e-invoices from 2025-06-01 for household businesses with at least 1 billion VND a year in retail, food service, lodging, passenger transport and entertainment ([misaeshop](https://www.misaeshop.vn/28175/ho-kinh-doanh-tren-1-ty-phai-xuat-hoa-don-may-tinh-tien/)). Whether Decree 254 kept that wording, and how it lines up with Decree 68's group rule, is **unverified**.

### 2.2 The four groups

As vendors and legal-summary sites read Decree 68 after Decree 141 (the group boundaries agree across [misaeshop](https://www.misaeshop.vn/?p=43105), [acman](https://acman.vn/phan-loai-ho-kinh-doanh-2026-theo-nghi-dinh-141-2026-nd-cp.html) and [doanhnghiephoinhap](https://doanhnghiephoinhap.vn/phan-loai-4-nhom-ho-kinh-doanh-bo-thue-khoan-tu-2026-109066.html); the rates are summaries, **unverified** against the decree):

| Group | Yearly revenue | VAT | PIT | Filing | E-invoice | Books (Circular 152) |
|---|---|---|---|---|---|---|
| 1 | up to 1 billion VND | none | none | revenue report once a year, by 31 January | voluntary | S1a-HKD |
| 2 | above 1 to 3 billion | % of revenue by trade (1 to 5%) | % of (revenue minus 1 billion), or (revenue minus costs) at 15% if chosen | quarterly (01/CNKD) | coded or cash-register | S2a-HKD (S2b to S2e on the income method) |
| 3 | above 3 to 50 billion | % of revenue | (revenue minus documented costs) at 17% | quarterly, settled yearly | yes | S2b, S2c, S2d, S2e-HKD, plus S3a-HKD for other taxes |
| 4 | above 50 billion | % of revenue | income at 20% | quarterly, settled yearly | yes | as group 3 (**unverified**) |

A household in group 2 whose real revenue for the year passes 3 billion moves to the income method from the next year ([summary of Decree 68](https://www.meinvoice.vn/tin-tuc/44997/nghi-dinh-68-2026-nd-cp-ve-thue-ho-kinh-doanh/)). For households using coded or cash-register e-invoices, the tax system can prefill a draft return; the household stays responsible for what it files ([vov2](https://vov2.vov.vn/phap-luat/nghi-dinh-682026-siet-quan-ly-thue-ho-kinh-doanh-tren-nen-tang-so-57445.vov2)).

### 2.3 How many

- About 3.08 million active household businesses on 2026-04-19, 78% of them using eTax Mobile ([baolaocai](https://baolaocai.vn/tu-khoa/etax-mobile-tag66644.html)); about 2.56 million at or below 1 billion VND ([sapo](https://www.sapo.vn/blog/nghi-dinh-141-2026-nd-cp)). So roughly 0.5 million owe tax (**inference**, as in the backlog review).
- Before the change, at the end of March 2025, about 1.98 million declared under lump sum and about 6,000 on their own returns ([nhadautu](https://nhadautu.vn/25-trieu-ho-kinh-doanh-duoc-lam-quen-voi-ke-khai-thue-d101653.html)): almost none had kept real books before 2026.

## 3. Books and returns a household business needs

**The books (Circular 152/2025).** The circular gives these forms; the household may add books or adapt a form as long as each keeps its name, date and the representative's signature ([thuvienphapluat](https://thuvienphapluat.vn/van-ban/Ke-toan-Kiem-toan/Thong-tu-152-2025-TT-BTC-huong-dan-ke-toan-cho-cac-ho-kinh-doanh-680351.aspx), [vietda](https://vietda.com.vn/pdf-thong-tu-152-2025-tt-btc-huong-dan-che-do-ke-toan-ho-kinh-doanh/)):

| Form | Name (as summarized) | Who keeps it |
|---|---|---|
| S1a-HKD | Sales detail book | Group 1 (no VAT, no PIT) |
| S2a-HKD | Revenue from goods and services | VAT and PIT on a % of revenue (group 2) |
| S2b-HKD | Revenue book | Income method (groups 3 and 4, group 2 by choice) |
| S2c-HKD | Revenue and cost detail | Income method |
| S2d-HKD | Materials, tools, products and goods detail | Income method |
| S2e-HKD | Cash detail (cash and bank) | Income method |
| S3a-HKD | Other tax obligations | Households liable to other taxes (environment, resources, excise) |

The group-to-form mapping above is how vendors read the circular ([MISA help on S2a](https://helphkd.misa.vn/kb/s2a-hkd/), [thuvienphapluat on group 3](https://thuvienphapluat.vn/phap-luat-doanh-nghiep/bai-viet/tai-mau-so-ke-toan-ho-kinh-doanh-nhom-3-nam-2026-file-excel-va-word-20638.html)); the exact columns of each form must come from the circular's appendix, which was not read.

**The returns.** Group 1 files the yearly revenue report (01/TKN-CNKD per [truepos](https://truepos.vn/tin-tuc/mau-so-01-tkn-cnkd), **unverified**). Groups 2 to 4 file 01/CNKD each quarter on the public service portal or eTax Mobile, with revenue by trade for VAT and PIT ([thuvienphapluat guide for Q3 2026](https://thuvienphapluat.vn/phap-luat-doanh-nghiep/bai-viet/huong-dan-dien-to-khai-01-cnkd-quy-3-2026-ho-kinh-doanh-23698.html)); groups 3 and 4 also settle PIT for the year.

**What this means for software (inference).** Groups 1 and 2 need almost nothing beyond their sales: the books are a sales listing, and the return is revenue by trade times a rate, which the tax system can prefill from their e-invoices. Group 3 is different in kind: costs decide the tax, so purchase invoices and other cost evidence must be collected, checked and kept, and stock and cash must be tracked. That is bookkeeping, not a till report.

## 4. What POS and e-invoice vendors already give them

| Vendor | What it offers household businesses | Source |
|---|---|---|
| MISA eShop | POS with the seven Circular 152 books filled automatically from sales, cash and stock; free for group 1, 99k to 699k VND a month for the others | [misaeshop](https://www.misaeshop.vn/?p=24283), [S2a help](https://helphkd.misa.vn/kb/s2a-hkd/) |
| MISA AMIS Kế toán HKD | Accounting product for household businesses with the Circular 152 books | [help](https://helpasp.misa.vn/accounting/kb/so-doanh-thu-ban-hang-hoa-dich-vu-mau-s2a-hkd/) |
| Sapo Omni and Sapo Invoice | S2a-HKD from POS or invoice data; drafts 01/CNKD as XML; a licensed T-VAN that files in the app | [S2a](https://help.sapo.vn/xem-so-doanh-thu-ban-hang-hoa-dich-vu-mau-s2a-hkd-tren-sapo-omni), [01/CNKD](https://www.sapo.vn/cap-nhat-tinh-nang/tu-dong-lap-to-khai-01-CNKD), [T-VAN](https://www.sapo.vn/blog/sapo-ket-noi-dich-vu-thue-dien-tu-t-van) |
| KiotViet | Free accounting module that writes sales into the books and returns; free e-invoices and digital signature; an agreement with the Ho Chi Minh City tax office to guide about 346,000 household businesses | [thoibaotaichinhvietnam](https://thoibaotaichinhvietnam.vn/kiotviet-mien-phi-phan-mem-ke-toan-cho-ho-kinh-doanh-183836.html), [thitruongtaichinhtiente](https://thitruongtaichinhtiente.vn/thue-tp-ho-chi-minh-va-kiotviet-hop-tac-huong-dan-chinh-sach-thue-cho-gan-346-000-ho-kinh-doanh-73616.html) |
| EasyPOS and others | Books generated during daily selling (vendor claim) | [easypos](https://easypos.vn/so-sach-ho-kinh-doanh/) |
| 39 approved e-invoice providers (Viettel, VNPT, BKAV, banks, ...) | Coded and cash-register e-invoices for household businesses | [thuehaiquan](https://thuehaiquan.tapchikinhtetaichinh.vn/cong-bo-39-ong-lon-cong-nghe-tiep-suc-ho-kinh-doanh-trien-khai-hoa-don-dien-tu-152563.html) |
| The tax authority's eTax Mobile | Registration, the yearly revenue report and quarterly returns; draft returns from e-invoice data; used by about 78% of household businesses | [baolaocai](https://baolaocai.vn/tu-khoa/etax-mobile-tag66644.html), [vov2](https://vov2.vov.vn/phap-luat/nghi-dinh-682026-siet-quan-ly-thue-ho-kinh-doanh-tren-nen-tang-so-57445.vov2) |

**Inference:** for groups 1 and 2 the market is closed. The data starts at the till or the e-invoice, both tools give the books away to keep the till, and the state prefills the return. A separate product would be one more app for the same numbers. What none of these pages describe is collecting and checking a household's purchase invoices as cost evidence for the income method, or a firm working through many household clients at once.

## 5. What Crove would add

What Crove has today maps onto group 3 households (and group 2 households choosing the income method), mostly when an accounting firm keeps their books:

| Need | Crove today | Gap |
|---|---|---|
| Costs with evidence (income method) | Inbox of purchase e-invoices by email or upload, AI-read, checked, approved (#8 onward) | Booked as TT133 journal entries; a household needs a cost list by Circular 152 categories, not a chart of accounts |
| Stock and goods (S2d) | None | Out of scope for now (no inventory) |
| Cash and bank (S2e) | Bank statement import per account (#326 stage 1) | Cash book and the S2e layout |
| Revenue (S2a, S2b) | Sales e-invoices read from files (#313) | Most household sales come from the till, which Crove does not see; an import of the POS export would be needed |
| The quarterly return | VAT working for companies (#316) | A 01/CNKD worksheet: revenue by trade times the rates, PIT on income for group 3 |
| Many clients | Multi-org and the accountant's multi-client view (#318) | A client kind "household business" with its own books instead of B01 and B02 |

**Inference:** about two thirds of the pipeline is shared (intake, reading, checks, approval, bank lines, multi-client); what differs is the book layer at the end. That makes household clients an add-on to the firm product, not a second product.

## 6. Recommendation for D1

1. **No-go: no Crove product sold directly to household businesses.** Groups 1 and 2 (about 2.9 million of 3.08 million) need nothing a paid tool sells, and the tools they already use give the books away. Selling to them means a POS or an e-invoice, which the backlog review rules out.
2. **Keep D1 as decided:** accounting service firms serving companies on Circular 133 first.
3. **Later go, small: household clients inside the firm product,** if the partner keeps such clients (ask in the M0 interview, #57; the accountant track, #61, confirms sections 2 and 3). Proposed scope, one M-sized issue after M3:
   - a client kind "household business" with its group, the trades it sells in (for the VAT and PIT rates) and whether it chose the income method;
   - S2b, S2c and S2e built from the documents, approvals and bank lines Crove already has (S2d waits for inventory);
   - a 01/CNKD worksheet per quarter for the firm to file, not filing itself;
   - rates, thresholds and form versions as data with effective dates, since 2026 alone changed the threshold twice (200 million, 500 million, 1 billion) and replaced the e-invoice decree and the form circular.
4. **Not now:** S1a and S2a books for groups 1 and 2, a household-facing mobile app, POS integrations, filing through a T-VAN.

## 7. What must be confirmed before building

- The thresholds and rates of section 2.2 against Decree 68/2026 as amended by Decree 141/2026 (official text).
- The columns of S2b to S2e and S3a in the appendix of Circular 152/2025.
- The current version of 01/CNKD (Circular 18/2026 as amended by Circular 50/2026) and whether Circular 91/2026 changed it.
- Whether Decree 254/2026 kept the cash-register e-invoice rule of Decree 70/2025 for household businesses.
- Whether the partner firm keeps household clients, how many, and in which group.
