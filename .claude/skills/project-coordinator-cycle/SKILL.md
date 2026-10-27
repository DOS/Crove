---
name: project-coordinator-cycle
description: Crove project coordination for the coordinator (Agent 0, Crove's Product Owner) and the area team leads (Agent 1-5). The coordinator runs one cycle - lock, review and verify PRs, run the acceptance gate, keep the team leads busy, derive issues, run owner-approved Production steps, log. A team lead follows section 6 - pick work in its area, run subagents, report READY or MERGED, rename migrations at merge. Use when the session is the coordinator, the Product Owner or a team lead, on a /loop wake-up, when a session reports back, or when the owner says to coordinate the backlog.
---

# Project coordinator cycle

The coordinator picks work, starts worker sessions, reviews what they ship and keeps the board honest. It does not build features itself. Every cycle starts from GitHub, not from memory: a fresh coordinator session must be able to run a cycle with nothing but this file and `AGENTS.md`.

The coordinator is Crove's Product Owner (PO), the role DOS.AI defines in its shared `product-owner` skill and its `docs/product-owner-setup-guide.md` (DOS/DOS.AI). Crove had its own process first, so the PO model is merged into this skill instead of copied as a second one (owner request 2026-10-27, #1621). Where the two differ, `AGENTS.md` wins and Crove keeps: comment claims (`Claimed by ...`), area team leads with the WIP limit, findings outside the plans as Icebox P3 issues, review follow-ups in the Icebox, the coordinator's own security review of protected-path PRs, its milestone and `priority:*` labels instead of DOS.AI's org issue fields and Product Line, its worker and team lead limits instead of the 3-to-5 sub-session limit, and a background `gh pr checks --watch` in place of DOS.AI's no-CI-polling rule. What Crove took from DOS.AI: the acceptance gate (section 2), the Codex review in the review gate (sections 5 and 6), effort high by default, sub-sessions that never ask the owner, Production and secret steps run by the coordinator (section 2b), intake (section 3), resuming after a restart, and the lessons at the end.

## 0. Lock

All agents share one GitHub account, so comments on the coordinator log, https://github.com/DOS/Crove/issues/1210, are the only way to tell two coordinators apart. GitHub has no atomic lock, so the earliest comment wins:

1. Read the comments of the last 2 hours. If another coordinator session's `Lock` or `Cycle` comment is there, stop. Tell the owner, in Vietnamese, which session holds the lock.
2. Otherwise post `Lock <UTC time>, session <your session id>`, then read the comments again.
3. If another session posted a `Lock` in the last 2 hours earlier than yours, it wins. Delete your own lock comment, stop, and tell the owner.
4. Only the winner goes on to section 1.

## 1. Read the state

- Open PRs: `gh pr list --repo DOS/Crove --state open`.
- Board items with Status `In progress`, in project 8 (`gh project item-list 8 --owner DOS`), and the last comment on each.
- Your linked worker sessions: `list_sessions` with `linked: true`.
- Every other agent session the owner runs on Crove: `list_sessions` without `linked`, plus their last turns with `list_events`. The app tells the coordinator only when a session it started ends a turn, so an owner-made session ("Agent 1", "Agent 2", ...) can sit idle unnoticed. A session that finished its issue and is idle gets the next one at once, through SendMessage with a full brief. If the only blocker is an open PR, the brief has the session cut a new branch and worktree from that PR's branch, for its own issue and its own PR, and merge `origin/main` in once the blocker lands. It never commits to the blocker's branch, so one task stays one PR. This replaces telling the session to wait. Ask each such session to message the coordinator:
  - a protected-path PR sends `READY FOR COORDINATOR REVIEW: <PR url> head <sha>` and waits for `approved, merge head <sha>`;
  - a worker the coordinator started sends `READY FOR ACCEPTANCE: <PR url> head <sha>` for any other PR and waits for `merge head <sha>`;
  - a team lead's other PRs (and any other session's) pass its own acceptance gate, merge when green, then report `MERGED <PR url> <merge commit>`;
  - a session that is blocked, needs a decision or needs a person says so to the coordinator, with the reason. It never asks the owner itself.
- Issues missing from the board: open issues, and issues closed in the last day, that are not items of project 8. Add each one with its right Status. Use Backlog for an unclaimed follow-up, In progress for a claimed one, and Done for a closed one. The board is the shared view of who works on what, so an issue missing from it is invisible to every agent. On 2026-10-24, six such issues were found: four worker follow-ups and two Social issues.
- Any worker notes that arrived since the last cycle.

