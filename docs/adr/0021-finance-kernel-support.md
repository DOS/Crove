# 0021. Kernel support for Finance: money domains, gapless numbering, period close, hash chain, source revisions and bank line keys

- Status: proposed (2026-10-15). The owner accepts it, or changes it, before the Phase 2a kernel additions (numbering, periods, hash chain) are built.
- Date: 2026-10-15
- Deciders: owner (JOY); evidence from the Phase 0b spike
- Builds on: plan §4.10 (audit, immutability, WORM fact stream), §5.2 (manifest `numbering`), §6 (`number_series`, `number_allocation`), §13 Phase 0b and Phase 2a exit criteria, red-team rows S26 and S32; the ledger posting definer and `created_xact_id` from #71 (`supabase/migrations/20261014090100_crove_finance_ledger_posting.sql`)
- Tracking: issue #58 (Phase 0b spike); Phase 2a Finance A1 (issue #60)
- Prototype: [`0021/`](0021/) (`spike.sql`, `scenarios.sql`, `checks.sql`, `bench/*.sql`, `run.sh`). Reference only, not a migration.

## Context and problem statement

`main` already has a small ledger: `crove_finance.journal_entry` and `journal_line` are append-only, only the `SECURITY DEFINER` function `post_journal_entry()` may insert, an entry must have at least 2 lines and balance at commit, and a line can only be added in the transaction that created its entry (`created_xact_id`, #71). The money domains `amount numeric(20,4)`, `unit_amount numeric(24,8)` and `quantity numeric(20,6)` exist; `fx_rate` does not yet.

Phase 2a needs more from the kernel before Finance can post real vouchers (PT/PC/BN/BC/NVK) and purchase or sales invoices:

1. Money domains that cannot lose or invent a dong.
2. Gapless document numbers per legal entity, document type and period, under concurrency, with voided numbers recorded.
3. Period close, so nothing posts into a closed period, and rules for reopening.
4. Tamper evidence for posted entries, number allocations and voids.
5. Re-posting a source document after a reversal: today `UNIQUE (org_id, source_type, source_id)` blocks it (red-team S32).
6. Bank statement lines that are never lost or doubled on overlapping imports (red-team S26).

The spike built each of these on a throwaway `postgres:17` database (PostgreSQL 17.11 in Docker on the owner's Windows workstation, 48 logical CPUs, default settings except `max_connections=1100`; `pgbench` ran in the same container) and measured them. `bash docs/adr/0021/run.sh` reproduces every number below and removes its container afterwards. Timings vary between runs; where two runs differ, both are given.

## Decision drivers

- Postgres enforces the invariants for every role and every path, not only the happy path through the TypeScript code (plan §1).
- Gapless means: every committed number is used exactly once, a rolled-back transaction leaves no hole, and a number that must not be used any more is voided on the record, never deleted.
- Small and medium companies, so per-legal-entity write volume is low; correctness first, but the design must not need more than one counter row lock per posting.
- Works on any PostgreSQL 17 with no extension (self-host, ADR-0027).
- Vietnamese rules only where they change a decision; everything else stays configurable per series.

## Decision

### 1. Money domains

Keep the sizes in the plan and add `fx_rate`:

| Domain | Type | Largest value | Used for |
|---|---|---|---|
| `amount` | `numeric(20,4)` | 9,999,999,999,999,999.9999 | Every stored money amount: lines, totals, balances, bank lines |
| `unit_amount` | `numeric(24,8)` | 16 integer digits, 8 decimals | Unit prices |
| `quantity` | `numeric(20,6)` | 14 integer digits, 6 decimals | Quantities |
| `fx_rate` | `numeric(24,10)`, `CHECK (VALUE > 0)` | 14 integer digits, 10 decimals | Exchange rates |

Rules that go with them:

- **Four decimals cover every currency; the currency decides how many are used.** ISO 4217 minor units go from 0 (VND, JPY) to at most 4 [4]. A `currency.minor_units` column holds the exponent, and the posting definer refuses any amount with more decimals than its currency allows (`AMOUNT_SCALE`, SQLSTATE 22023). Measured: `numeric(20,4)` **rounds silently** (`1.00005::amount` gives `1.0001`), so without this check a VND entry of `100.5` would be stored, and a USD amount with a third decimal rounded without anyone noticing. With the check, `100.5` VND is refused and `100.50` USD posts.
- **Overflow is an error, not a wrap.** `10^16::amount` fails with `22003 numeric field overflow`. Report totals are computed as unconstrained `numeric` and are not limited by the domain.
- **Exchange rates are stored as a direct quote, units of the book currency per 1 unit of the foreign currency** (for example 25,432.5 VND per USD), never as the inverse. Measured: the inverse `1/25,432.5` stored as `fx_rate` is `0.0000393198`, and converting USD 1,000,000 through it is off by **20,689 VND**; the direct quote is exact (USD 1,234.56 x 25,432.5 = 31,397,947 VND after rounding to the dong).
- **Round once, at the line, to the currency's minor units.** `quantity x unit_amount` keeps 14 decimals (`3 x 33,333.33333333 = 99,999.99999999`); the line `amount` is that product rounded to the currency (100,000 VND). Totals are sums of rounded lines, so a document always adds up. SQL `round()` rounds half away from zero, the same as `decimal.js` `ROUND_HALF_UP` used by `@crove/l10n-vn`.
- Amounts stay decimal strings outside SQL (AGENTS.md); JSON numbers are never used for money.

### 2. Gapless numbering

A kernel service, used by every module through the manifest `numbering` entry (§5.2) and `ctx.numbering`:

- **`number_series`**: one counter row per `(org_id, legal_entity_id, doc_type, period_key)`. `period_key` comes from the document date and the series policy: `'2026'` (yearly reset, the default), `'2026-10'` (monthly) or `'-'` (never resets). The period follows the document date, which is a `date` in the legal entity's calendar, so no time zone is involved.
- **`allocate_number()`** is one statement, `INSERT ... ON CONFLICT DO UPDATE SET next_number = next_number + 1 RETURNING next_number - 1`, run by the definer **inside the posting transaction**. The counter row stays locked until that transaction ends: a commit keeps the number, a rollback gives it back. It also creates the series row on first use without a race.
- **`number_allocation`**: one append-only row per number, with the document it went to. The document table carries `(legal_entity_id, doc_type, period_key, number)` with a UNIQUE constraint and a foreign key to the allocation.
- **Voiding**: a number is never deleted or reused. A void is a second append-only row in `number_void` (reason required, actor, time) with a foreign key to the allocation; voiding twice, or voiding a number that was never allocated, fails (measured: `23505` and `23503`). Allocations and voids both go into the hash chain (decision 4).
- **Drafts have no number.** The number is taken at posting, as the last step before the insert, so the counter row is locked for as short a time as possible. Work after the allocation in the same transaction (audit, outbox) holds the lock and directly lowers the throughput of that series (measured below).
- Numbers follow allocation order, not document date: a back-dated voucher gets the next number. Whether accountants expect date order inside a period is a question for the customer interviews; if they do, it is a reporting sort, not a renumbering.

Measured (each run: 1,000 transactions against one series; "gaps" is `max(number) - count(*)`):

| Run | Clients x transactions | Result | Throughput | Latency p50 / p95 |
|---|---|---|---|---|
| Allocation only | 1,000 x 1 (all at once) | 1..1000, 0 gaps, 0 duplicates | 382 to 490 tps | 1.15 to 1.39 s / 1.96 to 2.50 s |
| Allocation only | 50 x 20 | 1..1000, 0 gaps | 923 to 1,015 tps | 29 to 31 ms / 123 to 153 ms |
| Allocation, 1 in 10 rolled back | 50 x 20 | 886 and 899 committed, numbered 1..886 and 1..899, 0 gaps | 833 to 893 tps | 32 to 35 ms / 148 to 167 ms |
| Full posting (2 lines, period check, chain queue) | 1 x 1,000 | 1..1000, 0 gaps | 422 to 765 tps | 1.3 to 2.3 ms / 1.7 to 3.5 ms |
| Full posting | **1,000 x 1 (all at once)** | **1..1000, 0 gaps, every number on an entry** | 48 tps | 14.3 to 14.6 s / 20.4 to 20.8 s |
| Full posting | 50 x 20 | 1..1000, 0 gaps | 549 to 569 tps | 49 to 54 ms / 262 to 274 ms |
| Full posting + 5 ms more work after it in the same transaction | 50 x 20 | 1..1000, 0 gaps | 122 to 126 tps | 206 to 208 ms / 1.05 to 1.11 s |
| Rejected: `nextval()` sequence, 1 in 10 rolled back | 50 x 20 | 898 and 904 committed, **96 and 102 gaps** | 18,674 to 19,317 tps | 2.1 ms / 4.8 to 6.3 ms |
| Rejected: `SELECT max(n) + 1` then insert | 50 x 20 | **970 and 972 of 1,000 attempts collided** on the unique key | n/a | n/a |

Reading the numbers:

- The Phase 0b exit criterion "1,000 parallel posts yield gapless numbers 1..1000" holds: in the 1,000-client posting run every number from 1 to 1000 was allocated exactly once and belongs to an entry.
- One series is a serialization point by design: about 550 postings per second with 50 concurrent writers, far above what one legal entity's voucher series needs. With 1,000 simultaneous backends throughput drops to 48 tps. Sampling `pg_stat_activity` during that run showed about 440 backends waiting on `Lock:transactionid` (the queue behind the counter row, as designed) and 200 to 420 on `LWLock:LockManager`. Our reading (not proven further) is lock manager contention from 1,000 backends each touching more relations than the fast-path lock slots hold. The per-role connection pool (§3.3) keeps real concurrency far below 1,000, so this does not change the design. Dropping the currency foreign key and switching the period guard made no difference (46 to 51 tps), which ruled out both as the cause.
- Lock hold time is what matters: 5 ms of extra work after the allocation cut throughput from about 550 to about 125 tps. Hence "allocate last" and a short tail after it.

**Electronic invoice numbers are not Crove numbers.** Under Decree 123/2020/ND-CP Article 10(3), an e-invoice number is an Arabic numeral of at most 8 digits, starting from 1 on 1 January (or the day the invoice series starts being used) and ending on 31 December, and invoices are numbered consecutively within one invoice template and series symbol [1] [2]. Issuing goes through a provider (Phase 2b), which assigns that number at signing. Crove stores it, with `UNIQUE (org_id, legal_entity_id, template_symbol, series_symbol, invoice_number)`, and never allocates it from `number_series`. We did not check whether Decree 70/2025/ND-CP changed Article 10(3); the accounting legal work (§13 Phase 2a) confirms it before Finance GA. Crove's own series are for accounting vouchers, whose number the Law on Accounting requires on every voucher (Law 88/2015/QH13, Article 16(1)(a): "name and number of the voucher") without prescribing a format or reset period [3]; that is why the reset policy is per series and not fixed.

### 3. Period close and reopen

- **`accounting_period`** per `(org_id, legal_entity_id, period_start)`, with `period_end` and `status open | closed`. Boundaries never change once created. Every change is an append-only `period_event` (close or reopen, actor, reason), and every event goes into the hash chain.
- **The guard is a `BEFORE INSERT` trigger on `journal_entry`**, so it holds for every role and every path, superusers included (measured: a direct superuser `INSERT` dated in a closed period fails with `PERIOD_CLOSED`, SQLSTATE 55000). It reads the period with `FOR SHARE`. `close_period()` locks the same row `FOR UPDATE`, so a close waits for postings in flight into that period, and a posting that starts while a close is in flight waits and then sees `closed`.
- **A refused posting leaves no number behind**: the allocation rolls back with it (measured: series S3 stayed at 1 after a refused back-dated post).
- **Close in order, reopen newest first.** A period can be closed only when every earlier period is closed (`EARLIER_PERIOD_OPEN`), and only the latest closed period can be reopened (`LATER_PERIOD_CLOSED`). Reopening is an R3 command (P11 fresh MFA), restricted to the chief accountant and owner, and needs a reason (`REASON_REQUIRED`).
- **Corrections to a closed period are new entries in an open period**: a reversal of a January entry is dated in October and posts normally (measured).
- `period_balance` stays as the plan has it (written only by the posting definer, reconciled nightly); the spike did not build it.
- A terminal "locked" state (after year-end finalization or a tax audit) is deferred to the customer interviews; it would be a status that `reopen_period()` refuses.
- **As built for #329** (`supabase/migrations/20261019200000_crove_finance_period_lock.sql`, months only):
  - Because months close in order and reopen newest first, the closed months are always one range. They are stored as one `period_lock` row per org (`locked_from`, `locked_through`), not one `accounting_period` row per month.
  - Dates before `locked_from` are refused too: an entry there would change the opening balances of the closed months.
  - The guard, `FOR SHARE` and `FOR UPDATE` are as above. The first lock and the first posting create the org's row, whichever comes first, so they meet on the same row.
  - The history is the audit rows of `finance.period.lock` and `finance.period.unlock` (actor, month, reason, and for unlock the R3 assurance), not a `period_event` table. The hash chain is not built yet.
  - Unlock is for owners only until a chief accountant role exists. The errors are `PERIOD_LOCKED`, `EARLIER_PERIOD_OPEN`, `LATER_PERIOD_LOCKED`, `PERIOD_ALREADY_LOCKED`, `PERIOD_NOT_LOCKED` and `PERIOD_NOT_ENDED` (a month locks once it has ended, in Vietnam time).

Measured races, each with one transaction held open for 2 s and the other starting 0.5 s later:

| Case | Guard | Outcome |
|---|---|---|
| A. Posting first, then close | `FOR SHARE` | Close waited 1.46 to 1.50 s, then closed; the entry committed before the close |
| B. Close first, then posting | `FOR SHARE` | Posting waited 1.19 to 1.45 s, then failed with `PERIOD_CLOSED` |
| C. Posting first, then close | plain read (no lock) | Close returned in 3.3 to 3.6 ms; **an entry was committed into the closed period** |
| D. Posting first, then close | shared advisory lock | Close waited 1.51 s; same outcome as A |
| E. Close first, then posting | shared advisory lock | Posting waited 1.45 s, then `PERIOD_CLOSED` |

Case C is the race the lock prevents. We chose `FOR SHARE` over the advisory-lock variant (D, E):
- both are correct under READ COMMITTED, and their throughput is the same (50 x 20 postings: 549 tps with `FOR SHARE`, 525 tps with advisory; 1,000 x 1: 48 and 41 tps);
- the advisory variant is correct only because each statement takes a new snapshot under READ COMMITTED. Under REPEATABLE READ it would read a stale status, while `FOR SHARE` raises a serialization failure there instead;
- `FOR SHARE` needs no lock key scheme.

The kernel runs commands at the default READ COMMITTED (no isolation level is set in `packages/kernel-runtime`, `packages/db` or `apps/kernel`).

### 4. Hash chain

- **One chain per `(org_id, legal_entity_id)`** over every ledger fact: posted entries (header and lines), number allocations, number voids, and period close and reopen events.
- **Appended asynchronously by a chainer, not inside the posting transaction.** The posting definer inserts a row into `chain_pending` in the same transaction. A worker job takes the chain head row `FOR UPDATE` (one chainer per legal entity), reads the visible pending rows in queue order, writes `chain_link` rows and deletes the pending rows. A pending row only becomes visible when its transaction commits, so a transaction that commits late is chained in a later run: no watermark and no lost fact.
- **Link format, `hash_version = 1`:** `fact_sha256 = sha256(canonical JSON of the fact)`, with amounts as fixed 4-decimal strings, and `link_sha256 = sha256(prev_link || fact_sha256 || int8send(chain_seq))`. The chain starts from `sha256('')`. Every link stores its `hash_version`, so a later canonical form can be introduced without rewriting old links.
- **The verifier recomputes every link from the facts as they are now.** It reports the first changed fact (`fact_changed`), a missing fact (`fact_missing`), a broken link, and any posted entry that has neither a link nor a pending row.
- **What the chain proves, and what it does not.** It shows that the facts have not changed since they were chained. Someone with superuser rights can rewrite the facts **and** recompute the whole chain. Tamper evidence against that comes only from the WORM fact stream in plan §4.10: the chain head of every batch goes to the locked bucket, and the nightly verifier compares the database chain with those anchors. The chain makes that comparison cheap: one hash per batch instead of every row.
- `created_xact_id` (#71) stays for its own job, sealing posted entries against new lines. The chainer does not order by it: transaction ids restart low in a new cluster after a logical dump and restore, so a watermark based on them could skip new facts. This is a reasoned risk, not a measured one.

Measured:

| What | Result |
|---|---|
| Chainer, one run over all pending facts of one legal entity | 10,888 facts in 280 ms; 16,901 facts in 404 ms (about 40,000 facts/s) |
| Verifier over the whole chain | 10,888 links in 2.79 s and 16,901 links in 0.20 s in two runs (plan-dependent; the unchained-entry check is an anti-join) |
| Rejected: chaining inside the posting transaction (50 x 20 postings) | 329 to 377 tps instead of 549 to 569, and it serializes **every** document type of the legal entity on the chain head, not just one series |
| Tamper test: as superuser, triggers disabled, raise one debit and one credit by 1 dong (the entry still balances), delete one void row | Verifier reported `fact_changed` at the entry's chain position and `fact_missing` at the void's; 0 problems before the tampering |

### 5. `source_revision`: idempotent posting and re-posting

- `journal_entry` gains `source_revision int NOT NULL DEFAULT 1` and `payload_sha256 bytea`, and `UNIQUE (org_id, source_type, source_id)` becomes `UNIQUE (org_id, source_type, source_id, source_revision)` (red-team S32). Entries already on `main` become revision 1.
- `payload_sha256` is the hash of the canonical posting request: legal entity, date, currency, document type, the entry it reverses, and the lines with amounts at 4 decimals.
- The posting definer first takes `pg_advisory_xact_lock` on a hash of `(org, source_type, source_id)`. Calls for the same source are therefore serialized, while calls for different sources are not (a hash collision only costs a wait). Then:
  - **Same revision, same payload: replay.** It returns the original entry id and allocates no number.
  - **Same revision, different payload:** `IDEMPOTENCY_CONFLICT` (409).
  - **New revision:** only `previous + 1` (`REVISION_OUT_OF_ORDER`), and only when the previous revision has been reversed (`SOURCE_STILL_POSTED`).
- **Reversal** is an entry with `source_type = 'reversal'`, `source_id` = the original entry, revision 1, and `reverses_id` = the original, with `UNIQUE (org_id, reverses_id)`. Reversing twice is a replay that returns the same reversal.

Measured:
- **Concurrent replay.** 50 clients posted the same source revision at the same moment: 1 entry and 1 number came out, and all 50 calls returned (p95 38 ms).
- **Single-session scenarios.**
  - The replay returned the original id, and the series still had 1 number.
  - A different payload was refused.
  - Revision 2 was refused before the reversal and accepted after it; revision 3 was refused as out of order.
  - Revision 1 plus its reversal net to 0.0000 on every account (642, 1331, 331), so the Phase 0b criterion "reversal nets to zero" holds.

### 6. Bank line keys

Every imported line gets a `dedupe_key`, with `UNIQUE (org_id, bank_account_id, dedupe_key)`:

1. **`ref:<bank_ref>`** when the source gives a transaction reference (bank APIs, most statement exports).
2. **`bal:<value_date>|<amount>|<running_balance>`** when the file has a running balance but no reference. Two identical fees on the same day have different balances after them, so both are kept, and an overlapping re-import matches them exactly.
3. **No key** when there is neither: within one file, identical lines are kept (each has its own position). On a later import, a line that matches an earlier import's date and amount is **ambiguous** and becomes a `finance.bank_line.unmatched` Inbox exception. It is never dropped or doubled silently.

The plan's S26 fallback `(bank_account_id, import_id, position, value date, amount, running balance)` stays as the line's identity inside its import. `import_id` and `position` cannot be part of the cross-import key, because they differ between two files that overlap.

Measured:

| Import | Inserted / duplicates / exceptions |
|---|---|
| Statement 1: two identical 11,000 VND SMS fees on one day plus one transfer, with balances | 3 / 0 / 0 |
| Statement 2: overlaps statement 1 completely, plus one new line | 1 / 3 / 0 |
| File without balances: two identical lines | 2 / 0 / 0 |
| The same file again | 0 / 0 / 2 |
| API lines with references, one reference sent twice | 2 / 1 / 0 |

**Known gap, found while writing this ADR and not covered by the prototype.** Within one day, `+X`, `-X`, `+X` produces two lines with the same date, amount and balance after them, so key 2 would drop the second one as a duplicate. Phase 2a adds the occurrence index of that tuple within its value date to key 2. When an import does not start at the beginning of a day, it routes repeated tuples to the Inbox instead of deduplicating them. A Phase 2a test must cover this case.

### 7. APIs this locks for Phase 2a

- `ctx.numbering.allocate({ legalEntityId, docType, documentDate, documentId })` returns `{ periodKey, number }`. It runs in the command's transaction through the definer, after the caller has checked the legal entity with `ctx_le_allowed`. `ctx.numbering.void({ legalEntityId, docType, periodKey, number, reason })` is an R2 command.
- `crove_finance.post_journal_entry` gains these parameters: `legal_entity_id`, `currency`, `doc_type`, `source_revision`, and `reverses_id`.
  - Org and author still come from the context, never from parameters.
  - Allocation, the period guard, the scale check, the balance check and the chain queue all happen inside it.
- `finance.period.close` (R2) and `finance.period.reopen` (R3, reason required) are commands. A trigger, not the commands, protects the ledger.
- Migrations follow the repo rules: idempotent, applied files never edited, functions pinned to `search_path = pg_catalog, pg_temp`, and definers owned by `crove_definer_tenant`.

## Considered options

| Topic | Chosen | Rejected, with the measured reason |
|---|---|---|
| Numbering | Counter row per series, allocated in the posting transaction | `nextval()`: 96 to 102 gaps per 1,000 with 10% rollbacks. `max()+1`: 970 to 972 collisions per 1,000. A pre-allocated pool or a cached sequence: gaps by construction |
| Period guard | `FOR SHARE` in a `BEFORE INSERT` trigger | No lock: an entry committed into a closed period (race C). Advisory lock: correct, same speed, but depends on READ COMMITTED |
| Hash chain | Asynchronous chainer from a pending queue | In the posting transaction: about 35% less throughput, and it serializes all document types per legal entity. Watermark on transaction ids: unsafe across dump and restore |
| Re-posting | `source_revision` + payload hash + per-source advisory lock | Keep `UNIQUE(source)`: re-posting after a reversal becomes impossible (S32) |
| FX rates | Direct quote | Inverse quote: 20,689 VND error on USD 1,000,000 |
| Amount precision | `numeric(20,4)` + a per-currency scale check | `numeric(20,4)` alone: silent rounding. Integer minor units (`bigint`): exact, but every currency needs its own scaling everywhere, and amounts above about 9.2 x 10^18 minor units overflow; the gain over a scale-checked numeric is small |

## Consequences

- Good: every Phase 0b ledger exit criterion except the reports is met in the prototype: balance, immutability (already on `main`), reversal nets to zero, and 1,000 parallel posts give 1..1000. The reports (TT133 B01/B02 matching an accountant's hand calculation) and the fast-check model test are not done; they move to issue #154.
- Good: the invariants live in triggers and definers, so they hold for every role, and the superuser case is covered by the WORM anchor.
- Bad: each series and each period row is a serialization point; long command transactions after posting lower a series' throughput (about 125 tps with 5 ms of tail work). Commands must keep the work after posting short.
- Bad: up to one chainer interval passes before a fact is chained. Together with the batch interval of the WORM stream (at most 5 minutes, §4.10), that is the window in which tampering is not yet anchored.
- Neutral: `created_xact_id` stays as the line seal and is not reused for chaining.

## Confirmation

The Phase 2a migrations carry over the spike's checks as DB tests.
- Invariant suite: gapless 1..N under 1,000 parallel posts with rollbacks, the period guard races A and B, a superuser insert into a closed period, chain tampering detected, and replay under concurrency.
- Ordinary DB tests: scale checks, revision rules, and the bank key cases, including the `+X -X +X` case.

## References

1. Decree 123/2020/ND-CP, Article 10(3), invoice number, as quoted by Thư Viện Pháp Luật: https://thuvienphapluat.vn/hoi-dap-phap-luat/so-hoa-don-co-toi-da-may-so-331499.html and LuatVietnam: https://luatvietnam.vn/thue-phi-le-phi/quy-cach-ghi-so-hoa-don-565-34365-article.html (secondary sources, checked 2026-10-15; confirm against the official text in the accounting legal work)
2. Thời báo Tài chính Việt Nam, "Số hóa đơn điện tử phải lập theo thứ tự liên tục từ nhỏ đến lớn" (General Department of Taxation guidance): https://thoibaotaichinhvietnam.vn/so-hoa-don-dien-tu-phai-lap-theo-thu-tu-lien-tuc-tu-nho-den-lon-119346.html
3. Law on Accounting 88/2015/QH13, Article 16 (content of accounting vouchers), text at https://hoatieu.vn/phap-luat/luat-ke-toan-so-88-2015-qh13-103755 (secondary source; Thư Viện Pháp Luật notes that one point of Article 16 was repealed by a 2024 law, not point 1(a) as far as we could see, to be confirmed)
4. ISO 4217 currency codes and minor units: https://www.iso.org/iso-4217-currency-codes.html
