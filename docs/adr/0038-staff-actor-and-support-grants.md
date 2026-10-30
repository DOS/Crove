# 0038. The staff actor and support grants: who operates a deployment, and how they reach an org's data only when its owner says so

- Status: Proposed (2026-10-30). The decisions marked **owner** in the last section change who may read tenant data and how operators authenticate, so they wait for the owner. Nothing here is built.
- Date: 2026-10-30
- Deciders: owner (JOY), on the coordinator's review
- Builds on: plan §4.3 (actors), §4.5 (context and RLS), §4.10 (audit), §4.12 (kill switches, staff), §6 (control-plane tables), §7.8 (detective controls); ADR-0028 (identity, sessions, step-up P11); ADR-0029 (agents and their write allowlist, #285); ADR-0037 (private notes: no staff tool reads them); the audit stamp (#1482) and the worker instance stamp (#1951); the operator image roles (`user-disable`, #985)
- Issue: [#1950](https://github.com/DOS/Ludy/issues/1950)

## Context and problem statement

The plan names a sixth actor, `staff`: the people who run a deployment (Crove Cloud's support and operations, or a self-hoster's own operator). Plan §4.3 gives it one line: a staff user on an allowlist, with `aal2`, from the `crove-ops` job, running `staff.*` commands (flags, entitlement overrides, kill switches, diagnostics), and "touches tenant data only with an unexpired owner-issued `support_grant`; no impersonation". None of it exists.

What exists today:
- **Operator image roles.** For example `docker compose run worker user-disable …` (#985). They connect as `crove_worker` and act in a system context. Whoever holds the worker's database credentials runs them. The rows name no person (`system`, component `operator`), and there is no second factor.
- **"Staff" in the database's own sense.** In about twenty triggers and guards, "staff" means a session whose login is a superuser, or a member of the role that owns the table: the migration runner, the database owner fixing data by hand, and tests that build history. Those sessions bypass the guards ("staff writes aside" in the invariants). This is the database owner, not a person acting in the product.
- **Nobody reads an org's data through the product unless they are a member.** Operators reach it only with database credentials, outside every guard.

The external security review (#31) and the GA gate will ask how a support person helps a customer: who they are, what they may see, who allowed it, and where it is written down. Answering "they log in to the database" is the weakest possible answer.

What has to be decided:
1. Who staff are, and how a staff member proves it on each action.
2. How an org's owner allows support access: scope, time limit, revocation.
3. What staff may do with and without such a grant.
4. How each staff action is recorded and shown to the owner.
5. How this fits the invariants, and today's database-owner exemptions in particular.

## Decision drivers

- Tenancy holds: support access is the owner's choice, limited in time and scope, and visible to the owner.
- No impersonation: staff never act as a member, never hold a member's session, never get a user context.
- One write path, the sealed context, the audit stamp and the WORM stream stay as they are. Staff ride on them and get no bypass.
- A named person, with a second factor, on every staff action. Database credentials alone must never be enough to read tenant data as staff.
- ADR-0037 holds: no staff tool reads a private note or to-do. Sealed secrets (channel credentials, the input hash key) stay sealed.
- Self-host and Cloud work alike. Ludy must run without any DOS service, and the `crove-ops` job is Cloud's way to run the same tool.

## Terms

- **Database owner:** what the triggers call "staff" today. A superuser session, or a member of the owning role. This ADR leaves it unchanged; it is renamed only in prose.
- **Staff member:** a person on the deployment's staff allowlist, signed in with Ludy's identity provider like any user.
- **Staff context:** the sealed context a staff member's action runs in (actor `staff`).
- **Support grant:** an org owner's permission for staff to act in that org, with a scope, an expiry and a reason.

## Options for where staff act

**A. A staff command-line tool on its own database login (recommended).**
- `staff` is a new image role, like `user-disable`. The deployment operator runs it: on Crove Cloud from the `crove-ops` job behind a protected workflow, on a self-hosted deployment with `docker compose run --rm worker staff …`.
- It connects as a new login role `crove_staff`. That role is not a superuser, does not bypass RLS, owns nothing, and is a member of no owning role. The only context it may enter is a staff context.
- It takes the staff member's own access token (signed in through Ludy's identity provider), verifies it the way the API does, and runs the session check. Every action requires `aal2` with a second-factor timestamp in the last 5 minutes (P11).
- No HTTP route is added, so the route coverage invariant does not move.
- Good: the smallest attack surface. Every action names a person who just used a second factor. Database credentials alone get a `crove_staff` session that can enter nothing without a valid token, allowlist entry and grant.
- Bad: no screen for staff. Diagnostics are text, and Cloud may later want a console.

**B. Staff routes on the API, with a staff screen in the app.**
- Good: easy to use.
- Bad: the public API grows a surface that reaches across orgs, the most attractive target for an attacker. Every route needs the route coverage, rate limit and CSRF treatment. Rejected for now. A Cloud console can sit in front of option A later.

**C. Keep the operator image roles only.**
- Good: nothing to build.
- Bad: no named person, no second factor, no owner consent, and full database credentials for every support task. That is what #31 will flag. Rejected.

## Decision (proposed)

Option A, with the following design.

### 1. Who staff are

- **Allowlist:** `crove_kernel.staff`, a control-plane table without `org_id`, like `worker_heartbeat`:
  - `user_id` (a `user_account`), `added_at`, `added_by_note` (who added them, as text), `removed_at`;
  - RLS on, no grants to any login role;
  - read only through the definer that enters a staff context.
- **Managing the list:** only the deployment operator, with the migration (admin) credentials, through `staff-add` and `staff-remove` image roles. Worker credentials are not enough, since staff stand above the worker. Each change is a row in `crove_kernel.staff_event`, a control-plane log that is append-only and read by no login role, and a security alert (the `security_signals` path, signal `staff_changed`).
- **Checked on every action, in the database:**
  - the allowlist row is live;
  - the user is not disabled;
  - the user has a verified second factor;
  - the token is `aal2` with a fresh second factor.
- **Removal and blocking:** removing a staff member, or blocking their account (`user-disable`), ends their access at the next action.

### 2. Support grants

- **Table:** `crove_kernel.support_grant`, a tenant table with `org_id` and RLS. Columns:
  - `issued_by` (an owner);
  - `reason` (the customer's words, for example a ticket number);
  - `access`: `read`, or `read_write` with `commands`, a list from a fixed staff-eligible set (section 3);
  - `le_scope`: every entity, or the ones the owner picks;
  - `staff_user_id`: one named staff member, or NULL for any staff member (**owner** decision S-4);
  - `starts_at`, `expires_at`, `revoked_at`, `revoked_by`.
- **Issuing:** `kernel.support_grant.issue`, owners only, R3 (a fresh second factor), audited.
  - Default length 24 hours, at most 7 days (**owner** decision S-6).
  - The owners and admins are notified, and the activity feed shows it.
- **Revoking:** `kernel.support_grant.revoke`, any owner or admin, R1, audited. It takes effect at the next staff action. A grant also ends at `expires_at`, and when the org is offboarded or closed.
- **One grant, one org.** A grant never covers another org, and staff never see which other orgs hold grants.
- **Screen:** Settings > "Support access" lists active and past grants, who used them, when, and with which commands or queries, from the audit log.

### 3. What staff may do

- **Without a grant**, nothing that reads or writes an org's data:
  - control-plane `staff.*` commands: global kill switches, feature flags (when they exist), the staff allowlist's own read, and aggregate diagnostics (`crove_kernel.health()`-style counts, never an org's rows);
  - entitlement overrides and an org-scoped kill switch touch one org's settings without reading its data, so they wait on **owner** decision S-5.
- **With a `read` grant:** the same query definitions the app uses, run read-only in a staff context:
  - RLS limits them to the grant's org and `le_scope`;
  - ADR-0037's restrictive policies keep private notes and to-dos out;
  - sealed credentials stay sealed;
  - the org export, the audit CSV and the personal-data finder stay out (they are bulk copies, not support).
- **With a `read_write` grant:** also the commands the owner named, taken from a fixed staff-eligible list kept in code. Candidates: re-run an extraction, retry a dead letter, re-sync a channel. All go through `Runtime.execute()` with actor `staff`.
- **Never:**
  - any R3 command, deciding or creating a proposal, or posting to the ledger;
  - membership, role, invite or org-setting changes;
  - offboarding, purge or export;
  - sending mail or posts as the org;
  - entering a user's or an agent's context.

  **Owner** decision S-2 chooses whether `read_write` exists at all in v1. The recommendation is `read` only.

### 4. No impersonation

- A staff context has actor `staff`, the staff member's user id and the grant id. It never has a member's user id, role or session.
- Staff never sign in as a user, never receive or mint a user's token, and never appear as the author of an org's records.
- Rows a staff action writes name the staff member (`actor_type` `staff`).

### 5. Audit and visibility

- **Every staff action in an org is an audit row in that org**, stamped by `audit_event_stamp` from the sealed context: `actor_type` `staff`, `actor_id` the staff member, `detail.supportGrantId`, and for queries the query name, never its result. Reads are audited for staff, though not for members, because the owner must see what support looked at.
- The rows are anchored in the WORM stream like any other.
- The owner reads them in the audit log and on the Support access card. The owners get a notification when a grant is first used and when it ends.
- **Control-plane staff actions** (no org) are rows in `crove_kernel.staff_event`, alerted through `security_signals`.

### 6. The database

- **New login role `crove_staff`:**
  - not a superuser, no BYPASSRLS, owns nothing, member of no owning role;
  - granted only what its definers and the query and command paths need, like `crove_app`, with the staff write allowlist below;
  - checked by a new invariant.
- **`crove_kernel.enter_staff_context(org, grant)`**, a definer for the `crove_staff` login only. It checks:
  - the allowlist;
  - the user's state and second factor;
  - that the token's claims were verified, in the transaction, as `session_check` does;
  - the grant: its org, its window, that it is not revoked, its named staff member;
  - that the org is active.

  It then seals `{actor: 'staff', org, user, grant, role: null, le_scope: the grant's, flags: ['read_only'] unless read_write}`.
- **`crove_kernel.enter_staff_control_context()`** for control-plane commands. It has no org, so every tenant policy returns nothing.
- **A staff write allowlist**, like the agents' one (#285). A staff context writes only `audit_event` and the tables of the commands its grant names. Every other `crove_*` table refuses it, enumerated from the catalog in the invariant test.
- **The audit stamp** gains a `staff` branch, and `audit_event.actor_type` accepts `staff`.

### 7. Today's database-owner exemptions

The "staff writes aside" exemptions in the invariants (the audit stamp, effect proposals, proposal status, VAT returns filed, and others) are about the **database owner**: a superuser or a member of the owning role. The staff actor is not that. `crove_staff` is neither a superuser nor a member of an owning role, so **none of those exemptions apply to it**. A staff context meets every guard as a tenant session does, plus its own allowlist.

- **No code changes** for this. The invariant prose is reworded to say "database owner", and a new invariant pins it: `crove_staff` holds no superuser, BYPASSRLS, owning-role membership or ownership.
- **Two steps for the build**, as AGENTS.md asks:
  - **Step 1:** add the new actor's invariants (staff context entry, the write allowlist, `crove_staff`'s role shape, the RLS matrix cases: another org, an expired grant, a revoked grant, `le_scope`). Also widen any invariant that enumerates actor types (for example a check that refuses an unknown actor) to accept `staff` only from `enter_staff_context`.
  - **Step 2:** the commands, the CLI and the screen.
  - The coordinator reviews each step.

## Decisions for the owner (stop cases)

Each one weakens tenancy or changes authentication, so the owner decides. The build waits on S-1 to S-3.

| # | Decision | Why it matters | Recommendation | Without an answer |
|---|---|---|---|---|
| S-1 | May staff read an org's data at all, with an owner's grant? | Today no one outside the org reads it through the product | Yes: read-only, under a grant the owner issues with a second factor, audited per read | Not built; support keeps using database credentials outside the product |
| S-2 | May staff write under a grant in v1? | A write by someone outside the org | No: read only in v1. Add a fixed list of repair commands later, case by case | Read only |
| S-3 | A new login role `crove_staff` and a staff sign-in path (the CLI with the staff member's own token, `aal2`) | A new way into the database and a new authentication path | Yes, as option A; no HTTP route | Not built |
| S-4 | Does a grant name one staff member, or allow any? | The owner does not know Crove's staff by name; naming one slows support | Any active staff member; every action names the person | Any staff member |
| S-5 | May staff flip an org's kill switch, or override its entitlements, without a grant? | They change an org's settings without reading its data, in an incident or for billing | Kill switch: yes, audited in the org and the owners notified. Entitlement overrides: yes, audited | Grant required |
| S-6 | Who issues and revokes a grant, and how long can it run? | The window of outside access | Owners issue (R3); owners and admins revoke; 24 hours by default, 7 days at most | As recommended |
| S-7 | Does the open-source core ship the staff actor, or only Crove Cloud? | Self-hosters run their own support | Core: the plan puts staff in the control plane, and the same tool serves both; Cloud runs it from `crove-ops` | Core |

**For a lawyer** (#62, with the DPA and the terms): support access to personal data under a grant is processor access. The terms and the data processing agreement should describe it: who, when, under whose instruction, and logged.

## Consequences

- Support stops needing database credentials for routine help, and every look at an org's data has a person, a reason, a time and an owner's consent attached.
- One new login role, three definers, three tables, and invariants for each, in two steps.
- The operator image roles stay as they are for operations that touch no org's data as staff (block a user, rebind exports, restore). They can move to the staff actor later, one at a time.
- The plan rows (§4.3, §4.12, §6, and the line in §3.6 that says "not built yet") point here.