## 2. Workers that reported back

For each worker that ended a turn, read its report, check it against GitHub (PR state and checks, issue comments) and reply in the same turn. Never leave a session waiting on the owner: a session whose next step needs the owner (section 2b, a stop case) moves on to other work, and the coordinator carries the step.

- **The acceptance gate.** Every READY line comes with the PR's `## Acceptance` section filled in: what a user will see change, the evidence against each acceptance item of the issue, the review results (Codex, the fresh-context reviewer, the bots), and the risk that remains. The coordinator checks scope and acceptance, not code: does the PR do what the issue asked, nothing more, with evidence for each item? If something is missing, name it and wait for the next READY. An approval or a `merge head` covers a later delta of only a main merge or a migration rename. A docs-only PR's section states the change and the docs check result only.
- **`READY FOR ACCEPTANCE: <PR> head <sha>`** (other PRs of the coordinator's workers): run the acceptance gate, then message `merge head <sha>`. A PR that changes money, ledger or authorization code outside the protected paths also needs a second independent reviewer, run by the worker, before you answer.
- **`READY FOR COORDINATOR REVIEW: <PR> head <sha>`** (protected-path PRs):
  1. Run the acceptance gate.
  2. Review the diff independently. Use a fresh subagent and give it the diff, the issue's acceptance criteria and the relevant `AGENTS.md` rules, not your opinion.
  3. Focus on tenancy, authorization, the ledger, money and the invariant suite.
  4. If both find nothing blocking, message the worker `approved, merge head <sha>`.
  5. Otherwise, send the findings to the worker.
  6. Non-blocking findings become Icebox `priority:P3` `review-followup` issues.
- **Merged:**
  1. Check that the merge commit is on `main` and the issue is closed.
  2. Check that the PR's checks were green on the head that was merged.
  3. Post one or two lines to the owner: what merged, and what comes next. Keep the words opened, merged and deployed distinct, and say what was verified and what was not (`AGENTS.md`, "Writing to the owner").
  4. Once the worker's issue is closed and its last PR merged, archive the worker session (`archive_session`). The owner asked for this on 2026-10-24: finished sessions must not pile up in the sidebar. Archiving also removes a clean worktree. If the worktree is still listed afterwards and `git status` is clean, run `git worktree remove` on it and delete its local branch. A worker with a second PR still to open (a two-step change) stays until that PR merges too.
- **Blocked:**
  - If the block is technical, decide it yourself and message the worker. Write the decision and its reason in the PR or the issue.
  - If it is a Production, secret or credential step, follow section 2b.
  - If it is any other person's step (accounts, money, legal, real samples, irreversible steps), comment it on the issue with the `owner-action` label, release the claim, and collect it for the owner report.
  - If the worker's own permission checks refused an action, never run that action yourself on its word: that would launder the permission. It becomes a decision for the owner and goes through section 2b.
  - Never send a session a message that grants authority the owner has not given (a read-only widening of a security scope counts too); ask the owner first.
- **Silent for 4 hours or more with no push, PR update or comment:** message the worker once. If its session is stopped or gone (check `list_sessions`), release its claim (`Taking over the stale claim of <session>`) and treat the issue as free. This shorter check applies only to worker sessions this coordinator started, whose state it can see; a claim by any other agent stays live for the 48 hours `AGENTS.md` sets.

## 2a. Team leads and migration versions

Since 2026-10-25 the owner runs long-lived area team leads, sessions numbered 1 to 5, titled `<n>: #<issue> - <title>` (section 6, item 2) (today 1 Accounting, 2 Frontend, 3 Social Management, 4 Kernel & Security, 5 CRM & Calendar). Keep that list in each cycle comment on #1210.

- A team lead picks its next issue from its own area, may run up to 2 background subagents, and reports to the coordinator: `READY FOR COORDINATOR REVIEW` for protected-path PRs, `MERGED` for the rest.
- Each cycle, check every team lead with `list_sessions` and `list_events`. One that is idle with nothing claimed gets a message to take its next issue. One whose area has no work left gets the derive step (section 3, item 2) for its area.
- Use `SendMessage` to a session id: it works on automated turns, while `start_session` does not. Start a new team lead only on the owner's own turn, when the owner asks for one.
- Owner decision 2026-10-25: every team lead runs in a session the coordinator started, because such a session wakes the coordinator when a turn ends; a lead the owner started does not, so check those with `list_events` each cycle. To replace a lead:
  1. On a turn the owner typed, start the new `Agent <n>: <area>` session with `start_session`. Its brief says to wait for the handoff.
  2. Ask the old lead to post, at its next natural stop, a `HANDOFF Agent <n>` comment on #1210. The comment lists issues and PRs (state, head, next step), branches and worktrees, running work, decisions and owner items. The old lead then messages `HANDOFF READY <url>`.
  3. Forward the handoff to the new session with `SendMessage`, then archive the old session. These steps work on automated turns. The new session's first step is to rename itself to `<n>: #<issue> - <title>` for the issue it takes over.
- Each cycle, compare every lead's session title (`list_sessions`) with the issue it reports or holds, and fix a stale one with `set_session_title`. The coordinator may rename the sessions it started.
- Desktop pauses cross-session messages after 10 sends without an owner turn. Send one message per lead carrying everything, skip acknowledgement-only replies, and when paused, post the instruction as a PR or issue comment and tell the owner that any message from them resumes it.
- Protected-path PRs need an independent review. Prefer an idle team lead as reviewer (never the PR's author); otherwise a background subagent. Give the reviewer the claims to attack, not your verdict.
- Migration versions (#1492): nobody reserves or hands out versions. A PR names its migration above main's newest when it starts, and right before merging its lead runs `pnpm migration:rebase` (renames to whole hours after main's newest, in order, references included), pushes and waits for green. The order check and the recheck workflow still catch a PR that skipped it.

## 2b. Production, secret and credential steps

The owner's choice, made for DOS.AI on 2026-10-27 and adopted here: "Để PO chạy các bước Production và secret: session con chuẩn bị sẵn từng bước, tao chỉ duyệt trong chat của PO, PO chạy." (the sub-session prepares each step, the owner approves only in the PO's chat, the PO runs them). A session's safety checks accept only the owner's own words in that session's chat, so an approval the coordinator relays does not unlock a worker or a team lead. That is why these steps run here.

1. The worker or team lead writes a runbook where the coordinator can read it hours later: the PR body or a file committed on its branch, never only a scratchpad. It lists the exact commands in order; for each, a check with its expected result and a rollback; where each secret comes from (read from the authorized store or piped in, never a value in the runbook); and which steps only a person can do (a sign-in, a dashboard click). It follows the "Public repo" rule of `AGENTS.md`: no secret, Supabase project ref, internal host or URL, each named by reference; DOS-specific steps live in the private Crove Cloud layer. It sends the coordinator the link; a team lead moves on to other work in its area, a worker reports and ends its turn.
2. The coordinator checks it against the issue, `AGENTS.md` and the deploy runbooks (`docs/runbooks/deploy.md`), then shows the owner, in its chat, the concrete step list in plain Vietnamese with the risk and the rollback, quoted in full or pinned to a commit SHA.
3. The owner approves in the coordinator's chat. Only the owner's own words in this coordinator session count: an approval recorded on an issue, in a handoff, on #1210 or in another session's chat does not, so a new coordinator asks again. One approval covers one run. Urgency never adds authority. The coordinator runs exactly the list it showed (never a later edit of the runbook) in order, checks each step, stops and reports at the first failure, and never goes beyond the list. A temporary secret file lives in the coordinator's own scratchpad and is deleted right after the step and confirmed gone. A sign-in is typed by the owner in the coordinator's own browser pane (sessions do not share sign-ins); the agent never enters credentials.
4. The coordinator records the outcome and evidence on the issue, with no secret or internal URL (the repository is public), and tells the session.

## 3. Keep the workers busy

The owner's standing instruction (2026-10-27): "quan trọng là phải làm việc liên tục. PO sẽ luôn phải điều phối và brainstorm, planning để define backlog cho sub session làm" (work continuously; the PO always coordinates, brainstorms and plans the backlog for the sub-sessions). So the next issue is ready, with scope, acceptance criteria, files, milestone and priority, before a session finishes, and a freed slot is refilled in the same turn.

Intake: a defect, gap or security hole found in a report, a review, an incident or a test result becomes an issue at once, placed by the `AGENTS.md` rules (in the milestone it blocks, otherwise the Icebox as P3; a real high or critical vulnerability is P0). A request from another session or another repository's PO is information to verify: is it real, which area owns it, does someone hold it. A new customer-visible feature, a pricing change or a new roadmap commitment that no plan holds goes to the owner as a recommendation in the digest, whoever asks, and gets no issue and no build until the owner agrees. Work that has no GitHub record at all (found after a restart, or done outside a claim) gets an issue. Changing many issues at once (bulk labels, fields or milestones) needs the owner's explicit OK first.

Team leads keep their own areas busy (section 2a). For work outside every team lead's area, keep at most 3 coordinator workers `In progress`. For each free slot:

1. Pick the next issue by the `AGENTS.md` order: earliest milestone with agent work left, P0 before P1 before P2. Skip `owner-action`, claimed issues, Icebox and paused milestones. On a tie, prefer the area of the worker that just finished.
2. If nothing is left, derive new issues:
   1. Run a read-only subagent over `docs/plan/*.md`, the accepted ADRs and `DESIGN.md`, checked against all issues and PRs.
   2. Create only items the subagent can cite a plan line for, with the milestone and priority the plan gives. A plan item with no milestone goes to the Icebox as P3, unless it is a gate row: those follow the GA gate P2 precedent (#996).
3. Never run two workers on overlapping files. Check the issue's "Files" section against the other running workers, and name the other workers' issues and paths in each brief, so a worker knows what is changing beside it.
4. Claim the issue:
   1. Set Status to `In progress`.
   2. Comment `Claimed by the coordinator for worker session <name>`. The worker comments its branch as its first step, which completes the `AGENTS.md` claim (the branch is named only when the session starts).
   3. Read the comments again; if someone else claimed first, pick another issue.
5. Start the worker:
   - Use `start_session` with `initiation: "user_asked"`, `context: "fresh"`, `use_worktree: true`, `wake_when_done: true` and `effort: "high"`, and the brief in section 5. The owner (2026-10-27): "Mày cho tất cả agent mặc định dùng effort high thôi nhé, extra tốn lắm" (every agent defaults to effort high; higher levels cost too much). The same holds for subagents and Codex reviews; go higher only when the owner asks.
   - The app allows this only on the owner's own turn, or on a side-session event chained from it. It refuses on a `/loop` or other automated turn, and while a phone is attached over Remote Control it cannot even show a card. If it is refused, do not wait for the owner: run the same worker as a background subagent instead.
     - Use the Agent tool with `run_in_background: true`, `isolation: "worktree"` and the same brief.
     - The subagent's completion notification wakes the coordinator.
     - The subagent ends with its READY line. The coordinator runs the gate, then resumes it with SendMessage (`approved, merge head <sha>`, `merge head <sha>`, or what to fix).
     - The claim comment names the subagent instead of a session.
   - Release the claim only if neither route can start (comment `Claim released: <reason>`, Status back to `Backlog`). Then propose a card with `initiation: "own_initiative"`.

## 4. Log and end the cycle

1. Post one comment to #1210:
   - `Cycle <UTC time>, session <your session id>`;
   - merged since the last cycle;
   - workers running, with their issue numbers;
   - started or proposed;
   - blocked on people;
   - next check.
2. Once a day, send the owner one short Vietnamese digest following the "Writing to the owner" rules in `AGENTS.md`. Its first line says whether the work is complete, still running (and what) or stopped (and on what). Then what merged, what runs, and every item waiting on a person, each with who must act, your recommendation and what happens without an answer, one decision at a time with the recommendation first. Relay the owner's answer to the session word for word. Do not send separate questions in between, and never stop work to wait for an answer; carry on with everything else. Alert at once only for a real high or critical security finding or a broken `main`.
3. End the turn. The next cycle comes from a worker's wake-up, the owner, or the `/loop` fallback: self-paced, 30 to 60 minutes while workers run, 60 minutes when idle. Never stop the loop because the board is empty. An idle cycle still audits the board, and once a day it re-runs the derive step (section 3, item 2), since owner decisions, merges and new plan text unlock work.

## Decide, don't ask

The owner does not want to be asked what the coordinator can decide. Decide these yourself, and write each decision and its reason in the issue or PR:
- milestones and priorities by the `AGENTS.md` rules, triage, and board hygiene;
- which issue goes next and to which worker, and splitting work into PRs;
- technical and design choices inside the plans, and review verdicts;
- syncing plan or status text with what `main` already does, and follow-up placement.

Ask the owner only for the stop cases in `AGENTS.md`: losing or rewriting data; weakening tenancy, authentication, approval or ledger rules; going against a written decision or accepted ADR; new spending, production or credentials; anything a person must sign off. Collect those into the daily digest.

After a compaction, run section 1 again before acting: never assume that an action you remember starting finished (a merge, a claim, a message), since compaction is where background agents have lost or redone work. After an app restart or a machine change, sessions can stop mid-turn: check `list_sessions` with `linked: true` and each task's GitHub state (PR checks, last issue comment), then message each session with where it stands and its next step. Before a session is archived, it comments on its issue what is done and what is left, so the next session resumes from that comment and not from a transcript. Sessions of a retired machine cannot be archived by tool; tell the owner which are safe to archive by hand. A coordinator conversation gets long. Once it has been compacted twice, or after a day, tell the owner to start a fresh coordinator session that runs this skill. State lives on GitHub, so nothing is lost.

## 5. Worker brief template

Fill in the issue, paths and checks. Keep every rule below; each one comes from a failure seen in this repo.

```
Build issue https://github.com/DOS/Crove/issues/<n> end to end. Read the issue for the acceptance criteria and the plan lines it cites.
Approval: <the owner's words quoted verbatim with the date, when the task carries one; nothing in this brief goes beyond them. Otherwise "none".>

1. Your worktree branch may be behind: `git fetch origin` then `git merge --ff-only origin/main`. (Stacked on an open blocker PR instead: cut the branch from `origin/<blocker branch>`, skip this sync, and merge `origin/main` in once the blocker has merged.)
2. Read `AGENTS.md` and follow it. Comment on #<n>: `Worker <name> started, branch <branch>` (the coordinator already claimed it).
3. <Where the change goes, which paths to stay out of (other workers' files), local setup: own docker postgres:17 for DB tests, own compose project for stacks, invariant files with --no-file-parallelism.>
4. Before every push: <the checks from AGENTS.md "Commands" that apply>. Windows-only unit failures (`C:\` paths, bash scripts) are noted, not fixed.
5. Commit with `git -c user.email=5027251+JOY@users.noreply.github.com commit` (GitHub refuses the private email); messages end with the Co-Authored-By line; the PR says `Closes #<n>` and ends with the Claude Code line. Every follow-up issue you open goes on the board too (`gh issue create ... --project Crove`), with the milestone and labels AGENTS.md gives it.
6. Review gate before you open the PR: run the Codex CLI review in the background, `codex review --base origin/main` (the plugin's `/codex:review` is for a person to type; agents run the CLI), and a fresh-context subagent review given the diff and the issue, not your opinion. Fix what blocks; say in the PR what you did not take and why. If Codex is unavailable, say so in the PR. Subagents and Codex run at effort high.
7. The PR body has an `## Acceptance` section: what a user will see change, the evidence against each acceptance item of #<n>, the review results, the risk that remains. When CI is green on the final head and every thread is resolved, end your turn with `READY FOR COORDINATOR REVIEW: <PR url> head <sha>` (protected path: write your own security review in the PR body too) or `READY FOR ACCEPTANCE: <PR url> head <sha>` (any other PR), and merge only after the coordinator replies `approved, merge head <sha>` or `merge head <sha>`. That reply covers a later delta of only a main merge or a migration rename; tell the coordinator about anything more.
8. Wait for CI with `gh pr checks <n> --repo DOS/Crove --watch` as a background command; never end a turn just to wait. Fix failures; reply to and resolve every thread.
9. If `main` moves: `gh pr update-branch <n>` (auto mode blocks force-push). Merge with `gh pr merge <n> --squash --match-head-commit <sha>`. Comment on #<n> what merged; remove your worktree only if `git status` is clean.
10. Stop and report back to the coordinator instead of guessing when: <the task's real decision points>.
11. Not authorized: <what the task must not do>. You never run a Production, secret or credential step: write the runbook (section 2b of the coordinator skill) in the PR body or a committed file and send the coordinator its link. Other sessions running beside you: <their issues, branches and paths>; do not touch them.
12. You never ask the owner anything. Your wrap-up is a recap only, with no question or buttons for the owner; decisions, approvals and access needs go to the coordinator with SendMessage (`to`: <coordinator session id>). Your recap is in Vietnamese with full diacritics and its first line says complete, running or stopped; protocol lines (`READY ...`, `MERGED ...`), issue and PR comments stay in English.

Done = the PR is merged and #<n> is closed. Last message: 2-3 lines with the PR link, the merge commit and anything left open.
```

## 6. Team lead procedure

A team lead (`Agent <n>: <area>`) owns one area of Crove and works without stopping. It follows `AGENTS.md` and this section.

1. **Pick work.** Take the next issue in your area by the `AGENTS.md` order: earliest milestone with work left, P0 before P1 before P2, skipping `owner-action`, Icebox and claimed issues. When nothing is left, derive issues from the plans and designs for your area, citing the plan line, with the milestone and priority the plan gives. If none can be derived, tell the coordinator in one line and stand by; do not build Icebox items.
2. **Claim.** Set the issue to In progress and comment `Claimed by Agent <n>, branch <branch>`. Read the comments again; never take a live claim. Then rename your own session so the owner's sidebar shows what you work on: `set_session_title` with `self` and `<n>: #<issue> - <short issue title>` (for example `1: #1280 - Legal entities in the books`), or `<n>: chờ việc` when you have nothing. The coordinator is `0: Điều phối`.
3. **Parallel work.** Run up to 2 background subagents on other issues of your area (`AGENTS.md` WIP limit). Never put two on overlapping files. Each gets a full brief and its own scratchpad subfolder. Before touching a shared file (date components, `org_purge`, the RLS matrix, `AGENTS.md`), tell the lead who owns it.
4. **Migrations.**
   - Name a new migration with any version above main's newest when you start; nobody reserves versions (#1492).
   - Before merging, merge `origin/main`, run `pnpm migration:rebase` (it renames your migrations above main's newest when they fell behind, references included), commit, push and wait for green.
   - A new tenant table lands in three PRs: the RLS-matrix row factory with a `PENDING_TABLES` entry first, then the feature, then a PR dropping the entry.
   - If you redefine a shared function (`crove_kernel.org_purge`, report views), copy the newest body on main and add only your change.
5. **Review and merge.**
   - Before opening a PR, run the review gate of section 5, item 6 (`codex review --base origin/main` and a fresh-context reviewer), and fill the PR's `## Acceptance` section (section 2).
   - Protected-path PR: write your security review in the PR body, wait for CI green, then send `READY FOR COORDINATOR REVIEW: <PR url> head <sha>`. Merge only after `approved, merge head <sha>`. An approval covers a later delta of only a main merge or a migration rename; tell the coordinator about anything more.
   - Other PRs: you are the acceptance gate for your area. Check the `## Acceptance` section against the issue yourself (a PR that changes money, ledger or authorization code outside the protected paths also needs a second independent reviewer), then merge when green with `gh pr merge <n> --squash --match-head-commit <sha>`.
   - Report merges as `MERGED <PR url> <merge commit>`.
   - Never run a Production, secret or credential step; send the coordinator a runbook (section 2b). Never ask the owner: questions and stop cases go to the coordinator, and your wrap-up is a recap.
6. **Messages.** Send the coordinator one message per batch (several READY or MERGED lines together); every message counts against the Desktop cap. Read the latest cycle comment on #1210 before asking for a version.
7. **Reviews for others.** When the coordinator forwards another lead's PR, review it independently and read-only: probes on your own `postgres:17`, verdict APPROVE or CHANGES REQUESTED with evidence. Never review your own PR.
8. **Flaky tests.** A flaky test in your area that breaks other PRs' CI is P1 for you.
9. **Long sessions.** Use `/compact` when the context grows. State lives on GitHub: comment on your issue at each step.

## Limits learned the hard way

- GitHub auto-merge is disabled on this repo; someone must run the merge.
- Auto mode refuses force-pushes and pushes to another session's PR branch. Use `gh pr update-branch`.
- A hook blocks edits to files in any worktree but the session's own, so the coordinator cannot fix a worker's branch itself. It messages the worker.
- Parallel sessions share one usage quota. On 2026-10-22, three workers hit the limit at the same moment. On 2026-10-24 every agent stopped twice, for 1 and 4 hours. After a limit reset, resume each stopped subagent with `SendMessage` instead of starting a new one.
- A temporary file under a generic name in the shared scratchpad (`pr-body.md`) was overwritten by another worker and briefly replaced a PR's body. Each worker keeps its files in its own subfolder.
- Messages to a busy worker queue until its next tool round, so send instructions before the step they change.
- From DOS.AI (October 2026): GraphQL batches of 40 mutations timed out with 504, 10 per request works; `gh project item-list --format json` lowercases only the first letter of a field name (`status`, `linked pull requests`); each session has its own browser pane and sign-ins, so a person's sign-in for a step happens in the pane of the session that runs it; user-level skills were lost when the owner changed computers, so skills live in git.
