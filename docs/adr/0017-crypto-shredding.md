# 0017. Personal data in rows that cannot change: crypto-shredding with a per-subject key

- Status: Proposed (2026-10-30), for the coordinator's review before the build ([#1949](https://github.com/DOS/Ludy/issues/1949))
- Date: 2026-10-30
- Deciders: coordinator (design); owner (JOY) for the open questions in section 9
- Scope: the crypto-shredding part of ADR-0017. The plan lists ADR-0017 as "Data classification, PII, crypto-shredding, deletion map, PDPL" (plan §16). The data classes are plan §5.2 (#1599), the deletion map is plan §7.9, and the personal-data registry, finder and erase are #923 (`packages/kernel/src/personal-data.ts`, [personal-data-requests.md](../runbooks/personal-data-requests.md)). This file records the decision for the values those cannot reach.
- Builds on:
  - plan §4.10 ("Immutable stores that need PII use crypto-shredding: a per-subject key in `subject_key`"), §7.9 and red-team S27;
  - ADR-0025 (the credential vault);
  - the WORM fact stream (#891, [worm-archive.md](../runbooks/worm-archive.md));
  - the audit markers (#1626) and activity summaries without personal values (#1634, #1826, #1839);
  - the keyed input hash (#1732).

## Context and problem statement

A person may ask an org to erase the data it keeps about them (Law 91/2025, Decree 356/2025). The erase of #923 clears values in mutable rows. Some rows cannot change:

- `make_append_only` refuses UPDATE and DELETE for every role;
- column guards freeze a row once it is decided;
- the WORM stream anchors the SHA-256 of every audit event and journal entry, so a rewritten row fails the nightly verifier.

A value written into such a row stays as long as the row does. For the books that is the law's intent (Accounting Law 88/2015, Art. 41). For anything else it is a gap the erase cannot close.

Crypto-shredding closes it: the value is stored encrypted under a key that belongs to one person (a subject), and erasing that person deletes the key. The row does not change, its hash still verifies, and the value can no longer be read.

What has to be decided:

1. Which values are encrypted.
2. Where the subject keys live and how they are sealed.
3. Who decrypts, and for what.
4. What the WORM verifier sees.
5. How keys rotate, and what a backup restore does.
6. What happens to plaintext already written.

## Decision drivers

- An erasure the person asked for must reach every copy the org controls, or the answer must say plainly what stays and why.
- The books stay as they are: the law keeps them, and their WORM proof must keep verifying.
- No rewrite of existing rows without the owner. No weakening of an append-only or WORM invariant.
- One write path; tenancy and the sealed context unchanged. A key is never readable by a login role.
- The cheapest fix comes first: a value that does not need to be in an immutable row is kept out, not encrypted (as #1626 and #1634 did).

## What is in rows that cannot change today

An inventory of `origin/main` at a6488d54. Every row of the table below is either append-only, frozen by a guard, or WORM-anchored. Each line cites its source in the review notes of #1949.

| Group | Values | Today |
|---|---|---|
| **A. The books, kept by law** | `journal_entry.description`, `journal_line.memo` (an invoice's or a voucher's party name); `cash_voucher.person_name`, `.description`; `journal_voucher.description`; `bank_line.description`; `portal_invoice_row.seller_name`, `.seller_tax_code`; `portal_invoice_list.buyer_tax_code`, `.skipped`; `number_void.reason`; `purchase_document_void.reason`; `input_vat_check.note`; `purchase_line.description`; booked proposals (the approval trail) and the original files behind posted entries | Kept at least 10 years; the erase reports them as kept by law |
| **B. Personal, not kept by law, still written today** | `crove_social.review_feedback.reviewer_name` and `.body` (a client's person and words; `keep_record` in #923); `crove_kernel.outbox_event.payload` of `kernel.agent.proposal_requested` (the agent's draft with a party's name, tax code, address, email and phone; copied as plain JSON to the outbox archive, locked 400 days); `task_comment.body` and `crove_social.post_approval.comment` and `.snapshot` (members' free text; no purge, not even the org purge); free-text reasons in `audit_event.detail` (a member's disable reason, a publish hold reason); the payload, request, result and title of proposals that never reached the books, and `extraction.result` (frozen once decided, deleted only by the org purge) | No erase reaches them |
| **C. Legacy only** | `audit_event.detail` before #1626 (2026-10-27): party name, tax code, address, legal entity name and code, org address and tax code, WORM-hashed; `activity.summary` before #1826 and #1839 (2026-10-29): party, booking visitor and entity names, member and invitee emails, titles, reasons (append-only by grants only, not WORM-anchored); system `task_comment` rows that held a proposal title before #1839 (append-only) | Plaintext; no new rows of this kind |
| **D. Already handled** | `member_invite.email` (purged 90 days after the invite ends); `mail_suppression`, `mail_message.to_hash` (keyed hashes); `security_event` (an id, pruned after 30 days); `mail_event.detail` (bounce types only) | Nothing to do |

## Decision

### 1. Which values are encrypted

A personal value goes into a row that cannot change only when the row needs it. The order of remedies:

1. **Keep it out.** Ids and markers instead of values, as #1626 did for audit facts and #1634 for activity summaries.
2. **Encrypt it under the subject's key**, when the row must hold it, stay immutable, and is not kept by law.
3. **Keep it**, when the law requires it (group A). The erase result says so, as it does today.

Applied to group B:

| Values | Remedy | Subject |
|---|---|---|
| `outbox_event.payload` of `kernel.agent.proposal_requested` | **Keep it out.** The event carries the proposal id only, like every other event. The outbox archive keeps payloads as plain JSON for 400 days under Object Lock, so nothing personal may enter a payload. A test asks every emitted payload to hold ids and codes only. | none |
| `review_feedback.reviewer_name`, `.body` | **Encrypt.** | `review_link:<id>`: the client who answered one review link. The link names no person, so this subject is erased from the post's review panel by an owner or admin. The panel then shows "Đã xóa theo yêu cầu" in their place. |
| Free-text reasons in `audit_event.detail` that are not about the books (the operator's note on a member's status, `kernel.user.status_note`, and the like) | **Keep it out** where the reason is not needed to prove the act. A status note keeps a code in the audit fact; its text goes to a mutable row. Otherwise **encrypt** under the member's subject. | `member:<user_id>` |
| `task_comment.body`, `post_approval.comment` and `.snapshot` | **Not decided here**: open question Q1 (section 9). | (`member:<user_id>` if Q1 says yes) |
| Proposals and extractions that never reached the books | **Not decided here**: open question Q2. | (`contact:<hash>` of the party's email, phone or tax code if Q2 says yes) |

Group A is never encrypted for shredding: the books stay readable for their legal period. Group C is section 6. Group D needs nothing.

### 2. Subjects and their keys

A subject is one person, as the org knows them. Its row in `crove_kernel.subject_key`:

| Column | Holds |
|---|---|
| `org_id`, `id` | The tenant key, `PRIMARY KEY (org_id, id)`, RLS through `apply_tenant_rls` |
| `ref` | How the erase finds the subject, unique per org. One of: `contact:<hmac>`, the keyed hash of a normalized email or digits (the same normalization as the finder's probe, keyed like `crove_kernel.mail_address_hash`, whose key no login role reads; never the value); `member:<user_id>`; `review_link:<link_id>` |
| `key_id`, `wrapped_key` | The subject's data key, wrapped (section 3) |
| `created_at` | |

- **No login role reads or writes it.** No grant to `crove_tenant`, `crove_app` or `crove_worker`. It is reached only through `SECURITY DEFINER` functions, with `search_path = pg_catalog, pg_temp`, EXECUTE granted to the runtime roles and checked against the sealed context:
  - `subject_key_ensure(ref, key_id, wrapped_key)` returns the subject's id, creating the row when it is missing;
  - `subject_key_wrapped(ids[])` returns `key_id` and `wrapped_key` of the context org's subjects only;
  - `subject_key_shred(refs[])` deletes them and returns how many. It is called only by the erase commands, which are R3 for owners with a fresh second factor, as the #923 erase is.
- **Mutable on purpose.** Deleting a row is the shredding. Re-wrapping one is the key rotation. Neither touches the rows that hold sealed values.
- **The org purge** deletes the org's subject keys with the org.

### 3. Sealing (the credential vault pattern, ADR-0025)

- **The data key.** Each subject has its own random 32-byte data key. It is wrapped with AES-256-GCM under the deployment key the credential vault already uses: `CREDENTIAL_KEY`, with `CREDENTIAL_KEY_PREVIOUS` during a rotation. In Ludy Cloud that key is later wrapped by KMS.
- **Bound to its subject.** The wrap's AAD binds the domain `crove.subject.v1`, the org, the subject id and the key id. A wrapped key moved to another org's or subject's row does not open.
- **The deployment key stays out of the database.** A dump, a backup or a replica holds wrapped keys only. The API and the worker hold the deployment key, as for credentials.
- **The value.**
  - It is encrypted with AES-256-GCM under the subject's data key. The AAD binds the org, the subject id and the value's place (`<schema>.<table>.<column>`, or `audit:<command>:<fact>`).
  - It is stored as text: `crove:s1:<subject_id>:<base64url(iv | tag | ciphertext)>`. Inside `audit_event.detail` this text is the fact's value.
  - A sealed column keeps its type (text). A sealed value fits a CHECK on length only after widening that check, which the build does in its migration.
- **Code.** `@crove/kernel-runtime` gets a `SubjectVault` next to `CredentialVault`, with the same envelope code, and a `ctx.seal(subjectRef, place, value)` in commands. Sealing happens in the command, inside its transaction, before the insert. No other path writes these columns.

### 4. Who decrypts, and for what

- **Only query handlers** that already show the value to a member open it, for the same members as today:
  - the post's review panel for those who read the post;
  - the audit log for owners and admins;
  - the data request JSON of #923 for owners and admins.

  They call `subject_key_wrapped` and unwrap in the API process.
- **Not the worker, an agent, an export of the books or a log line.** An org export (#212) writes the sealed text as it is, plus a note that it needs the org's keys. A shredded value is not part of an export.
- **A value whose key is gone** reads as `{ "erased": true }` in an answer, and the screens show "Đã xóa theo yêu cầu". A value that does not open (a damaged envelope, a key from another org) fails the query loudly, like a credential that does not open.

### 5. What the WORM verifier sees

- **Hashes of the stored ciphertext.** The archive batches hold the SHA-256 of each audit event's columns as stored, `detail` included, and never the row's content. A sealed fact is hashed as its ciphertext.
- **Shredding changes nothing the verifier reads.** Deleting the key leaves the row byte for byte as it was, so every batch keeps verifying, before and after an erasure.
- **`subject_key` is not anchored.** Its rows are meant to be deleted.
- **The outbox archive stores payloads**, so it must never receive a sealed or personal value. Section 1 keeps it out, and a test holds every payload to ids and codes.

### 6. Rows already written in plaintext (group C)

From now on only. Nothing already written is rewritten by this decision. What stays is documented as residual, and the erase result says it:

- **`audit_event.detail` before #1626.**
  - It is append-only and WORM-hashed. Rewriting it would need a trigger bypass by the database owner and a new hash version or tombstone scheme for the verifier.
  - It stays.
  - The erase result adds: "Nhật ký trước ngày 2026-10-27 có thể còn giá trị này; nhật ký là bằng chứng không sửa được."
- **`activity.summary` before #1826 and #1839.**
  - It is append-only by grants only and not WORM-anchored, so a forward migration could replace those summaries with neutral text, as earlier backfills did.
  - That rewrites existing data: open question Q3.
- **System `task_comment` rows that held a proposal title before #1839.**
  - They are append-only, so they stay.
  - The title names a party already in the books (group A).
- **Outbox archive objects written before the fix of section 1.**
  - They hold agent drafts under Object Lock until their 400 days end, then the bucket's lifecycle rule removes them.
  - They stay until then.

### 7. Rotation

- **The deployment key.**
  - It rotates as [credential-key.md](../runbooks/credential-key.md) describes: set the new key, keep the old one in `CREDENTIAL_KEY_PREVIOUS`, and let the worker's reseal pass re-wrap.
  - The pass gains `subject_key`: up to 200 rows a pass, each unwrapped with the previous key and wrapped with the new one, through a definer. No sealed value changes.
  - The log line counts subject keys apart.
- **A subject's data key never rotates.** Re-encrypting its values would rewrite immutable rows. A data key believed exposed is shredded, the same as an erasure, and the org is told which values it covered.
- **Losing the deployment key** makes every sealed value unreadable, as it makes every channel token unusable. The runbook says so and asks to back the key up apart from the database.

### 8. Backups and restores

- **A point-in-time restore brings deleted keys back**, and with them the values. The runbook already asks to run again the erasures recorded since the restore point.
- **The audit rows of those erasures roll back too**, so the erase also writes its refs to the archive store as `shred/v1/<org>/<id>.json`. Those refs are keyed hashes and ids, never a value. They are written once under the archive's Object Lock.
- **After a restore**, `kernel-shred-replay` deletes every key whose ref the store lists. It runs on demand from the restore runbook, and at worker start when `ARCHIVE_STORE` is set.

### 9. Open questions (not decided here)

- **Q1. Members' own free text.**
  - Are task comments and post approval comments a member's personal data, to be erased on their request after they leave, or the org's work record?
  - Who decides: the lawyer (#62), through the owner.
  - Until then they stay as they are and the erase result lists them as kept.
- **Q2. Proposals and extractions that never reached the books.**
  - These are rejected, expired or failed proposals, frozen by their guards and kept until the org purge.
  - Should a retention purge delete them after a period? Or should their party values be sealed under the party's `contact:` subject from now on? Sealing reaches into the approval path, which reads the payload to execute it.
  - Who decides: the owner, on the coordinator's recommendation. The recommendation is a retention purge.
- **Q3. Legacy activity summaries.**
  - May a forward migration replace the summaries written before #1826 and #1839 with neutral text?
  - It rewrites existing rows, so it needs the owner's approval.

## Consequences

- **What an erasure reaches.** The erase of #923 deletes the person's `contact:` subject keys besides clearing mutable rows. A review link's reviewer can be erased from the post's review panel. The result lists what was shredded, what was cleared, and what stays and why.
- **New invariant tests** (the build, `apps/kernel/test/invariant/`):
  - no login role reads or writes `subject_key`, and only the definers above reach it, each only for the context's org;
  - after an erasure, no row of a sealed column opens for the erased subject, and no plaintext of the sealed value is left in any column of the database (a canary value, searched in every text and jsonb column);
  - the WORM verifier passes before and after the erasure;
  - a sealed value moved to another org or subject does not open.
- **A unit test** asks every column the build seals to be in a registry next to `PERSONAL_DATA_COLUMNS`, with handling `shred`. It also asks every outbox payload to hold no personal value.
- **Cost:**
  - one key lookup per subject in a query that shows sealed values, batched per page;
  - sealed columns lose search by value: no reviewer-name search exists today;
  - the deployment key becomes required wherever sealed values are written, not only when a channel provider is on.
- **Docs.** In the build PR: the runbooks personal-data-requests.md (section 5's "planned" line), credential-key.md (subject keys in the reseal pass) and the restore runbook (the shred replay); and the plan §4.10 and §7.9 lines.

## Build plan (#1949, after this ADR is accepted)

1. Migration and definers:
   - `subject_key` and its definers;
   - the reseal pass;
   - `SubjectVault` and `ctx.seal`;
   - the refs in the archive store and the replay.
2. Values:
   - the outbox draft out of `kernel.agent.proposal_requested`;
   - the status note's text out of the audit facts;
   - review feedback sealed, with its erase on the review panel.
3. The #923 erase deletes `contact:` and `member:` subject keys, and its result names what was shredded.
4. Tests: the invariant and unit tests above; the WORM verifier over sealed and shredded rows.
5. Q1 to Q3 follow when they are answered, each as its own issue.
