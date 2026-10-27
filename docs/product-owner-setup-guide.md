# Product-owner setup guide

> For the agent of another DOS.AI repository that is asked to set up the way Crove works with agents. Written from Crove's practice up to 2026-10-27. Read it whole, then adapt it: copy the ideas and the files, change the names, numbers and rules to fit your repository. Every link points to `DOS/Crove` on GitHub, so it opens from anywhere.

**If your repository already has its own agent process** (its own `AGENTS.md` or `CLAUDE.md` rules, a skill, a board, a claim habit; Second-Spawn is one), merge what is missing from this guide into that process. Do not add a second rule set next to it: two sets of rules contradict each other within a week, and agents then follow whichever they read last. Where the two disagree, keep the existing repository's rule unless the owner decides otherwise, and write the difference in your PR.

When the owner says "customize it to DOS.AI's skill and process", it means: take Crove's skill and procedures as the template, keep their shape and their safety rules, and rewrite everything Crove-specific (paths, areas, milestones, invariants, commands) for your repository.

## 1. The model on one page

- **The owner** (JOY) sets direction and decides what only a person can decide: money, accounts, credentials, production, legal sign-off, changes to written decisions. The owner does not code, run commands or merge, and should never have to type "continue" or "status?".
- **The plans are the backlog.** Work comes from written plans and designs in the repository (`docs/plan/*.md`, ADRs, a design file). Agents never build what no plan or design calls for; an idea outside the plans becomes a low-priority Icebox issue for later triage.
- **The board** is a GitHub Project. One task = one issue = one worktree = one branch = one PR. A task goes end to end (schema, server, contract, UI, tests), split by feature, not by layer.
- **Picking order:** earliest open milestone first, then `priority:P0`, P1, P2. Skip issues already `In progress`, issues labelled `owner-action`, the Icebox and paused milestones. When a milestone has no issue left, the agent derives the next issues from the plan, each citing the plan line it comes from, then builds one.
- **Claim by comment.** All agents share one GitHub account, so a comment is the lock: set Status to `In progress`, comment `Claimed by <agent>, branch <branch>`, read the comments again, and back off if someone else was first. A claim silent for 48 hours is stale and may be taken over, with the evidence in a comment.
- **Worktrees.** Nobody edits the main checkout. Each task has its own worktree under `.claude/worktrees/<task>` (Codex: `.codex/worktrees/<task>`), cut from a freshly fetched `origin/main`, removed after merge.
- **Agents merge their own PRs** when the merge bar is met: every CI check green, rebased on `origin/main` with no conflict, every review thread answered and resolved, and on protected paths a security review. Squash merge with the expected head SHA.
- **Ask the owner only for the stop cases:** losing or rewriting data, weakening authentication, tenancy, approval or financial rules, going against a written decision, new spending, production or credentials, anything a person must sign off. Ask once, link the issue, keep working on other tasks while waiting.
- **Memory lives on GitHub.** At each step of a task (PR opened, merged, blocked) the agent comments on its issue what is done and what is next. A resumed or compacted session reads its open claims before anything else.
- **Roles.** A coordinator session (Agent 0, the product-owner session) keeps the board honest, starts and reviews workers and reports to the owner; it does not build features. Area team leads (`Agent <n>: <area>`) each own one area and run up to 2 background subagents, so at most 3 issues `In progress` per lead. Any other session takes one issue at a time.
- **Reporting.** After each merge, one or two lines to the owner: what merged, what is next. Keep the words opened, merged and deployed distinct, and say what was verified and what was not. Once a day the coordinator sends one digest of items waiting on a person.

## 2. Tools on the machine

Install these once on each machine that runs agents, and check them before the first session.

1. **GitHub CLI (`gh`)**, version 2.100 or newer (Crove runs 2.103). Install it from https://cli.github.com, then sign in and add the project scope, which the board commands need:

   ```bash
   gh auth login
   ```

   ```bash
   gh auth refresh -s project,read:project
   ```

   Check with `gh auth status`: the token scopes must list `project`.
