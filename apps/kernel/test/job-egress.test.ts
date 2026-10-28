// Every job queue declares its network egress, and the declaration is what its worker handler reaches (plan §4.6
// `defineJob`, §7.7, #1653); a command whose events feed a queue with egress declares an external effect, at least R2
// (plan §4.7 "Derived risk"). The sources are parsed and followed by job-egress.ts; planted sources show each check
// failing.
import { describe, expect, it } from 'vitest';
import { CHANNEL_PROVIDERS } from '@crove/channel';
import { KERNEL_NOTIFYING_EVENTS, kernelCommands } from '@crove/kernel';
import { deriveRisk, type CommandDef } from '@crove/kernel-runtime';
import { crmCommands } from '@crove/mod-crm';
import { FINANCE_NOTIFYING_EVENTS, financeCommands } from '@crove/mod-finance';
import { CHAT_ALERTING_EVENTS, CHAT_ALERT_TEST_EVENT, NOTIFYING_EVENTS, socialCommands } from '@crove/mod-social';
import { MAIL_QUEUES, QUEUES, SOCIAL_PUBLISH_QUEUES, TENANT_HOSTED_PROVIDERS, queueEgress, socialPublishQueue, type JobEgress } from '../src/jobs-schema.ts';
import { orgPurgeCommand } from '../src/org-purge.ts';
import { DEPS_REACH, Sources, emittersOf, reachOf, sendSites, workSites, type DynamicRuns, type Known, type WorkSite } from './job-egress.ts';

const known: Known = {
  imports: { CHAT_ALERTING_EVENTS, CHAT_ALERT_TEST_EVENT, NOTIFYING_EVENTS, KERNEL_NOTIFYING_EVENTS, FINANCE_NOTIFYING_EVENTS },
  calls: { socialPublishQueue: SOCIAL_PUBLISH_QUEUES },
};
const ALL_QUEUES = [...Object.values(QUEUES), ...SOCIAL_PUBLISH_QUEUES, ...MAIL_QUEUES];
const targets = (egress: JobEgress): readonly string[] => (egress === 'none' ? [] : egress);
const hasEgress = (queue: string) => queueEgress(queue) !== 'none';
const publishProvider = (queue: string) => CHANNEL_PROVIDERS.find((p) => socialPublishQueue(p) === queue) ?? null;

// What is wrong with the worker's queues: an undeclared one, a handler reaching more than its queue declares, or a
// declaration its handler no longer needs.
function workProblems(sites: readonly WorkSite[]): string[] {
  const out: string[] = [];
  for (const site of sites) {
    const at = `${site.file}:${site.line}`;
    if (site.reaches.has('raw_network')) out.push(`${at}: the handler uses fetch() or a Node network module itself; reach the network through the egress guard or a provider adapter`);
    for (const queue of site.queues) {
      let egress: JobEgress;
      try {
        egress = queueEgress(queue);
      } catch (error) {
        out.push(`${at}: ${(error as Error).message}`);
        continue;
      }
      const needs = new Set<string>();
      for (const r of site.reaches) {
        if (r === 'tenant_url' || r.startsWith('provider:')) needs.add(r);
        if (r === 'publishers') {
          // The channel adapters, and the guard for the hosts a tenant names. A publish queue holds one provider's jobs.
          const provider = publishProvider(queue);
          needs.add(provider === null ? 'provider:channel' : `provider:${provider}`);
          if (provider === null || TENANT_HOSTED_PROVIDERS.includes(provider)) needs.add('tenant_url');
        }
      }
      const declared = new Set<string>(targets(egress));
      const shown = egress === 'none' ? 'none' : egress.join(', ');
      for (const n of needs) if (!declared.has(n)) out.push(`${at}: queue ${queue} reaches ${n} but declares egress ${shown}`);
      for (const d of declared) if (!needs.has(d)) out.push(`${at}: queue ${queue} declares ${d} but its handler does not reach it`);
    }
  }
  return out;
}

const RANK = { R0: 0, R1: 1, R2: 2, R3: 3 } as const;
const all = (): Array<CommandDef<unknown, unknown>> =>
  [...kernelCommands, orgPurgeCommand({ store: {} as never }), ...financeCommands, ...socialCommands, ...crmCommands] as Array<CommandDef<unknown, unknown>>;

