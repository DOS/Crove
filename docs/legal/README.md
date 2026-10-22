# Terms of service and privacy notice: drafts

**Status: DRAFT, not reviewed by a lawyer. Do not publish as is.** Plan M3-6 (`docs/plan/backlog-review-2026-10-17.md` §4) asks for "Vietnamese terms and privacy notice reviewed by a lawyer, linked at sign-up". As with M0-5, an agent drafts and the owner and a lawyer sign. The review is tracked on #328; these drafts come from #688.

| File | What it is |
|---|---|
| [terms.vi.md](terms.vi.md) | Điều khoản sử dụng (Vietnamese, the version the partner signs) |
| [privacy.vi.md](privacy.vi.md) | Chính sách quyền riêng tư (Vietnamese) |
| [terms.md](terms.md), [privacy.md](privacy.md) | English working copies, for review only; the Vietnamese text prevails |
| [pdpl/](pdpl/README.md) | The PDPL package for gate T16: record of processing, impact and transfer assessments, processing agreement annex, sub-processors, breach notices (#1012) |

## How a deployment uses them

1. Fill the placeholders in square brackets (`[Tên đơn vị vận hành]`, addresses, dates, the AI provider) and have a lawyer review the result.
2. Publish both pages on an `https:` address the deployment controls.
3. Set `TERMS_URL` and `PRIVACY_URL`. The sign-up screen and the invite acceptance screen then show "Khi tiếp tục, bạn đồng ý với Điều khoản sử dụng và Chính sách quyền riêng tư", with the two links. Unset, the line is hidden.

A self-hoster who runs Crove only for their own company writes their own documents; these drafts describe a provider that runs Crove for accounting firms and their client companies.

## How the drafts are built

- **Roles.** The accounting firm (or company) that holds the account decides why and how its client companies' data is processed: it is the controller ("bên kiểm soát dữ liệu cá nhân"). The operator of the Crove instance processes that data on the firm's instructions: it is the processor ("bên xử lý dữ liệu cá nhân"). For the account holders' own data (members' names, emails, sign-in records) the operator is the controller.
- **Law.** The Law on Personal Data Protection (Luật Bảo vệ dữ liệu cá nhân, Law 91/2025/QH15, in force from 1 January 2026) and its implementing decree (Decree 356/2025/NĐ-CP). The Law on E-transactions and the Law on Accounting matter for e-invoices and the 10-year retention of accounting records.
- **What Crove actually does.** These are described from the code, not promised beyond it:
  - documents and e-invoices stored per organization with row-level isolation;
  - AI reading of PDFs and photos through the provider chosen in decision D9, whose output is checked and approved by a person;
  - audit records of every change;
  - nightly backups (RPO 24 hours) and an alert path;
  - export before an organization leaves, then deletion.

## Questions for the lawyer

1. **Roles.** Is the firm the controller and the operator the processor for client company data? Does the PDPL require a written processing contract between them? If so, should it be an annex to these terms?
2. **Sensitive data.** Do invoices, bank statements and ledger entries of client companies count as sensitive personal data ("dữ liệu cá nhân nhạy cảm") when the client company is a household business or a sole trader? What extra consent or impact assessment does that require?
3. **Impact assessment.** Must the operator file a processing impact assessment ("hồ sơ đánh giá tác động xử lý dữ liệu cá nhân") with the authority? When, and in what form?
4. **Cross-border transfer.** If the AI provider (decision D9) processes documents outside Vietnam, what transfer assessment and notice are needed? Does keeping all storage in Vietnam (#122) change that?
5. **72-hour notice.** Is the breach notice to the authority and to the firm worded correctly? Who notifies the client companies: the firm or the operator?
6. **Retention and deletion.**
   - The Law on Accounting asks companies to keep accounting records for 10 years. Is it enough that the operator exports everything to the firm and deletes it 30 days after the account closes?
   - Should the operator itself keep anything?
7. **Liability.** Is the cap on liability in the terms (fees paid in the last 12 months) valid under Vietnamese law? Is the exclusion for figures a person approved valid?
8. **Tax portal (O1, #325).** If Crove later signs in to the tax portal with a client's credentials at the accountant's request, what consent and wording does that need?
9. **Language and governing law.** Is a Vietnamese-only signed version with an English courtesy copy fine? Are courts in Vietnam the right forum?
