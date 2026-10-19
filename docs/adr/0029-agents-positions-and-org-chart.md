# 0029. Agents as org members: positions, an org chart shared with humans, and tasks

- Status: accepted. The owner set the direction on 2026-10-14. Phase 1 is implemented (issue #79); its tables and fields are in "Phase 1 as built" below.
- Date: 2026-10-14
- Deciders: owner (JOY)
- Builds on: plan §4.3 (actors), §4.5 (context), §4.6 (authorization), §4.7 (policy and risk levels), §8 (AI layer), §8.9 (external agents); ADR-0027 (the open-source core has no DOS dependency)
- Supersedes: plan §8 "One agent per org: one persona, several skill packs per module"
- Tracking: plan Tracking "External-tenant gate" row T18

## Context and problem statement

The owner wants every module to ship one or more agents, for example a Chief Accountant agent ("Kế toán trưởng") in Accounting. An org has an org chart; every seat has tasks and a job description. Humans and agents work together, and where a module or a whole org has no humans, agents work with each other.

The idea comes from Paperclip ([github.com/paperclipai/paperclip](https://github.com/paperclipai/paperclip), MIT). Per our review of a local clone on 2026-10-14, Paperclip has:
- agents in an org chart (`agents.reports_to`);
- issues with a single assignee and an atomic checkout;
- a wake-up queue (timer, assignment, mention) that coalesces requests;
- run records;
- budget policies with soft and hard stops;
- a human "board" that approves hires, strategy and budget overrides.

In that review, some of Paperclip's model did not fit Crove:
- humans cannot hold positions in Paperclip's org chart;
- delegation and escalation are conventions in the agents' instructions, not rules the server enforces;
- there is no single write path, no risk levels and no row-level security;
- the product targets coding agents.

Crove already has the `agent` actor kind, risk levels R0-R3, policy P01-P13, proposals and the AI Inbox, audit, outbox and jobs, RLS per org, and built-in roles such as `finance.chief_accountant`. The question is how to add an org chart in which humans and agents hold seats, without weakening any of these.

## Decision

### 1. The position is the unit of the org chart

`crove_kernel.position (org_id, id, title, module, role_key, reports_to, holder_user_id, holder_agent_id, le_scope, flags, job_description, status)`.

- **Holder.** At most one holder: a human or an agent.
  - `holder_user_id` has a composite FK `(org_id, holder_user_id)` to `tenant_member` with `ON DELETE SET NULL`, so removing a member vacates the position.
  - `holder_agent_id` has a composite FK to `agent`.
  - `CHECK (num_nonnulls(holder_user_id, holder_agent_id) <= 1)`.
  - Both NULL means the position is vacant.
  - A partial unique index allows an agent to hold at most one position.
- **Chart structure.** `reports_to` has a composite FK `(org_id, reports_to)` and a no-self-reference check. A trigger rejects cycles and takes a per-org advisory lock, so two concurrent updates cannot form one.
- **Scope.** `le_scope` and the sensitivity `flags` default to none.
- **Job description.** `job_description` is structured: responsibilities, KPIs and working hours.
- **Root.** In every org the owner is the root human of the chart. A position without `reports_to` reports to the owner.

### 2. Agents are org members with their own identity, not tenant members

`crove_kernel.agent (org_id, id, template_key, display_name, runtime builtin|external, model_alias, status active|paused|retired, max_risk, created_by)`.

- **Not members.** A position-holding agent is not a `tenant_member` and has no `role_assignment` (that table is FK'd to `tenant_member`, §4.6).
- **Effective permissions.** They resolve from `position.role_key` through `role_permission`, intersected with the template ceiling, the agent's `max_risk`, the position's `le_scope` and `flags`, the trigger class and taint (§4.7). An agent never gets more than a human in the same position would.
- **Context entry (§4.5).**
  - Background runs enter through the worker with a live `ai_run` reference.
  - At entry the DB checks that the agent is `active`, still holds an `active` position, that the run is live, and that no budget or kill switch is tripped. Nothing is taken from parameters.
- **Chat agents.** An agent that a user invokes in their own chat keeps the current model (`on_behalf_of`, user ∩ grant).

### 3. Modules declare agent templates; only humans manage the chart

**Templates.** Modules declare agent templates in their manifest, for example `finance.chief_accountant`. A template carries:
- a default title, such as "Kế toán trưởng (AI)";
- a job description;
- its tools: the module's commands and queries marked `ai.expose`;
- subscribed events and a default schedule;
- a ceiling `max_risk`.

Installing a template creates a position and an agent from data.

**Chart and agent management.**
- These commands are **user-only**: create or edit a position (`role_key`, `reports_to`, `le_scope`, `flags`, `job_description`), change a holder, install a template, change an agent's `max_risk` or status, set budgets, and use kill switches. They are never `ai.expose`, never `allowSystem`, and never reachable through an agent grant.
- These need a human with the permission and `aal2`: raising `max_risk`, changing `role_key`, `le_scope` or `flags`, or giving a position to an agent.
- No agent can edit any position, job description or reporting line, its own or another's. The LLM never sees or edits policy (§4.7).

### 4. Work is tasks; collaboration is enforced by the kernel

The kernel `task` gains these fields:
- `assignee_position_id` and `parent_task_id`;
- `created_by` (actor plus run);
- `source`: `event`, `proposal`, `human` or `schedule`;
- `status`: `todo`, `in_progress`, `waiting`, `in_review`, `done` or `cancelled`;
- `due` and `request_depth`;
- `taint`;
- a checkout lease: `checkout_run_id`, `lock_expires_at` and a fencing token.

**Checkout.**
- A task is claimed through `execute()`. The caller must be the holder of `assignee_position_id`. The claim is `UPDATE ... WHERE checkout_run_id IS NULL OR lock_expires_at < now()`, and it increments the fencing token.
- Every write made under the claim carries the token, and a run that lost its lease is rejected.
- The lease is released on completion, on pause, and on a holder change.

**Delegation.** An agent creates subtasks only for positions inside its own subtree.

**Escalation.** An agent escalates when a step needs more risk than its `max_risk`, a permission it lacks, or more budget than its limit, or when it is not confident. Escalating creates a task or a proposal for its supervisor position.
- If the supervisor position is vacant or paused, or the agent is at the root, escalation goes to the nearest human up the chart, otherwise to the owner.
- Humans see escalations in the AI Inbox.

**Depth.** `request_depth` increments on both delegation and escalation and is inherited through `parent_task_id`. It has a cap, and chains started by agents also keep the causal depth of at most 5 (§4.3, automation).

**Communication and taint.**
- Agents communicate only through tasks, comments and proposals, so all of it is audited.
- Task, comment and subtask content inherits the taint of its source.
- `task.source` and the causal chain feed P03 and P07.
- The actors in a task's creator chain count as authors for P10.

### 5. Wake-ups run on the existing outbox and jobs

- **Requests.** A task assignment, a mention, a subscribed event or a schedule creates an `agent_wakeup` request. Requests are coalesced per agent.
- **Execution.** One job per agent runs at a time (`orderingKey` = agent). Each run is an `ai_run`.
- **Limits.** Concurrency 1 per agent, a daily run cap, the `request_depth` cap, and the causal depth limit.

### 6. Approvals reuse proposals; humans close the risky ones

- **Who approves.** Eligible approvers are the holders of positions with the command's permission and legal-entity scope (P12).
- **When an agent may approve.** An agent-held position may approve R1 or R2 within its `max_risk` only if all of these hold:
  - no rule among P03, P04, P05, P06 or P07 is in the proposal's outcome;
  - the agent is not in the proposal's causal chain (the same run, the parent task, or its own subtree);
  - the agent is not an author.
- **When a human must approve.** A human approver is required for:
  - every R3;
  - every proposal with P03-P07 in its outcome.

  That human is the nearest one up the chart who holds the permission and the legal-entity scope, otherwise the owner. The only exception is an owner-defined standing rule under P05's founder exception.
- **Four-eyes.** P10 counts only human eligible approvers.
- **Owner-only orgs.** In an org where the owner is the only human, the owner receives the R3 approvals and budget alerts, and holds kill switches per agent, per module and per org.

### 7. Budgets

- A budget policy applies per agent, per module or per org. It has a monthly window, a warning percentage and a hard stop, and covers `ai_run` cost. On Crove Cloud, the cost is paid in DOS.AI credits.
- A hard stop pauses the agent, releases its checkouts, moves its in-progress tasks to `waiting`, and shows an incident to the owner.

### 8. Runtimes are adapters

**Built-in.** The open-source core ships a built-in runner: `@crove/agent` over the AI SDK, pointed at the deployment's OpenAI-compatible endpoint.

**External runtimes.** An external runtime, such as an external orchestrator, Claude Code or any MCP client, can drive a position agent. It acts through MCP or the API with an `agent_grant` bound to `(org, client_id, agent_id)`.
- A human with the permission creates the grant.
- The grant is revoked when the agent is paused or retired, or no longer holds a position.
- User-delegated MCP clients keep the `(org, client_id, user)` grant of §8.9.

**Source of truth.** The kernel stays the source of truth for the chart, tasks, permissions and audit, so no write bypasses `execute()`. Paperclip is not embedded, and the core gains no dependency on any orchestrator.

### 9. Legal accountability stays with a human

To be confirmed by a Vietnamese accountant, together with the presets (§4.7): Vietnamese accounting rules require a qualified person as chief accountant and as signer of financial statements, and very small businesses and household businesses may have no chief accountant at all.

Until that is confirmed:
- An agent in a Chief Accountant position prepares and checks the work.
- Posting approval (P09) and signing stay with a qualified human, either in-house or at the outsourced firm through `external_accountant`.
- The UI labels agent-held positions as AI.

## Phase 1 as built (issue #79)

Migration `20261018050000_crove_kernel_agents_org_chart.sql`, commands and queries in `packages/kernel/src/agents.ts`, the template program in `modules/finance/src/agent.ts`, negative tests in `apps/kernel/test/invariant/agents.db.test.ts` (gate T18). Refinements of the proposal above:

- **Templates are data.** `crove_kernel.agent_template` is a global table seeded by migration (`finance.chief_accountant`: role key `finance.chief_accountant`, ceiling `R1`, subscribes to `kernel.proposal.created`, 50 runs a day). The template's program is code, wired into the worker by template key.
- **Template ceiling.** An agent enters only while its position's `role_key` equals its template's, and its effective `max_risk` is the lower of the agent's and the template's.
- **Agent access is declared per command.** A command or query declares `agent: { roles, taint? }`; without it no agent may run it. Only the task commands declare it (`kernel.task.checkout`, `.comment`, `.set_status`, `.escalate`, `.delegate`), all R1 and marked `taint: 'propagate'`: they write only task rows and comments, which carry the run's taint forward. The runtime refuses an agent any R3 (P05) or R2 (P06) command, anything above `max_risk` (P02), and any R1 command that does not propagate taint from a tainted run (P03). Agents never approve in Phase 1. #260 adds agent proposals and approvals; see below.
- **Database guards.** A trigger refuses every write to `position`, `agent`, `ai_run`, `kill_switch` and `budget_policy` in an agent context (`AGENT_FORBIDDEN`). Task and comment triggers stamp the creator from the context, inherit `request_depth` and taint from the parent, and in an agent context allow only a claim of a free or expired lease on the agent's own position's task (fencing token plus one), or writes under the lease the run holds (same token, never extended). The command layer also checks the token, so a stale token of the same run is refused too.
- **Context entry.** `crove_kernel.enter_agent_context(org, agent, run)`, worker only (EXECUTE and `session_user`), checks the run is `running` and not expired, the agent is `active` and holds an `active` position, no kill switch covers the org, module or agent, and no hard-stop budget is spent. The sealed context carries `actor: 'agent'`, the agent, run, position, module, role key, `max_risk`, taint, and the position's `le_scope` and `flags` (none by default). Like `enter_context`, it reads without row locks: a run finished or a switch engaged concurrently takes effect from the next transaction.
- **Owner as root.** A task with no `assignee_position_id` belongs to the owners. In Phase 1 escalation goes only to humans: the nearest active position up the chart held by a human, else the owners (an agent-held supervisor would get work no template program handles yet).
- **Chart cycles.** A trigger walks up the chart under a per-org advisory lock; chart writes outside READ COMMITTED are refused, since they would walk an old snapshot.
- **Runs and wake-ups.** Assigning a task to an agent-held position upserts the agent's one pending `agent_wakeup` and emits `kernel.agent.wakeup_requested` (on every request; the queue coalesces); the relay sends it to the `stately` queue `kernel-agent-wake` keyed `<org>:<agent>`. The job starts a run as the system (`kernel.agent.run.start`: one running run per agent by a unique index, daily cap, kill switches and budgets checked, expired runs closed and their leases released), runs the template program as the agent, and finishes the run (`kernel.agent.run.finish`), which wakes the agent again if a wake-up arrived meanwhile. A wake-up whose run was refused (daily cap, kill switch, budget, a run still live after a crash) stays pending; releasing a switch, reactivating an agent or setting a budget wakes those agents again, and the worker sweeps pending wake-ups every 10 minutes (`crove_kernel.agent_wakeups_due`, worker only). Idempotency keys of agents are per run. `kernel.proposal.created` goes to `kernel-agent-dispatch`, whose command reads the event from the outbox and creates one `proposal_review` task per subscribed agent position (idempotent per event and position).
- **Human commands.** Position create, update and assign, template install, agent update, budget set and kill-switch release are owner only and R3 (aal2 with a fresh second factor). Engaging a kill switch is R1 for owners and admins, so stopping AI is never behind a second factor; it also cancels the covered runs at once. Kill-switch and budget targets are stored in canonical form (a lowercase agent id, a module id), enforced by CHECK constraints, so the comparisons at entry always match.
- **Follow-ups (issue #244).** Migration `20261018160000_crove_kernel_agents_followups.sql`:
  - **Taint both ways.** An untainted run that claims a tainted task becomes tainted: the task trigger sets `ai_run.tainted`, the one write an agent context may make to `ai_run` (false to true on its own run, every other column unchanged). The task triggers read it at once (`ctx_run_tainted`), so later writes in the same transaction are tainted too, and the next context entry reads it as well. A tainted run taints every task it writes: an update in its context, a comment or a child task. An agent never clears a task's taint. Tasks whose comments were already tainted are backfilled as tainted. `kernel.task.list` and `kernel.task.get` show an untainted run only untainted tasks, so tainted content never reaches a run that would write it untainted; a tainted task wakes its agent with a tainted wake-up, so a tainted run picks it up.
  - **Programs get a facade.** An `AgentProgram` receives an `AgentRuntime` (`agentRuntime(runtime, orgId, actor)`): a frozen object with the org, agent and run ids and `execute`/`query` bound to them. It holds no `Runtime`, and options other than an idempotency key are ignored, so a program, or a model or tool runner behind it, cannot act as another actor, org or run.
  - **The database checks where agents send work.** In an agent context, `task_before_insert` accepts only a `delegation` to a position strictly below the agent's own (`position_in_subtree`) and an `escalation` to the nearest active position up the chart held by a human, else the owners (`task_escalation_target`); any other kind is refused (`AGENT_DELEGATION_SUBTREE`, `AGENT_ESCALATION_TARGET`, `AGENT_TASK_KIND`). The child's provenance comes from its parent, never from the agent: the parent's `source` and `source_ref`, no source event, status `todo`, no due date. Handing over a position wakes its new agent holder once for all open tasks, tainted if any of them is. `refuse_agent_write` also covers `tenant`, `tenant_member`, `member_invite`, `proposal` (approvals are recorded there) and the finance rows only humans confirm: `journal_entry`, `journal_line` (posting approval, P09, stays human) and `vendor_account_rule`.
  - **Quiet sweep.** `agent_wakeups_due(limit, modules)` returns only agents that can start a run now: an active position of the template's role key, no kill switch, under the daily run cap, no spent hard-stop budget, and a template whose module the deployment enables (the worker passes `Runtime.modules()`). A blocked agent's wake-up stays pending and is found again once the gate lifts, without a refused start and its audit row every 10 minutes.
  - **Activity names the agent.** `activity.agent_id` (foreign key to `agent`) is stamped from the sealed context: set, with `actor_id` cleared, in an agent context, and cleared in any other. `ctx.activity` sets it too.
  - **Module enablement (ADR-0031).** Installing a template whose module the deployment does not enable is refused (`MODULE_DISABLED`). Agents of a disabled module get no Inbox triage task, are not woken (their wake-up request stays pending for when the module is enabled again), and `kernel.agent.run.start` refuses them (`module_disabled`). Handlers ask `ctx.installed(module)`.
- **Agent writes are an allowlist (issue #285).** Migration `20261019010000_crove_kernel_agent_write_allowlist.sql`:
  - **The guard.** `crove_kernel.agent_write_guard` is on every table of every `crove_*` schema except `crove_meta` and `crove_jobs`. It refuses every row an agent context inserts, updates or deletes (`AGENT_FORBIDDEN`), whoever writes it. It runs as its owner, so it reads the sealed context even for roles without EXECUTE on the `ctx_*` helpers.
  - **Exempt tables.** These tables carry no guard because they have agent rules of their own: `task` and `task_comment` (lease), `ai_run` (taint only) and `activity` (stamped). The same goes for the tables only definers write while an agent acts: `outbox_event` (`emit`) and `refusal_tally`.
  - **Narrow rules.** Four guarded tables accept narrow agent writes:
    - `audit_event` takes rows of the context's agent and run only (`detail.agentRun`), dated now. The offboarding readers also skip agent rows, since no agent runs those commands.
    - `idempotency_key` takes keys of the context's run only (`agent:<agent>:<run>`), so an agent cannot plant an answer for a user's retry.
    - `agent_wakeup` takes pending requests only, for agents holding a position below the context's (the agents a delegation wakes). The agent cannot claim or finish one, inserts one request at a time, never clears its taint (a tainted run's request is tainted), and never lowers its count or depth.
    - `outbox_pending` takes inserts only (`emit`), so an agent transaction cannot claim or drop pending events (`outbox_claim` deletes them).
  - **Known gap.** `crove_jobs` (pg-boss) stays outside the guard: pg-boss owns its tables and the worker login writes them, so raw SQL in an agent transaction could enqueue a job. The runtime never does; #333 tracks it.
  - **New tables.** `apply_tenant_rls` installs the guard on every table it sets up. The invariant suite enumerates the catalog and fails on any unguarded table that is not exempt, so a new table is closed to agents by default. `refuse_agent_write` stays on its twelve tables for now (the earlier invariant suite expects it) and fires after the guard.
  - **Archived positions.** An agent never delegates to an archived position (`kernel.task.delegate` with `POSITION_ARCHIVED`, the insert trigger with `AGENT_DELEGATION_SUBTREE`).
  - **Chart reads stay unlocked.** The delegation and escalation checks read the chart without locks. A concurrent re-parent or holder change can race them, but a mismatch fails closed. Locking the chart there would invert the lock order of `kernel.position.assign` (position, then the tasks whose leases it releases) against an agent's delegation (task, then chart) and risk deadlocks.
- **Agent proposals and approvals (issue #260).** Migration `20261019180000_crove_kernel_agent_proposals.sql`, commands in `packages/kernel/src/agents.ts`, the decision in `decideAgentApproval` (`packages/kernel/src/approval.ts`):
  - **Never in an agent context.** An agent context never writes a proposal (the write guards stay as they are). The agent's command records what it wants as an outbox event, under the lease of the task it works on. A system command in the worker then acts on the event, after checking it again from the database. The event carries ids and what the agent's run prepared, never a decision.
  - **Proposals instead of refusal (P05, P06).** The runtime still refuses an agent R2 and R3 work. The agent asks with `kernel.task.propose` instead: R1, taint `propagate`, naming a preparer the agent's role key may run. The preparer must be R0, so it writes nothing; it runs in the agent's run, and the event carries the command and the payload it built (at most 64 KiB of JSON, #435), never its kind or title. The task then waits.
    - **The worker creates the proposal.** `kernel.agent.proposal.create` checks that the event was emitted by that agent's `kernel.task.propose`, in that run, on that task and for that command: the event's `command_id` names a successful audit row of the command whose actor, run (stamped by the database from the sealed context), target and detail match (#435). It then checks that the run is the agent's and live (running or succeeded; a run cancelled by a kill switch or a stop asks for nothing), that no kill switch covering the org, the run's or the position's module, or the agent is engaged or was engaged since the request, released or not (#435), that the task belongs to a position the agent holds, that the preparer is still R0, and that the payload is within the cap. It never runs the preparer again, so nothing an agent names runs as the system. It creates one proposal per event.
    - **Kind and title.** The Inbox renders a proposal by its kind and title, so neither comes from the agent's run (#435). The kind is the command's: a proposal command may declare `proposalKind` (`<module>.<name>` in its own module, checked at registration), otherwise its name. The title is built by the kernel from the agent's name, which an owner sets, and that kind.
    - **The proposal records its causal chain** (`requested_by_agent`, `requested_by_run`, `source_task_id`) and its taint.
    - **Flags.** P03 when the run or the task is tainted; P04 unless the command declares agent approvers (no code classifies contact or payment fields yet, so the declaration says the command writes none); P05 for R3; P06 for R2; P07 when the task chain did not start from a human.
    - **Unassessed flags.** An empty `policy_flags` means "assessed, none applies", and only the writer that assessed them may say so. Every other writer (`kernel.proposal.request`, extraction) leaves them NULL, and NULL never becomes an array. Agents never approve a proposal with NULL flags.
    - **Authors.** The agent and its run, plus every user who created a task in the chain (P10).
    - **Approvers.** The eligible approvers are humans (P12). The asking agent gets no review task for its own proposal.
  - **Agent approvals within `max_risk`.**
    - **Who may approve.** A proposal command declares `agentApprovers: { roles, noContactOrPayment: true }`: the role keys whose agents may approve it, and that it writes no contact or payment field (P04). Only R1 and R2 proposal commands may declare them, and the runtime refuses any other declaration or one without `noContactOrPayment: true`.
    - **Recording.** The agent records its approval with `kernel.task.approve_proposal`, only from the review task the dispatch created for its position (`created_by_type` system, kind `proposal_review`). A delegated or escalated copy names the proposal too, but records nothing. The command is R1 without taint propagation, so the runtime refuses a tainted run (P03).
    - **Execution.** The worker's `kernel.agent.proposal.approve` checks that the event was emitted by that agent's `kernel.task.approve_proposal`, in that run, from that task, for that proposal and revision (the same audit binding as creation, #435), that the review task is that dispatch-created review of this proposal and belongs to a position the agent holds. It waits while a re-extraction of the proposal's file is in flight, decides again on the locked proposal and executes the command through the proposal gate, as the system. It records `decided_by_agent`.
    - **Conditions.** `decideAgentApproval` allows it only when all of these hold:
      - the command is a proposal command below R3, and the agent's role key is one of its agent approvers;
      - the outcome names none of P03 to P07, the content is untainted, and the flags were assessed (never NULL);
      - the risk is within the agent's `max_risk` (P02);
      - the run is the agent's, untainted and live (running, or succeeded after recording; never cancelled, failed or expired), and no kill switch covers it (P01); at execution, also none engaged after the approval was recorded, even one released since (#435);
      - the agent is not an author (P10);
      - the agent is not in the causal chain: it did not ask for the proposal, and no task in the chain was its own or its position's;
      - four-eyes along the reporting line: the approver and the asking agent are not on one line in either direction. Neither position is in the other's subtree, for the asking agent's position when it asked (the source task's assignee) and the one it holds now. A report could otherwise approve its superior's proposal, which the superior can route to it. When neither position is known, the line cannot be checked and the approval is refused (#435).
    - **Revision.** The approval names the revision it judged.
  - **Database.** For every writer:
    - a proposal's taint comes from its extraction too, and a tainted proposal is flagged P03;
    - the causal chain never changes, the taint and the flags only grow, and NULL flags stay NULL;
    - an agent-decided proposal is untainted, flagged with none of P03 to P07, and not decided by the agent that asked for it;
    - only an agent's request carries assessed flags: `policy_flags IS NULL OR requested_by_agent IS NOT NULL` (#435).
  - **R3 stays human.** Human approval is unchanged: P10 counts only human eligible approvers, and an agent author neither blocks four-eyes nor satisfies it. With today's proposal commands all R3, agents approve nothing yet. The chief accountant template's `R1` ceiling also keeps it from approving R2.
  - **Two steps.** #341 first let the invariant suite accept the two new task commands, so that its base copy held on both sides of this change.
  - **Follow-ups (#435).** Done: binding create and approve to the emitting command, the kind and title from the command and the kernel with a payload cap, assessed flags only on agent requests, kill switches engaged since the request, and the reporting line failing closed. Left: a budget re-check (P01); the kill switch of the approved command's module; whether approvers must differ in template from the requester (today every agent shares one template, so such a rule would refuse all); waking waiting and done tasks when the worker refuses; agent proposals of commands outside the human allowlist; P12 legal-entity scope; database enforcement of R3-human; taint from data the preparer reads.
- **Not in Phase 1** (follow-up issue): the oRPC contract and UI for the chart, tasks and switches; the language-model runner behind the template program (the Phase 1 program is deterministic: it records the proposal's checks and escalates the approval); recording `ai_run` cost; schedules; editing `le_scope` and `flags`.

## Consequences

- Humans and agents share one model of who does what. The kernel enforces delegation, escalation and approval limits, and audits every step.
- Modules and orgs staffed only by agents work within limits, and humans can be added later without remodelling.
- More kernel schema in Phase 1: `position`, `agent` fields, `task` fields, `agent_wakeup`, `budget_policy`.
- Agent chains could run away or launder untrusted input. Mitigations: causal depth, `request_depth`, taint inheritance, human approval for flagged and R3 proposals, budgets and kill switches.
- **Before Phase 1 ships agent approvals,** the P10 and P12 work (issue #75) must land, and gate row T18 must have its negative tests.
- **Phasing:**
  - Phase 1: positions, agents, task assignment and checkout, and wake-ups for the Finance template (Inbox triage plus a Chief Accountant review step).
  - Phase 2a: the budget UI and schedules.
  - Phase 3: external runtimes through agent grants.
