# Runbook: a person's request about their personal data

How an owner of an org answers a person who asks to see or to erase the data the org keeps about them, under the personal data protection law (Law 91/2025 and Decree 356/2025; issue #923, plan §7.9). The org is the controller and Crove Cloud is its processor; the org answers the person, and Crove gives it the tools. **The deadlines and the identity check below are to be confirmed by the lawyer (#62)** before the first external tenant.

## 1. Receive and log the request

- Note the date it arrived, who asked, through which channel, and what they asked: to see their data, to correct it, or to erase it.
- Check that the person is who they say they are before you send or erase anything, for example by replying to the address already on file, or by seeing an ID document that you do not keep. Never erase on the word of a third party.
- Answer within the legal deadline (to be confirmed by the lawyer, #62). If you cannot finish in time, tell the person why and when.

## 2. Find their data

1. Open **Cài đặt > Dữ liệu cá nhân** (owners and admins).
2. Search each value the person gave: their email address, their phone number (any spelling, with or without +84), and their tax code or national ID. Each search lists every row of the org that holds the value, where it is stored, and what an erasure would do with it.
3. **Tải JSON** downloads the rows found. Send the file to the person through a channel that only they can open. It holds their data and nobody else's, but check it before sending.

The search covers the columns listed in `packages/kernel/src/personal-data.ts`. An invariant test keeps that list complete for columns whose name looks like personal data (emails, phones, addresses, tax codes, names of people, recipients). See section 5 for what it does not search.

## 3. Erase on request

1. Search the value as above. Check that the rows really are the person's: a shared address such as `ketoan@` may belong to someone else as well.
2. Click **Xóa dữ liệu của người này**, confirm, and enter a fresh second factor. Only owners can do this, and it cannot be undone.
3. Read the result. It lists what was erased and what was kept, and why:
   - **Erased:**
     - the email, phone and address of each party the value matches;
     - the sender of forwarded mails;
     - the recipient of mails Crove sent;
     - the org's contact email;
     - the address in Social report schedules (a schedule left with nobody to mail is deleted).

     A party that no recorded invoice, voucher or journal line names also loses its tax code, and its name becomes "Đã xóa theo yêu cầu".
   - **Kept by law** (Accounting Law 88/2015, Art. 41: at least 10 years):
     - the name and tax code of a party on recorded invoices, vouchers or journal lines;
     - the payer or payee named on a phiếu thu or phiếu chi;
     - the tax portal's invoice lists.
   - **Kept in a record:**
     - Invites: the retention purge deletes them 90 days after they are accepted, revoked or expired (`docs/runbooks/org-offboarding.md`).
     - A client's review feedback on Social posts.
   - **Kept as a hash:** a mail address the org stopped mailing (bounce, unsubscribe) stays suppressed through its keyed hash, so the person is not mailed again.
4. Tell the person what was erased and what the law requires the org to keep, with the reason the result gives.

The audit log records that an erasure ran, by whom, and how many rows of each column it changed. It never records the value or the rows.

## 4. Correct on request

A correction is an ordinary edit: change the party on its page (Nhà cung cấp or Khách hàng). An invoice already recorded stays as issued. A wrong invoice is corrected by its issuer with a replacement or an adjustment invoice, which Crove links to the original (#916).

## 5. What the tools do not reach yet

Answer these by hand, or tell the person they are kept, until a later issue covers them:

- **Free text:** activity lines, task comments, journal descriptions, voucher reasons, Social posts and comments. Search them in the app, and edit what can be edited.
- **Stored files:** invoice PDFs and XML, uploaded images, and the extraction results read from them. They are accounting documents and are kept with the books.
- **Backups and archives:** the 7-day point-in-time recovery, the WORM archive of the books (`docs/runbooks/worm-archive.md`) and offboarding exports. A restore brings erased data back, so after one, run the erasures recorded in the audit log again. Crypto-shredding of immutable stores (ADR-0017) is planned.
- **The person's own Crove account:** if they are a user of Crove, their sign-in account lives with the identity provider (DOS ID or Supabase Auth), not in the org. They delete it there.
