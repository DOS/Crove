# Tax calendar per client (issue #921)

The multi-client home screen lists each client's recurring tax obligations, not only the VAT return. It shows:

- the next one, per client;
- a list across all clients of what is due in the next 30 days or overdue and not marked done, by due date.

A member marks an obligation done for a period, and it leaves the list.

- **Rules:** `packages/kernel-contract/src/tax-calendar.ts`, `TAX_RULES`. Each line gives:
  - the obligation and its frequency;
  - its year basis: the calendar, or the org's fiscal year;
  - the due-day rule;
  - the periods it covers;
  - its legal basis;
  - `confirmed`, false until the partner's accountant (#61) confirms the line.

  A change of the law is a change of this table. Unit tests: `packages/kernel-contract/test/tax-calendar.test.ts`.
- **What an org chose:** `crove_kernel.tax_profile`, one row per org. Owners and admins set it in Settings, "Lịch thuế" (`kernel.tax_profile.save`, R1, audited). It holds:
  - the obligations that apply;
  - the PIT withholding frequency;
  - the last month of the fiscal year.

  The VAT return follows the VAT filing period chosen just above it (#318).
- **Done marks:** `crove_kernel.tax_obligation_done`, at most one per obligation and period. Owners, admins and members mark an obligation done or take the mark back (`kernel.tax_obligation.done` and `.undo`, R1, audited). A period of another frequency is refused (`TAX_PERIOD_MISMATCH`).
- **Who sees the button (#1917):** each due row of `kernel.org.overview` lists its open legal entities with `canMark`, the server's answer to whether the reader may mark it done there. It applies the same rule as the mark: owners, admins and members for most obligations, and, for the VAT return with finance on, the filers of that entity. The Overview and the multi-client home show the button only where `canMark` is true. `kernel.tax_obligation.done` and `.undo` apply the same rule, so they refuse the VAT return to a member who is not a filer (`FORBIDDEN`).
- **The VAT return with finance on (#1400):** its mark goes through `finance.vat.return_mark` (owners and admins, and a chief accountant for the entity, #1508), which records the return as filed with [22], [25] and [43] (Crove's own working when marked from the calendar) and writes the same done mark in the same transaction, so the next period's [22] starts from that [43]. See [htkk-01gtgt-xml.md](htkk-01gtgt-xml.md).
- **What the screen lists:** `kernel.org.overview` `taxDues`, read in each org's own context (`packages/kernel/src/tax-calendar.ts`). It holds:
  - what is due from today to 30 days ahead;
  - what is overdue and not marked done, back to the day the org first saved its calendar and at most a year.

  An org that just set its calendar is not shown a year of returns it filed elsewhere. Without a saved calendar, only the VAT return is listed.

## The table

A due date on a Saturday or a Sunday moves to the next Monday (Civil Code 2015, Article 148(5)), as for the VAT return. Public holidays are not applied, so the date shown is never later than the real one.

| Obligation | Frequency | Due | Legal basis (as recorded) |
|---|---|---|---|
| VAT return (`vat_return`) | month | 20th of the next month | Law 38/2019/QH14, Art. 44(1)(a) |
| | quarter | last day of the first month of the next quarter | Law 38/2019/QH14, Art. 44(1)(b) |
| PIT withholding return (`pit_withholding`) | month or quarter, per the org | as the VAT return | Law 38/2019/QH14, Art. 44(1); Decree 126/2020/NĐ-CP, Art. 8 and 9 |
| Provisional CIT (`cit_provisional`, a payment) | quarter of the fiscal year | 30th of the first month of the next quarter | Law 38/2019/QH14, Art. 55(1) |
| CIT finalization (`cit_finalization`) | fiscal year | last day of the third month after the fiscal year | Law 38/2019/QH14, Art. 44(2)(a) |
| PIT finalization (`pit_finalization`) | calendar year | last day of the third month after the year | Law 38/2019/QH14, Art. 44(2)(a) |
| Annual financial statements (`financial_statements`) | fiscal year | 90 days after the fiscal year ends | Circular 133/2016/TT-BTC, Art. 80(1) |
| Business license fee (`license_fee`) | calendar year, 2020 to 2025 | 30 January of the year | Decree 139/2016/NĐ-CP, Art. 6(3), amended by Decree 22/2020/NĐ-CP; abolished from 2026 by Resolution 198/2025/QH15 |

How periods are named:

- A fiscal year is named by the calendar year it ends in. With the year ending in March, fiscal year 2027 runs from April 2026 to March 2027.
- Its quarters are numbered from its first month, so "2027-Q1" is April to June 2026.

## Not covered, and unconfirmed

- **Not covered:**
  - Public holidays and Tet, and extensions (gia hạn).
  - Returns filed per event rather than per period (on cessation, on a change of ownership).
  - The obligations of household businesses.
- **Law 108/2025/QH15 (from 2026-07-01):** it replaces Law 38/2019/QH14 (see htkk-01gtgt-xml.md), and the table still cites Law 38. Whether the new law and its circulars keep the same deadlines is **unconfirmed**; that is question 1 below.
- **Every line is `confirmed: false`,** and the screen says the table is not confirmed yet.

## Questions for the partner's accountant

1. Do the deadlines above still hold for periods from July 2026 under Law 108/2025/QH15 and Circular 89/2026? Which articles should the table cite instead?
2. Is the provisional CIT due by the 30th of the first month of the next quarter for every client? How do you track a client whose fiscal year is not the calendar year?
3. Is 90 days after the year end the right deadline for the financial statements of your clients (30 days for a sole proprietorship)? Do you treat it as the same day as the CIT finalization?
4. Should the calendar add other recurring obligations your clients have, such as the land rental fee, the environmental fee, or the statistics reports?
5. With the license fee abolished from 2026 (Resolution 198/2025/QH15), is there anything left to file for it?
