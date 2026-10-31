# Product Owner config: DOS/Ludy

Repository-specific values for the shared `product-owner` and `task-claim` skills of the cc-po plugin, the same
skills DOS/DOS.AI and DOS/DOS.Me use. The keys and their defaults are in the plugin's
`product-owner/config-schema.md`; check this file with its `check-config.mjs`. Sessions read this file at run time
and it carries JOY's authority, so a change to it is a change to agent instructions, not a docs-only change.

## Owner and reporting

- owner_name: JOY
- owner_profile: the repository owner, a non-coder who does not code, run
  commands, read diffs or merge. Agents own technical decisions and merge
  their own PRs once they meet the merge bar; they bring JOY only material
  product, business, risk and Production decisions, one at a time, in plain
  words.
- report_language: Vietnamese with full diacritics, in plain words; explain
  a technical term in Vietnamese the first time it is used, and give every
  issue or PR number with its short name. The first line says whether the
  work is done, still running (and what) or stopped (and on what). Code,
  comments, commits, PRs, issues and messages to other agents stay in
  English, with no em dashes.
- agent_account: every runtime posts as the JOY GitHub account, so
  Assignees stay empty; the claim comment is the lock (AGENTS.md).

## Board

- project_url: https://github.com/orgs/DOS/projects/8 (Ludy)
- project_owner: DOS
- project_number: 8
- project_id: PVT_kwDOA388Vc4BhIzl
- product_line_field: PVTSSF_lADOA388Vc4BhIzlzhn4WEI (options in Lines)
- priority_field: none (priority is the `priority:P0` to `priority:P3`
  labels, see AGENTS.md)
- sprint_field: none
- bot_owned_fields: none

JOY chose 7-day sprints on 2026-10-30. The board has only an old 14-day
`Iteration` field, and creating a new 7-day `Sprint` iteration field from a
session was refused by its permission check. Once JOY or a session with that
permission adds it, set `sprint_field` to `<field id>; Sprint, 7 days` and
turn on `sprint_review` with `line_scopes`.

## Lines

| Line | Label | Product Line option id | PO session |
| --- | --- | --- | --- |
| Accounting (Ludy Kế toán: ledger, VAT, invoices, bank feeds, MISA, `modules/finance`) | `line:accounting` | `c6def6cf` | `Accounting Product Owner` |
| Frontend (UI/UX: the app in `apps/app`, `packages/ui`, the landing page ludy.vn in `apps/web`, the logo) | `line:frontend` | `b395d36d` | `Frontend Product Owner` |
| Notes & CRM (notes, to-dos, bookings and calendar) | `line:notes-crm` | `b8743ac2` | `Notes & CRM Product Owner` |
| Social Management (`modules/social`) | `line:social-management` | `735657ce` | `Social Management Product Owner` |
| Platform (the shared backend core: kernel, database, tenancy, authentication and sessions, the command runtime, the WORM archive; architecture and ADRs; security reviews; CI, deploy and operations) | `line:platform` | `3d3f0729` | `0: Điều phối` (the coordinator session) |

