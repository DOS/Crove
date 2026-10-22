# PDPL package: drafts for the lawyer

**Status: DRAFT, not reviewed by a lawyer. Do not file, sign or publish as is.** Gate row T16 of the [kernel plan](../../plan/crove-os-kernel.md) (§7.9) asks for a DPIA, a cross-border transfer dossier, a DPA template, a 72-hour breach runbook and a sub-processor list, reviewed by a lawyer. An agent drafted them from what the code does (#1012). The owner engages the lawyer and signs (#62).

The law: the Law on Personal Data Protection (Law 91/2025/QH15, in force from 1 January 2026) and Decree 356/2025/NĐ-CP. The Vietnamese texts are the ones to file or sign; the English file is the fact base.

| File | What it is | For |
|---|---|---|
| [processing-record.md](processing-record.md) | Record of processing: every kind of personal data, where it is stored, retention, other services and security measures, each with the file that shows it | the lawyer and agents; the source for the others |
| [impact-assessment.vi.md](impact-assessment.vi.md) | Hồ sơ đánh giá tác động xử lý dữ liệu cá nhân | filed with the authority, if the lawyer confirms |
| [transfer-assessment.vi.md](transfer-assessment.vi.md) | Hồ sơ đánh giá tác động chuyển dữ liệu cá nhân ra nước ngoài | filed if any processing happens outside Vietnam |
| [dpa.vi.md](dpa.vi.md) | Phụ lục thỏa thuận xử lý dữ liệu cá nhân, an annex to the [terms](../terms.vi.md) | signed with each firm |
| [sub-processors.vi.md](sub-processors.vi.md) | Danh sách bên xử lý phụ | published to the firms |
| [breach-notice.vi.md](breach-notice.vi.md) | Mẫu thông báo vi phạm: to the authority and to the firm | used with [incidents.md §9](../../runbooks/incidents.md) |

The terms and privacy drafts, with their own questions, are in [docs/legal](../README.md) (#328).

## What the owner fills in before the lawyer's review

- The operator's legal name, tax code, address, and the person in charge of personal data protection.
- The hosting provider and the country of the server, the files and the backups (#122, #306).
- The SMTP provider.
- What the DOS.AI gateway (D9) promises: where the models run, whether inputs are kept or used for training, and its breach notice time.
- The alert channel (Telegram, Slack or Discord), the uptime service and the tax code lookup service.

## Questions for the lawyer

The drafts refer to these numbers.

1. **Roles and the processing agreement.**
   - Is the firm the controller and the operator the processor for client company data?
   - Is a written processing agreement required between them? Is an annex to the terms ([dpa.vi.md](dpa.vi.md)) the right form?
   - When a firm keeps the books of client companies, is the client company a controller too, so that a chain of agreements is needed?
2. **Sensitive data and legal basis.**
   - Do invoices, bank account numbers and ledgers of household businesses or sole traders count as sensitive personal data?
   - Which legal basis covers the processing: the firm's contract with its client, the Accounting Law, or consent?
   - Does reading documents with AI need separate consent?
3. **Impact assessment.**
   - Who must prepare it: the operator, each firm, or both?
   - Is it filed with the authority? In which form and by when?
   - Does [impact-assessment.vi.md](impact-assessment.vi.md) cover what Decree 356 asks?
4. **Cross-border transfer.**
   - Which of the flows in [transfer-assessment.vi.md](transfer-assessment.vi.md) count as a transfer abroad? For example, Cloudflare relaying inbound mail through its global network, or an AI provider outside Vietnam.
   - Does hosting in Vietnam (#122) remove the need for a dossier for the other flows?
   - Are the social networks an org connects its own choice, and so outside the operator's sub-processors?
5. **Breach notice.**
   - Which authority receives the notice, within what deadline, and in which form?
   - When the data belongs to a firm's books, does the firm notify, or the operator?
   - Is a 24-hour notice from the operator to the firm enough for the firm to meet the deadline?
   - Is [breach-notice.vi.md](breach-notice.vi.md) worded correctly?
6. **Retention after erasure or exit.**
   - May the operator keep the books and the documents behind recorded entries for 10 years after an org leaves, or after a person asks for erasure, as the drafts say? Or must it hand them to the firm and delete them?
   - How long may backups (30 days) keep erased data?
7. **Security logs.** `refusal_tally` (7 days) and `security_event` (30 days) keep a user id and codes after an erasure, as a security log ([processing-record.md](processing-record.md), section 2.2). Is that acceptable without a mention in the privacy notice?
8. **Response time.** What deadline applies to a person's request to see or erase their data? [personal-data-requests.md](../../runbooks/personal-data-requests.md) leaves it to be confirmed.
