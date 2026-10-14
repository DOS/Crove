# 0029. Agents as org members: positions, an org chart shared with humans, and tasks

- Status: accepted (direction decided by the owner on 2026-10-14); table and field details are proposed until the Phase 1 implementation PR
- Date: 2026-10-14
- Deciders: owner (JOY)
- Builds on: plan §4.3 (actors), §4.7 (policy and risk levels), §8 (AI layer); ADR-0027 (the open-source core has no DOS dependency)
- Supersedes: plan §8 "One agent per org: one persona, several skill packs per module"

## Context and problem statement

The owner wants every module to ship one or more agents, for example a Chief Accountant agent ("Kế toán trưởng") in Accounting. An org has an org chart, and every seat on it has tasks and a job description. Humans and agents work together. Where a module, or a whole org, has no humans, agents work with each other. The idea comes from Paperclip, which DOS.AI plans to fork.

Paperclip (MIT, reviewed at tag `v2026.916.1`) models:
- agents in an org chart (`agents.reports_to`);
- issues with a single assignee and an atomic checkout;
- a wake-up queue (timer, assignment, mention) that coalesces duplicate requests;
- run records;
- budget policies with soft and hard stops;
- a human "board" that approves hires, strategy and budget overrides.

What does not fit Crove:
- humans cannot hold positions in Paperclip's org chart;
- delegation and escalation are prompt conventions, not enforced rules;
- there is no single write path, no risk levels and no row-level security;
- the product is built around coding agents.

Crove already has:
- the `agent` actor kind;
- risk levels R0 to R3 and policy rules P01 to P13;
- proposals and the AI Inbox;
- audit, outbox and jobs;
- RLS per org;
- built-in roles such as `finance.chief_accountant`.

The question is how to add an org chart in which humans and agents hold seats, without weakening any of these.

## Decision

1. **The position is the unit of the org chart.**
   - Table: `crove_kernel.position (org_id, id, title, module, role_key, reports_to, job_description, status)`.
   - `reports_to` is a position in the same org, and the database rejects cycles.
   - `job_description` is structured data: responsibilities, KPIs and working hours.
   - A position has exactly one holder or is vacant. The holder is either a human (a `tenant_member`) or an agent.
   - Changing the holder is an audited command.

2. **Agents are org members with their own identity.**
   - Table: `crove_kernel.agent (org_id, id, position_id, template_key, display_name, runtime, model_alias, status, created_by)`, where `runtime` is `builtin` or `external` and `status` is `active`, `paused` or `retired`.
   - An agent that holds a position acts as itself. Its permissions are:
     - the permissions of the position's role;
     - intersected with the module template's ceiling, the owner-set `max_risk`, the trigger class and taint (§4.7).
   - An agent never gets more than a human in the same position.
   - `on_behalf_of` stays only for an agent that a user invokes in their own chat. That agent gets the user's permissions intersected with the grant, as today.

3. **Modules declare agent templates in their manifest.** Example: `finance.chief_accountant`. A template carries:
   - a default title, such as "Kế toán trưởng (AI)";
   - a job description;
   - its tools, which are the module's commands and queries marked `ai.expose`;
   - subscribed events and a default schedule;
   - a ceiling `max_risk`.

   Installing a template creates a position and an agent from data. Owners edit the job description and the limits. The LLM never sees or edits policy (§4.7).

4. **Work is tasks.** The kernel `task` gains these fields:
   - `assignee_position_id`, `created_by`, `parent_task_id`;
   - `source`: event, proposal, human or schedule;
   - `status`: `todo`, `in_progress`, `waiting`, `in_review`, `done` or `cancelled`;
   - `due`, `request_depth`;
   - a checkout: the run id and a lock timestamp.

   Each task has one assignee position, and an agent claims it with an atomic checkout. Comments are activities. The kernel enforces collaboration as commands, not as prompt instructions:
   - **Delegation:** an agent creates subtasks only for positions inside its own subtree of the chart.
   - **Escalation:** when a step needs more risk than its `max_risk`, authority it lacks, budget beyond its limit, or when the agent is not confident, it creates a task or a proposal for its supervisor position. Humans see escalations in the AI Inbox.
   - **Agent-to-agent communication** goes only through tasks, comments and proposals in the database, so it is audited. There are no side channels.

5. **Wake-ups run on the existing outbox and jobs.**
   - Requests come from a task assignment, a mention, a subscribed event or a schedule. They are stored as `agent_wakeup` rows and coalesced per agent.
   - One job per agent runs at a time, with `orderingKey` set to the agent.
   - Each run is an `ai_run`, so the worker enters context through the run reference (§4.5).
   - Limits: concurrency 1 per agent, a daily run cap, a causal depth of at most 5 for chains started by agents, and a `request_depth` cap on tasks.

6. **Approvals reuse proposals.**
   - Eligible approvers are the positions that hold the command's permission (P12).
   - An agent-held position may approve R1 and R2 within its `max_risk`, provided the author is a different actor (P10).
   - R3 always ends at a human: the nearest human up the chart, otherwise the org owner, who acts as the board. The only exception is an owner-defined standing rule under P05's founder exception.
   - P03, P04 and P07 stay non-overridable.
   - In an org where the owner is the only human, the owner receives R3 approvals and budget alerts, and holds kill switches per agent, per module and per org.

7. **Budgets.**
   - A budget policy can apply per agent, per module or per org. It has a window (month), a warning percentage and a hard stop, and it applies to `ai_run` cost. On Crove Cloud the cost is paid in DOS.AI credits.
   - A hard stop pauses the agent and moves its in-progress tasks to `waiting`, and an incident is shown to the owner.

8. **Runtimes are adapters.**
   - The open-source core ships a built-in runner: `@crove/agent` over the AI SDK, pointed at the deployment's OpenAI-compatible endpoint.
   - External runtimes (DOS.AI's Paperclip fork, Claude Code, any MCP client) act through MCP or the API with an agent grant scoped to a single agent (§8.9).
   - The kernel stays the source of truth for the chart, tasks, permissions and audit, so no write bypasses `execute()`.
   - Paperclip is not embedded, and the core gains no DOS dependency (ADR-0027).

9. **Legal accountability stays with a human.**
   - Vietnamese accounting law requires a qualified person as kế toán trưởng and on signed financial statements. To be confirmed by a Vietnamese accountant, together with the presets (§4.7).
   - An agent in a Chief Accountant position prepares and checks the work. Posting approval (P09) and signing stay with a qualified human, either in-house or at the outsourced firm through `external_accountant`.
   - The UI labels agent-held positions as AI.

## Consequences

- Humans and agents share one model of who does what. The kernel enforces delegation, escalation and approval limits, and every step is audited.
- Modules and orgs staffed only by agents work within limits, and humans can be added later without remodelling.
- More kernel schema in Phase 1: `position`, the new `agent` and `task` fields, `agent_wakeup` and `budget_policy`.
- Chains of agents waking each other could run away. Mitigations: causal depth, `request_depth`, budgets and kill switches.
- Phasing:
  - Phase 1: `position`, `agent`, task assignment and checkout, and wake-ups for the Finance template (Inbox triage plus a Chief Accountant review step).
  - Phase 2a: the budget UI and schedules.
  - Phase 3: external runtimes through MCP grants.
