// The org chart and AI agents (ADR-0029, issue #258): positions held by members or agents, with every agent-held
// position labelled AI (section 9), the agent templates, the agents' status, max risk and daily run cap, the monthly
// budgets, and "Stop AI". In an org of several legal entities, owners choose each position's entities (#1763). The
// server enforces every rule; the screen hides what the viewer's role can never do.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useMemo, useState, type FormEvent } from 'react';
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
import {
  EVERY_ENTITY,
  LE_SCOPE_MAX,
  agentPermissions,
  budgetUsage,
  chartTree,
  defaultScope,
  holderCandidates,
  isBudgetAmount,
  isEveryEntity,
  scopeNames,
  toggleScopeEntity,
  type AgentPermissions,
  type ChartNode,
  type LeScope,
} from '../lib/agents.ts';
import { errorMessage, isStepUpRequired, orpc, queryClient } from '../lib/api.ts';
import { getConfig } from '../lib/auth.ts';

type Chart = Awaited<ReturnType<typeof orpc.chart.get.call>>;
type Position = Chart['positions'][number];
type Agent = Chart['agents'][number];
type KillSwitch = Chart['killSwitches'][number];
type Member = { userId: string; email: string; displayName: string | null };
type Entity = { id: string; name: string; isDefault: boolean };

const RISKS = ['R0', 'R1', 'R2'] as const;
const AGENT_STATUSES = ['active', 'paused', 'retired'] as const;
// A module by its name in the reader's language ("finance" reads "Kế toán"); a module this build does not know keeps its
// id.
const MODULE_IDS = ['kernel', 'finance', 'social'] as const;
function useModuleName() {
  const t = useTranslations('modules');
  return (id: string) => ((MODULE_IDS as readonly string[]).includes(id) ? t(id as (typeof MODULE_IDS)[number]) : id);
}

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