2. **Codex CLI**, used for independent second opinions and blind reviews (Crove's app-shell and identity decisions, ADR-0027 and ADR-0028, were each taken after a Codex review and a Claude review that did not see each other). Install it with Node 20 or newer:

   ```bash
   npm install -g @openai/codex
   ```

   Then sign in once with `codex login` and check with `codex --version`.
3. **Codex plugin for Claude Code** (`codex@openai-codex`, from https://github.com/openai/codex-plugin-cc). It gives Claude sessions the `codex:rescue` agent and the `/codex:setup` check, so a session can hand a diagnosis or a second implementation to Codex. In an interactive `claude` terminal:

   ```text
   /plugin marketplace add openai/codex-plugin-cc
   /plugin install codex@openai-codex
   /reload-plugins
   /codex:setup
   ```

4. **Claude desktop app (Code tab)**, recommended for the owner: it shows sessions side by side, lets the coordinator start worker sessions that wake it when they finish, and lets the owner follow from a phone.

## 3. The GitHub Project

One project per repository keeps the picking order unambiguous. Replace `<org>`, `<repo>` and `<n>` below.

**Create and link it:**

```bash
gh project create --owner <org> --title "<Repo name>"
```

```bash
gh project link <n> --owner <org> --repo <org>/<repo>
```

**Fields.** Crove uses the built-in fields plus:

| Field | Type | Options |
| --- | --- | --- |
| Status | single select | Backlog, Ready, In progress, In review, Done |
| Size | single select | XS, S, M, L, XL |
| Estimate | number | |
| Iteration | iteration | optional |

A new project starts with Status `Todo, In Progress, Done`. Rename and add options in the project's settings page, or with the GraphQL mutation `updateProjectV2Field` (its `singleSelectOptions` replaces the whole list, so pass every option). Add Size with:

```bash
gh project field-create <n> --owner <org> --name Size --data-type SINGLE_SELECT --single-select-options "XS,S,M,L,XL"
```

In the project's Workflows page, turn on "Item closed" and "Pull request merged" (set Status to Done) and "Auto-add to project" for the repository, so a closed issue never stays `In progress`.

**Labels.** Priorities, roles and one label per area:

```bash
gh label create "priority:P0" --repo <org>/<repo> --color b60205 --description "The current milestone cannot finish without it"
gh label create "priority:P1" --repo <org>/<repo> --color b60205 --description "Needed before the next gate"
gh label create "priority:P2" --repo <org>/<repo> --color d93f0b --description "Important, not blocking the next gate"
gh label create "priority:P3" --repo <org>/<repo> --color fbca04 --description "Later, starts on its trigger"
gh label create "owner-action" --repo <org>/<repo> --color e99695 --description "Needs a decision or action from the owner"
gh label create "review-followup" --repo <org>/<repo> --color c5def5 --description "Non-blocking review finding; Icebox unless it blocks a milestone"
gh label create "security" --repo <org>/<repo> --color 5319e7 --description "Security, tenancy or integrity"
gh label create "epic" --repo <org>/<repo> --color 3e4b9e --description "Tracks several issues"
gh label create "spike" --repo <org>/<repo> --color f9d0c4 --description "Time-boxed investigation"
```

Crove's area labels are `kernel`, `security`, `auth`, `finance`, `web`, `infra`, `tooling`, `cloud`; pick your own, one per team lead.

**Milestones.** Name them by user outcome, in order, plus an Icebox:

```bash
gh api repos/<org>/<repo>/milestones -f title="M0 Decisions and discovery" -f description="..."
```

Crove has M0 Decisions and discovery, M1 Pilot deploy, M2 Monthly close loop, M3 Paid pilot, a GA gate, and the Icebox. Each milestone's acceptance criteria live in a plan file (Crove: https://github.com/DOS/Crove/blob/main/docs/plan/backlog-review-2026-10-17.md, section 4), so agents can derive issues from it.

**The coordinator log.** Open one issue titled "Coordinator log" and pin it. The coordinator posts its lock and each cycle there (Crove: https://github.com/DOS/Crove/issues/1210).

**Reading IDs.** `gh` 2.103 edits items by issue URL and field name, which is the simplest route (older versions need `--id`, `--field-id` and `--project-id`, read with the commands after it):

```bash
gh project item-edit <n> --owner <org> --url https://github.com/<org>/<repo>/issues/<issue> --field Status --value "In progress"
```

When a script needs node IDs (older `gh`, GraphQL calls), read them fresh each time and never hard-code them in committed files:

```bash
gh project view <n> --owner <org> --format json --jq .id
```

```bash
gh project field-list <n> --owner <org> --format json --jq '.fields[] | {name, id, options}'
```

```bash
gh project item-list <n> --owner <org> --limit 1000 --format json --jq '.items[] | select(.content.number == <issue>) | .id'
```

Issues are added to the board when created: `gh issue create ... --project "<Project title>" --milestone "<milestone>" --label "priority:P2"`.

## 4. Files to copy and adapt

| Crove file | What it gives | What to change |
| --- | --- | --- |
| [AGENTS.md](https://github.com/DOS/Crove/blob/main/AGENTS.md), sections "Picking up work", "The owner, merging and reporting", "Worktrees" | Picking order, stop cases, claim procedure, WIP limit, Icebox rule, merge bar, owner reporting, worktree rules | Board URL, milestone names, area labels, owner name and language, the coordinator log issue |
| [AGENTS.md](https://github.com/DOS/Crove/blob/main/AGENTS.md), "Protected paths" | The idea: a list of paths whose change needs a security review and runs the base branch's invariant tests | Your own list (CI workflows, hooks, agent policy, dependency files, auth and money code). Drop Crove's invariant inventory |
| [AGENTS.md](https://github.com/DOS/Crove/blob/main/AGENTS.md), "Commands" and "Rules" | Shape only | Your commands and your architecture rules; keep "code and commits in English" and "no secrets in a public repo" |
| [.claude/skills/project-coordinator-cycle/SKILL.md](https://github.com/DOS/Crove/blob/main/.claude/skills/project-coordinator-cycle/SKILL.md) | The coordinator cycle (lock, read state, review workers, keep them busy, log), the team lead procedure (section 6), the worker brief template (section 5), "Limits learned the hard way" | Skill name and description, repository and project number, coordinator log issue, team lead areas, migration steps (drop them if your repository has no ordered migrations), commit email |
| [.github/workflows/docs-check.yml](https://github.com/DOS/Crove/blob/main/.github/workflows/docs-check.yml) with [tools/docs-check.mjs](https://github.com/DOS/Crove/blob/main/tools/docs-check.mjs) | Optional. A fast check that replaces agent review for docs-only PRs (dashes, balanced HTML, relative links) | Keep only the docs check step: the path boundary, migration order and migration lint steps call Crove-only scripts and apply Crove's policy |
| [.github/workflows/protected.yml](https://github.com/DOS/Crove/blob/main/.github/workflows/protected.yml) with [tools/ci/protected-paths.mjs](https://github.com/DOS/Crove/blob/main/tools/ci/protected-paths.mjs) | Optional. On protected-path PRs: the base branch's tests against the PR's code, and a security reviewer agent that needs an `ANTHROPIC_API_KEY` secret (an owner action) | Your path list and test command. Without the secret, a same-repository PR passes with a notice and the session writes its own security review; a fork PR on protected paths fails with "Maintainer security review required", since forks never get the secret |
| [.github/workflows/migration-recheck.yml](https://github.com/DOS/Crove/blob/main/.github/workflows/migration-recheck.yml), [tools/ci/migration-order.mjs](https://github.com/DOS/Crove/blob/main/tools/ci/migration-order.mjs), [tools/migration-rebase.mjs](https://github.com/DOS/Crove/blob/main/tools/migration-rebase.mjs) | Optional, only for timestamped SQL migrations. Fails a PR whose migration fell behind `main`, re-checks open PRs after each push to `main`, and renames a branch's migrations at merge time | Migration directory and file pattern |
| [.github/workflows/gitleaks.yml](https://github.com/DOS/Crove/blob/main/.github/workflows/gitleaks.yml) | Optional. Secret scan on every PR | Nothing, usually |

Rules for the copy:

- Pin third-party actions by commit SHA, as Crove does, and check that a pinned version exists before you rely on it.
- Put the policy file (`AGENTS.md`, or the file your repository already uses) and the skill on your protected-path list, so a later PR cannot quietly loosen the rules.
- Keep one source of truth. If your repository has `CLAUDE.md` and `AGENTS.md`, let one point to the other instead of copying text into both.
- Land the setup as one PR, with the owner-only steps (secrets, project settings the agent cannot reach) listed in its body as `owner-action` issues.

## 5. Opening a product-owner session

1. In the Claude desktop app, open a new Code session on the repository's main checkout (the coordinator only reads there and works through worktrees and GitHub). Title it `0: Điều phối` (the owner reads Vietnamese).
2. First message from the owner, adapted:

   > You are the coordinator (Agent 0) of `<repo>`. Run the `<your coordinator skill>` skill, then keep cycling with `/loop` and no interval.

3. The coordinator locks the coordinator log, reads the board, open PRs and sessions, and keeps the team leads busy; for work outside every team lead's area it starts up to 3 workers of its own. Team leads are started only on a turn the owner typed (the app refuses `start_session` on automated turns); give each one the `Agent <n>: <area>` brief from the skill's section 6. When a start is refused, the coordinator runs the same brief as a background subagent in its own worktree.
4. Workers on protected paths end with `READY FOR COORDINATOR REVIEW: <PR url> head <sha>` and wait for `approved, merge head <sha>`; the others merge when green and report `MERGED <PR url> <merge commit>`.
5. After two compactions, or after a day, the coordinator asks the owner to open a fresh coordinator session. State is on GitHub, so nothing is lost.

## 6. Lessons from Crove

Each of these cost real time on Crove; the rules above exist because of them.

**Planning**

- In the first weeks, the only milestones before product work were security gates, and agents pick the highest priority in the earliest milestone, so they always picked security. Every security review also filed its non-blocking findings as P2 in the same early milestones, which the next agent picked up: a loop that fed itself. About 55 of 125 commits were hardening while roughly 10 changed what a user sees (https://github.com/DOS/Crove/blob/main/docs/plan/backlog-review-2026-10-17.md, section 1). Fixes: milestones named by user outcome, review follow-ups go to the Icebox as P3, and security work is picked only when the current milestone's checklist needs it or a real high or critical vulnerability is found.
- Items an ADR explicitly deferred were built anyway, and an epic with no child issues left nothing to pick. Fixes: "never build what no plan calls for", and derive issues from the plan with the line they come from.
- Every step towards real users was an owner action with no date, and agents filled the gap with work they could do alone. Fix: `owner-action` issues with a recommendation and what happens without an answer, collected in a daily digest.
- Agents kept ending turns to ask whether to go on. Fix (owner decision 2026-10-20): work without stopping; a merged task is followed by the next one in the same session.

**Coordination**

- One shared GitHub account means only comments tell agents apart. GitHub has no atomic lock, so the earliest comment wins, and every agent reads the comments again after posting its claim.
- Six open issues were found missing from the board on 2026-10-24, invisible to every agent. The coordinator now checks each cycle for issues that are not board items.
- Finished sessions piled up in the sidebar. The coordinator archives a worker once its issue is closed and its last PR merged.
- The desktop app pauses cross-session messages after 10 sends without an owner turn. Send one message per session carrying everything, skip acknowledgements, and when paused post the instruction as a PR or issue comment.
- Messages to a busy session queue until its next tool round, so send an instruction before the step it changes.
- Parallel sessions share one usage quota: three workers hit the limit at once on 2026-10-22, and every agent stopped twice on 2026-10-24. After a reset, resume a stopped subagent instead of starting a new one, so its work is not redone.
- After a compaction, re-read the state on GitHub before acting. Compaction is where background agents lost or redid work: never assume a merge, claim or message you remember actually happened.

**Git and CI**

- GitHub auto-merge is off on Crove, so an agent must run the merge. Auto mode refuses force-pushes and pushes to another session's branch: update a PR with `gh pr update-branch`, merge with `gh pr merge <n> --squash --match-head-commit <sha>`.
- GitHub refuses commits made with a private email; commit with the account's `users.noreply.github.com` address.
- GitHub does not re-run PR checks when `main` moves, so two PRs could each pass with a migration version that collided after the first merged. Version reservations by the coordinator were tried and dropped (https://github.com/DOS/Crove/issues/1492); a rename script at merge time plus a re-check after every push to `main` replaced them.
- A review bot that is out of quota has not reviewed the PR. Say so in the PR and do not wait for it or loop on it.
- A temporary file with a generic name (`pr-body.md`) in a shared scratchpad was overwritten by another worker and briefly replaced a PR's body. Each worker keeps its files in its own subfolder.
- Never run two workers on overlapping files; each brief names the other running workers and their paths.

**Writing to the owner**

- In Vietnamese with full diacritics, in plain words, each technical term explained on first use, each issue or PR given with its number and short name.
- Every question says what is being decided, why it matters, the options, the recommendation, and what happens without an answer, and names who must act (the owner, an accountant, a lawyer, another agent).
- Links must open in a browser: GitHub URLs, never local paths. GitHub shows an `.html` file as source, so publish an owner page as a private claude.ai artifact or summarize it in the message.

## 7. Checklist for the adopting agent

1. Read your repository's existing agent rules, skills and board. Decide whether you are merging into an existing process or creating one, and say which in the PR.
2. Check the tools (section 2).
3. Create or adapt the project, fields, labels, milestones and the coordinator log (section 3).
4. Copy and adapt the files (section 4) in one PR in its own worktree; file the owner-only steps as `owner-action` issues.
5. Merge when the bar is met, then tell the owner in Vietnamese, in two or three lines: what is set up, the board link, how to open the coordinator session, and what waits on them.
