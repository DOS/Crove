// The org chart and AI agents (ADR-0029, issue #258): positions held by members or agents, with every agent-held
// position labelled AI (section 9), the agent templates, the agents' status, max risk and daily run cap, the monthly
// budgets, and "Stop AI". The server enforces every rule; the screen hides what the viewer's role can never do.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { Alert, AlertDescription, AlertTitle } from '@crove/ui/components/alert';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Checkbox } from '@crove/ui/components/checkbox';
import { Input } from '@crove/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { TableCell, TableRow } from '@crove/ui/components/table';
import { StepUpPrompt } from '../components/two-factor.tsx';
import { DataTable, Empty, ErrorText, PageHeader, Spinner } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { agentPermissions, budgetUsage, chartTree, isBudgetAmount, type AgentPermissions, type ChartNode } from '../lib/agents.ts';
import { errorMessage, isStepUpRequired, orpc, queryClient } from '../lib/api.ts';
import { getConfig } from '../lib/auth.ts';

type Chart = Awaited<ReturnType<typeof orpc.chart.get.call>>;
type Position = Chart['positions'][number];
type Agent = Chart['agents'][number];
type KillSwitch = Chart['killSwitches'][number];
type Member = { userId: string; email: string; displayName: string | null };

const RISKS = ['R0', 'R1', 'R2'] as const;
const AGENT_STATUSES = ['active', 'paused', 'retired'] as const;
const SCOPES = ['org', 'module', 'agent'] as const;

const refresh = () => void queryClient.invalidateQueries();

// The refusal of a request this screen sent. The chart, agent, template and budget commands and releasing a stop are
// R3 (ADR-0029), so they need a second factor verified in the last 5 minutes (P11): on STEP_UP_REQUIRED the step-up
// prompt asks for one, then `retry` sends the refused request again as it was (a refused request stores no
// idempotency key, so the same key is fine), and cancel drops it (#345). Any other refusal shows as text. While the
// prompt shows, the screen locks the fields of the refused request, so what is sent again is what is on screen, and
// the prompt sits outside any <form>: its own forms and buttons must not submit the screen's form.
function Refusal<V>({
  error,
  variables,
  retry,
  reset,
  action,
  className,
}: {
  error: unknown;
  variables: V | undefined;
  retry: (variables: V) => void;
  reset: () => void;
  action: string;
  className: string;
}) {
  if (!error) return null;
  if (isStepUpRequired(error)) {
    return (
      <div className="mt-2">
        <StepUpPrompt action={action} onVerified={() => variables !== undefined && retry(variables)} onCancel={reset} />
      </div>
    );
  }
  return <p className={className}>{errorMessage(error)}</p>;
}

// "Stop AI": owners and admins, R1, so it never waits for a second factor. One idempotency key per confirmation.
function StopAi() {
  const t = useTranslations('agents');
  const tc = useTranslations('common');
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [key, setKey] = useState(() => crypto.randomUUID());
  const stop = useMutation(orpc.agents.stop.mutationOptions({ onSuccess: refresh }));
  if (!open) {
    return (
      <div className="flex flex-col items-end gap-1">
        <Button variant="destructive" onClick={() => setOpen(true)}>
          {t('stop')}
        </Button>
        {stop.data && <p className="text-xs text-muted-foreground">{t('stopped', { count: String(stop.data.stoppedRuns) })}</p>}
      </div>
    );
  }
  return (
    <div className="max-w-sm space-y-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm" role="alertdialog" aria-label={t('stopTitle')}>
      <p className="font-medium text-foreground">{t('stopTitle')}</p>
      <p className="text-muted-foreground">{t('stopBody')}</p>
      <label className="block text-xs">
        <span className="text-subtle-foreground">{t('stopReason')}</span>
        <Input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} className="mt-1" />
      </label>
      <div className="flex gap-2">
        <Button
          variant="destructive"
          disabled={stop.isPending}
          onClick={() =>
            stop.mutate(
              { scope: 'org', target: '*', ...(reason.trim() ? { reason: reason.trim() } : {}), idempotencyKey: key },
              {
                onSuccess: () => {
                  setOpen(false);
                  setReason('');
                  setKey(crypto.randomUUID());
                },
              },
            )
          }
        >
          {stop.isPending ? <Spinner /> : null}
          {t('stopConfirm')}
        </Button>
        <Button variant="ghost" disabled={stop.isPending} onClick={() => setOpen(false)}>
          {tc('cancel')}
        </Button>
      </div>
      {stop.error && <ErrorText>{errorMessage(stop.error)}</ErrorText>}
    </div>
  );
}

