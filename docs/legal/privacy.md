# Crove Privacy Notice (English working copy)

> **DRAFT, NOT REVIEWED BY A LAWYER.** English courtesy copy of [privacy.vi.md](privacy.vi.md) for review; the Vietnamese text prevails. Questions for the lawyer: [README.md](README.md).

Version [number], effective [date]. Under the Law on Personal Data Protection (Law 91/2025/QH15) and Decree 356/2025/NĐ-CP.

1. **Our roles.**
   - **Account data** (members' names, emails, sign-in history, devices): the Operator is the controller.
   - **Data in an organization's books** (documents, invoices, bank statements and entries, which may hold personal data of sellers, buyers, staff or household business owners): the organization, for example an accounting firm, decides the purpose. The Operator is the processor and acts only on its instructions.
2. **What we collect.**
   - Account: name, email, a hashed password only, second factors.
   - Activity: sign-in times, IP address, browser, and the audit trail of who approved what and when.
   - Documents and books: e-invoices, PDFs, photos, statements, entries, tax codes, partners' names and addresses.
   - Support messages.
   - Outside calendars: when a member connects their own Google calendar, the address of the Google account and the busy time ranges (start and end), never titles or attendees. Every member of the organization sees these busy ranges (without content), and they are part of the organization's data export. When a member disconnects, the busy ranges are deleted at once, and within about 15 minutes the grant is revoked at Google and the address deleted. The grant is not revoked, and the member can remove the app's access in their Google account, when Google cannot be reached for 3 days, when the stored token can no longer be opened, when the connection had already expired, or when the organization is closed. While an organization is being offboarded its calendar connections are not processed at all: a sealed token and the account address stay until the organization's data is purged, and the grant is not revoked then.

   Some financial data may be sensitive personal data, so all documents and books get the protection of sensitive data. [Lawyer to confirm, question 2.]
3. **Purposes.**
   - Providing the service.
   - Security: authentication, two-factor authentication, detecting unusual access, the audit trail.
   - Support and operations: system email, error monitoring.
   - Legal obligations.

   We do not sell personal data, use documents or books for advertising, or use them to train AI models.
4. **AI.**
   - XML e-invoices are read without AI.
   - PDFs and photos are sent to [AI provider, country] to be read. The provider may use the data only to return the result, and keeps none for training. [Per the D9 provider contract.]
   - Results are checked by rules and approved by a person.
5. **Processors.**
   - Server host, file storage, email provider and AI provider, each with [country].
   - A transfer impact assessment is made when data leaves Vietnam. [Lawyer to confirm, question 4.]
6. **Retention.**
   - An organization's data is kept while it uses Crove. After it closes, it has [30] days to export; the data is then deleted, and backups follow their lifecycle of at most [n] days.
   - Recipient addresses and subjects in the mail log are dropped after 13 months; only a hash stays, to keep honouring unsubscribes.
   - Audit records stay with the organization's books.
   - The organization keeps accounting records for the legal period from its own export.
7. **Security.**
   - Per-organization isolation in the database.
   - Encrypted transport.
   - Two-factor authentication for approvals.
   - An append-only audit trail.
   - Daily backups with restore drills.
   - Sign-in attempt limits.

   A personal data breach is notified to the authority and to your organization within 72 hours of discovery.
8. **Your rights.** You may:
   - be informed about the processing;
   - consent, or withdraw consent;
   - access and correct your data;
   - ask for deletion;
   - restrict or object to processing;
   - receive a copy;
   - complain and seek compensation.

   For account data, write to [email]. For data in an organization's books, contact that organization first; we help it act on your request. Legal retention duties, such as for accounting records, limit some rights.
9. **Changes.** At least [30] days' notice in the app and by email before processing is widened.
10. **Contact.** Data protection contact: [name or team], [email], [address].