// Commands below R2 whose handlers emit an event that feeds a queue with egress, themselves or through a nested
// command they run (ctx.run or ctx.tryRun, followed transitively). None since #1662 and #1698 (coordinator decision):
// each is R2 `external`, a line to the org's own team chat on Telegram or Discord included, since it sends tenant
// content to a third-party provider, and so is a command that runs one of them nested (kernel.inbound.receive and
// social.media.save_stock run kernel.file.ingest, social.post_comment.accept runs social.post.submit). An exemption
// needs a product flow the plans require and a reason in plan §4.7.
const BELOW_R2: Readonly<Record<string, readonly string[]>> = {};

// The commands a nested run may run when its source does not name them, worked out from the registered definitions,
// by '<the command it is in>: <its command expression>'.
const dynamicRuns = (defs: ReadonlyArray<CommandDef<unknown, unknown>>): DynamicRuns => {
  const names = (keep: (c: CommandDef<unknown, unknown>) => boolean) => defs.filter(keep).map((c) => c.name);
  const proposals = names((c) => c.access === 'proposal');
  return {
    // kernel.task.propose refuses a preparer that is not R0 before it runs it.
    'kernel.task.propose: input.preparer': names((c) => c.risk === 'R0'),
    // The approvals run the approved proposal's command.
    'kernel.agent.proposal.approve: proposal.command': proposals,
    'kernel.proposal.approve: proposal.command': proposals,
    // The edit runs the reviser registered for the proposal's command (its `revises`).
    'kernel.proposal.edit: reviser': names((c) => typeof c.revises === 'string'),
  };
};

// The commands of `emitters` that are not external, with the fed queues each event of theirs leads to.
function belowR2(emitters: ReadonlyMap<string, ReadonlySet<string>>, external: (name: string) => boolean, fed: (event: string) => string[]): Record<string, string[]> {
  const below: Record<string, string[]> = {};
  for (const [event, by] of emitters) for (const name of by) if (!external(name)) (below[name] ??= []).push(...fed(event));
  for (const routes of Object.values(below)) routes.sort();
  return below;
}

// Sends to a queue with egress from outside the outbox relay, and why each needs no command of its own: the command
// that decides it, which must declare an external effect, or the reason.
const OTHER_SENDS: Readonly<Record<string, { command: string } | { reason: string }>> = {
  // The sweep queues the variants that are due; the job runs social.publish.begin before any call.
  sweepSocialPublishing: { command: 'social.publish.begin' },
  // The push of a notification that social.notification.dispatch wrote.
  [`${QUEUES.socialNotify} handler`]: { command: 'social.notification.dispatch' },
  // Mail a command queued; every command that queues mail declares an external effect (#1563).
  sweepMail: { command: 'kernel.mail.contact.queue' },
  [`${QUEUES.extract} handler`]: { reason: 'the same file again, once its org is back under its daily limit' },
};

// Events that feed a queue with egress and that no command emits: a definer writes them for a request without one.
const NO_COMMAND: Readonly<Record<string, string>> = {
  // A client's answer on a review link (crove_social review link definers, run by the public link's route).
  'social.review.answered': 'the review link definers',
};