// "Stop AI": owners and admins, R1, so it never waits for a second factor. One idempotency key per confirmation and per
// reason: a retry of the same request (a lost answer) replays with the same key, but the key is renewed whenever the
// reason is edited, so a changed reason is never sent under a key the server already holds for another reason
// (IDEMPOTENCY_MISMATCH). Renewing is safer than reading that error as "already stopped": the stop is not assumed, the
// new request is simply processed, and stopping twice only engages the switch again.
export function StopAi() {
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
        <Input
          value={reason}
          maxLength={500}
          onChange={(e) => {
            setReason(e.target.value);
            setKey(crypto.randomUUID());
          }}
          className="mt-1"
        />
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
  const moduleName = useModuleName();
  const f = useFormat();
  const release = useMutation(orpc.agents.release.mutationOptions({ onSuccess: refresh }));
  if (switches.length === 0) return null;
  const scopeText = (k: KillSwitch) =>
    k.scope === 'org'
      ? t('scope.org')
      : k.scope === 'module'
        ? t('scopeModule', { module: moduleName(k.target) })
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

// The legal entities of a position (#1763): every entity, or some of the org's, picked one by one. Shown only to owners
// of an org with more than one entity; the server checks the ids (POSITION_SCOPE_INVALID).
function LeScopePicker({ label, entities, value, onChange, disabled }: { label: string; entities: Entity[]; value: LeScope; onChange: (next: string[]) => void; disabled?: boolean }) {
  const t = useTranslations('agents');
  const every = isEveryEntity(value);
  return (
    <fieldset className="text-xs" disabled={disabled}>
      <legend className="text-subtle-foreground">{label}</legend>
      <NativeSelect
        className="mt-1 w-full"
        aria-label={t('leScopeMode')}
        value={every ? 'every' : 'some'}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value === 'every' ? [...EVERY_ENTITY] : defaultScope(entities))}
      >
        <NativeSelectOption value="every">{t('leScopeEvery')}</NativeSelectOption>
        <NativeSelectOption value="some">{t('leScopeSome')}</NativeSelectOption>
      </NativeSelect>
      {!every && (
        <ul className="mt-2 space-y-1">
          {entities.map((e) => (
            <li key={e.id}>
              <label className="flex min-h-6 items-center gap-2 text-foreground">
                <Checkbox
                  checked={value.includes(e.id)}
                  // The commands take at most LE_SCOPE_MAX entities one by one; more is every entity.
                  disabled={disabled || (!value.includes(e.id) && value.length >= LE_SCOPE_MAX)}
                  onCheckedChange={(checked) => onChange(toggleScopeEntity(value, e.id, checked, entities))}
                />
                <span className="break-words">{e.name}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {!every && value.length === 0 && (
        <p className="mt-1 text-destructive" role="alert">
          {t('leScopeNone')}
        </p>
      )}
    </fieldset>
  );
}

const scopeReady = (scope: LeScope) => isEveryEntity(scope) || scope.length > 0;

// A position's legal entities as text, and for owners the control that changes them (kernel.position.update, R3).
function PositionScope({ position, entities, manage }: { position: Position; entities: Entity[]; manage: boolean }) {
  const t = useTranslations('agents');
  const tc = useTranslations('common');
  const [editing, setEditing] = useState<string[] | null>(null);
  const update = useMutation(
    orpc.chart.updatePosition.mutationOptions({
      onSuccess: () => {
        setEditing(null);
        refresh();
      },
    }),
  );
  const locked = isStepUpRequired(update.error);
  const names = scopeNames(position.leScope, entities);
  return (
    <div className="mt-1">
      <p className="text-xs text-subtle-foreground">
        {t('leScopeShown', { names: names === null ? t('leScopeEvery') : names.length > 0 ? names.join(', ') : t('leScopeUnnamed') })}
      </p>
      {manage && editing === null && (
        <Button
          size="sm"
          variant="outline"
          className="mt-1"
          aria-label={t('leScopeEditOf', { title: position.title })}
          onClick={() => {
            update.reset();
            setEditing([...position.leScope]);
          }}
        >
          {t('leScopeEdit')}
        </Button>
      )}
      {manage && editing !== null && (
        <div className="mt-2 space-y-2 rounded-lg border bg-muted/40 p-2">
          <LeScopePicker label={t('leScope')} entities={entities} value={editing} onChange={setEditing} disabled={update.isPending || locked} />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={update.isPending || locked || !scopeReady(editing)}
              onClick={() => update.mutate({ id: position.id, leScope: editing, idempotencyKey: crypto.randomUUID() })}
            >
              {update.isPending ? <Spinner /> : null}
              {t('save')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={update.isPending}
              onClick={() => {
                // A refused request waiting for a second factor is dropped too, so it is never sent after a cancel.
                update.reset();
                setEditing(null);
              }}
            >
              {tc('cancel')}
            </Button>
          </div>
        </div>
      )}
      <Refusal
        error={update.error}
        variables={update.variables}
        retry={(v) => update.mutate(v)}
        reset={() => update.reset()}
        action={t('stepUpLeScope', { title: position.title })}
        className="mt-1 text-xs text-destructive"
      />
    </div>
  );
}

function holderValue(holder: Position['holder']): string {
  if (!holder) return '';
  return holder.type === 'agent' ? `agent:${holder.agentId}` : `user:${holder.userId}`;
}

// Owner control: gives the position to a member or an agent, or vacates it. Picking only proposes the change: the R3
// assign is sent after an inline confirmation, since it changes who acts in the organization's name.
function AssignHolder({ position, members, agents }: { position: Position; members: Member[]; agents: Agent[] }) {
  const t = useTranslations('agents');
  const tc = useTranslations('common');
  const [pending, setPending] = useState<string | null>(null);
  const assign = useMutation(
    orpc.chart.assign.mutationOptions({
      onSuccess: () => {
        setPending(null);
        refresh();
      },
    }),
  );
  const current = holderValue(position.holder);
  const locked = isStepUpRequired(assign.error);
  const labelOf = (value: string): string => {
    const [type, id] = value.split(':');
    if (type === 'user') {
      const m = members.find((x) => x.userId === id);
      return t('holderMember', { name: m ? (m.displayName ?? m.email) : (id ?? '') });
    }
    return t('holderAgent', { name: agents.find((a) => a.id === id)?.displayName ?? id ?? '' });
  };
  const send = (value: string) => {
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
          value={pending ?? current}
          disabled={assign.isPending || locked}
          onChange={(e) => {
            assign.reset();
            setPending(e.target.value === current ? null : e.target.value);
          }}
        >
          <NativeSelectOption value="">{t('holderVacant')}</NativeSelectOption>
          {members.map((m) => (
            <NativeSelectOption key={m.userId} value={`user:${m.userId}`}>
              {t('holderMember', { name: m.displayName ?? m.email })}
            </NativeSelectOption>
          ))}
          {agents.map((a) => (
            <NativeSelectOption key={a.id} value={`agent:${a.id}`}>
              {t('holderAgent', { name: a.displayName })}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </label>
      {pending !== null && !locked && (
        <div className="mt-2 space-y-2 rounded-lg border border-warning/30 bg-warning/10 p-2 text-xs" role="alertdialog" aria-label={t('assignConfirmTitle')}>
          <p className="text-foreground">{pending === '' ? t('assignConfirmVacate', { title: position.title }) : t('assignConfirm', { title: position.title, holder: labelOf(pending) })}</p>
          <div className="flex gap-2">
            <Button size="sm" disabled={assign.isPending} onClick={() => send(pending)}>
              {assign.isPending ? <Spinner /> : null}
              {t('assignConfirmButton')}
            </Button>
            <Button size="sm" variant="ghost" disabled={assign.isPending} onClick={() => setPending(null)}>
              {tc('cancel')}
            </Button>
          </div>
        </div>
      )}
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

// entities: the org's legal entities when it has more than one, else none (the screen then shows no scope).
type PositionContext = {
  members: Member[];
  agents: Agent[];
  positions: Position[];
  templateRoles: ReadonlyMap<string, string>;
  perms: AgentPermissions;
  entities: Entity[];
};

export function PositionNode({ node, ctx }: { node: ChartNode<Position>; ctx: PositionContext }) {
  const t = useTranslations('agents');
  const moduleName = useModuleName();
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
        <p className="text-xs text-subtle-foreground">{t('positionMeta', { module: moduleName(p.module), roleKey: p.roleKey })}</p>
        {ctx.entities.length > 1 && <PositionScope position={p} entities={ctx.entities} manage={ctx.perms.manage} />}
        <p className="text-sm text-muted-foreground">
          {holder === null
            ? t('vacant')
            : holder.type === 'agent'
              ? t('holderAgent', { name: holder.name ?? '' })
              : t('holderMember', { name: holder.displayName ?? holder.email ?? holder.userId })}
        </p>
        {ctx.perms.manage && <AssignHolder position={p} members={ctx.members} agents={holderCandidates(p, ctx.agents, ctx.positions, ctx.templateRoles)} />}
      </Card>
      {node.children.length > 0 && (
        <ul className="mt-2 space-y-2 border-l border-border pl-4">
          {node.children.map((child) => (
            <PositionNode key={child.position.id} node={child} ctx={ctx} />
          ))}
        </ul>
      )}
    </li>
  );
}

// entitiesReady: the org's legal entities are known (an owner's create waits for them, so it never sends no scope
// in an org of several only because the list has not loaded or failed).
function AddPosition({ positions, entities, entitiesReady }: { positions: Position[]; entities: Entity[]; entitiesReady: boolean }) {
  const t = useTranslations('agents');
  const moduleName = useModuleName();
  const modules = getConfig().modules;
  const [title, setTitle] = useState('');
  const [module, setModule] = useState(modules[0] ?? 'kernel');
  const [roleKey, setRoleKey] = useState('');
  const [reportsTo, setReportsTo] = useState('');
  // Until the owner picks, the org's default entity, which the server gives a new position anyway.
  const [picked, setPicked] = useState<string[] | null>(null);
  const leScope = picked ?? defaultScope(entities);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const create = useMutation(orpc.chart.createPosition.mutationOptions({ onSuccess: refresh }));
  const cleared = {
    onSuccess: () => {
      setTitle('');
      setRoleKey('');
      setPicked(null);
      setKey(crypto.randomUUID());
    },
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!entitiesReady || (entities.length > 1 && !scopeReady(leScope))) return;
    create.mutate(
      { title: title.trim(), module, roleKey: roleKey.trim(), reportsTo: reportsTo || null, ...(entities.length > 1 ? { leScope } : {}), idempotencyKey: key },
      cleared,
    );
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
                {moduleName(m)}
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
        {entities.length > 1 && (
          <div className="sm:col-span-2 lg:col-span-5">
            <LeScopePicker label={t('leScope')} entities={entities} value={leScope} onChange={setPicked} disabled={locked} />
          </div>
        )}
        <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-5">
          <Button type="submit" disabled={create.isPending || locked || !entitiesReady || (entities.length > 1 && !scopeReady(leScope))}>
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
export function AgentRow({ agent, perms }: { agent: Agent; perms: AgentPermissions }) {
  const t = useTranslations('agents');
  const tc = useTranslations('common');
  const [status, setStatus] = useState(agent.status);
  const [maxRisk, setMaxRisk] = useState(agent.maxRisk);
  const [cap, setCap] = useState(String(agent.dailyRunCap));
  const [confirmRetire, setConfirmRetire] = useState(false);
  const update = useMutation(orpc.agents.update.mutationOptions({ onSuccess: refresh }));
  const capValue = Number(cap);
  const capValid = Number.isInteger(capValue) && capValue >= 1 && capValue <= 10000;
  const changed = status !== agent.status || maxRisk !== agent.maxRisk || capValue !== agent.dailyRunCap;
  const editable = perms.manage && agent.status !== 'retired';
  const locked = isStepUpRequired(update.error);
  const retiring = status === 'retired' && agent.status !== 'retired';
  const send = () => {
    setConfirmRetire(false);
    update.mutate({
      id: agent.id,
      ...(status !== agent.status ? { status } : {}),
      ...(maxRisk !== agent.maxRisk ? { maxRisk } : {}),
      ...(capValue !== agent.dailyRunCap ? { dailyRunCap: capValue } : {}),
      idempotencyKey: crypto.randomUUID(),
    });
  };
  return (
    <TableRow data-testid="agent-row">
      <TableCell className="px-4">
        <span className="font-medium text-foreground">{agent.displayName}</span>{' '}
        <Badge variant="secondary">{t('aiBadge')}</Badge>
      </TableCell>
      <TableCell className="px-4 text-xs text-muted-foreground">{agent.templateKey}</TableCell>
      <TableCell className="px-4">
        {editable ? (
          <NativeSelect size="sm" aria-label={t('colStatus')} value={status} disabled={locked} onChange={(e) => {
              setStatus(e.target.value as typeof status);
              setConfirmRetire(false);
            }}>
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
        {editable && !confirmRetire && (
          <Button size="sm" disabled={!changed || !capValid || update.isPending || locked} onClick={() => (retiring ? setConfirmRetire(true) : send())}>
            {t('save')}
          </Button>
        )}
        {editable && confirmRetire && (
          // Retiring cannot be undone, so it is sent only after this confirmation.
          <div className="max-w-56 space-y-2 rounded-lg border border-destructive/30 bg-destructive/5 p-2 text-xs" role="alertdialog" aria-label={t('retireConfirmTitle')}>
            <p className="text-foreground">{t('retireConfirm', { name: agent.displayName })}</p>
            <div className="flex gap-2">
              <Button size="sm" variant="destructive" onClick={send}>
                {t('retireConfirmButton')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmRetire(false)}>
                {tc('cancel')}
              </Button>
            </div>
          </div>
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

function Templates({ perms, entities, entitiesReady }: { perms: AgentPermissions; entities: Entity[]; entitiesReady: boolean }) {
  const t = useTranslations('agents');
  const moduleName = useModuleName();
  const templates = useQuery(orpc.chart.templates.queryOptions());
  const install = useMutation(orpc.chart.installTemplate.mutationOptions({ onSuccess: refresh }));
  // The entities of the next agent installed; until the owner picks, the org's default entity, as the server would.
  const [picked, setPicked] = useState<string[] | null>(null);
  const leScope = picked ?? defaultScope(entities);
  // Shown only while some template can be installed.
  const scoped = perms.manage && entities.length > 1 && (templates.data ?? []).some((tpl) => tpl.moduleEnabled);
  return (
    <section className="mt-8">
      <h2 className="mb-3 text-sm font-semibold text-foreground">{t('templatesTitle')}</h2>
      {scoped && (
        <div className="mb-3 max-w-md rounded-lg border bg-muted/40 p-3">
          <LeScopePicker label={t('leScopeInstall')} entities={entities} value={leScope} onChange={setPicked} disabled={install.isPending || isStepUpRequired(install.error)} />
        </div>
      )}
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
                <p className="text-xs text-subtle-foreground">{t('templateMeta', { module: moduleName(tpl.module), risk: tpl.maxRisk, cap: String(tpl.dailyRunCap) })}</p>
                {!tpl.moduleEnabled && (
                  <Alert className="border-warning/30 bg-warning/10 text-warning" role="note">
                    <AlertDescription className="text-warning">{t('moduleDisabled', { module: moduleName(tpl.module) })}</AlertDescription>
                  </Alert>
                )}
                {perms.manage && (
                  <div>
                    <Button
                      size="sm"
                      disabled={!tpl.moduleEnabled || install.isPending || !entitiesReady || (scoped && !scopeReady(leScope))}
                      onClick={() => install.mutate({ templateKey: tpl.key, ...(scoped ? { leScope } : {}), idempotencyKey: crypto.randomUUID() })}
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
  const moduleName = useModuleName();
  const modules = getConfig().modules;
  const [scope, setScope] = useState<(typeof SCOPES)[number]>('org');
  const [target, setTarget] = useState('*');
  const [limit, setLimit] = useState('');
  const [warnPercent, setWarnPercent] = useState('80');
  const [hardStop, setHardStop] = useState(true);
  const [touched, setTouched] = useState(false);
  const set = useMutation(orpc.agents.setBudget.mutationOptions({ onSuccess: refresh }));
  const targets: Array<{ value: string; label: string }> =
    scope === 'org' ? [{ value: '*', label: t('scope.org') }] : scope === 'module' ? modules.map((m) => ({ value: m, label: moduleName(m) })) : agents.map((a) => ({ value: a.id, label: a.displayName }));
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
  const moduleName = useModuleName();
  const f = useFormat();
  const budgets = useQuery(orpc.agents.budgets.queryOptions());
  const targetText = (scope: string, target: string) =>
    scope === 'org' ? t('scope.org') : scope === 'module' ? t('scopeModule', { module: moduleName(target) }) : t('scopeAgent', { name: agents.find((a) => a.id === target)?.displayName ?? target });
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
  // The role each template fills: an agent can only hold a position of its template's role (the server answers
  // AGENT_ROLE_MISMATCH otherwise). Shared with the templates list, which asks for the same query.
  const templates = useQuery(orpc.chart.templates.queryOptions());
  const templateRoles = useMemo(() => new Map((templates.data ?? []).map((tpl) => [tpl.key, tpl.roleKey])), [templates.data]);
  // The org's legal entities, which only owners and admins read (#1763): with one entity the screen shows no scope.
  const legalEntities = useQuery({ ...orpc.legalEntities.list.queryOptions(), enabled: perms.manage });
  // Owners only, whatever another screen left in the cache (Settings reads the same list for admins).
  const entities: Entity[] = perms.manage && (legalEntities.data?.length ?? 0) > 1 ? (legalEntities.data ?? []) : [];
  // Until the list is known, an owner's create and install wait: a failed or pending list is not a single entity.
  const entitiesReady = !perms.manage || legalEntities.data !== undefined;

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
          {perms.manage && legalEntities.error && (
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <ErrorText>{errorMessage(legalEntities.error)}</ErrorText>
              <Button size="sm" variant="outline" disabled={legalEntities.isFetching} onClick={() => void legalEntities.refetch()}>
                {t('leScopeRetry')}
              </Button>
            </div>
          )}
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
                  <PositionNode key={node.position.id} node={node} ctx={{ members, agents: chart.data.agents, positions: chart.data.positions, templateRoles, perms, entities }} />
                ))}
              </ul>
            )}
            {perms.manage && <AddPosition positions={chart.data.positions} entities={entities} entitiesReady={entitiesReady} />}
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
          <Templates perms={perms} entities={entities} entitiesReady={entitiesReady} />
          {perms.budgets && <Budgets agents={chart.data.agents} perms={perms} />}
        </>
      )}
    </div>
  );
}
