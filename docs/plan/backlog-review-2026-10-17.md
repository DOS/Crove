# Crove backlog review, 2026-10-17

> Proposal for the product backlog of `DOS/Crove` and its board (GitHub Project 8). Written for the owner and for the agents that pick work from the board. Status: proposed; the owner decisions in section 6 are open. Vietnamese page for the owner: [backlog-review-2026-10-17.vi.html](backlog-review-2026-10-17.vi.html). The kernel plan ([crove-os-kernel.md](crove-os-kernel.md)) stays the architecture record; where this file and the plan's Tracking section disagree about what to build next, this file is the proposal to adopt.

## 1. Diagnosis

Crove has a working accounting wedge (upload or forward an e-invoice, AI and deterministic checks propose a TT133 entry, a human approves, Excel export), but four days after that MVP merged (#8, 2026-10-13) nobody outside the team can use it: there is no hosted instance, and on any public URL the app refuses to start without MFA step-up for approvals while the SPA has no MFA enrollment screen yet (#32), so even a hosted copy could not approve an invoice. Since #8, about 125 commits landed on `main`; about 55 of them are security, auth, session or hardening work, and roughly 10 changed something a user sees in the accounting flow (reversal UI, re-extract, invites, members, sessions, offboarding, i18n, the design system). The cause is structural, not individual: (1) the only milestones before the product work were "MVP exit criteria" and an 18-row "External-tenant gate" that is entirely security evidence, and agents are told to pick the highest priority in the earliest milestone, so they always picked security; (2) every security review produced "non-blocking follow-up" issues filed as P2 in the same early milestones, which the next agent picked up, a loop that feeds itself (#117, #134, #180, #203, #221, #223, #276, #281, #285, #289, #293 are all review follow-ups); (3) items ADR-0026 explicitly deferred (the HMAC context seal, SSE realtime) were built anyway; (4) every step that leads to users is an owner action with no date (spend #52, DNS #53, interviews #57, accountant #61), and agents filled the vacuum with work they could do alone; (5) two new streams with no customer (Social, Decision 17; the agents org chart, ADR-0029) started before the first pilot; (6) the Finance epic (#60) is a placeholder with no child issues, so there was literally no product work on the board to pick.

## 2. Market context

Desk research on 2026-10-17. Most sources are vendor blogs and legal-summary sites; the official gazette texts were not read directly, so every legal detail below is "verify with the accountant before building on it". Items marked (unverified) could not be confirmed.

**Household businesses (hộ kinh doanh) after the end of lump-sum tax.**
- Lump-sum tax (thuế khoán) ended on 2026-01-01 (Resolution 68-NQ/TW, Resolution 198/2025/QH15) ([source](https://doanhnghiephoinhap.vn/hon-18500-ho-kinh-doanh-chuyen-tu-nop-thue-khoan-sang-ke-khai-119355.html)). Decree 68/2026/ND-CP set the rules, and Decree 141/2026/ND-CP (retroactive to 2026-01-01) raised the VAT and PIT exemption threshold from 500 million to 1 billion VND of yearly revenue ([source](https://tapchicongthuong.vn/chinh-thuc--nang-nguong-chiu-thue-voi-ho-kinh-doanh-len-1-ty-dong-nam--ap-dung-tu-1-1-2026-514336.htm)).
- Above 1 billion VND a household business must use coded or cash-register e-invoices and declare quarterly ([source](https://www.sapo.vn/blog/lich-ke-khai-thue-ho-kinh-doanh)). Below it, it only reports revenue once a year, and the state says it does not need to buy software ([source](https://baolaocai.vn/ho-kinh-doanh-chuyen-sang-ke-khai-khong-can-mua-phan-mem-nop-le-phi-post885854.html)).
- Bookkeeping: Circular 152/2025/TT-BTC replaced TT88/2021 from 2026-01-01, with ledgers S1a-HKD to S2e-HKD by tax group ([source](https://www.sapo.vn/blog/thong-tu-152-2025-tt-btc)).
- Size: about 3.08 million active household businesses on 2026-04-19, 78% of them on eTax Mobile ([source](https://baolaocai.vn/tu-khoa/etax-mobile-tag66644.html)); about 2.56 million are at or below 1 billion VND ([source](https://www.sapo.vn/blog/nghi-dinh-141-2026-nd-cp)). So roughly 0.5 million owe tax and need invoices and ledgers (an inference from those two figures).
- That paying segment is flooded with free or cheap bundles: MISA eShop is free for group 1 and costs 99k to 699k VND a month for the others ([source](https://www.misaeshop.vn/?p=24283)); KiotViet has a free accounting module ([source](https://thoibaotaichinhvietnam.vn/kiotviet-mien-phi-phan-mem-ke-toan-cho-ho-kinh-doanh-183836.html)); Sapo is a licensed T-VAN that files returns in the app ([source](https://www.sapo.vn/blog/sapo-ket-noi-dich-vu-thue-dien-tu-t-van)). The tax authority lists 39 approved e-invoice providers for household businesses, among them Viettel, VNPT, banks and BKAV ([source](https://thuehaiquan.tapchikinhtetaichinh.vn/cong-bo-39-ong-lon-cong-nghe-tiep-suc-ho-kinh-doanh-trien-khai-hoa-don-dien-tu-152563.html)).
- The rules keep moving: in 2026, Decree 68 was amended by 141, Circular 18 by Circular 50, and Decree 254 and Circular 91 followed. Thresholds and form versions must be data, not code.

**Enterprise regimes and e-invoices.**
- TT133/2016 is still the SME regime; a draft replacement was published around 2026-09 ([source](https://www.meinvoice.vn/tin-tuc/52063/du-thao-thong-tu-thay-the-thong-tu-133/)). Circular 99/2025 replaces TT200 for fiscal years from 2026 ([source](https://www.grantthornton.com.vn/contentassets/af9027513fcd4f7bb7c9e9aa395c3390/slides---webinar-mt-s-cp-nht-quan-trng-trong-thong-t-s-99-v-ch--k-toan-doanh-nghip-vit-nam.pdf)).
- Decree 254/2026/ND-CP (effective 2026-07-01) is reported to repeal Decree 123/2020 and Decree 70/2025 on e-invoices ([source](https://www.meinvoice.vn/?p=48311)). The README still cites Decree 123/2020 and should be checked against it. The XML schema is Decision 1450/QD-TCT; whether it was superseded is unverified.
- VAT returns use form 01/GTGT under Circular 89/2026 from Q3/2026 ([source](https://thuvienphapluat.vn/hoi-dap-phap-luat/cach-dien-chi-tieu-to-khai-01gtgt-theo-thong-tu-89-day-du-moi-nhat-2026-138098760.html)). Third parties file only as licensed T-VAN providers; everyone else exports HTKK-compatible XML that the user uploads on eTax.

**Purchase-invoice sync.** The tax portal (hoadondientu.gdt.gov.vn) has no public API that could be found. Vendors sync each client's purchase invoices with the client's portal login: MISA meInvoice "xử lý hóa đơn đầu vào" ([source](https://meinvoice.vn/xu-ly-hoa-don-dau-vao/)) and Bizzi ([source](https://bizzi.vn/en/bizzi-launches-new-feature-to-synchronize-invoices-with-tax-office/)). The legal and terms-of-use status of that pattern is unverified. Issuing APIs exist for MISA meInvoice (public docs) and Viettel S-Invoice (REST); VNPT hands its API out at onboarding.

**Accounting service firms and the incumbent.**
- MISA ASP is a platform for service firms that is **free** for firms and their clients. It covers multi-client management, automatic invoice retrieval, automatic posting from purchase invoices, bank-statement import and tax filing. It reports 14,328 partner firms and 87,813 enterprises ([source](https://asp.misa.vn/)). The ledgers sit in MISA SME (desktop, from 6.15 million VND a year, [source](https://sme.misa.vn/bao-gia/)) or MISA AMIS (cloud, 2.95 to 8.15 million VND a year, [source](https://amis.misa.vn/20355/bao-gia-phan-mem-ke-toan-online-misa-amis/)).
- Firms charge clients by invoice volume, roughly 400k VND a month with no invoices to 2 million VND for 21 to 30 invoices ([source](https://thue.man.net.vn/dich-vu-ke-toan-thue-tron-goi-gia-re/)). Margins are thin, so staff minutes per client are the cost that matters (an inference).
- Their pains: one portal login per client tax code to download invoices, Excel tracking, missed invoices that cause back tax, bank reconciliation, preparing HTKK returns, and no single deadline view across clients ([source](https://www.meinvoice.vn/tin-tuc/11011/5-cach-quan-ly-hoa-don-dien-tu-dau-vao/)).

**Pilot practice.** Charge from the start, even at a discount. Keep pilots to 3 to 5 customers with an end date, success metrics against a baseline and a check-in every 1 to 2 weeks; onboard them by hand and bill outside the product ([source](https://headway.io/blog/how-to-run-a-software-pilot-program-b2b-dos-and-donts), [source](https://paulgraham.com/ds.html)).

**What this means for the backlog.**
1. The reachable first customer is the small accounting service firm (10 to 50 TT133 clients). Household businesses below 1 billion VND owe no tax and get free tools, so they are a poor paying target. Above that line they are served by POS vendors, and also by the same firms.
2. The bar is a free incumbent (MISA ASP). Crove wins a pilot only by being clearly faster per client: AI posting that is right most of the time, bulk review, and one view across clients. It also has to feed the ledger the firm already keeps (MISA) instead of asking the firm to switch.
3. Table stakes after the first loop: purchase-invoice sync from the tax portal per client, bank-statement import, and 01/GTGT output that HTKK and eTax accept. Crove should not become an invoice provider or a T-VAN.

## 3. MVP goal

**Outcome, testable on 2027-01-31:** an accounting-firm design partner runs the monthly bookkeeping of at least **5 real client companies** (SMEs on TT133) in Crove for **4 consecutive weeks**, measured by the instance's own audit data:

1. at least 80% of those clients' purchase and sales e-invoices for the month enter Crove and are approved there;
2. at least 70% of proposals are approved without edits (AI and rules are good enough);
3. the VAT working (input and output invoice lists, 01/GTGT totals) and the voucher export go into the firm's existing software or tax filing without re-typing;
4. the firm reports at least 30% less time per client per month than its current process (interview before and after);
5. at least 1 firm (the partner or a second firm) pays for the next month or signs a paid order.

If the partner's interviews (M0) show that a different first job matters more (for example household businesses, see section 2), the owner changes the goal in writing and the milestones follow; the shape (a named user, a weekly job, a measured saving, a payment) stays.

**What the MVP is not:** a general ERP, a MISA replacement on day one, a self-serve product for strangers, Social, CRM, agents with their own budgets, a public API, or a mobile app.

## 4. Milestones

Order is strict: an agent picks only from the earliest open milestone (section 7). Sizes: S up to 1 day, M 2-4 days, L 1-2 weeks of agent work. "New" means a new issue; numbers in brackets are existing issues reused (retitled and rescoped) or merged.

### M0 Decisions and discovery (owner, 2026-10-17 to 2026-10-31, parallel with M1)

Goal: the owner's decisions in section 6 are made, and the design partner has confirmed the first job with evidence.

| # | Issue | Why it matters for the user | Acceptance criteria | Size | Replaces / reuses |
|---|---|---|---|---|---|
| M0-1 | Owner: answer the backlog decisions (segment, pilot terms, hosting, identity, Social pause) | Nothing in M1 can start its deploy part without them | Each question in section 6 answered in chat and recorded in this file; milestones adjusted | S | new; closes #80 and #122 by decision |
| M0-2 | Owner: interview the design partner (5 staff, 5 of their client companies) | We build the job they actually pay for, not the one we imagine | 10 interviews with the plan's script; a one-page summary (time per client per month, volumes, software used, what they would pay); MVP goal confirmed or changed | M | reuses #57 (rescoped from 10-15 cold interviews) |
| M0-3 | Owner: collect 100 real sample documents with written consent | Extraction must work on the partner's real invoices, not synthetic ones | 100 documents (XML, PDF, photos, a month of 2-3 clients) shared under a consent note; anonymized copies kept outside the public repo | S | new |
| M0-4 | Owner: name the partner's accountant who reviews mappings and reports | TT133 mappings and VAT figures need a qualified human sign-off | A named accountant with 2 hours a week through M2; review sessions booked | S | reuses #61 |
| M0-5 | Owner: sign a short pilot agreement with the design partner | Real client data needs an agreed basis: purpose, AI processing, deletion on exit, no warranty | Vietnamese pilot agreement signed (agent drafts, owner and partner sign) | S | new, part of #62 |

### M1 Pilot deploy (2026-10-20 to 2026-11-07)

Goal: the design partner's staff sign in at a real URL, upload a month of invoices, approve them with MFA, and export; data is backed up and the owner hears about outages.

| # | Issue | Why it matters for the user | Acceptance criteria | Size | Replaces / reuses |
|---|---|---|---|---|---|
| M1-1 | SPA auth flows: password recovery, email confirmation, MFA enrollment and step-up | On a public URL approval requires MFA; without enrollment no one can approve, and users who forget a password are locked out | Recovery and confirmation work end to end through SMTP; a user enrolls TOTP and approves an R3 proposal; covered by the e2e test | M | [#32], open PR #101 |
| M1-2 | Playwright end-to-end test of the core flow as the deploy gate | A broken release must not reach the partner | Sign up, org, upload e-invoice, approve, lists, export, green in CI on every PR and before each deploy | M | [#18], open PR #91 |
| M1-3 | Owner: approve pilot hosting spend | The partner needs a URL; today there is none | Hosting choice from section 6 (D3) approved with a monthly cap; budget alert set | S | [#52] retitled; absorbs #122 |
| M1-4 | Owner: DNS and inbound email routing for the pilot domain | Users reach the app and forward invoices by email | Scoped token stored in the private secret store; DNS record and email route live | S | [#53] |
| M1-5 | Provision the pilot instance (compose stack on one server) | One instance is enough for 5-20 orgs and costs a fraction of the planned Cloud setup | One server runs `docker compose` (Postgres, Supabase Auth, Crove `all` role, extract sandbox) behind a TLS reverse proxy; SMTP via a transactional provider; S3-compatible bucket; secrets from the private repo, never in git; production config guards pass | M | new; uses [#55] (private repo, minimal: env and deploy only, no OpenTofu yet) |
| M1-6 | Deploy pipeline: release tag to the pilot instance with smoke test and rollback | Agents ship weekly without breaking the partner's day | A tag on `main` deploys through a workflow in the private repo; migrations run first; smoke test (health, sign-in, one upload) after deploy; documented one-command rollback to the previous image | M | [#56] retitled (single instance, `all` role, so no worker-first ordering yet) |
| M1-7 | Nightly backups and a restore drill | Losing a client's books ends the pilot and the reputation | Nightly `pg_dump` and file bucket copy to a second location, 30 days kept; a restore onto a scratch instance done once and timed; RPO 24 h and RTO 4 h written down | M | new |
| M1-8 | Pilot readiness checklist | Replaces the 18-row External-tenant gate as the blocker for a consenting design partner; the full gate stays for public sign-up | One checklist, signed off by the owner: TLS; secrets changed from defaults; `AUTH_AUTOCONFIRM=false`; step-up on; RLS matrix green (T8, done); sandbox on (T12 self-host, done); backups tested (M1-7); sign-up limited to invited users or a domain allowlist | S | new |
| M1-9 | Alerts reach the owner's phone, plus an outside uptime check | The owner learns about an outage before the partner calls | Prober alerts go to a Telegram or Slack channel the owner reads; an external uptime check pings `/healthz` every 5 minutes; one test alert received | S | new; absorbs the remainder of #151 |
| M1-10 | Feedback and support channel in the app | Pilot users need a fast way to report problems in Vietnamese | A "Góp ý / Hỗ trợ" link in the app shell opens the agreed channel (Zalo group or email); a 1-page Vietnamese quick guide (upload, approve, export) linked from the empty Inbox | S | new |
| M1-11 | Usage metrics for the MVP goal | The goal in section 3 must be measured, not guessed | A weekly report (SQL over audit rows, or an owner-only screen): active orgs and users, invoices received, approved, approved without edits, median time from upload to approval, exports | S | new |
| M1-12 | AI endpoint and spend cap for the pilot | PDFs and photos need a model; XML needs none | The pilot uses an OpenAI-compatible endpoint chosen in D9 with a monthly cap; the conformance suite passes against it once | S | new; uses the work of #153 |

### M2 Monthly close loop for an accounting firm (2026-11-09 to 2026-12-19)

Goal: for one client company, the firm's accountant does a month in Crove: all purchase and sales e-invoices in, approved in bulk, VAT working out, vouchers exported to the firm's existing software, ledger reports checked.

| # | Issue | Why it matters for the user | Acceptance criteria | Size | Replaces / reuses |
|---|---|---|---|---|---|
| M2-1 | Sales (output) e-invoices | A month has sales too; without them there is no VAT working and no revenue | Output e-invoice XML (the org is the seller) becomes a sales document, a customer party and a proposed entry (131 / 511 / 3331); duplicates refused; shown in Documents and the journal | L | new |
| M2-2 | Bulk intake: a ZIP or 200 XML files at once | Firms download a month of invoices in one go from the tax portal | ZIP upload expands server side in the sandbox; per-file progress and result (proposed, duplicate, failed); 200 files finish without a timeout | M | new |
| M2-3 | Bulk approve with one MFA step-up | 200 invoices a month cannot each ask for a TOTP code | Select many pending proposals and approve them in one action under one fresh step-up; each still gets its own audit row and four-eyes check; keyboard shortcuts for review | M | new |
| M2-4 | VAT working per month or quarter | The firm's main monthly deliverable is the VAT return | Input and output invoice lists for a period, with the totals that feed form 01/GTGT (taxable value and VAT by rate), Excel export; figures checked by the partner's accountant on one real month | M | new |
| M2-5 | Export vouchers to the firm's existing accounting software | Firms will not switch their system of record in a pilot; Crove must feed it | Excel export in the import template of the software the partner uses (expected: MISA SME purchase and sales voucher templates), imported once successfully by the partner | M | new |
| M2-6 | Accountant's multi-client view | One accountant serves many companies; switching orgs one by one is slow, and missed deadlines cost back tax | A home screen listing every org the user belongs to with pending proposals, failed files, last activity and the next VAT deadline (monthly or quarterly per org); one click into a client | M | new |
| M2-7 | Chart of accounts: TT133 default plus sub-accounts | Firms use sub-accounts (bank accounts, cost centers); vendor defaults must point to them | Add and deactivate sub-accounts under TT133 parents; a vendor's default account can be a sub-account; posted entries keep their account | M | new |
| M2-8 | Opening balances from Excel | Reports are wrong without the balances at the start date | Import a trial balance at a date from an Excel template; posted as one opening entry through `execute()`; validated (balances, known accounts) | M | new |
| M2-9 | Ledger reports in the app | The accountant checks the month before filing | Trial balance (bảng cân đối số phát sinh), general ledger per account, payables and receivables per party for a period; Excel export with exact amounts | L | new |
| M2-10 | B01-DNN and B02-DNN in the app, verified | Year-end statements are the next deliverable after VAT | The draft domain code (#170) wired to a screen and Excel; one real company's figures match the accountant's to the dong | M | merges [#154] and the report part of [#61] |
| M2-11 | Extraction accuracy on the partner's real documents | Trust breaks at the first wrong amount | An eval set from the 100 consented documents (stored privately); XML 100% correct on amounts; PDF and photo field accuracy measured and the top 5 error types fixed; the eval runs on demand before a model change | M | merges [#153] |
| M2-12 | Refuse a second reversal while one is pending | Prevents a confusing double reversal in the journal | Finish open PR #292 as scoped; no further rounds | S | [#254] |
| M2-13 | Owner and accountant: review mappings, VAT figures and reports | Legal correctness needs a qualified human | Sign-off on M2-4, M2-9 and M2-10 recorded in the issue | S | [#61] |
| M2-14 | Spike: purchase-invoice sync from the tax portal | The incumbent retrieves invoices automatically; Crove needs a path to parity before M3 | 1 week: how vendors do it (client portal login, provider APIs), legal and terms-of-use position, how a client's credential would be held (sealed per org, consent, revocation), core or Cloud layer; a go or no-go note with an estimate | S | new |

### M3 Paid pilot (2026-12-21 to 2027-01-31)

Goal: the partner pays, a second firm can start without the owner's hands-on help, and the most-requested time saver after M2 is in.

| # | Issue | Why it matters for the user | Acceptance criteria | Size | Replaces / reuses |
|---|---|---|---|---|---|
| M3-1 | Owner: pilot price and manual invoicing | A payment is part of the MVP goal; billing software can wait | A price per client company per month (D7); payment by bank transfer or VietQR; a VAT invoice issued by the owner's company; no in-app billing | S | new |
| M3-2 | Onboarding from a tax code | A second firm adds 20 clients; typing each company is friction | Create an org by tax code: name and address prefilled from a public lookup, TT133 preset, invite the client's contact; under 2 minutes per client | M | new |
| M3-3 | Automatic purchase-invoice sync from the tax portal | Downloading invoices by hand is the step firms most want gone, and the incumbent already does it | Only if the M2-14 spike says go: a daily sync per client into the Inbox, credentials sealed per org with the client's consent, a failed login shown to the accountant; in the Cloud layer if it needs a commercial connector | L | new |
| M3-10 | 01/GTGT output that HTKK and eTax accept | The firm still types the VAT return into HTKK by hand | The VAT working of M2-4 exported as the HTKK-compatible XML of form 01/GTGT (Circular 89/2026 version); one real return uploaded on eTax by the partner's accountant | M | new |
| M3-4 | Bank statement import and matching | Payments clear payables; firms reconcile banks monthly | Excel/CSV statements from the 5 most common banks of the partner's clients; dedupe by running balance; matches to open payables and receivables proposed in the Inbox | L | new (plan Phase 2a "file-based bank statements") |
| M3-5 | Receipts and payments vouchers | Bank lines and cash need vouchers (phiếu thu, phiếu chi, báo nợ, báo có) | Vouchers proposed from matched bank lines or entered by hand; posted through `execute()`; in the export of M2-5 | M | new |
| M3-6 | Terms of service and privacy notice for paid use | Paying customers need terms; PDPL basics apply | Vietnamese terms and privacy notice reviewed by a lawyer, linked at sign-up | S | part of [#62] |
| M3-7 | Period lock | Filed months must not change silently | Lock a month; posting or reversing into a locked month is refused; unlock is owner R3 with a reason | M | new |
| M3-8 | Household business spike | Section 2: the 2026 change creates a large new segment; decide with evidence whether Crove serves it | 1-week spike: the bookkeeping forms and declarations a household business needs in 2026, what POS and e-invoice vendors already give them, what Crove would add; a go or no-go note for the owner | S | new |
| M3-9 | Case study and a second firm | Repeatability is the real MVP test | A short Vietnamese case study with the partner's numbers (with permission); one more firm onboarded with the guide only | S | new |

### GA gate (before public self-serve sign-up; not before M3)

The existing "External-tenant gate" milestone, renamed. It keeps #31 (external security review), #62 (PDPL package), and any T-row still open. It applies before Crove accepts organizations that are not under a signed pilot agreement. Nothing in it is picked while M1 to M3 have open P0 or P1 issues.

### Paused and icebox

- **Social** (Phase 5 milestone): paused if the owner accepts D5; issues keep their content at P3.
- **Icebox** (the "Later (Phase 3+)" milestone, renamed "Icebox"): review follow-ups, tooling polish, client apps, the public API, agents beyond the Inbox.

## 5. Every open issue and the recommended action

Snapshot of the 57 open issues on 2026-10-17. P0 = the current milestone cannot finish without it; P1 = needed in that milestone; P2 = useful, after P0 and P1; P3 = icebox (picked only by an owner decision or when a real user hits it).

| Issue | Title (short) | Action | Priority, milestone | Reason |
|---|---|---|---|---|
| #18 | Playwright e2e of the Inbox flow | Keep | P0, M1 | Deploy gate for the pilot (M1-2); PR #91 open |
| #25 | Vendor the pg-boss schema | Keep, finish only | P2, M1 | PR #104 is written; merge if green, no new work |
| #31 | External security review | Keep | P2, GA gate | Needed before public sign-up, not for a consenting design partner |
| #32 | SPA auth flows (recovery, MFA) | Keep | P0, M1 | Without MFA enrollment nobody can approve on a public URL (M1-1); PR #101 open |
| #33 | LICENSE, CLA, CONTRIBUTING... | Close as done | - | Files added in #144; the lawyer review of the CLA moves to #62 |
| #34 | Verify Supabase Auth rate limits | Defer | P3, Icebox | Pilot is invite-only; merge PR #191 as-is only if green |
| #41 | Adopt Vite+ toolchain | Defer | P3, Icebox | Tooling with no user value now |
| #50 | Renovate | Defer | P3, Icebox | Config merged (#145); installing the app adds PR noise during the pilot |
| #52 | Approve Supabase and GCP spend | Keep, retitle | P0, M1 (owner) | Becomes "approve pilot hosting spend" (M1-3) |
| #53 | Cloudflare token for DNS and email | Keep | P0, M1 (owner) | Pilot URL and invoice forwarding (M1-4) |
| #54 | DOS-side redirect URL for DOS Auth | Defer | P3, Icebox | Not needed if the pilot uses the bundled sign-in (D4) |
| #55 | Create the private crove-cloud repo | Keep, rescope | P1, M1 | Minimal: pilot env and deploy workflow only (M1-5) |
| #56 | Deploy beta and prod worker-first | Keep, retitle | P0, M1 | Becomes the single-instance deploy pipeline (M1-6) |
| #57 | 10-15 customer interviews | Keep, rescope | P0, M0 (owner) | 10 interviews inside the design partner (M0-2) |
| #60 | Epic: Phase 2a Finance A1 | Close, replaced | - | Replaced by milestone M2 and its issues |
| #61 | Accountant track | Keep | P1, M2 (owner) | Sign-off on VAT and reports (M0-4, M2-13) |
| #62 | Legal track: PDPL, CLA, license terms | Keep, split | P2, GA gate | Pilot agreement (M0-5) and terms (M3-6) split out; the PDPL package stays here |
| #63 | File the Crove trademark | Keep | P2, no milestone (owner) | Cheap protection, not on the product path; do when convenient |
| #64 | PWA with Web Push | Defer | P3, Icebox | No user asked |
| #65 | Mobile app with Expo | Defer | P3, Icebox | No user asked |
| #66 | Desktop app with Tauri 2 | Defer | P3, Icebox | No user asked |
| #68 | Epic: public API, webhooks, MCP | Defer | P3, Icebox | No partner needs it yet |
| #70 | Shut down the legacy forks | Defer | P3, Icebox (owner) | DOS-side cleanup, not Crove product work |
| #80 | Brand: Crove or Bexly | Close by decision | - | Recommend keeping Crove (D8); a rename now costs days and gains nothing |
| #95 | ANTHROPIC_API_KEY for the reviewer agent | Defer | P3, Icebox (owner) | Spend with no user impact; sessions review protected PRs themselves |
| #117 | Sealed context follow-ups | Defer | P3, Icebox | Review follow-up; remaining items wait on decisions nobody needs yet |
| #122 | Data residency in Vietnam | Merge into M1-3 / D3 | - | Part of the hosting decision |
| #130 | Remove the migrateJobs no-op | Merge into #25 | P3 | Tail of #25 |
| #134 | Member invite follow-ups | Defer | P3, Icebox | Remaining item waits on a `security_event` table nobody needs yet |
| #151 | Prober alert de-duplication | Close as done | - | Done in #273 and #274; the real-endpoint check moves to M1-9 |
| #153 | AI evals in CI | Merge into M2-11 | P1, M2 | Evals matter on real documents, run on demand |
| #154 | Phase 0b remainder: B01/B02 | Merge into M2-10 | P2, M2 | Domain done (#170); accountant verification is the remaining work |
| #174 | Nightly canary registers | Close, won't do now | - | Bun and TypeScript-next canaries have no user value; close PR #192 |
| #180 | MFA enforcement follow-ups | Defer | P3, Icebox | Remaining item is Cloud `jwt` mode only, not used by the pilot |
| #203 | Optional CAPTCHA | Close, won't do | - | Revisit only on real sign-up abuse |
| #221 | Per-client limit on /auth/v1 proxy | Defer | P3, Icebox | Pilot is invite-only; merge PR #229 as-is only if green and reviewed |
| #223 | Staged upload follow-ups | Close as done | - | Both items done in #252 |
| #233 | Social: schema, commands, API | Pause | P3, Social (paused) | D5; in progress in the social stream, stop at a clean point |
| #234 | Social: exactly-once publish | Pause | P3, Social (paused) | D5 |
| #235 | Social screens | Pause | P3, Social (paused) | D5 |
| #236 | Channel OAuth: Meta, Zalo OA | Pause | P3, Social (paused) | D5 |
| #237 | Social AI drafting | Pause | P3, Social (paused) | D5 |
| #238 | Social metrics | Pause | P3, Social (paused) | D5 |
| #239 | Social media library and more | Pause | P3, Social (paused) | D5 |
| #250 | Social domain follow-ups | Pause | P3, Social (paused) | Review follow-up of a paused stream |
| #254 | Refuse a second pending reversal | Keep, finish only | P2, M2 | PR #292 open (M2-12) |
| #258 | Agents: contract and UI for the chart | Defer | P3, Icebox | The Inbox already is the AI experience; an org chart UI helps no pilot user; stop at a clean point |
| #259 | Agents: model runner and cost | Defer | P3, Icebox | Same |
| #260 | Agents: R2/R3 proposals by agents | Defer | P3, Icebox | Same |
| #261 | Agents: le_scope, schedules | Defer | P3, Icebox | Same |
| #264 | Channel layer review follow-ups | Pause | P3, Social (paused) | Review follow-up of a paused stream |
| #276 | Refuse OAuth-bound sessions (db check) | Defer | P3, Icebox | No OAuth clients exist; finish only if its PR is already green |
| #281 | SSE stream hardening | Defer | P3, Icebox | Review follow-up; merge PR #296 as-is only if green |
| #285 | Agents: allowlist agent writes | Defer | P3, Icebox | Agents do not act on real data in the pilot |
| #289 | Auth proxy: OAuth-bound sessions | Defer | P3, Icebox | No OAuth clients exist |
| #293 | Color lint edge cases | Close, won't do | - | Lint polish; none fires on current sources |
| #294 | Typecheck every test file | Defer | P3, Icebox | Tooling; finish only if its branch is nearly done |

Board hygiene: #35 is closed but still "In progress" on the board (set Done); #130, #153, #250, #264 and #289 are open but not on the board (add them with their new status).

## 6. Owner decisions that block progress

Each question has the recommended answer; per the plan's working rule, a recommendation is adopted unless the owner objects, except spend, which needs an explicit yes.

| # | Question | Recommendation | Why |
|---|---|---|---|
| D1 | Which customer first: accounting service firms (through the design partner) or household businesses? | Accounting firms serving SMEs on TT133 first; household businesses as a 1-week spike in M3 (M3-8) | What is built (TT133 entries, approvals, multi-org, export for the accountant) fits firms; a partner exists; one firm brings many companies. About 2.56 million of the roughly 3.08 million household businesses are under the 1 billion VND line and owe no tax; those above it already get free or cheap tools from POS and e-invoice vendors (section 2) |
| D2 | May the design partner use Crove with real client data before the full External-tenant gate is green? | Yes, under the pilot agreement (M0-5) and the Pilot readiness checklist (M1-8); the full gate stays for public sign-up | The gate's evidence rows (external review, PDPL package) take months and money; a consenting partner on an invite-only instance is a normal pilot. The heavy controls already on `main` (RLS matrix, sealed context, sandbox, immutable ledger) exceed what most pilots have |
| D3 | Where does the pilot run and how much may it cost per month? | One server running the compose stack, preferably at a Vietnamese data center (or Google Cloud Singapore if that is faster to set up), with object storage and nightly backups; cap about 50-100 USD a month. Defer the planned Cloud setup (Supabase Pro with PITR, Cloud Run, two GCP projects; about 350-770 USD a month in plan §12-E) until about 20 paying orgs | One instance serves 5-20 orgs easily; it is the same image self-hosters run, so nothing is thrown away. Hosting in Vietnam also sidesteps the data-residency question in #122 |
| D4 | Do pilot users sign in with Crove's own accounts or with DOS ID? | Crove's bundled sign-in (email, password, MFA) for the pilot; DOS ID later | Removes the cross-repo DOS change (#54) and the dependency on DOS's Auth project from the critical path; accounts can be linked later because `user_account` keys on issuer and subject |
| D5 | Pause the Social stream and the agents org-chart work until M2 is done? | Yes: both to P3; the sessions on #233 and #258 stop at a clean point and merge nothing half done | Neither has a pilot user; agent capacity is the scarce resource, and Social alone is 6 weeks of plan |

**D5 answered by the owner, 2026-10-17: no for Social.** Social continues (Decision 17), core features first: the contract and router, the Social screens (S5), publishing on the sandbox (S4), then Facebook Page (S6). Review follow-ups of the stream stay at P3. The agents org-chart part of D5 is not decided by this answer.
| D6 | Who books the interviews and collects the 100 sample documents, and by when? | The owner with the partner's COO, by 2026-10-31 | The plan has waited for interviews since 2026-10-13; M2 scope depends on them |
| D7 | What does the pilot cost the partner? | Free until 2026-12-31, then a per-client-company monthly price; starting hypothesis about 100k VND per active client company a month, tested in the interviews; invoiced by hand | Payment is the MVP test. Firms charge their clients roughly 400k to 2 million VND a month, and the incumbent platform is free, so Crove's price must be a small share of the firm's fee and clearly below the staff time it saves. Billing software is not needed for 1 to 3 customers |
| D8 | Keep the Crove brand (issue #80)? | Keep Crove; close #80 | A rename touches packages, schemas, docs and domains; the alternative was already checked and rejected (premium domain, an existing accounting brand with a similar name) |
| D9 | Which AI endpoint processes PDFs and photos in the pilot, and may invoice data leave Vietnam for it? | The DOS.AI endpoint with a monthly cap; XML e-invoices (most of the volume) never call AI; say so in the pilot agreement | XML is parsed deterministically, so AI only sees scans and photos; the agreement makes the processing explicit |
| D10 | Work alongside the firm's current software instead of replacing it? | Yes for the MVP: Crove is the AI intake and review layer, and exports vouchers to the firm's system of record (M2-5) | Switching a firm's ledger is a year-end decision with retraining; feeding their software removes the switching cost and still saves the data-entry time |

## 7. Rules that keep the backlog healthy

1. **Every issue has a milestone with a user outcome, or it is in the Icebox.** Milestones run in order (M0 to M3, then the GA gate); an agent picks only from the earliest milestone that has an open, unclaimed P0 or P1 issue. Nothing is picked from the Icebox, Social (paused) or the GA gate without an owner decision.
2. **Review follow-ups go to the Icebox.** A non-blocking finding from any review (security, code, bot) becomes a P3 issue labelled `review-followup` in the Icebox. It moves into a milestone only when it blocks that milestone's acceptance criteria or a real user hits it. Blocking findings are fixed in the same PR, as today.
3. **No hardening for features nobody uses.** Security work is picked only when (a) a row of the current milestone's checklist needs it (M1-8 for the pilot, the GA gate for public sign-up), or (b) a real high or critical vulnerability is found, which is P0 at once.
4. **WIP limit.** At most 3 issues in progress at once across all agents, at least 2 of them in the current milestone; one issue per agent.
5. **Agents do not create P0 or P1 issues.** New issues default to P3 in the Icebox; the coordinator triages once a week and the owner sees the result.
6. **Done means deployed.** From M1 on, an issue is done when it runs on the pilot instance and has a one-line Vietnamese release note for the partner.
7. **Owner actions have dates.** Every `owner-action` issue has a due date; the weekly update lists the overdue ones in chat with a workaround proposal.
8. **Time-boxes cut scope, not dates silently.** A milestone that misses its date is re-planned in writing (what moves to the next milestone), never extended in silence.
9. **New gate rows need an owner decision.** No agent adds rows to a gate or new checklist items to the plan without the owner's yes.
10. **Weekly owner update (Vietnamese, one page):** what pilot users did (M1-11 metrics), what shipped, what is blocked on the owner.

`AGENTS.md` ("Picking up work") must be updated to rules 1 to 5; it is a protected path, so that change is its own PR.