function KillSwitches({ switches, agents, perms }: { switches: KillSwitch[]; agents: Agent[]; perms: AgentPermissions }) {
  const t = useTranslations('agents');
  const f = useFormat();
  const release = useMutation(orpc.agents.release.mutationOptions({ onSuccess: refresh }));
  if (switches.length === 0) return null;
  const scopeText = (k: KillSwitch) =>
    k.scope === 'org'
      ? t('scope.org')
      : k.scope === 'module'
        ? t('scopeModule', { module: k.target })
        : t('scopeAgent', { name: agents.find((a) => a.id === k.target)?.displayName ?? k.target });
  return (
    <Alert variant="destructive" className="mb-6 border-destructive/30 bg-destructive/10" role="status">
      <AlertTitle>{t('killSwitchOn')}</AlertTitle>
      <AlertDescription>
        <ul className="mt-2 space-y-2">
          {switches.map((k) => (
            <li key={k.id} className="flex flex-wrap items-center justify-between gap-2">
              <span>
                <strong>{scopeText(k)}</strong>. {t('killSwitchSince', { when: f.dateTime(k.engagedAt) })}
                {k.reason ? `. ${t('killSwitchReason', { reason: k.reason })}` : ''}
              </span>
              {perms.manage && (
                <Button size="sm" variant="outline" disabled={release.isPending} onClick={() => release.mutate({ id: k.id, idempotencyKey: crypto.randomUUID() })}>
                  {t('release')}
                </Button>
              )}
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs">{t('releaseHint')}</p>
        <Refusal
          error={release.error}
          variables={release.variables}
          retry={(v) => release.mutate(v)}
          reset={() => release.reset()}
          action={t('stepUpRelease')}
          className="mt-2 text-xs"
        />
      </AlertDescription>
    </Alert>
  );
}

function holderValue(holder: Position['holder']): string {
  if (!holder) return '';
  return holder.type === 'agent' ? `agent:${holder.agentId}` : `user:${holder.userId}`;
}

// Owner control: gives the position to a member or an agent, or vacates it.
function AssignHolder({ position, members, agents }: { position: Position; members: Member[]; agents: Agent[] }) {
  const t = useTranslations('agents');
  const assign = useMutation(orpc.chart.assign.mutationOptions({ onSuccess: refresh }));
  const pick = (value: string) => {
    const [type, id] = value.split(':');
    const holder = type === 'user' && id ? { type: 'user' as const, userId: id } : type === 'agent' && id ? { type: 'agent' as const, agentId: id } : null;
    assign.mutate({ id: position.id, holder, idempotencyKey: crypto.randomUUID() });
  };
  return (
    <div className="mt-2">
      <label className="block text-xs">
        <span className="text-subtle-foreground">{t('holder')}</span>
        <NativeSelect
          size="sm"
          className="mt-1 w-full"
          value={holderValue(position.holder)}
          disabled={assign.isPending || isStepUpRequired(assign.error)}
          onChange={(e) => pick(e.target.value)}
        >
          <NativeSelectOption value="">{t('holderVacant')}</NativeSelectOption>
          {members.map((m) => (
            <NativeSelectOption key={m.userId} value={`user:${m.userId}`}>
              {t('holderMember', { name: m.displayName ?? m.email })}
            </NativeSelectOption>
          ))}
          {agents
            .filter((a) => a.status === 'active')
            .map((a) => (
              <NativeSelectOption key={a.id} value={`agent:${a.id}`}>
                {t('holderAgent', { name: a.displayName })}
              </NativeSelectOption>
            ))}
        </NativeSelect>
      </label>
      <Refusal
        error={assign.error}
        variables={assign.variables}
        retry={(v) => assign.mutate(v)}
        reset={() => assign.reset()}
        action={t('stepUpAssign', { title: position.title })}
        className="mt-1 text-xs text-destructive"
      />
    </div>
  );
}

function PositionNode({ node, members, agents, perms }: { node: ChartNode<Position>; members: Member[]; agents: Agent[]; perms: AgentPermissions }) {
  const t = useTranslations('agents');
  const p = node.position;
  const holder = p.holder;
  return (
    <li>
      <Card className="gap-1 p-3" data-testid="position">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-foreground">{p.title}</span>
          {holder?.ai && (
            // ADR-0029 section 9: an agent-held position is always labelled as AI.
            <Badge variant="secondary" aria-label={t('aiBadge')}>
              {t('aiBadge')}
            </Badge>
          )}
          {p.status === 'paused' && <Badge variant="warning">{t('positionPaused')}</Badge>}
          {p.status === 'archived' && <Badge variant="outline">{t('positionArchived')}</Badge>}
        </div>
        <p className="text-xs text-subtle-foreground">{t('positionMeta', { module: p.module, roleKey: p.roleKey })}</p>
        <p className="text-sm text-muted-foreground">
          {holder === null
            ? t('vacant')
            : holder.type === 'agent'
              ? t('holderAgent', { name: holder.name ?? '' })
              : t('holderMember', { name: holder.displayName ?? holder.email ?? holder.userId })}
        </p>
        {perms.manage && <AssignHolder position={p} members={members} agents={agents} />}
      </Card>
      {node.children.length > 0 && (
        <ul className="mt-2 space-y-2 border-l border-border pl-4">
          {node.children.map((child) => (
            <PositionNode key={child.position.id} node={child} members={members} agents={agents} perms={perms} />
          ))}
        </ul>
      )}
    </li>
  );
}

function AddPosition({ positions }: { positions: Position[] }) {
  const t = useTranslations('agents');
  const modules = getConfig().modules;
  const [title, setTitle] = useState('');
  const [module, setModule] = useState(modules[0] ?? 'kernel');
  const [roleKey, setRoleKey] = useState('');
  const [reportsTo, setReportsTo] = useState('');
  const [key, setKey] = useState(() => crypto.randomUUID());
  const create = useMutation(orpc.chart.createPosition.mutationOptions({ onSuccess: refresh }));
  const cleared = {
    onSuccess: () => {
      setTitle('');
      setRoleKey('');
      setKey(crypto.randomUUID());
    },
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate({ title: title.trim(), module, roleKey: roleKey.trim(), reportsTo: reportsTo || null, idempotencyKey: key }, cleared);
  };
  const locked = isStepUpRequired(create.error);
  return (
    <>
      <form onSubmit={submit} className="mt-4 grid gap-3 rounded-lg border bg-muted/40 p-3 sm:grid-cols-2 lg:grid-cols-5">
        <label className="block text-xs lg:col-span-2">
          <span className="text-subtle-foreground">{t('positionTitle')}</span>
          <Input required maxLength={200} value={title} disabled={locked} onChange={(e) => setTitle(e.target.value)} className="mt-1" />
        </label>
        <label className="block text-xs">
          <span className="text-subtle-foreground">{t('positionModule')}</span>
          <NativeSelect className="mt-1 w-full" value={module} disabled={locked} onChange={(e) => setModule(e.target.value)}>
            {modules.map((m) => (
              <NativeSelectOption key={m} value={m}>
                {m}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
        <label className="block text-xs">
          <span className="text-subtle-foreground">{t('positionRoleKey')}</span>
          <Input required pattern="[a-z][a-z0-9_.]*" maxLength={100} value={roleKey} disabled={locked} onChange={(e) => setRoleKey(e.target.value)} className="mt-1" />
        </label>
        <label className="block text-xs">
          <span className="text-subtle-foreground">{t('reportsTo')}</span>
          <NativeSelect className="mt-1 w-full" value={reportsTo} disabled={locked} onChange={(e) => setReportsTo(e.target.value)}>
            <NativeSelectOption value="">{t('reportsToOwners')}</NativeSelectOption>
            {positions.map((p) => (
              <NativeSelectOption key={p.id} value={p.id}>
                {p.title}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
        <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-5">
          <Button type="submit" disabled={create.isPending || locked}>
            {create.isPending ? <Spinner /> : null}
            {t('addPosition')}
          </Button>
          {create.error && !locked && <span className="text-xs text-destructive">{errorMessage(create.error)}</span>}
        </div>
      </form>
      {locked && (
        <Refusal
          error={create.error}
          variables={create.variables}
          retry={(v) => create.mutate(v, cleared)}
          reset={() => create.reset()}
          action={t('stepUpAddPosition', { title: create.variables?.title ?? '' })}
          className="text-xs text-destructive"
        />
      )}
    </>
  );
}

// Owner controls for one agent: status, max risk and daily run cap, saved together.
function AgentRow({ agent, perms }: { agent: Agent; perms: AgentPermissions }) {
  const t = useTranslations('agents');
  const [status, setStatus] = useState(agent.status);
  const [maxRisk, setMaxRisk] = useState(agent.maxRisk);
  const [cap, setCap] = useState(String(agent.dailyRunCap));
  const update = useMutation(orpc.agents.update.mutationOptions({ onSuccess: refresh }));
  const capValue = Number(cap);
  const capValid = Number.isInteger(capValue) && capValue >= 1 && capValue <= 10000;
  const changed = status !== agent.status || maxRisk !== agent.maxRisk || capValue !== agent.dailyRunCap;
  const editable = perms.manage && agent.status !== 'retired';
  const locked = isStepUpRequired(update.error);
  return (
    <TableRow data-testid="agent-row">
      <TableCell className="px-4">
        <span className="font-medium text-foreground">{agent.displayName}</span>{' '}
        <Badge variant="secondary">{t('aiBadge')}</Badge>
      </TableCell>
      <TableCell className="px-4 text-xs text-muted-foreground">{agent.templateKey}</TableCell>
      <TableCell className="px-4">
        {editable ? (
          <NativeSelect size="sm" aria-label={t('colStatus')} value={status} disabled={locked} onChange={(e) => setStatus(e.target.value as typeof status)}>
            {AGENT_STATUSES.map((s) => (
              <NativeSelectOption key={s} value={s}>
                {t(`status.${s}`)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        ) : (
          <Badge variant={agent.status === 'active' ? 'success' : 'outline'}>{t(`status.${agent.status}`)}</Badge>
        )}
        {editable && status === 'retired' && agent.status !== 'retired' && <p className="mt-1 text-xs text-warning">{t('retireHint')}</p>}
      </TableCell>
      <TableCell className="px-4">
        {editable ? (
          <NativeSelect size="sm" aria-label={t('colMaxRisk')} value={maxRisk} disabled={locked} onChange={(e) => setMaxRisk(e.target.value as typeof maxRisk)}>
            {RISKS.map((r) => (
              <NativeSelectOption key={r} value={r}>
                {r}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        ) : (
          agent.maxRisk
        )}
      </TableCell>
      <TableCell className="px-4">
        {editable ? (
          <Input aria-label={t('colDailyCap')} type="number" min={1} max={10000} value={cap} disabled={locked} onChange={(e) => setCap(e.target.value)} className="w-24" />
        ) : (
          agent.dailyRunCap
        )}
      </TableCell>
      <TableCell className="px-4">
        {editable && (
          <Button
            size="sm"
            disabled={!changed || !capValid || update.isPending || locked}
            onClick={() =>
              update.mutate({
                id: agent.id,
                ...(status !== agent.status ? { status } : {}),
                ...(maxRisk !== agent.maxRisk ? { maxRisk } : {}),
                ...(capValue !== agent.dailyRunCap ? { dailyRunCap: capValue } : {}),
                idempotencyKey: crypto.randomUUID(),
              })
            }
          >
            {t('save')}
          </Button>
        )}
        <Refusal
          error={update.error}
          variables={update.variables}
          retry={(v) => update.mutate(v)}
          reset={() => update.reset()}
          action={t('stepUpUpdateAgent', { name: agent.displayName })}
          className="mt-1 text-xs text-destructive"
        />
      </TableCell>
    </TableRow>
  );
}

function Templates({ perms }: { perms: AgentPermissions }) {
  const t = useTranslations('agents');
  const templates = useQuery(orpc.chart.templates.queryOptions());
  const install = useMutation(orpc.chart.installTemplate.mutationOptions({ onSuccess: refresh }));
  return (
    <section className="mt-8">
      <h2 className="mb-3 text-sm font-semibold text-foreground">{t('templatesTitle')}</h2>
      {templates.isPending ? (
        <Spinner />
      ) : templates.error ? (
        <ErrorText>{errorMessage(templates.error)}</ErrorText>
      ) : templates.data.length === 0 ? (
        <Empty title={t('noTemplates')} />
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {templates.data.map((tpl) => (
            <li key={tpl.key}>
              <Card className="gap-2 p-3" data-testid="template">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-foreground">{tpl.title}</span>
                  <Badge variant="secondary">{t('aiBadge')}</Badge>
                </div>
                <p className="text-xs text-subtle-foreground">{t('templateMeta', { module: tpl.module, risk: tpl.maxRisk, cap: String(tpl.dailyRunCap) })}</p>
                {!tpl.moduleEnabled && (
                  <Alert className="border-warning/30 bg-warning/10 text-warning" role="note">
                    <AlertDescription className="text-warning">{t('moduleDisabled', { module: tpl.module })}</AlertDescription>
                  </Alert>
                )}
                {perms.manage && (
                  <div>
                    <Button
                      size="sm"
                      disabled={!tpl.moduleEnabled || install.isPending}
                      onClick={() => install.mutate({ templateKey: tpl.key, idempotencyKey: crypto.randomUUID() })}
                    >
                      {t('install')}
                    </Button>
                  </div>
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}
      {install.data && <p className="mt-2 text-sm text-success">{t('installed')}</p>}
      {install.error && !isStepUpRequired(install.error) && (
        <div className="mt-2">
          <ErrorText>{errorMessage(install.error)}</ErrorText>
        </div>
      )}
      {isStepUpRequired(install.error) && (
        <Refusal
          error={install.error}
          variables={install.variables}
          retry={(v) => install.mutate(v)}
          reset={() => install.reset()}
          action={t('stepUpInstall', { title: templates.data?.find((tpl) => tpl.key === install.variables?.templateKey)?.title ?? install.variables?.templateKey ?? '' })}
          className="text-sm text-destructive"
        />
      )}
    </section>
  );
}

function BudgetForm({ agents }: { agents: Agent[] }) {
  const t = useTranslations('agents');
  const modules = getConfig().modules;
  const [scope, setScope] = useState<(typeof SCOPES)[number]>('org');
  const [target, setTarget] = useState('*');
  const [limit, setLimit] = useState('');
  const [warnPercent, setWarnPercent] = useState('80');
  const [hardStop, setHardStop] = useState(true);
  const [touched, setTouched] = useState(false);
  const set = useMutation(orpc.agents.setBudget.mutationOptions({ onSuccess: refresh }));
  const targets: Array<{ value: string; label: string }> =
    scope === 'org' ? [{ value: '*', label: t('scope.org') }] : scope === 'module' ? modules.map((m) => ({ value: m, label: m })) : agents.map((a) => ({ value: a.id, label: a.displayName }));
  const amountOk = isBudgetAmount(limit);
  const warn = Number(warnPercent);
  const warnOk = Number.isInteger(warn) && warn >= 1 && warn <= 100;
  const pickScope = (next: (typeof SCOPES)[number]) => {
    setScope(next);
    setTarget(next === 'org' ? '*' : next === 'module' ? (modules[0] ?? '') : (agents[0]?.id ?? ''));
  };
  const locked = isStepUpRequired(set.error);
  return (
    <>
      <form
        className="mt-4 grid gap-3 rounded-lg border bg-muted/40 p-3 sm:grid-cols-2 lg:grid-cols-5"
        onSubmit={(event) => {
          event.preventDefault();
          setTouched(true);
          if (!amountOk || !warnOk || !target) return;
          set.mutate({ scope, target, monthlyLimit: limit.trim(), warnPercent: warn, hardStop, idempotencyKey: crypto.randomUUID() });
        }}
      >
        <label className="block text-xs">
          <span className="text-subtle-foreground">{t('budgetScope')}</span>
          <NativeSelect className="mt-1 w-full" value={scope} disabled={locked} onChange={(e) => pickScope(e.target.value as (typeof SCOPES)[number])}>
            {SCOPES.map((s) => (
              <NativeSelectOption key={s} value={s}>
                {t(`scope.${s}`)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
        <label className="block text-xs">
          <span className="text-subtle-foreground">{t('budgetTarget')}</span>
          <NativeSelect className="mt-1 w-full" value={target} onChange={(e) => setTarget(e.target.value)} disabled={scope === 'org' || locked}>
            {targets.map((o) => (
              <NativeSelectOption key={o.value} value={o.value}>
                {o.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
        <label className="block text-xs">
          <span className="text-subtle-foreground">{t('budgetLimit')}</span>
          <Input inputMode="decimal" required value={limit} disabled={locked} onChange={(e) => setLimit(e.target.value)} className="mt-1" aria-invalid={touched && !amountOk} />
        </label>
        <label className="block text-xs">
          <span className="text-subtle-foreground">{t('warnPercent')}</span>
          <Input type="number" min={1} max={100} value={warnPercent} disabled={locked} onChange={(e) => setWarnPercent(e.target.value)} className="mt-1" />
        </label>
        <label className="flex items-center gap-2 self-end pb-2 text-xs text-muted-foreground">
          <Checkbox checked={hardStop} disabled={locked} onCheckedChange={(checked) => setHardStop(checked)} />
          {t('hardStop')}
        </label>
        <div className="flex flex-wrap items-center gap-2 sm:col-span-2 lg:col-span-5">
          <Button type="submit" disabled={set.isPending || locked}>
            {set.isPending ? <Spinner /> : null}
            {t('setBudget')}
          </Button>
          {touched && !amountOk && <span className="text-xs text-destructive">{t('budgetAmountInvalid')}</span>}
          {touched && !warnOk && <span className="text-xs text-destructive">{t('warnPercentInvalid')}</span>}
          {touched && !target && <span className="text-xs text-destructive">{t('budgetTargetMissing')}</span>}
          {set.error && !locked && <span className="text-xs text-destructive">{errorMessage(set.error)}</span>}
        </div>
      </form>
      {locked && <Refusal error={set.error} variables={set.variables} retry={(v) => set.mutate(v)} reset={() => set.reset()} action={t('stepUpBudget')} className="text-xs text-destructive" />}
    </>
  );
}

function Budgets({ agents, perms }: { agents: Agent[]; perms: AgentPermissions }) {
  const t = useTranslations('agents');
  const f = useFormat();
  const budgets = useQuery(orpc.agents.budgets.queryOptions());
  const targetText = (scope: string, target: string) =>
    scope === 'org' ? t('scope.org') : scope === 'module' ? t('scopeModule', { module: target }) : t('scopeAgent', { name: agents.find((a) => a.id === target)?.displayName ?? target });
  return (
    <section className="mt-8">
      <h2 className="text-sm font-semibold text-foreground">{t('budgetsTitle')}</h2>
      <p className="mt-1 mb-3 text-xs text-muted-foreground">{t('budgetsHint')}</p>
      {budgets.isPending ? (
        <Spinner />
      ) : budgets.error ? (
        <ErrorText>{errorMessage(budgets.error)}</ErrorText>
      ) : budgets.data.length === 0 ? (
        <Empty title={t('noBudgets')} />
      ) : (
        <DataTable head={[t('colScope'), t('colLimit'), t('colSpent'), t('colUsage')]}>
          {budgets.data.map((b) => {
            const usage = budgetUsage(b.spent, b.monthlyLimit, b.warnPercent);
            return (
              <TableRow key={b.id} data-testid="budget-row">
                <TableCell className="px-4">{targetText(b.scope, b.target)}</TableCell>
                <TableCell className="px-4 tabular-nums">
                  {f.aiAmount(b.monthlyLimit)} <span className="text-xs text-subtle-foreground">({b.hardStop ? t('hardStop') : t('softLimit')})</span>
                </TableCell>
                <TableCell className="px-4 tabular-nums">{f.aiAmount(b.spent)}</TableCell>
                <TableCell className="px-4">
                  <Badge variant={usage.state === 'spent' ? 'destructive' : usage.state === 'warn' ? 'warning' : 'success'}>
                    {t('usage', { percent: String(usage.percent) })} {t(`usageState.${usage.state}`)}
                  </Badge>
                </TableCell>
              </TableRow>
            );
          })}
        </DataTable>
      )}
      {perms.manage && <BudgetForm agents={agents} />}
    </section>
  );
}

export function AgentsPage() {
  const t = useTranslations('agents');
  const org = useQuery(orpc.org.get.queryOptions());
  const chart = useQuery(orpc.chart.get.queryOptions());
  const perms = agentPermissions(org.data?.role);
  const members: Member[] = org.data?.members ?? [];

  return (
    <div>
      <PageHeader title={t('title')} subtitle={t('subtitle')} actions={perms.stop ? <StopAi /> : undefined} />
      {chart.isPending ? (
        <Spinner />
      ) : chart.error ? (
        <ErrorText>{errorMessage(chart.error)}</ErrorText>
      ) : (
        <>
          <KillSwitches switches={chart.data.killSwitches} agents={chart.data.agents} perms={perms} />
          {perms.manage && <p className="mb-4 text-xs text-muted-foreground">{t('manageHint')}</p>}
          <section>
            <h2 className="mb-3 text-sm font-semibold text-foreground">{t('chart')}</h2>
            <Card className="mb-3 gap-1 p-3">
              <span className="text-xs text-subtle-foreground">{t('root')}</span>
              <span className="text-sm text-foreground">{chart.data.root.map((o) => o.displayName ?? o.email ?? o.userId).join(', ')}</span>
            </Card>
            {chart.data.positions.length === 0 ? (
              <Empty title={t('noPositions')} hint={t('noPositionsHint')} />
            ) : (
              <ul className="space-y-2 border-l border-border pl-4">
                {chartTree(chart.data.positions).map((node) => (
                  <PositionNode key={node.position.id} node={node} members={members} agents={chart.data.agents} perms={perms} />
                ))}
              </ul>
            )}
            {perms.manage && <AddPosition positions={chart.data.positions} />}
          </section>
          <section className="mt-8">
            <h2 className="mb-3 text-sm font-semibold text-foreground">{t('agentsTitle')}</h2>
            {chart.data.agents.length === 0 ? (
              <Empty title={t('noAgents')} />
            ) : (
              <DataTable head={[t('colAgent'), t('colTemplate'), t('colStatus'), t('colMaxRisk'), t('colDailyCap'), '']}>
                {chart.data.agents.map((a) => (
                  // Keyed on the saved values, so the row's inputs start again from the server's answer.
                  <AgentRow key={`${a.id}:${a.status}:${a.maxRisk}:${a.dailyRunCap}`} agent={a} perms={perms} />
                ))}
              </DataTable>
            )}
          </section>
          <Templates perms={perms} />
          {perms.budgets && <Budgets agents={chart.data.agents} perms={perms} />}
        </>
      )}
    </div>
  );
}
