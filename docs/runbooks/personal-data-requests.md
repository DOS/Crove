# Runbook: a person's request about their personal data

How an owner of an org answers a person who asks to see or to erase the data the org keeps about them, under the personal data protection law (Law 91/2025 and Decree 356/2025; issue #923, plan §7.9). The org is the controller and Ludy Cloud is its processor; the org answers the person, and Ludy gives it the tools. **The deadlines and the identity check below are to be confirmed by the lawyer (#62)** before the first external tenant.

## 1. Receive and log the request

- Note the date it arrived, who asked, through which channel, and what they asked: to see their data, to correct it, or to erase it.
- Check that the person is who they say they are before you send or erase anything, for example by replying to the address already on file, or by seeing an ID document that you do not keep. Never erase on the word of a third party.
- Answer within the legal deadline (to be confirmed by the lawyer, #62). If you cannot finish in time, tell the person why and when.

## 2. Find their data

1. Open **Cài đặt > Dữ liệu cá nhân** (owners and admins).
2. Search each value the person gave: their email address, their phone number (any spelling, with or without +84), and their tax code or national ID. Each search lists every row of the org that holds the value, where it is stored, and what an erasure would do with it.
3. **Tải JSON** downloads the rows found. Send the file to the person through a channel that only they can open. It holds their data and nobody else's, but check it before sending.
4. **Notes and to-dos** (#1678): the search also looks inside their text, for the whole address or the digits however they are spaced. A shared note that holds the value is listed with its text. Members' private notes and to-dos are only counted, per author ("2 ghi chú riêng của 1 thành viên"), never shown, not even your own: only their author reads them. Only owners see these counts, and every search is recorded in the activity log (who, the kind of value and the counts, never the value). Before an erasure, an owner clicks **Báo cho các tác giả** under the counts: each author gets a notification saying how many of their items mention a person who asked to be erased (never which items or who the person is), even if they turned notifications off. The audit log records which items the notice named, by id.
5. **A member asking for their own notes and to-dos** (#1678): they take them themselves at any time. On **Ghi chú**, **Tải về Markdown** or **Tải về JSON** saves every note they wrote, private or shared, archived or in the trash, with its links, and every to-do of theirs. Nobody else can download another member's items, not even an owner.

The search covers the columns listed in `packages/kernel/src/personal-data.ts`. An invariant test keeps that list complete for columns whose name looks like personal data (emails, phones, addresses, tax codes, names of people, recipients). It also searches free text for the value anywhere inside it (#1948, #1961): activity lines, task titles, descriptions and comments, journal entry descriptions and journal line memos, the reasons written on phiếu thu, phiếu chi and journal vouchers, and imported bank statement lines. A phone number is found however it is spelled, but never inside a longer number. See section 5 for what it does not search.

## 3. Erase on request

1. Search the value as above. Check that the rows really are the person's: a shared address such as `ketoan@` may belong to someone else as well.
2. If members' private notes or to-dos mention the value, send the notice first (section 2, step 4) and give the authors time to read it and copy out what they need without the person's details: at least one working day, and always inside the legal deadline (to be confirmed by the lawyer, #62). The erasure deletes only the private items a notice named, unchanged since, once the notice's notification reached their author at least 24 hours before (the erasure enforces the wait; the worker sends the notification within seconds).
3. Click **Xóa dữ liệu của người này**, confirm, and enter a fresh second factor. Only owners can do this, and it cannot be undone.
4. Read the result. It lists what was erased and what was kept, and why:
   - **Erased:**
     - the email, phone and address of each party the value matches;
     - the sender of forwarded mails;
     - the recipient of mails Ludy sent;
     - the org's contact email;
     - the address in Social report schedules (a schedule left with nobody to mail is deleted);
     - every mention of the value in shared notes: "[đã xóa]" takes its place in the title and body, and a tag that holds it goes; the note stays (#1678);
     - the private notes and to-dos that mention the value and that a notice named, deleted whole without anyone reading them (`crove_notes.note`, `crove_notes.todo`);
     - the value wherever an activity line, or a task's title or description, quotes it: it is replaced by "[đã xóa]" inside the text, and the line or the task itself stays (#1948, #1961). A number of 8 or 9 digits (an old ID card number) is not replaced in activity lines or tasks, since it may as well be an amount or a voucher number there: the result lists them with that reason, for you to check.

     A party that no recorded invoice, voucher or journal line names also loses its tax code, and its name becomes "Đã xóa theo yêu cầu".
   - **Kept by law** (Accounting Law 88/2015, Art. 41: at least 10 years):
     - the name and tax code of a party on recorded invoices, vouchers or journal lines;
     - the name and tax code of a legal entity the org keeps books for (**Cài đặt > Pháp nhân**): a client company, a branch, or a household business, whose 12-digit code is its owner's national ID number (#1312). The org's default entity is the org itself and is reported as the org's own. The org purge keeps every entity until the lawyer decides otherwise (#1315);
     - the payer or payee named on a phiếu thu or phiếu chi;
     - the description of a journal entry, the memo of a journal line and the reason written on a phiếu thu, phiếu chi or journal voucher that quotes the value (#1948, #1961);
     - an imported bank statement line that quotes the value, as the bank wrote it (#1961);
     - the tax portal's invoice lists;
     - the original files of posted invoices that name the party (`crove_kernel.file`), with the date their retention hold runs to: erasure clears data in the database only and never deletes a stored file (#1009, `docs/runbooks/evidence-holds.md`).
   - **Kept in a record:**
     - Invites: the retention purge deletes them 90 days after they are accepted, revoked or expired (`docs/runbooks/org-offboarding.md`).
     - A client's review feedback on Social posts.
     - A comment on a task that quotes the value: comments are an append-only record of the work (#1948). They go with the org.
   - **Kept until the next notice:** private notes and to-dos that mention the value but that no notice named, because they were written or changed after it. Send the notice again, wait, and erase again.
   - **Kept as a hash:** a mail address the org stopped mailing (bounce, unsubscribe) stays suppressed through its keyed hash, so the person is not mailed again.
5. Tell the person what was erased and what the law requires the org to keep, with the reason the result gives.

The audit log records that an erasure ran, by whom, and how many rows of each column it changed. It never records the value or the rows.

## 4. Correct on request

A correction is an ordinary edit: change the party on its page (Nhà cung cấp or Khách hàng). An invoice already recorded stays as issued. A wrong invoice is corrected by its issuer with a replacement or an adjustment invoice, which Ludy links to the original (#916).

## 5. What the tools do not reach yet

Answer these by hand, or tell the person they are kept, until a later issue covers them:

- **Free text in Social:** posts and comments (Social is paused, decision D5). Search them in the app, and edit what can be edited.
- **Notes and to-dos:** covered (section 2, step 4, and section 3) for the whole address or the digits; a name or a postal address in a note is not searched, so ask the authors.
- **Notifications written before #1977:** an approval-waiting, unreadable-file or rerouted-task notice written before then keeps a copy of its proposal's or task's title, or its file's name, in the notice row. The notice now shows the subject's current title, so a redacted task reads redacted, but the old copy stays in the row, and the erasure neither changes nor lists it (each member's notices are readable only by that member). Whether to drop those copies is an owner decision (#1958); until then, tell the person such copies may remain in old notices, which members can see only in their own notification list when the subject is gone.
- **Stored files:** invoice PDFs and XML, uploaded images, and the extraction results read from them. They are accounting documents and are kept with the books; the original file of a posted invoice is held in the bucket for the legal period (`docs/runbooks/evidence-holds.md`), and the erasure result counts the ones that name the person's party.
- **Backups and archives:** the 7-day point-in-time recovery, the WORM archive of the books (`docs/runbooks/worm-archive.md`) and offboarding exports. A restore brings erased data back, so after one, run the erasures recorded in the audit log again. Crypto-shredding of immutable stores (ADR-0017) is planned.
- **The person's own Ludy account:** if they are a user of Ludy, their sign-in account lives with the identity provider (DOS ID or Supabase Auth), not in the org. They delete it there.
