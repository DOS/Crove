# 0031. Per-deployment module enablement and modules that run when others are off

- Status: accepted (plan Decision 12, adopted proposals "Per-deployment module enablement" and "Modules run when other modules are off")
- Date: 2026-10-16
- Deciders: owner (JOY)
- Builds on: ADR-0030 (composition root), plan Decision 10 (entitlements)
- Tracking: issue #44

## Context and problem statement

Plan Decision 12 adopted two proposals: a deployment chooses its modules with a setting such as `CROVE_MODULES=crm,finance`, and a module keeps working when another module is off, because UI slots and `ctx.query` answer a typed `not_installed` instead of failing. Before this ADR every build registered every module: `createKernel` registered the kernel's and finance's commands and queries unconditionally, the worker always worked the finance extraction queue, and the SPA always showed the finance menus.

## Decision

1. `CROVE_MODULES` (in `apps/kernel/src/config.ts`) is a comma-separated list of module ids. Unset, empty or only separators (`,`) enables every module the build ships (`AVAILABLE_MODULES`, today `kernel` and `finance`). `kernel` is always on, listed or not. An unknown name stops the boot (`invalid configuration: CROVE_MODULES (unknown module(s) ...)`), so a typo never turns a module off silently. The `api` and `worker` roles must run with the same value: a worker without finance claims and drops the extraction events of files the API accepted, and those files stay unread even after finance is enabled.
2. The setting controls registration only. `moduleDefinitions(config)` in `apps/kernel/src/kernel.ts` returns the commands and queries of the enabled modules, and `createKernel` registers exactly those. Migrations still apply to every schema: one linear ledger, whatever the setting says. Per-org access stays with entitlements (Decision 10, the `billing` port of ADR-0030).
3. The runtime's registry is the one source of what is installed. `Runtime.installed(module)` is true when the runtime registered a command or query whose name starts with `<module>.`; `Runtime.modules()` lists them. The HTTP edge, the RPC router and the worker ask it:
   - a command of a disabled module is `COMMAND_NOT_FOUND` (404), also when an approved proposal tries to run it;
   - finance routes are not registered: `/api/export/journal.xlsx` falls through to the `NOT_FOUND` 404, and the finance procedures of the shared oRPC contract answer 404 `NOT_FOUND` before any database work;
   - the worker neither works the finance extraction queue nor queues jobs for it: `kernel.file.ingested` and `kernel.file.reextract_requested` are relayed to nothing, so an uploaded file is stored and stays unread. Enabling finance later does not read those files retroactively. `kernel.file.reextract` stays registered (it is a kernel command); on a file with an older proposal its event is dropped the same way, and the Inbox shows the run as reading until it goes stale.
   - `/api/config` returns `modules`, and the SPA shows only the menus of installed modules; a screen of a module the deployment leaves out (any module's, not only finance's; #1652) opened by URL redirects to the inbox; one outside `/o/$slug` (the share target, the channel OAuth callback, the client review and report links, the booking page; #1660) shows the not-found page, with no sign-in asked on public links.
4. `ctx.query(name, input)` (on `QueryContext`, so also on `CommandContext`) runs another registered query in the caller's transaction and context, with the same role check as `Runtime.query()`, and returns `Lookup<O>`: `{ status: 'ok', value }` or `{ status: 'not_installed', module }`. `not_installed` means the query's module is one the build ships but the deployment leaves out (`RuntimeOptions.absentModules`, which `createKernel` fills from `CROVE_MODULES`); any other unknown query, an installed module's or a misspelled module's, is `QUERY_NOT_FOUND`, because that is a caller bug. A runtime built without that list (tests and tools that register only some modules) treats every unregistered module as absent. Query handlers must not write: from a command, `ctx.query` runs them in the command's writable transaction. The role and system checks, and the typo case, are covered by the invariant suite (`apps/kernel/test/invariant/ctx-query-access.db.test.ts`). The SPA's equivalent is `slot(installed, module, value)` in `apps/app/src/lib/modules.ts`, with the same two answers.
5. CI runs the kernel alone: `apps/kernel/test/module-enablement.db.test.ts` boots `createKernel` with `CROVE_MODULES=kernel` on PostgreSQL 17 and checks that no finance command, query, job or route is registered, that lookups into finance answer `not_installed`, and that kernel flows (org, inbox, upload) still work. Finance cannot run without the kernel, so "each module alone" is the kernel today; a new module adds its own case.

## Consequences

- A deployment can run the kernel without accounting, and later modules (CRM, Service) can be left out the same way without code changes.
- Module ids are the prefix of command, query and event names (`finance.purchase.record`), which `ctx.emit` already enforces; a new module must keep that rule, or `Runtime.installed` will not see it.
- A route or job that belongs to a module must check `Runtime.installed` when it is added. Today the finance checks are in `http.ts`, `rpc.ts` and `worker.ts`.
- Turning a module off does not remove its data or its schema, and turning it back on shows that data again.
