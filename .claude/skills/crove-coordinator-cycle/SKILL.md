---
name: crove-coordinator-cycle
description: Run one Crove coordinator cycle - check the lock, review and verify worker PRs, keep up to 3 worker sessions busy from the board, derive issues from the plans when the board is empty, and log the cycle. Use when the session is the Crove coordinator, on a /loop wake-up, when a worker session reports back, or when the owner says to coordinate the backlog.
---

# Crove coordinator cycle

The coordinator picks work, starts worker sessions, reviews what they ship and keeps the board honest. It does not build features itself. Every cycle starts from GitHub, not from memory: a fresh coordinator session must be able to run a cycle with nothing but this file and `AGENTS.md`.

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
- Any worker notes that arrived since the last cycle.

## 2. Workers that reported back

For each worker that ended a turn:

- **`READY FOR COORDINATOR REVIEW: <PR> head <sha>`** (protected-path PRs):
  1. Review the diff independently. Use a fresh subagent and give it the diff, the issue's acceptance criteria and the relevant `AGENTS.md` rules, not your opinion.
  2. Focus on tenancy, authorization, the ledger, money and the invariant suite.
  3. If the review finds nothing blocking, message the worker `approved, merge head <sha>`.
  4. Otherwise, send the findings to the worker.
  5. Non-blocking findings become Icebox `priority:P3` `review-followup` issues.
- **Merged:**
  1. Check that the merge commit is on `main` and the issue is closed.
  2. Check that the PR's checks were green on the head that was merged.
  3. Post one or two lines to the owner: what merged, and what comes next. Keep the words opened, merged and deployed distinct, and say what was verified and what was not (`AGENTS.md`, "Writing to the owner").
  4. Once the worker's issue is closed and its last PR merged, archive the worker session (`archive_session`). The owner asked for this on 2026-10-24: finished sessions must not pile up in the sidebar. Archiving also removes a clean worktree. If the worktree is still listed afterwards and `git status` is clean, run `git worktree remove` on it and delete its local branch. A worker with a second PR still to open (a two-step change) stays until that PR merges too.
- **Blocked:**
  - If the block is technical, decide it yourself and message the worker. Write the decision and its reason in the PR or the issue.
  - If it is a person's step (accounts, money, legal, real samples, irreversible steps), comment it on the issue with the `owner-action` label, release the claim, and collect it for the owner report.
- **Silent for 4 hours or more with no push, PR update or comment:** message the worker once. If its session is stopped or gone (check `list_sessions`), release its claim (`Taking over the stale claim of <session>`) and treat the issue as free. This shorter check applies only to worker sessions this coordinator started, whose state it can see; a claim by any other agent stays live for the 48 hours `AGENTS.md` sets.

## 3. Keep the workers busy

Keep at most 3 issues `In progress` across all agents, at least 2 of them in the current milestone (`AGENTS.md`). For each free slot:

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
   - Use `start_session` with `initiation: "user_asked"`, `context: "fresh"`, `use_worktree: true` and `wake_when_done: true`, and the brief in section 5.
   - The app allows this only on the owner's own turn, or on a side-session event chained from it. On a `/loop` or other automated turn the call is refused. If it is refused:
     1. Release the claim at once: set Status back to `Backlog` and comment `Claim released: the worker could not start on an automated turn`.
     2. Propose the worker with `initiation: "own_initiative"`.
     3. Tell the owner one card is waiting. Do not retry.

## 4. Log and end the cycle

1. Post one comment to #1210:
   - `Cycle <UTC time>, session <your session id>`;
   - merged since the last cycle;
   - workers running, with their issue numbers;
   - started or proposed;
   - blocked on people;
   - next check.
2. Once a day, or when something new needs a person, send the owner a short Vietnamese report following the "Writing to the owner" rules in `AGENTS.md`: what each open item is, who must act, your recommendation, and what happens without an answer.
3. End the turn. The next cycle comes from a worker's wake-up, the owner, or the `/loop` fallback (self-paced, 30 to 60 minutes when workers run, longer when idle).

After a compaction, run section 1 again before acting: never assume that an action you remember starting finished (a merge, a claim, a message), since compaction is where background agents have lost or redone work. A coordinator conversation gets long. Once it has been compacted twice, or after a day, tell the owner to start a fresh coordinator session that runs this skill. State lives on GitHub, so nothing is lost.

## 5. Worker brief template

Fill in the issue, paths and checks. Keep every rule below; each one comes from a failure seen in this repo.

```
Build issue https://github.com/DOS/Crove/issues/<n> end to end. Read the issue for the acceptance criteria and the plan lines it cites.

1. Your worktree branch may be behind: `git fetch origin` then `git merge --ff-only origin/main`.
2. Read `AGENTS.md` and follow it. Comment on #<n>: `Worker <name> started, branch <branch>` (the coordinator already claimed it).
3. <Where the change goes, which paths to stay out of (other workers' files), local setup: own docker postgres:17 for DB tests, own compose project for stacks, invariant files with --no-file-parallelism.>
4. Before every push: <the checks from AGENTS.md "Commands" that apply>. Windows-only unit failures (`C:\` paths, bash scripts) are noted, not fixed.
5. Commit with `git -c user.email=5027251+JOY@users.noreply.github.com commit` (GitHub refuses the private email); messages end with the Co-Authored-By line; the PR says `Closes #<n>` and ends with the Claude Code line.
6. Protected path: write your own security review in the PR body, then, when CI is green on the final head, end your turn with `READY FOR COORDINATOR REVIEW: <PR url> head <sha>` and merge only after the coordinator replies `approved, merge head <sha>`. Not protected: merge yourself when green.
7. Wait for CI with `gh pr checks <n> --repo DOS/Crove --watch` as a background command; never end a turn just to wait. Fix failures; reply to and resolve every thread.
8. If `main` moves: `gh pr update-branch <n>` (auto mode blocks force-push). Merge with `gh pr merge <n> --squash --match-head-commit <sha>`. Comment on #<n> what merged; remove your worktree only if `git status` is clean.
9. Stop and report back instead of guessing when: <the task's real decision points>.

Done = the PR is merged and #<n> is closed. Last message: 2-3 lines with the PR link, the merge commit and anything left open.
```

## Limits learned the hard way

- GitHub auto-merge is disabled on this repo; someone must run the merge.
- Auto mode refuses force-pushes and pushes to another session's PR branch. Use `gh pr update-branch`.
- A hook blocks edits to files in any worktree but the session's own, so the coordinator cannot fix a worker's branch itself. It messages the worker.
- Parallel sessions share one usage quota. On 2026-10-22, three workers hit the limit at the same moment, which is why there are 3 workers at most.
- Messages to a busy worker queue until its next tool round, so send instructions before the step they change.
