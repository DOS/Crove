# 0037. Private notes and to-dos: who may read them, and what offboarding, purge and personal-data requests do

- Status: Accepted (owner, 2026-10-28, decisions N-2 to N-6 as recommended; [notes.md](../plan/notes.md#6-owner-decisions), PR [#1659](https://github.com/DOS/Ludy/pull/1659)). Proposed 2026-10-27.
- Date: 2026-10-28
- Deciders: owner (JOY)
- Builds on: plan §4.5 (context and RLS), §4.10 (audit), §7.9 (PDPL, deletion map, offboarding); ADR-0029 (agents, tasks) and its write allowlist (#285); ADR-0031 (module enablement); the data classes (#1599) and audit markers (#1626); the personal-data registry (#923); the org purge (#1024) and export (#38)
- Issue: [#1649](https://github.com/DOS/Ludy/issues/1649), epic [#1648](https://github.com/DOS/Ludy/issues/1648)

## Context and problem statement

The notes module ([notes.md](../plan/notes.md)) gives every member private notes and a private to-do list, next to shared notes and the team's tasks. Until now every tenant row of Crove is either readable by every member of the org (tasks, parties, documents) or by one member and the system (`crove_social.saved_view`, `crove_kernel.notification`, whose restrictive policies let the worker's system context read all rows). A private note is the first row whose content is meant for one person only, and in an accounting firm it will hold facts about clients and their staff.

What has to be decided:
1. Who may read a private item: the author only, or also the org's owners and admins (always, or on demand).
2. How the database enforces it, given the sealed context, the system context the worker runs in, and agents.
3. What happens to private items when a member leaves, when the org is exported and purged, and when a person asks for their data under the PDPL (Law 91/2025, Decree 356/2025).

## Decision drivers

- "Riêng tư" must hold, or staff will not write anything real in it.
- An accounting firm must not lose what it needs to serve a client when an accountant leaves.
- The PDPL: a person whose data sits in a note can ask to see or erase it, within the legal deadline.
- One write path, tenancy, the sealed context and the agents' table allowlist stay as they are.
- Audit rows are anchored in the WORM stream (#891) and cannot be erased later, so no text may reach them.

## Options for who reads a private item

**A. The author only (recommended).** No owner, admin, member, viewer, agent or Crove staff tool reads a private item's text. The system context (the worker) does not read it either: it reaches private rows only through named definers that return ids, owners and dates, or delete by rule.
- Good: the word means what it says; nothing to explain; the strictest rule is the simplest to test.
- Bad: the firm cannot read what a member kept private, even when it needs it. Mitigated by shared notes by default where client knowledge lives (notes.md N-7), and by a warning to the owner when a member with private items is removed.

**B. The author, and owners and admins always.** Private means "hidden from colleagues".
- Good: the firm keeps control of everything written on its system.
- Bad: staff learn that "private" is read by the boss and stop using it or keep a paper notebook; an admin of a client org (a firm accountant) could read the client staff's notes and the other way round. Rejected.

**C. The author, and owners on demand (break-glass).** An owner runs an R3 command with a reason and a fresh second factor; the audit row records it and the author is notified.
- Good: control in a dispute or an investigation, with a trace.
- Bad: one more R3 path that reads text and needs its own invariant tests, for a case the firm can solve by asking the member; it still makes "private" conditional. Possible later if the owner asks for it; not v1.

**D. The author, plus the system context (the `saved_view` pattern).** People see only their own; the worker reads all.
- Good: no new definers; the precedent exists.
- Bad: every system command (export, a future job, a bug in one) can read private text; the org export would carry it to the owner unless the export code remembers to filter it. Rejected in favor of A's narrow definers.

**E. End-to-end encryption with a key only the author holds.**
- Good: not even the operator reads it.
- Bad: no server search, no reminders with dates computed server side, no recovery when a member loses the key, no AI later, and a large key-management design. Rejected for v1; "private" in A is private from the org, not from the deployment's operator, and the docs say so.

## Decision

### 1. Readers: option A

A private note or to-do is read and changed only in a context whose user is its author. A shared note is read by its author, by owners, admins and members of the org whose scope covers the whole org (`le_scope` `*`), and by the system context; other viewers and members limited to some legal entities read none in v1; agent contexts read and write nothing.

### 2. Enforcement in the database

- `apply_tenant_rls` on `crove_notes.note`, `todo` and `link`: tenant isolation, the grants, and the agent write guard (#285). The tables are not added to the guard's exempt list, so the allowlist and its invariant test stay unchanged.
- Restrictive policies beside `tenant_isolation`, written as `crove_social.saved_view`'s are (each context function wrapped in a subquery, so it runs once per statement):
  - `note`: read when `author_user_id = ctx_user_id()` (the author always reads their own note, whatever their role or scope), or `visibility = 'org'` and either the caller is a user whose base role is owner, admin or member and whose `le_scope` contains `*`, or the context is the system's (no user, no agent). Insert: `WITH CHECK (author_user_id = ctx_user_id())`, as `saved_view` does, so nobody writes a note for someone else. Update and delete: the author for their own notes; owners and admins also update and delete shared notes, and since a row policy cannot limit columns, the commands limit them to pin, archive and delete (and the personal-data erasure, section 5, to editing out a value); `author_user_id` never changes. The system context writes only through the definers below.
  - `todo`: every command `owner_user_id = ctx_user_id()`. No other context, the system's included.
  - `link`: read through an `EXISTS` over its note or to-do, which goes through that row's policies; written only by the parent's author or the to-do's owner, so neither the system context nor a reader of a shared note adds a link.
- The user in the policies is the sealed context's (`ctx_user_id()`, T11), so the app cannot claim another user, and the re-entry guard (T10) keeps one transaction in one context.
- `author_user_id` and `owner_user_id` are set by the command to the caller and checked by the policies' `WITH CHECK` against `ctx_user_id()`; they never change, so a writer cannot create a row "for" someone else or move one. They have no foreign key to `tenant_member` (unlike `saved_view`, which cascades), so a member's rows outlive their removal (section 4).
- Other code reaches private rows only through `SECURITY DEFINER` functions in `crove_notes`, each returning or touching the minimum and never returning text:
  - worker login only (EXECUTE and `session_user`):
    - `todo_reminders_claim(limit)`: one `UPDATE ... SET reminded_at = now() ... RETURNING` of due, unreminded to-dos, answering `org_id`, `id`, `owner_user_id`, `remind_at`;
    - `trash_empty(org, before)`: deletes items in the trash since before `before`, and never one there for less than 30 days (#1733): the floor stops it removing more, and `before` can only make it remove fewer; returns counts;
    - `member_items_purge(org, user)`: deletes a former member's private items when the user is still not a member and was not removed from the org (`kernel.member.remove` in the audit trail) in the last 30 days (#1733), returns counts;
    - `former_members_due(limit)`: for the nightly sweep (section 4), the former members with private items past that delay, ids only, each marked whether the audit trail records their removal;
  - callable in a user context, checked inside to be an owner of the context's org, or for `private_counts` an owner or admin (the members screen and the personal-data screen run as that user, not as the worker):
    - `private_counts()`: items per author, for the removal warning;
    - `private_matches(kind, value)`: per author, how many private items contain a value, for the finder (section 5), owners only (#1972; the finder also records every search, section 3);
    - `private_notice_items(kind, value)`: the ids and authors of the private items that contain a value, owner only, for the owner's notice to the authors (#1678), which records the ids in its audit row;
    - `private_erase(kind, value)`: deletes the private items that contain the value and that an earlier notice's audit row names at their current revision, once its author got that notice's notification at least 24 hours before (or sent it), owner only, from the R3 erasure command; it counts the others per author.
  The org purge (`crove_kernel.org_purge`) runs as the table owner, which row-level security does not bind here, and deletes `crove_notes` by org before the kernel's tasks.
- The invariant suite gets a test file of its own (`notes-private.db.test.ts`): a private row is invisible and unwritable to another member, an owner, an admin, a viewer, an entity-limited member, an agent context and the system context, through raw SQL in each context; the author reads their own shared note after losing the whole-org scope; the definers return no text, the worker-only ones refuse every other login and the user-context ones refuse members and viewers; a forged context is refused by the seal. The generated RLS matrix keeps its cross-org cases for the three tables and lists them as an author-only exception to its system-context controls (notes.md step N1).

### 3. What may still be seen

- **By owners and admins, in audit:** that a member created, shared, handed over or deleted an item with a given id, and when. The text is a `{"redacted": "pii"}` marker (`auditValue`, #1626).
- **By owners, as counts (#1678):**
  - The personal-data finder tells an owner how many private items of each author contain a value.
  - So an owner can confirm a guess one probe at a time: is "15000000" or this ID number in someone's private note? The finder never shows which item holds it, or its text.
  - Every search is a command (`kernel.personal_data.find`) whose audit row records who searched, the kind of value and the counts, never the value. Other owners and admins see the probing in the activity log.
  - Admins search the other rows but get no private counts.
  - The notice to the authors (`kernel.personal_data.notify`) is also an owner command with its own audit row, and it tells the authors their counts. So the authors see the probing too, but only when a notice is sent.
  - That audit row lists the ids of the private items it names. They are UUIDv7, so a reader of the audit log learns when those items were made, as for every command on them.
- **By every open app of the org:** a stream hint with the id of a changed row (#69). The app refetches through RLS and sees nothing; the id and its time are the residue.
- **By the operator of the deployment:** everything in the database, as for every table (Crove Cloud's staff rules apply; no staff tool shows notes). The docs and the in-app help say "Chỉ bạn xem được trong tổ chức này", not "nobody can ever read it".
- **Nowhere else:** no text in outbox events, activity summaries (a private note writes no activity), notifications, mail, logs, error messages, idempotency results or a shared search index.

### 4. A member leaves the org

When `kernel.member.removed` is emitted (the module subscribes to it and schedules a job 30 days later, with ids only in its payload):
- Shared notes stay, shown with "Thành viên cũ" as the author.
- Private notes and to-dos stay sealed: the member cannot enter the org, so nobody reads them. If the member is added back within 30 days, they find them again (no foreign key cascaded them away). After 30 days the job runs `notes.member_items.purge` (system, R3, `irreversible`), which deletes them unless the user is a member again; the definer counts the 30 days from the removal's audit row, whenever the job runs (#1733).
- A nightly sweep, after the trash, catches a removal that queued no job (the notes module off when the member left, a dropped job): `former_members_due` lists the former members past the delay and the sweep runs the same command for each. It fails closed: a user whose membership ended with no removal in the audit trail (an SQL delete, a restore) has no date to count from, so the sweep keeps their items and logs the org, never purges them.
- Before the removal, the members screen warns the owner how many private items the member has (`private_counts`), so the owner can ask them to share what the firm needs first.
- To-dos already handed over are tasks of a position; they stay with the position (ADR-0029).

Options considered: delete at once (rejected: a removal by mistake loses the member's work); hand them to the owner (rejected: contradicts option A); keep them until the org closes (rejected: personal data kept with no purpose, PDPL storage limitation).

### 5. Personal-data requests (PDPL, #923)

- **The member's own request:** they download their notes and to-dos (Markdown and JSON) at any time; their private items are personal data the org processes, and this answers access and portability.
- **A third person's request** (a client's director named in a note). The finder (`kernel.personal_data.*`) today compares whole values in email, phone and tax-code columns of four schemas; notes.md step N9 adds `crove_notes` and a match inside free text. Then it lists shared notes that contain the email, phone or tax code; for private items it reports only how many each author has (`private_matches`), never the text. The finder is a read-only query, so telling the authors is a separate owner command whose event a system command turns into notifications. An erasure (R3, owner) edits the value out of each shared note that holds it ("[đã xóa]" in its place, a matching tag dropped: the one case where someone other than the author edits a note; `title` is NOT NULL, so nulling columns is not an option) and deletes the matching private items through `private_erase`, without showing them, after the authors were notified: only items a notice for the same value named at their current revision, once its notification reached the author (#1678). The runbook of #923 sets the waiting time inside the legal deadline.
- Classes: `title`, `body`, `tags`, `details`, `checklist` and `search` (the folded search words) are `pii` in the manifest; their registry entries come with step N9, and until then they wait in `PERSONAL_DATA_PENDING` (#1874).

### 6. Org export and org purge

- **Export at offboarding** (#38): the export snapshot (`kernel.org.export.snapshot`) runs in the system context under row-level security, so the policies of section 2 already leave private rows out and shared notes in; `search_text` is not exported; the export records how many private items each author had. Each member could download their own beforehand; the offboarding notice says so.
- **Purge** (#1024): every `crove_notes` row of the org is deleted, shared and private; nothing is kept, since notes are not books and no law requires them.
- **WORM:** notes are not in the fact stream; their commands' audit rows are, with markers only (section 3).

## Consequences

- Good: a private item is private against every other actor of the org, enforced by the database and tested in the invariant suite; the agents' allowlist, the task table and ADR-0029 are untouched.
- Good: a third person's data request can be answered without anyone reading another member's private text.
- Bad: the firm cannot recover what a departed member kept private after 30 days, nor read it before. The defaults (shared on a client's page) and the removal warning limit this.
- Bad: six definers and an author-only exception in the RLS matrix, where the system actor loses its positive read and write controls on three tables; each is a protected-path change with its own security review.
- Bad: the system context loses the "sees everything" property it has on other per-user tables, so every future worker feature on notes needs a definer of its own (AI included, notes.md section 3.11).
- Neutral: the operator can still read the database; "private" is stated as private within the org.

## Revisit when

- The owner asks for break-glass access (option C).
- Teams exist (`team_lead`), so a note can be shared with a team instead of the whole org.
- Notes carry a legal entity, so entity-limited members can read shared notes of their entities.
- AI on notes (N8): an addendum on the definer that lets the worker read the one note the author asked about.