- Social is paused (decision D5): its PO starts work only once JOY reopens
  it (the open question on #236).
- Platform owns what every line builds on, not the features: a line's own
  feature stays with that line even when it adds a migration or a kernel
  command. Platform owns the shared core itself, the architecture (ADRs),
  CI, deploy and operations. Its PO, the coordinator session, also runs the
  Opus security review of every protected-path PR from any line.
- Each line owns its feature's behavior and data; Frontend owns presentation
  and UX across the apps.

## Issue fields

The DOS organization ids are the same in every DOS repository.

- issue_types: Task `IT_kwDOA388Vc4As2J7`, Bug `IT_kwDOA388Vc4As2J9`,
  Feature `IT_kwDOA388Vc4As2KA`
- org_priority_field: `IFSS_kgDOAOxu8w`; Urgent `IFSSO_kgDOAZ2tDA`, High
  `IFSSO_kgDOAZ2tDQ`, Medium `IFSSO_kgDOAZ2tDg`, Low `IFSSO_kgDOAZ2tDw`
- org_effort_field: `IFSS_kgDOAOxu9g`; High `IFSSO_kgDOAZ2tEA`, Medium
  `IFSSO_kgDOAZ2tEQ`, Low `IFSSO_kgDOAZ2tEg`
- issue_notes: every issue also carries its milestone and a `priority:P*`
  label as AGENTS.md gives them; review follow-ups go to the Icebox as
  `priority:P3` and `review-followup`.

## Rule documents

- agent_instructions: `AGENTS.md`
- task_scope: `AGENTS.md`, "Picking up work" (one task, one issue, one
  worktree, one PR; split by feature).
- tracking_doc: `AGENTS.md`, "Picking up work" (Status `In progress` plus
  the claim comment `Claimed by <session>, branch <branch>`; stale after 48
  hours).
- review_rules: `AGENTS.md`, "The owner, merging and reporting" and
  "Protected paths"; `CONTRIBUTING.md`.
- domain_rules: `AGENTS.md`, "Rules"; `DESIGN.md` for UI and brand;
  `docs/adr/` for accepted decisions.
- roadmap_sources: `docs/plan/backlog-review-2026-10-17.md` (milestones M0
  to M3 and the GA gate), `docs/plan/*.md`, `DESIGN.md`.
- decision_log: https://github.com/DOS/Ludy/issues/1210 (the coordinator
  log; owner decisions are also written into AGENTS.md with their date).

## Branches, environments and gates

- integration_branch: main
- integration_merge: squash
- default_branch: main
- draft_pr_first: no
- production_branch: none
- production_effect: two things ship from `main`.
  - Every merge into `main` deploys the landing page (`apps/web`) to
    Vercel Production on ludy.vn and ludy.so within minutes.
  - The app reaches the pilot instance only through `deploy.yml` on a `v*`
    tag of `main`. Pushing that tag is a Production step that JOY approves
    in the coordinator's chat (AGENTS.md, "Production, secret and
    credential steps").
- test_environment: none yet (a beta instance from a `dev` branch is
  planned in plan §3.5).

## Checks and review

- required_checks: every CI check green on the final head, including
  "Invariant suite (from base)", which runs the base branch's copy of the
  invariant suite on protected-path PRs; the migration order check for PRs
  with a migration; all review threads resolved. A review bot out of quota
  is not a failure.
- claim_gate: none
- external_review_app: none
- local_reviews: `codex review --base origin/main` in the background, then
  a fresh-context subagent given the diff and the issue; docs-only PRs skip
  both and need `pnpm docs:check`. A protected-path PR also gets the
  coordinator's independent security review before merge.
- agent_effort: high. PO sessions run on Opus at effort high. Every sub-session
  runs on Sonnet 5.5 (`claude-sonnet-5-5`) at effort high, and at xhigh only
  for hard work (a protected-path security change, a migration, a root-cause
  hunt). The coordinator's security review of a protected-path PR runs on
  Opus; Codex reviews at effort high (AGENTS.md, owner decisions 2026-10-27,
  2026-10-30 and 2026-10-31).

## Sessions

- sub_sessions_normal: 1 (JOY caps the repository at 3 sub-sessions at
  once, across every line; owner decision 2026-10-31)
- sub_sessions_max: 2

A PO keeps its context small at natural breaks. With a warm cache, it uses
`/compact` with a focus. After a long idle, such as overnight, it starts a
fresh session from a handoff file instead. Its loop wakes at most 30 minutes
apart, inside the one-hour prompt cache (owner decision 2026-10-31).
- check_in_minutes: 30

JOY's standing instructions (work without stopping; the coordinator merges every PR that meets the merge bar) are
in AGENTS.md and the decision log above.
