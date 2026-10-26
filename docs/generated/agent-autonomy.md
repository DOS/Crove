# Agent autonomy

Generated from the registered commands by `apps/kernel/test/agent-autonomy.test.ts`; do not edit by hand. This file is a protected path (AGENTS.md): a pull request that changes what an AI agent may do changes this file and gets a security review (plan §4.7).

## Commands an agent may run by itself

An agent holding a position runs these without asking a human, within its `max_risk` (P02). A command at R2 or R3 is never run by an agent: it asks for a proposal instead (P05, P06). A tainted run (one that read outside input) may run only the commands marked "yes, it carries the taint forward" (P03).

| Command | Risk | Positions | Tainted run |
| --- | --- | --- | --- |
| `kernel.task.approve_proposal` | R1 | any position | no |
| `kernel.task.checkout` | R1 | any position | yes, it carries the taint forward |
| `kernel.task.comment` | R1 | any position | yes, it carries the taint forward |
| `kernel.task.delegate` | R1 | any position | yes, it carries the taint forward |
| `kernel.task.escalate` | R1 | any position | yes, it carries the taint forward |
| `kernel.task.propose` | R1 | any position | yes, it carries the taint forward |
| `kernel.task.set_status` | R1 | any position | yes, it carries the taint forward |

## Proposals an agent may approve

An agent in one of these positions may approve a pending proposal of the command, only when the proposal is clean (no P03 to P07 flag), assessed, within its `max_risk`, outside its own work and causal chain and its reporting line, and asked through the review task the dispatch created (ADR-0029, T18). R3 proposals are always decided by a human.

None today: no proposal command declares agent approvers, so every proposal is decided by a human.
