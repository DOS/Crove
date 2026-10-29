# Crove Notes: notes and personal to-do lists

> Plan for notes and personal to-do lists (module `notes`), 2026-10-27. Owner request of 2026-10-27 in the coordinator chat (epic [#1648](https://github.com/DOS/Ludy/issues/1648)): add note-taking and to-do lists; plan it first, build only after the owner approves the plan ([#1649](https://github.com/DOS/Ludy/issues/1649)). The owner approved the plan on 2026-10-28 with every recommendation of section 6 (decisions N-1 to N-7, option a each); its steps (section 4) are now build issues under the epic. Architecture decision on private items: [ADR-0037](../adr/0037-private-notes-and-todos.md) (Accepted). Vietnamese page for the owner: [notes.vi.html](notes.vi.html).
>
> Reference products, studied for behavior only (no code copied): Odoo Notes and To-do, Notion, Google Keep, Todoist, Apple Notes, Things.

## 1. Goal and users

Give every member of an org a place to write down what they know and what they must do, next to the work Crove already holds, without mixing private jottings into the team's task list.

The first users are the staff of the pilot accounting firm. A firm's accountant is a member of each client company's org (ADR-0036 section 8, the multi-client view of #318), so for them:
- **A note in a client's org** is a note about that client: "Giám đốc chỉ nghe máy sau 15h", "Hóa đơn điện tháng nào cũng về trễ, nhắc kế toán bên khách ngày 5", the login hints the firm keeps for the client's bank portal (never the password itself: section 3.9).
- **A to-do** is the accountant's own work list: "Gọi khách xin sao kê tháng 10" by the 5th, "Kiểm tra lại hóa đơn của nhà cung cấp X", with checklist steps and a reminder.
- **My work** is one view of the accountant's own to-dos and the tasks of the positions they hold (ADR-0029), across the org they are in.

**v1 (steps N1 to N6):**
- Notes: title, Markdown body, tags, pinned; private to the author or shared with the org (section 3.3); linked to a party, a document, a voucher or a booking; a note with no link belongs to the org itself, which in a client company's org is the client.
- To-do lists: a member's own list, always private; due date with an optional time, a reminder, checklist steps, a link like a note's; hand a to-do over to a position, which turns it into a team task.
- "Việc của tôi" (My work): my open to-dos and the open tasks of my positions, grouped by due date (overdue, today, next 7 days, later, no date).
- Pinned notes on the org's overview, on a party's page and on a document's page.
- Search in notes and to-dos, without Vietnamese marks, from the notes screen and the `⌘K` palette.
- Reminders through the kernel notifications (#671), with no note or to-do text in the notification.

**Later (same plan, not v1):** a line of a note becomes a to-do (N7); AI summary of a note and suggested to-dos, as the author's proposals (N8, needs its own decision first); links to meetings once the Meeting Notes module exists ([#932](https://github.com/DOS/Ludy/issues/932)); notes shared with a team once teams exist (`team_lead` waits for teams, plan §4.6); file attachments; shared lists.

**Not in this plan:** real-time co-editing of one note by two people, end-to-end encryption (ADR-0037 option E), a public or client-facing note page, email-in to notes, handwriting and voice notes.

## 2. Fit with what exists

| Need | Reuse | New |
|---|---|---|
| Team work | `crove_kernel.task` and its screen `apps/app/src/routes/tasks.tsx` (ADR-0029, #258): tasks for positions, read by every member and by agents | Nothing; a to-do handed over becomes a task through the kernel (N5) |
| Personal to-dos | none: a task belongs to a position and every member reads it | `crove_notes.todo` (section 3.2) |
| Notes | short `note` columns on a few rows (CRM bookings, Social ideas, VAT checks) | `crove_notes.note` |
| Links to records | parties (`crove_kernel.party`), files (`crove_kernel.file`); `record_link` is a Phase 3 plan item, not built | `crove_notes.link` (section 3.4) |
| Per-user rows | the restrictive policies of `crove_social.saved_view` and `crove_kernel.notification` (`ctx_user_id()` from the sealed context) | the same pattern, stricter for the system context (ADR-0037) |
| Reminders | kernel notifications and their mute per kind (#671, `notifyMembers()`), the worker's sweeps | kind `notes.todo_due` |
| Search | `pg_trgm` in the `extensions` schema (plan §5.5) and `crove_kernel.search_fold` (Finance's search, #673); the `⌘K` palette (DESIGN.md §5.2) | a trigram index in `crove_notes`, a palette source |
| Realtime | the stream hints (#69: ids only, the app refetches through RLS) | hints for `note` and `todo` |
| Personal data | the registry and the finder of #923 (`packages/kernel/src/personal-data.ts`), data classes (#1599), audit markers (#1626) | registry entries and the private-item handling of ADR-0037 |
| Org purge and export | `crove_kernel.org_purge` (#1024) and the org export (#38) | `crove_notes` in the deletion map; private items left out of the export (ADR-0037) |

## 3. Design

### 3.1 A module of its own: `modules/notes`

Notes and to-dos are a module, `notes` (`@crove/mod-notes`, schema `crove_notes`), enabled through `CROVE_MODULES` like `crm` and `social` (ADR-0031), not kernel tables.

Why a module:
- Nothing else depends on them. The kernel holds what every module shares (parties, files, tasks, notifications); notes link to those, and nothing links back. A deployment that does not want them turns them off, and every other module runs unchanged (ADR-0031's rule).
- The module boundary keeps the private rules in one schema: `tools/test/module-schemas.test.ts` (#1464) keeps other modules out of `crove_notes`, and `crove_notes` reaches only `crove_kernel`.
- Its manifest owns its tables, the data class of every column (#1599) and its permissions (#1630) in one file (`modules/notes/src/manifest.ts`), as `modules/crm/src/manifest.ts` does.

What it costs: `notes` joins `AVAILABLE_MODULES` (`apps/kernel/src/config.ts`) and the module token list of plan §5.3; the org purge gets a `crove_notes` part in a kernel migration, as CRM's did (`20261030130100_crove_kernel_org_purge_crm.sql`); and a to-do handed over needs one kernel change (N5).

Rejected: kernel tables (`crove_kernel.note`, `crove_kernel.todo`). They would be on in every deployment, they would grow the kernel's protected surface for a feature no module needs, and nothing would be gained, since modules may already reference `crove_kernel` rows by foreign key.

### 3.2 Personal to-dos: a new table, not `crove_kernel.task`

A to-do is a row of `crove_notes.todo`, owned by one member and readable by that member only. It is not a `crove_kernel.task` row.

Why not reuse `task`:
- **Who reads it.** Every member reads every task (the tenant policy only), and agents read the tasks of their positions (`kernel.task.list`, ADR-0029). Making some tasks private means a new restrictive policy on `task`, which changes what members and agents see today: an invariant change (`agents.db.test.ts`, the RLS matrix) and a change to ADR-0029, for a convenience.
- **The agents' table allowlist (#285).** `task` and `task_comment` are exempt from the agent write guard because they carry the lease rules. A private to-do there would sit in a table agents may write under a lease. A new table gets the guard from `apply_tenant_rls` and stays closed to agents with no change to the allowlist.
- **Who owns it.** A task belongs to a position (or to the owners, with no position), so it survives a change of holder. A to-do belongs to a person and goes away with them (ADR-0037).
- **What it carries.** A task has a lease, a fencing token, `request_depth`, a status machine for team work and taint from agents. A to-do needs a checklist, a reminder, an order in the member's list and nothing of the rest.

The epic's goal, "a to-do can later be handed to a position or an agent", holds through hand-over: `notes.todo.hand_over` creates a kernel task for the chosen position, with the to-do's title and details the member confirms, and marks the to-do `handed_over` with the task's id. From then on the work is a task, with every rule of ADR-0029, and an agent can hold it. Nothing private enters the task table unless the member hands it over.

### 3.3 Who sees what

ADR-0037's answer (decided by the owner on 2026-10-28, decisions N-2 to N-5):

| Item | Its author | Other members | Owners and admins | Viewers | Members limited to some legal entities | Agents | The system (worker) |
|---|---|---|---|---|---|---|---|
| Private note, to-do | read, write | nothing | nothing | nothing | nothing | nothing | ids and dates only, through named definers |
| Shared note | read, write | read | read, archive, delete | nothing | nothing in v1 | nothing in v1 | read (export, purge) |

- **Shared** means every member of the org with base role `owner`, `admin` or `member` and the whole org in scope (`le_scope` `*`). Viewers are left out, because a client's own staff may be invited into the client's org (M3-2, "invite the client's contact") and the firm's notes about that client are not for them (decision N-4). Members limited to some legal entities (`external_accountant`) see shared notes only once notes carry an entity (later).
- **Defaults** (decision N-7): a to-do is always private; a note written from the notes screen starts private; a note written from a party's, a document's or the org overview's panel starts shared, since a note about a client is usually for the team. The editor always shows which one it is, and making a private note shared asks once.
- **Only the author edits** a note's text in v1. Owners and admins may pin, archive or delete a shared note (to take down something wrong). A row policy cannot limit columns, so the database lets owners and admins update a shared note and the commands limit what they change; the one exception is a personal-data erasure (N9), where the owner edits a shared note's text. Shared editing by every member is a later option once someone asks for it.
- **The author always reads their own note**, shared or private, whatever their role or scope later becomes (a member limited to some legal entities who writes a shared note still reads it back).

### 3.4 Data (tenant tables: `org_id`, `PRIMARY KEY (org_id, id)`, RLS through `apply_tenant_rls` plus the restrictive policies of ADR-0037)

`crove_notes.note`

| Column | Type and rule | Class (#1599) |
|---|---|---|
| `org_id`, `id` | `uuid`, `uuid_v7()` | internal |
| `author_user_id` | `uuid NOT NULL`, set by the command to the caller; the policy's `WITH CHECK` requires it to equal `ctx_user_id()` (as on `saved_view`), and an update may not change it. No foreign key to `tenant_member`, so a removed member's rows outlive the removal (section 3.12) | internal |
| `visibility` | `text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'org'))` | internal |
| `title` | `text NOT NULL`, 1 to 200 characters | pii |
| `body` | `text NOT NULL DEFAULT ''`, Markdown, at most 100,000 characters | pii |
| `tags` | `text[] NOT NULL DEFAULT '{}'`, at most 20, each 1 to 40 characters, lower case | pii |
| `pinned` | `boolean NOT NULL DEFAULT false` | internal |
| `tainted` | `boolean NOT NULL DEFAULT false`: text that came from AI or untrusted content (N8) | internal |
| `search_text` | `text NOT NULL`, set by a trigger: title, tags and body folded by `crove_kernel.search_fold` (lower case, without marks) | pii |
| `revision` | `integer NOT NULL DEFAULT 1`, raised by every edit | internal |
| `created_at`, `updated_at`, `archived_at`, `deleted_at` | `timestamptz`; `deleted_at` puts it in the trash | internal |

`crove_notes.todo`

| Column | Type and rule | Class |
|---|---|---|
| `org_id`, `id` | as above | internal |
| `owner_user_id` | `uuid NOT NULL`, the caller, under the same `WITH CHECK` and with no foreign key, as `author_user_id` | internal |
| `title` | `text NOT NULL`, 1 to 300 characters (the limit of a task title, so a hand-over never truncates) | pii |
| `details` | `text`, at most 10,000 characters (a task description's limit) | pii |
| `checklist` | `jsonb NOT NULL DEFAULT '[]'`: at most 50 steps `{"text": ..., "done": bool}`, each text at most 300 characters (CHECK) | pii |
| `status` | `text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'handed_over', 'cancelled'))` | internal |
| `due_on` | `date`: the day it is due | internal |
| `due_at` | `timestamptz`: an exact time, only with `due_on` | internal |
| `time_zone` | `text NOT NULL`, IANA, from the member's browser (default `Asia/Ho_Chi_Minh`) | internal |
| `remind_at`, `reminded_at` | `timestamptz` | internal |
| `sort_key` | `text NOT NULL`, the member's own order (fractional keys) | internal |
| `source_note_id` | `uuid`, the note it came from (N7); FK `(org_id, source_note_id)` to `note` | internal |
| `task_id` | `uuid`, set by the hand-over; FK `(org_id, task_id)` to `crove_kernel.task` | internal |
| `tainted`, `search_text`, `revision`, `created_at`, `updated_at`, `done_at`, `deleted_at` | as on `note` | `search_text` pii, others internal |

`crove_notes.link`: a note or a to-do linked to one record.

| Column | Type and rule | Class |
|---|---|---|
| `org_id`, `id` | as above | internal |
| `note_id`, `todo_id` | `uuid`, exactly one set (CHECK); FKs to `note` and `todo` with `ON DELETE CASCADE` | internal |
| `target_type` | `text NOT NULL CHECK (target_type IN ('kernel.party', 'kernel.file', 'finance.purchase_document', 'finance.journal_entry', 'crm.booking'))`, widened by a later migration (`meetings.meeting`, #932) | internal |
| `target_id` | `uuid NOT NULL` | internal |
| `party_id`, `file_id` | `uuid`, set for the kernel targets so they get a foreign key (`(org_id, party_id)` to `party`, `(org_id, file_id)` to `file`) | internal |
| `created_by`, `created_at` | | internal |

- No foreign key goes to another module (plan §5.5): a `finance.*` or `crm.*` target is checked when the link is made, by running that module's `get` query in the writer's context (`ctx.query`, so its RBAC and `le_scope` apply), and read the same way when shown. A target the reader cannot open, or whose module is off, shows as "Bản ghi không mở được"; a deleted target shows as deleted. Links read the policies of their note or to-do: the restrictive read policy on `link` is an `EXISTS` over its parent, which itself goes through the parent's policies. Writing a link needs more: only the parent's author (or the to-do's owner) adds or removes one, so neither the system context nor a reader of a shared note can link it.
- Indexes: every foreign key gets an index led by `org_id` (G3 conformance, #1200); `(org_id, author_user_id, updated_at DESC)` and `(org_id, owner_user_id, status, due_on)` for the lists; `(org_id, target_type, target_id)` on `link` for a record's panel; a GIN trigram index on `search_text` (section 3.7).
- `search_text` is filled by a trigger that calls `crove_kernel.search_fold`, the immutable fold Finance's search already uses, so the module adds no wrapper of its own; the trigger sets `search_path = pg_catalog, pg_temp` like every function.
- Not in the WORM stream: notes are not books. Their commands' audit rows are, which is why no text may reach them (section 3.6).

### 3.5 Commands and queries

Every write is a command through `Runtime.execute()`. Every command declares `risk` and `sideEffect` (#1563); none declares a module permission, so the manifest's `permissions` is `[]` (#1630), and access comes from the base role (`access`), as in CRM. Every command result carries ids and the new `revision`, never text, because idempotency rows keep results.

| Command | Who | Risk | Side effect | Notes |
|---|---|---|---|---|
| `notes.note.create` | owner, admin, member | R1 | internal | visibility from the caller, default per section 3.3 |
| `notes.note.update` | the author | R1 | internal | title, body, tags; refused with `NOTES.REVISION_CONFLICT` when the expected revision is stale |
| `notes.note.set_visibility` | the author | R1 | internal | private to shared and back |
| `notes.note.pin`, `.unpin` | the author; for a shared note also owners and admins | R1 | internal | the database lets owners and admins update a shared note; this command and the next two are the only ones that do (section 3.3) |
| `notes.note.archive`, `.restore` | as pin | R1 | internal | |
| `notes.note.delete` | as pin | R1 | internal | to the trash; restorable for 30 days |
| `notes.link.add`, `.remove` | the author of the note or owner of the to-do | R1 | internal | checks the target in the writer's context |
| `notes.todo.create`, `.update`, `.complete`, `.reopen`, `.reorder`, `.delete` | the to-do's owner (owner, admin, member) | R1 | internal | delete goes to the trash |
| `notes.todo.hand_over` | the to-do's owner | R1 | internal | creates the task through the kernel (N5); the member confirms the text the team will see |
| `notes.todo.remind` | system | R1 | internal | writes the `notes.todo_due` notification for to-dos the reminder definer claimed, no text |
| `notes.trash.empty` | system | R3 | irreversible | daily job: removes items 30 days in the trash |
| `notes.member_items.purge` | system | R3 | irreversible | removes a former member's private items 30 days after they left, from a job the `kernel.member.removed` subscriber schedules, or the daily sweep for a removal that queued none (ADR-0037 section 4, #1733) |

Queries (R0): `notes.note.list` (mine, shared, pinned, archived, trash; by tag or link), `notes.note.get`, `notes.note.search`, `notes.todo.list` (open by due group, done, trash), `notes.todo.get`, `notes.record.panel` (the pinned and recent notes of one record), `notes.my_work` (my open to-dos plus the open tasks of the positions I hold, read through the kernel's task query). Viewers run none of them in v1, since they see no note.

Agents: no command or query of the module declares `agent` (ADR-0029), so the runtime refuses every one to an agent; the database refuses the rest (section 3.6).

### 3.6 Tenancy, privacy and audit

- **RLS.** `apply_tenant_rls` on each table (tenant isolation, grants, the agent write guard), then restrictive policies per ADR-0037: a private row is visible and writable only when `author_user_id` (or `owner_user_id`) equals `ctx_user_id()` of the sealed context; a shared note to the users of section 3.3 and to the system context; an agent context sees and writes nothing. Unlike `saved_view` and `notification`, the system context does not see private rows: the worker reaches them only through named definers that return ids, owners and dates, never text (reminder claim, trash, member purge, the personal-data counts), and the org purge deletes them as the table owner. The author always reads their own notes, shared or private, whatever their role.
- **Agents' table allowlist (#285).** Unchanged. The three tables get `agent_write_guard` from `apply_tenant_rls` and are not added to the exempt list, so the invariant test that enumerates unguarded tables keeps passing, and no agent writes them.
- **Audit (#1626).** Every command's audit detail passes `title`, `body`, `tags`, `details` and `checklist` through `auditValue()`, so the WORM-anchored audit row keeps a `{"redacted": "pii"}` marker, never the text. What an auditor does see: who created, shared, handed over or deleted which item id, and when (ADR-0037, "Consequences").
- **Events and activity.** Outbox events carry ids only (`notes.note.shared`, `notes.todo.handed_over`). A shared note linked to a party writes an activity on its timeline with a fixed summary ("Thêm ghi chú"), never the title; a private note writes none, so the timeline does not reveal it.
- **Stream hints.** `note` and `todo` send the usual hint (org, type, id). Hints reach every open stream of the org (#69); another member's app refetches and sees nothing. The id and its time are the only things that reach them (ADR-0037).
- **Logs, errors, mail.** No note or to-do text in logs, error messages, notifications or mail (a reminder says "Bạn có 1 việc đến hạn", and the app shows the title when the member opens it).
- **Markdown.** Rendered in the app with a renderer that drops raw HTML, opens links with `rel="noopener noreferrer nofollow"` and loads no remote image in v1 (no tracking pixels), under the app's Content Security Policy.
- **Data classes and the personal-data registry (#923).** `title`, `body`, `tags`, `details`, `checklist` and `search` (the folded search words) are `pii` in the manifest from N2 and N4. The registry and the finder need new work, which is step N9: today the finder compares whole values in email, phone and tax-code columns only (`columnMatch` in `packages/kernel/src/personal-data.ts`), its schema list (`PERSONAL_DATA_SCHEMAS`, which holds `crove_notes` since #1874) only drives a scan of column names, the text columns wait in `PERSONAL_DATA_PENDING`, and its erasure sets a column to null, which `title` (NOT NULL) refuses. N9 moves those entries into the registry and adds a search for a value inside free text, and an erasure that deletes a private item or leaves a shared note for the owner to edit; the private-item handling is ADR-0037's (counts per author, no text).
- **The three-PR rule for new tenant tables** (#291, `PENDING_TABLES` in `rls-matrix.db.test.ts`): the row factories of `note`, `todo` and `link` land on `main` first with their `PENDING_TABLES` entries (N1), the tables come in N2 and N4, and the entries are removed in the PR after each table is on `main`.

### 3.7 Search

`notes.note.search` and the to-do list filter search `search_text` with a trigram match on the unaccented query ("hoa don" finds "hóa đơn"), ranked by similarity and recency, under the reader's RLS, so a member finds their private items and the shared notes and nothing else. The `⌘K` palette gets a "Ghi chú" source when the module is on. When the kernel's search projector exists (plan §5.2, not built), it may index shared notes only; private items never leave `crove_notes`.

### 3.8 Reminders and due dates

- A to-do may have a due day, a due time and a reminder (default: 8:00 on the due day in the to-do's time zone, or 30 minutes before a due time; the member may turn it off or pick another time).
- Every 5 minutes the worker claims due reminders through `crove_notes.todo_reminders_claim(p_limit)` (definer, worker login only): one `UPDATE ... SET reminded_at = now() ... RETURNING` of open to-dos whose `remind_at` has passed and that were not reminded for it, returning `org_id`, `id`, `owner_user_id` and `remind_at`. For each it runs `notes.todo.remind`, which writes one kernel notification (kind `notes.todo_due`, `dedupe_key` per to-do and reminder time) for the owner; a crash between the claim and the notification at worst skips one reminder, never sends two. Members can mute the kind (#671). Changing `remind_at` clears `reminded_at`.
- A done, cancelled, handed-over or deleted to-do is not reminded. Overdue to-dos show in red in My work; no repeated nagging.
- Repeating to-dos (every month on the 5th: the firm's monthly cycle) are a natural next item; they are left out of v1 and get their own step when the pilot asks.

### 3.9 Secrets in notes

Accountants keep portal logins in notebooks. A note is not a password store: the editor warns when the text looks like a password line ("mật khẩu:", "password:", "pass:"), the quick guide says why, and the plan adds no secret storage. Crove's credential vault (ADR-0025) is for channel tokens, not for members' passwords.

### 3.10 UI (DESIGN.md)

- **Menu** "Ghi chú" and "Việc của tôi", contributed by the module (ADR-0031, DESIGN.md §9); with `notes` off, neither shows.
- **Notes screen** (`/o/:slug/notes`): a list on the left (Của tôi, Dùng chung, Đã ghim, Lưu trữ, Thùng rác; tag filter; search), the note on the right; on a phone the list and the note are two screens. The editor is a plain Markdown textarea with a preview toggle and a small toolbar (bold, list, checkbox, link); it autosaves after a pause through `notes.note.update` and shows "Đã lưu". A lock icon and the word "Riêng tư" or "Dùng chung" sit next to the title, always visible.
- **Việc của tôi** (`/o/:slug/my-work`): groups Quá hạn, Hôm nay, 7 ngày tới, Sau đó, Không hạn; each row a checkbox, the title, the due chip, the linked record and, for tasks, the position and a "Việc nhóm" badge. Quick add at the top ("Thêm việc, Enter để lưu"); keyboard: `N` new, `J`/`K` move, `X` done, `E` edit (DESIGN.md §5.2).
- **Record panels**: "Ghi chú" on the org overview (the client), on a party, a document and a voucher page: pinned notes first, then the latest three, and "Thêm ghi chú" (shared by default there). The multi-client view (#318) shows a client's pinned note count, read in that org.
- **States** (DESIGN.md §5.3): empty notes say "Ghi lại điều cần nhớ về khách hàng này" with one action; empty My work says "Không có việc nào đến hạn"; a revision conflict says the note was just changed and offers to reload.
- **Tainted text** (N8): an AI-made note or to-do carries the "Đề xuất" style until the member edits or accepts it (DESIGN.md §2, principle 2).
- Every string in `vi.ts` and `en.ts`; checked at 360px, both themes and keyboard only (DESIGN.md §10).

### 3.11 AI, later (N8)

AI calls only through `packages/agent`, with an OpenAI-compatible endpoint, budgets and kill switches (plan §8). Two features: summarize a note, and suggest to-dos from a note. Both are started by the author on one note, their output is tainted and lands as a suggestion only the author sees; accepting it runs the author's own `notes.todo.create` or `notes.note.update` with `tainted` set. Suggestions are not kernel proposals, because `crove_kernel.proposal` is read by the org's approvers and would expose a private note. Before N8 is built, ADR-0037 gets an addendum on how the worker may read the one note the author asked about (a definer bound to the request's audit row, as #435 binds agent requests) and where the text goes (the AI endpoint of decision D9). Agents never read notes in this plan (decision N-6).

### 3.12 Personal data, offboarding and the org purge

Summary of ADR-0037 (Accepted):
- **A member leaves the org** (`kernel.member.removed`): their shared notes stay with the org, showing "Thành viên cũ" as the author; their private notes and to-dos stay sealed for 30 days (if they are added back, they find them again, since `author_user_id` has no foreign key that would cascade), then `notes.member_items.purge` deletes them. The module's subscriber to `kernel.member.removed` schedules that purge as a job 30 days later (ids only in the payload); the job checks that the user is still not a member before it deletes. Open to-dos already handed over are tasks and stay.
- **A member asks for their own data:** they can download their notes and to-dos as Markdown and JSON at any time ("Tải về").
- **A person asks for their data under the PDPL** (#923, built in N9): the finder learns to search free text and lists shared notes that mention the value, and for private items only how many each author has, never the text. The finder is a read-only query, so telling the authors is a separate owner action (a command whose event a system command turns into notifications). An erasure leaves shared notes for the owner to edit (the one case where someone other than the author edits a note) and deletes matching private items without showing them, after their authors were told.
- **Org export** (offboarding, #38): the export snapshot runs in the system context under RLS, so the policies already leave private rows out; `EXPORT_TABLES` lists the `crove_notes` tables without `search_text`, and the export records how many private items each author had.
- **Org purge** (#1024): every `crove_notes` row is deleted, before the kernel's tasks (a handed-over to-do references its task); nothing is kept (notes are not books).

## 4. Steps (one PR each, end to end)

Epic: [#1648](https://github.com/DOS/Ludy/issues/1648). The owner approved this plan on 2026-10-28, so each step is an issue linked from the epic; milestones and priorities are those of decision N-1.

| # | Step | Scope | Acceptance criteria | Files | Milestone, priority | Protected paths |
|---|---|---|---|---|---|---|
| N0 | Plan and ADR ([#1649](https://github.com/DOS/Ludy/issues/1649)) | This file, ADR-0037, the owner page | Merged with `pnpm docs:check` green; the owner's decisions recorded in section 6 and ADR-0037 `Accepted` | `docs/plan/notes.md`, `docs/adr/0037-private-notes-and-todos.md`, `docs/plan/notes.vi.html`, `docs/plan/crove-os-kernel.md` | Icebox, P3 (this PR) | No |
| N1 | Invariants first | Row factories for `crove_notes.note`, `todo`, `link` with `PENDING_TABLES` entries; the three tables in a reasoned `AUTHOR_ONLY` set with per-actor exceptions to the matrix's controls: the factories set `author_user_id` or `owner_user_id` explicitly (the matrix seeds as superuser with no context, so nothing can be taken from a context); the system context's read control is a shared note for `note` and 0 rows for `todo` and a to-do's `link`; the system context's insert and update controls, which expect success today, are replaced by the member context's, since the system writes these tables only through definers. The cross-org cases stay as they are for every actor. This removes the system actor's positive control on three tables, a reasoned exception the security review checks; private-row behavior is tested in `notes-private.db.test.ts` (N2), not in the matrix | CI green on `main` with the tables absent; the matrix names the three tables as pending | `apps/kernel/test/invariant/rls-matrix.db.test.ts` | M3, P2 | Yes (invariant suite) |
| N2 | Notes, end to end | `modules/notes` (manifest with every column's class, `permissions: []`), `notes` in `AVAILABLE_MODULES`, migration `crove_notes` with `note` and `link` (link targets `kernel.party` and `kernel.file` first), the restrictive policies and definers of ADR-0037, the note commands and queries, audit markers, the org purge and export rules, the member-left handling (subscriber and delayed purge job), trash job, the removal warning on the members screen, the notes screen and the record panels for the org overview and parties; `notes-private.db.test.ts` in the invariant suite; the module's package and the kernel's dependency on it | A member writes a private note on a client and a shared one; another member, a viewer, an entity-limited member, an agent context and the system context read none of the private one (database tests); the audit row holds markers, not text; removing the member hides their private notes and deletes them after 30 days; the org export has the shared note and a count for the private one; the org purge deletes both; with `notes` off nothing loads; e2e: write, pin, find on the client's overview | `modules/notes/**` (with `package.json`), `supabase/migrations/<ts>_crove_notes_core.sql`, `<ts>_crove_kernel_org_purge_notes.sql` (`crove_notes` deleted before tasks), `apps/kernel/src/config.ts`, `apps/kernel/src/kernel.ts`, `apps/kernel/package.json`, `pnpm-lock.yaml`, `apps/kernel/test/manifest-permissions.ts` (`MODULE_MANIFESTS`), `packages/kernel/src/offboarding.ts` (`EXPORT_TABLES`), `docs/runbooks/org-offboarding.md`, `apps/app/src/routes/notes.tsx`, `apps/app/src/i18n/messages/{vi,en}.ts`, `apps/kernel/test/invariant/notes-private.db.test.ts`, `packages/db/src/generated/database.ts` | M3, P2 | Yes (migrations, invariant suite, `package.json`, lockfile) |
| N3 | Links to documents, vouchers and bookings | `link` targets `finance.purchase_document`, `finance.journal_entry`, `crm.booking`, checked through each module's `get` query; panels on the document, voucher and booking pages; links to an unreadable target show as such | A note linked to a voucher of entity A shows the link to a member of A and "Bản ghi không mở được" to a member limited to B; with `finance` off the panel still works and the link shows as unavailable | `modules/notes/**`, a migration widening `target_type`, `apps/app/src/routes/documents.tsx`, `journal.tsx`, `bookings.tsx` | M3, P2 | Yes (migration) |
| N4 | Personal to-dos | `todo` (migration), its commands and queries, checklist, due day and time, the "Việc của tôi" screen with my to-dos only, keyboard shortcuts, quick add | Another member, an owner, an agent context and the system context read no to-do of a member (database tests); a to-do with a due day appears under Hôm nay that day in its time zone; checklist steps save; e2e: add, complete, reorder | `modules/notes/**`, `supabase/migrations/<ts>_crove_notes_todo.sql`, `apps/app/src/routes/my-work.tsx`, messages | M3, P2 | Yes (migration) |
| N5 | My work and hand-over | `notes.my_work` joins the open tasks of my positions; `notes.todo.hand_over` creates the task through a kernel helper modules call in the same transaction, which sets `source_ref` `{"type": "notes.todo", "id": ...}` itself; `kernel.task.create`'s public input gains nothing, so a member cannot forge a task's provenance (a `kernel.proposal` reference would make `kernel.task.get` attach that proposal); the confirm dialog shows the text the team will see | A handed-over to-do becomes a task of the chosen position, readable by the team, with `source_ref` `{"type": "notes.todo"}`; the to-do shows "Đã giao" and links to it; an archived position is refused (`POSITION_ARCHIVED`); a task of my position shows in My work with its badge | `modules/notes/**`, `packages/kernel/src/agents.ts`, `apps/app/src/routes/my-work.tsx`, `tasks.tsx` | M3, P2 | No (kernel source outside the protected list; a reviewer still checks the task change) |
| N6 | Reminders and search | The reminder definer and sweep, `notes.todo.remind`, notification kind `notes.todo_due` with its mute; `search_text`, the trigram index, `notes.note.search`, the `⌘K` source | A reminder arrives once at its time, never for a done or deleted to-do, and holds no text; "hoa don" finds "hóa đơn" in my private note and in shared notes, never in another member's private note | `modules/notes/**`, a migration (index, definer), `apps/kernel/src/worker.ts`, `apps/app/src/components/command-palette.tsx` | M3, P2 | Yes (migration) |
| N7 | Note line to to-do | Select a line or a checklist item of a note and make it a to-do, with `source_note_id` | The new to-do links back to its note; a shared note's line becomes my private to-do | `modules/notes/**`, `apps/app/src/routes/notes.tsx` | Icebox, P3 | No |
| N8 | AI summary and suggested to-dos | ADR-0037 addendum first (section 3.11); `NoteAssistant` in `packages/agent`; suggestions for the author only, tainted, accepted by the author | A prompt-injection note cannot make a to-do or change a note without the author's click; AI text keeps the "Đề xuất" style until accepted; budgets and kill switches stop it | `packages/agent/**`, `modules/notes/**`, an ADR-0037 addendum | Icebox, P3 | Possibly (a definer migration) |
| N9 | Personal-data finder for notes | registry entries for the note and to-do text, moved from `PERSONAL_DATA_PENDING` (`crove_notes` is in `PERSONAL_DATA_SCHEMAS` since #1874); a free-text match (the finder compares whole values today); the counts per author for private items through definers an owner or admin context may call (checked inside); an owner command that tells the authors (its event becomes notifications through a system command); an erasure that deletes matching private items without showing them and lists shared notes for the owner to edit (`title` is NOT NULL, so nulling is not an option); the member's own download | A search for an email finds it inside a shared note's body and reports "2 ghi chú riêng của 1 thành viên" without text; the authors get a notification; the erasure deletes those two after they were told; the member downloads their own items | `packages/kernel/src/personal-data.ts`, `modules/notes/**`, a definer migration, `apps/app/src/routes/personal-data.tsx` | GA gate, P2 (with #923) | Yes (migration, invariant `personal-data.db.test.ts` stays as is) |
| N10 | Meeting links (starts once the Meeting Notes module exists, #932) | `meetings.meeting` as a link target; a meeting's summary saved as a shared note | A note links to a meeting and shows on the meeting's page; a member who cannot open the meeting sees "Bản ghi không mở được"; a summary saved as a note is tainted until the member edits it | `modules/notes/**`, a migration | Icebox, P3 | Yes (migration) |

Order: N1, then N2; N3 and N4 can run in parallel after N2 (different files but both migrations, renamed at merge, #1492); N5 after N4; N6 after N4. N9's registry entries, free-text matching and private-item handling all land in N9.

## 5. Exit criteria (v1, N1 to N6)

1. No member, owner, admin, viewer, agent context or system context reads the title, body, tags, details or checklist of another member's private note or to-do, through the app, the API or raw SQL in their context (invariant tests).
2. No note or to-do text in audit rows, outbox events, activity summaries, notifications, mail, logs or command results.
3. A member writes a note about a client in under 10 seconds from the client's overview, and finds it again by a word without marks.
4. My work shows a member's to-dos and the tasks of their positions in one list, by due date; a to-do handed over becomes a task the team sees.
5. A reminder arrives once, at its time, in the member's time zone.
6. With `CROVE_MODULES` excluding `notes`, nothing of it loads and every other module runs unchanged; `docker compose up` runs it with no outside account.

## 6. Owner decisions

Decided 2026-10-28 by the owner, in the coordinator chat, on PR [#1659](https://github.com/DOS/Ludy/pull/1659): every recommendation as written (option a of each question). The "Decision" column is what is built; the "Why" column keeps the reason, and N-1 keeps the options that were not taken.

| # | Question | Decision | Why |
|---|---|---|---|
| N-1 | When is it built? | Decided 2026-10-28 by the owner: (a) N1 to N6 in M3 at P2, after M2's P0 and P1 work; N7, N8 and N10 in the Icebox; N9 with the GA gate | The pilot's staff juggle many clients and dates, and the multi-client view and tax calendar already exist to hang notes and to-dos on; but no pilot interview has asked for it yet and agent capacity goes to the monthly close first (backlog review D5, D11). Options not taken: start in M2 now (delays M2's finance work), or keep it in the Icebox until the partner asks |
| N-2 | Who may read a private note or to-do? (ADR-0037) | Decided 2026-10-28 by the owner: (a) the author only: not owners, not admins, not Crove staff | "Riêng tư" must mean what it says, or staff will not use it; anything the firm needs is a shared note or a task |
| N-3 | What happens to a leaving member's private items? | Decided 2026-10-28 by the owner: (a) kept sealed for 30 days, then deleted; shared notes stay with the org | 30 days covers a removal by mistake; the firm keeps everything that was shared |
| N-4 | Who sees a shared note? | Decided 2026-10-28 by the owner: (a) owners, admins and members; not viewers; not members limited to some legal entities, until notes carry an entity | A client's own staff may be invited into the client's org; the firm's notes about the client are not for them |
| N-5 | Does the org's export at offboarding include members' private items? | Decided 2026-10-28 by the owner: (a) no: shared notes yes, private items only as a count per author | Same reason as N-2; each member can download their own items |
| N-6 | May AI read notes (later, N8)? | Decided 2026-10-28 by the owner: (a) only when the author asks, one note at a time, with the AI endpoint of decision D9; agents never read notes | Notes may hold personal data of clients; the author decides each time |
| N-7 | What is private by default? | Decided 2026-10-28 by the owner: (a) to-dos always; notes from the notes screen private, notes from a client's, party's or document's page shared | Matches what each place is for; the editor always shows which one it is |

## 7. Risks

| Risk | Mitigation |
|---|---|
| A private note leaks through a side channel (audit, events, timeline, notifications, search index, export) | ADR-0037's list, each with a test: audit markers, ids-only events, no activity for private notes, no text in notifications, no shared search index, export rules |
| Staff write client secrets (passwords) in notes | The editor's warning and the guide (section 3.9); private notes still sit in the database in clear, which the guide says |
| A firm loses knowledge when an accountant leaves | Client notes default to shared on a client's page (N-7); a removal warns the owner how many private items the member had, and the member can share before leaving |
| Two people edit one shared note | Only the author edits in v1; the revision check refuses a stale save and offers a reload |
| Scope creep into a Notion clone | v1 stops at plain Markdown notes and a personal list; databases, pages in pages, co-editing and templates are out |
| Agent capacity taken from the pilot milestones | Decision N-1 keeps it after M2's P0 and P1 work |
