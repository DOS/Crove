# 0029. Agents as org members: positions, an org chart shared with humans, and tasks

- Status: accepted. The owner set the direction on 2026-10-14. Table and field details stay proposed until the Phase 1 implementation PR.
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