describe('job egress (#1653)', () => {
  const sources = new Sources();

  it('declares the egress of every queue, as none, provider:<x> or tenant_url', () => {
    for (const queue of ALL_QUEUES) {
      const egress = queueEgress(queue);
      if (egress === 'none') continue;
      expect(egress.length, queue).toBeGreaterThan(0);
      expect(new Set(egress).size, queue).toBe(egress.length);
      for (const t of egress) expect(t, queue).toMatch(/^(tenant_url|provider:[a-z_]+)$/);
    }
    expect(() => queueEgress('kernel-undeclared')).toThrow(/declares no egress/);
    expect(queueEgress(QUEUES.retention)).toBe('none');
    expect(queueEgress(QUEUES.socialLinkPreview)).toEqual(['tenant_url']);
    expect(queueEgress(socialPublishQueue('x'))).toEqual(['provider:x']);
    expect(queueEgress(socialPublishQueue('mastodon'))).toEqual(['provider:mastodon', 'tenant_url']);
    expect(queueEgress('kernel-mail-send')).toEqual(['provider:mail']);
  });

  it('works only declared queues, works every declared queue, and sends and schedules only declared ones', () => {
    const worked = new Set(workSites(sources, known).flatMap((s) => s.queues));
    expect([...worked].filter((q) => !ALL_QUEUES.includes(q))).toEqual([]);
    expect(ALL_QUEUES.filter((q) => !worked.has(q))).toEqual([]);
    const sent = sendSites(sources, known).flatMap((s) => s.queues.map((q) => [q, s] as const));
    expect(sent.length).toBeGreaterThan(30);
    expect(sent.filter(([q]) => !ALL_QUEUES.includes(q)).map(([q, s]) => `${s.file}:${s.line} ${q}`)).toEqual([]);
  });

  it('declares on each queue what its handler reaches, and nothing more', () => {
    const sites = workSites(sources, known);
    expect(workProblems(sites)).toEqual([]);
    // The analysis sees the reach it should: the guard of link previews, the chat platforms, the mailer, the push
    // sender and the channel adapters.
    const reach = (queue: string) => new Set(sites.filter((s) => s.queues.includes(queue)).flatMap((s) => [...s.reaches]));
    expect(reach(QUEUES.socialLinkPreview)).toEqual(new Set(['tenant_url']));
    expect(reach(QUEUES.socialChatAlert)).toEqual(new Set(['provider:telegram', 'provider:discord']));
    expect(reach('kernel-mail-send')).toEqual(new Set(['provider:mail']));
    expect(reach(QUEUES.socialPush)).toEqual(new Set(['tenant_url']));
    expect(reach(QUEUES.socialRemove)).toEqual(new Set(['publishers']));
    expect(reach(QUEUES.extract)).toEqual(new Set(['provider:ai']));
    expect(reach(QUEUES.agentWake)).toEqual(new Set());
  });

  it('fails a planted queue without a declaration, an egress beyond or short of the declaration, and a bare fetch', () => {
    const planted = new Sources({
      'apps/kernel/src/planted-worker.ts': `
        import { guardedFetch } from '@crove/kernel-runtime';
        import { XRefresher, sendTelegramText } from '@crove/channel';
        import { request } from 'node:https';
        import { QUEUES } from './jobs-schema.ts';
        import { runLinkPreviewJob } from './link-preview.ts';
        export async function startWorker(deps: WorkerDeps) {
          const boss = new PgBoss({ connectionString: deps.connectionString });
          await boss.work('kernel-undeclared', async () => {});
          await boss.work(QUEUES.retention, async () => {
            await guardedFetch('https://example.test/', { timeoutMs: 1000, maxBytes: 1000 });
          });
          const preview = (id: string) => runLinkPreviewJob({ runtime: deps.runtime }, 'org', id);
          await boss.work(QUEUES.orgExport, async ([job]) => preview(job.id));
          await boss.work(QUEUES.inbound, async () => sendTelegramText({ chatId: '1' }, 'hi'));
          await boss.work(QUEUES.mailEvent, async () => fetch('https://example.test/'));
          const mail = deps.mail;
          await boss.work(QUEUES.notify, async () => run({ ...mail }));
          await boss.work(QUEUES.socialLinkPreview, async () => {});
          await boss.work(QUEUES.portalList, async () => read({ extractor: deps.extractor }));
          const { sender } = deps.push;
          await boss.work(QUEUES.agentDispatch, async () => sender.send('x'));
          await boss.work(QUEUES.signOut, async () => new XRefresher().refresh());
          await boss.work(QUEUES.socialChatAlert, async () => sendTelegramText({ chatId: '1' }, 'hi'));
          await boss.work(QUEUES.yearArchive, async () => request('https://example.test/'));
        }`,
    });
    const problems = workProblems(workSites(planted, known, 'apps/kernel/src/planted-worker.ts'));
    const at = (line: number) => `apps/kernel/src/planted-worker.ts:${line}`;
    expect(problems).toEqual([
      `${at(9)}: queue kernel-undeclared declares no egress (QUEUE_EGRESS in apps/kernel/src/jobs-schema.ts)`,
      `${at(10)}: queue ${QUEUES.retention} reaches tenant_url but declares egress none`,
      `${at(14)}: queue ${QUEUES.orgExport} reaches tenant_url but declares egress none`,
      `${at(15)}: queue ${QUEUES.inbound} reaches provider:telegram but declares egress none`,
      `${at(16)}: the handler uses fetch() or a Node network module itself; reach the network through the egress guard or a provider adapter`,
      `${at(18)}: queue ${QUEUES.notify} reaches provider:mail but declares egress none`,
      `${at(19)}: queue ${QUEUES.socialLinkPreview} declares tenant_url but its handler does not reach it`,
      `${at(20)}: queue ${QUEUES.portalList} reaches provider:ai but declares egress none`,
      `${at(22)}: queue ${QUEUES.agentDispatch} reaches tenant_url but declares egress none`,
      `${at(23)}: queue ${QUEUES.signOut} reaches provider:channel but declares egress none`,
      `${at(24)}: queue ${QUEUES.socialChatAlert} declares provider:discord but its handler does not reach it`,
      `${at(25)}: the handler uses fetch() or a Node network module itself; reach the network through the egress guard or a provider adapter`,
    ]);
    // A WorkerDeps field nobody classified stops the analysis.
    const unknownField = new Sources({
      'apps/kernel/src/planted-worker.ts': `
        export async function startWorker(deps: WorkerDeps) {
          await boss.work('kernel-retention-purge', async () => deps.webhooks.post());
        }`,
    });
    expect(() => workSites(unknownField, known, 'apps/kernel/src/planted-worker.ts')).toThrow(/WorkerDeps field webhooks is not classified/);
  });

  it('classifies every field of WorkerDeps', () => {
    const fields: string[] = [];
    for (const node of sources.get('apps/kernel/src/worker.ts').program.body) {
      const decl = node.type === 'ExportNamedDeclaration' ? node.declaration : node;
      if (decl?.type === 'TSInterfaceDeclaration' && decl.id.name === 'WorkerDeps') for (const m of decl.body.body) fields.push(m.key.name);
    }
    expect(fields.length).toBeGreaterThan(20);
    const topLevel = [...new Set(Object.keys(DEPS_REACH).map((k) => k.split('.')[0] as string))];
    expect(topLevel.sort()).toEqual([...fields].sort());
  });

  it('keeps the network out of the modules and packages/kernel, so the worker reaches it only from apps/kernel', () => {
    const files = sources.list(['modules', 'packages/kernel/src']).filter((f) => f.includes('/src/'));
    expect(files.length).toBeGreaterThan(50);
    const reaching = files.map((f) => [f, [...reachOf(sources.get(f).program, sources)]] as const).filter(([, reach]) => reach.length > 0);
    expect(reaching).toEqual([]);
    // A planted module file that checks a Telegram chat, or calls fetch through globalThis.
    const planted = new Sources({
      'modules/planted/src/a.ts': "import { checkTelegramChat, CHANNEL_PROVIDERS } from '@crove/channel';\nexport const a = () => checkTelegramChat(CHANNEL_PROVIDERS);",
      'modules/planted/src/b.ts': "export const b = () => globalThis.fetch('https://example.test/');",
      'modules/planted/src/c.ts': "export const c = () => window['fetch']('https://example.test/');",
    });
    expect([...reachOf(planted.get('modules/planted/src/a.ts').program, planted)]).toEqual(['provider:telegram']);
    expect([...reachOf(planted.get('modules/planted/src/b.ts').program, planted)]).toEqual(['raw_network']);
    expect([...reachOf(planted.get('modules/planted/src/c.ts').program, planted)]).toEqual(['raw_network']);
  });

  it('hands the egress guard to the adapters of the providers whose host the tenant names, and to no other', () => {
    const kernel = sources.get('apps/kernel/src/kernel.ts').text;
    const body = kernel.slice(kernel.indexOf('export function channelPublishers('), kernel.indexOf('return publishers;', kernel.indexOf('export function channelPublishers(')));
    const guarded = [...body.matchAll(/publishers\.(\w+) = new \w+\(([^;]*)\);/g)].filter((m) => (m[2] ?? '').includes('egressFetch')).map((m) => m[1]);
    expect(guarded.sort()).toEqual([...TENANT_HOSTED_PROVIDERS].sort());
  });

  it('declares an external effect, at least R2, on every command whose events feed a queue with egress (plan §4.7)', () => {
    const sends = sendSites(sources, known).filter((s) => s.queues.some(hasEgress));
    // Every send of the relay to such a queue names the events that lead to it.
    expect(sends.filter((s) => s.within === 'the outbox relay' && s.events === null).map((s) => `${s.file}:${s.line}`)).toEqual([]);
    const feeds = [...new Set(sends.flatMap((s) => s.events ?? []))].sort();
    expect(feeds).toContain('social.link_preview.requested');
    expect(feeds).toContain('social.variant.remove_requested');

    // Sends outside the relay are the reviewed ones, and what decides each declares an external effect.
    const byName = new Map(all().map((c) => [c.name, c]));
    const external = (name: string) => {
      const def = byName.get(name);
      // register() already holds the declared risk at or above the derived one.
      return def?.sideEffect !== undefined && RANK[deriveRisk(def.sideEffect)] >= RANK.R2;
    };
    expect([...new Set(sends.filter((s) => s.within !== 'the outbox relay').map((s) => s.within))].sort()).toEqual(Object.keys(OTHER_SENDS).sort());
    for (const [site, why] of Object.entries(OTHER_SENDS)) if ('command' in why) expect(external(why.command), `${site}: ${why.command}`).toBe(true);

    const { commands, runs, problems } = emittersOf(feeds, sources, known, ['packages/kernel/src', 'modules', 'apps/kernel/src'], dynamicRuns(all()));
    expect(problems).toEqual([]);
    expect([...commands].filter(([, by]) => by.size === 0).map(([event]) => event)).toEqual(Object.keys(NO_COMMAND).sort());
    // A command that runs one of the commands that decide the other sends, at any depth, declares an external effect.
    for (const [site, why] of Object.entries(OTHER_SENDS)) {
      if (!('command' in why)) continue;
      const callers = new Set([why.command]);
      for (let grown = true; grown; ) {
        grown = false;
        for (const [caller, callees] of runs) {
          if (callers.has(caller) || ![...callees].some((c) => callers.has(c))) continue;
          callers.add(caller);
          grown = true;
        }
      }
      expect([...callers].filter((c) => !external(c)), site).toEqual([]);
    }
    // The nested runs are seen: the ones that once reached an R2 emitter from an R1 command (#1698) among them.
    expect(runs.get('kernel.inbound.receive')).toEqual(new Set(['kernel.file.ingest']));
    expect(runs.get('social.media.save_stock')).toEqual(new Set(['kernel.file.ingest']));
    expect(runs.get('social.post_comment.accept')).toContain('social.post.submit');
    for (const name of ['kernel.file.ingest', 'kernel.inbound.receive', 'social.media.save_stock']) expect(commands.get('kernel.file.ingested')?.has(name), name).toBe(true);
    expect(commands.get('social.post.submitted')?.has('social.post_comment.accept')).toBe(true);
    // Each event with the queues it feeds and their egress: 'social.post.submitted -> social-chat-alert (provider:...)'.
    const fed = (event: string) =>
      [...new Set(sends.filter((s) => s.events?.includes(event)).flatMap((s) => s.queues.filter(hasEgress)))]
        .sort()
        .map((q) => `${event} -> ${q} (${targets(queueEgress(q)).join(', ')})`);
    expect(belowR2(commands, external, fed)).toEqual(BELOW_R2);
  });

  it('follows nested runs to the command that runs them, and fails a planted R1 command that runs an emitter (#1698)', () => {
    const planted = new Sources({
      'modules/planted/src/a.ts': `
        const NAMES = { a: 'planted.emit' } as const;
        export const emitter = defineCommand({ name: 'planted.emit', risk: 'R2', sideEffect: 'external', handler: async (ctx) => ctx.emit('planted.fed', {}) });
        export const outer = defineCommand({ name: 'planted.outer', risk: 'R1', handler: async (ctx) => ctx.run('planted.emit', {}) });
        export const twice = defineCommand({ name: 'planted.twice', risk: 'R1', handler: async (ctx) => ctx.tryRun('planted.outer', {}, { recover: () => true }) });
        export const table = defineCommand({ name: 'planted.table', risk: 'R1', handler: async (ctx, input) => ctx.run(NAMES[input.k], {}) });
        function nest(ctx, name) {
          return ctx.run(name, {});
        }
        export const helper = defineCommand({ name: 'planted.helper', risk: 'R1', handler: async (ctx) => nest(ctx, 'planted.emit') });
        function make(name, inner) {
          return defineCommand({ name, risk: 'R1', handler: async (ctx) => ctx.run(inner, {}) });
        }
        export const made = make('planted.made', 'planted.emit');
        export const quiet = defineCommand({ name: 'planted.quiet', risk: 'R1', handler: async (ctx) => ctx.run('planted.other', {}) });
        export const dynamic = defineCommand({ name: 'planted.dynamic', risk: 'R1', handler: async (ctx, input) => ctx.run(input.name, {}) });
        export const renamed = defineCommand({ name: 'planted.renamed', risk: 'R1', handler: async (c) => c.run('planted.emit', {}) });
        export const arrow = defineCommand({ name: 'planted.arrow', risk: 'R1', handler: async (ctx) => { const go = (name) => ctx.tryRun(name, {}, {}); return go('planted.emit'); } });
        export const pulled = defineCommand({ name: 'planted.pulled', risk: 'R1', handler: async (ctx) => { const { run } = ctx; return run('planted.emit', {}); } });
        export function nestOut(ctx) {
          return ctx.run('planted.emit', {});
        }
        function listed(ctx, name) {
          return ctx.run(name, {});
        }
        export { listed };`,
      'modules/planted/src/b.ts': `
        import { nestOut as n, listed as l } from './a.ts';
        export const aliased = defineCommand({ name: 'planted.aliased', risk: 'R1', handler: async (ctx) => n(ctx) });
        export const far = defineCommand({ name: 'planted.far', risk: 'R1', handler: async (ctx) => l(ctx, 'planted.other') });
        function pass(ctx, input) {
          return ctx.run(input.name, {});
        }
        export const one = defineCommand({ name: 'planted.one', risk: 'R1', handler: async (ctx, input) => pass(ctx, input) });
        export const two = defineCommand({ name: 'planted.two', risk: 'R1', handler: async (ctx, input) => pass(ctx, input) });`,
    });
    const external = (name: string) => name === 'planted.emit';
    const fed = (event: string) => [`${event} -> planted-queue (provider:planted)`];
    const route = ['planted.fed -> planted-queue (provider:planted)'];
    const reached = ['planted.aliased', 'planted.arrow', 'planted.helper', 'planted.made', 'planted.outer', 'planted.renamed', 'planted.table', 'planted.twice'];
    // What the test cannot read it says, and does not guess: a run whose command it cannot read, a parameter of an
    // exported function (called from anywhere), a run taken off its context.
    const blind = emittersOf(['planted.fed'], planted, known, ['modules/planted']);
    expect(blind.problems).toEqual([
      "modules/planted/src/a.ts:16: a nested run whose command the test cannot read (planted.dynamic: input.name); name the commands it may run in the test's dynamic runs",
      'modules/planted/src/a.ts:19: run destructured from its context; call it on the context',
      "modules/planted/src/a.ts:24: a nested run whose command the test cannot read (planted.far: name); name the commands it may run in the test's dynamic runs",
      "modules/planted/src/b.ts:6: a nested run whose command the test cannot read (planted.one: input.name); name the commands it may run in the test's dynamic runs",
      "modules/planted/src/b.ts:6: a nested run whose command the test cannot read (planted.two: input.name); name the commands it may run in the test's dynamic runs",
    ]);
    expect(belowR2(blind.commands, external, fed)).toEqual(Object.fromEntries(reached.map((name) => [name, route])));
    // Told what a dynamic run may run, it follows it for each command it is named for: the helper's other caller stays
    // a problem. A stale entry is a problem too.
    const told = emittersOf(['planted.fed'], planted, known, ['modules/planted'], {
      'planted.dynamic: input.name': ['planted.twice'],
      'planted.one: input.name': ['planted.emit'],
      'planted.gone: x': ['planted.emit'],
    });
    expect(told.problems).toEqual([blind.problems[1], blind.problems[2], blind.problems[4], 'the dynamic run planted.gone: x is no longer in the sources']);
    expect(Object.keys(belowR2(told.commands, external, fed)).sort()).toEqual([...reached, 'planted.dynamic', 'planted.one'].sort());
    // A call listed as not a command's run that is no longer there, under the scanned directories, is a problem.
    expect(emittersOf([], new Sources({ 'apps/kernel/src/stream.ts': 'export {};' }), known, ['apps/kernel/src']).problems).toEqual([
      'apps/kernel/src/stream.ts: gate.run is no longer in the sources (NOT_RUNS)',
    ]);
  });
});
