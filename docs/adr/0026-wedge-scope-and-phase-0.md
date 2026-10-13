# 0026. Wedge, scope and a lighter Phase 0

- Status: accepted, partly superseded by ADR-0027
- Date: 2026-10-13
- Deciders: owner (JOY)

## Context

The kernel plan (`docs/plan/crove-os-kernel.md`) was produced by research and red-team agents that reviewed security, feasibility and operations, but not the market. Review on 2026-10-13 found:

- No target segment, pricing, competitor view or customer-facing success metric; first revenue around week 20 at the earliest.
- Six native modules (CRM, Service, Social, Sign, Accounting, HRM), each a product category with specialist competitors and its own integrations.
- Phase 0 carried 9 exit criteria in 2 weeks, including enterprise-grade controls not needed before the first external tenant.
- Phase 0 depended on three DOS.Me PRs to sync org membership from DOS.
- Protected-path PRs required a manual approval label from an owner who does not review code.
- The plan budgeted one-way sync, parity checks and imports for five forks; the owner confirmed none has real users (prod stats show only a few test accounts).

## Decision

1. Start with one wedge, the Document Inbox (forwarded invoices and statements -> AI-proposed bookkeeping -> human approval), for startups and SMEs using outsourced accounting, testing accounting firms as a channel. The owner runs 10-15 customer interviews before Phase 2a scope is frozen.
2. Commit only to the kernel and Accounting. Later modules start on wedge-customer demand.
3. Time-box Phase 0 to 4-6 weeks. Build now what is expensive to change later (tenancy, keys, single write path, money types, migration discipline, proposals and audit). Defer the HMAC seal, WORM stream, self-host, MCP and public API, SSE, partitions and NAT, each with a revisit trigger (plan, Tracking section).
4. Ship DOS ID login via OIDC first, with Crove-managed membership. Link DOS orgs (DOS-1, DOS-26, DOS-27) when per-org billing through DOS.AI is needed.
5. Replace the manual owner approval on protected paths with the invariant suite from base, a security reviewer agent, and an external security review before the first external tenant.
6. Freeze the forks: no sync, parity, imports or rollback windows.

## Consequences

- Faster path to a usable product and to customer evidence; scope beyond Accounting is explicitly unfunded until demand appears.
- Deferred controls become explicit gates (first external tenant, Finance GA) instead of Phase 0 work; they must not be skipped at those gates.
- Moving from Crove-managed membership to DOS org sync later needs a migration path for existing tenants (`tenant.external_org_id` stays in the schema from day one).
- Text in the plan body that conflicts with these decisions is superseded; the plan's Tracking section is the source of truth.
