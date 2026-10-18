'use client';

import { Bot, Check, ListChecks, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import type { Dictionary } from '../../content/vi';
import { Chip, toneOf } from './ui';

type Agents = Dictionary['agents'];
type Node = Agents['nodes'][number];
type PanelId = keyof Agents['panels'];

function NodeCard({ node, selected, onSelect, a }: { node: Node; selected: boolean; onSelect: () => void; a: Agents }) {
  const isAgent = node.kind === 'agent';
  const isTasks = node.kind === 'tasks';
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`relative z-10 mx-auto flex w-full max-w-[210px] min-w-0 flex-col gap-1.5 rounded-lg border bg-surface p-2.5 text-left transition-colors sm:p-3 ${
        isAgent ? 'border-dashed border-accent/70' : 'border-line-strong/50'
      } ${selected ? 'outline-2 outline-offset-2 outline-accent' : 'hover:bg-surface-2'}`}
    >
      <span className="flex items-center gap-2">
        {isAgent ? (
          <Bot className="size-4 shrink-0 text-accent-ink" aria-hidden="true" />
        ) : isTasks ? (
          <ListChecks className="size-4 shrink-0 text-muted" aria-hidden="true" />
        ) : (
          <span className="hidden size-6 shrink-0 items-center justify-center rounded-full bg-surface-2 text-[10px] font-semibold text-muted sm:inline-flex" aria-hidden="true">
            {node.initials}
          </span>
        )}
        <span className="min-w-0 text-[13px] leading-tight font-semibold sm:text-sm">{node.name}</span>
      </span>
      <span className="text-[11px] leading-snug text-subtle sm:text-xs">{node.role}</span>
      {node.budget ? (
        <span className="flex flex-col gap-1">
          <span className="h-1 rounded-full bg-surface-2">
            <span className="block h-full rounded-full bg-accent" style={{ width: `${node.budget.pct}%` }} />
          </span>
          <span className="flex items-center justify-between gap-1 text-[11px] text-subtle">
            <span className="num">{node.budget.pct}%</span>
            <span className="rounded-sm border border-accent/50 px-1 font-medium text-accent-ink">{node.budget.risk}</span>
          </span>
        </span>
      ) : null}
      {node.chip ? (
        <Chip tone={toneOf(node.chip.tone)} wrap className="self-start text-[11px] leading-snug sm:text-xs">
          {node.chip.tone === 'ok' ? <Check className="size-3 shrink-0" aria-hidden="true" /> : null}
          {node.chip.label}
        </Chip>
      ) : null}
      <span className="sr-only">{a.hint}</span>
    </button>
  );
}

// The agents section's org chart: people and agents in their positions. Each node is a button that opens what is
// waiting at that position; the accounting agent is selected first.
export function OrgChart({ dict }: { dict: Dictionary }) {
  const a = dict.agents;
  const [selected, setSelected] = useState<PanelId>('acc');
  const byId = Object.fromEntries(a.nodes.map((n) => [n.id, n])) as Record<PanelId, Node>;
  const panel = a.panels[selected];
  const node = (id: PanelId) => <NodeCard node={byId[id]} selected={selected === id} onSelect={() => setSelected(id)} a={a} />;

  return (
    <div className="grid overflow-hidden rounded-lg border border-line bg-surface lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="min-w-0 border-b border-line lg:border-r lg:border-b-0">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
          <div className="text-sm">
            <span className="font-semibold">{a.chartTitle}</span> <span className="text-subtle">{a.chartSub}</span>
          </div>
          <div className="flex items-center gap-3 text-xs text-muted">
            <span className="flex items-center gap-1.5">
              <span className="size-3 rounded-sm border border-line-strong" aria-hidden="true" />
              {a.legendPerson}
            </span>
            <span className="flex items-center gap-1.5">
              <span className="size-3 rounded-sm border border-dashed border-accent" aria-hidden="true" />
              {a.legendAgent}
            </span>
          </div>
        </div>
        <div className="canvas-dots px-2 py-6 sm:px-6 sm:py-8">
          <p className="mb-5 text-center text-xs text-subtle">{a.hint}</p>
          <div className="grid grid-cols-3 gap-x-2 sm:gap-x-4">
            <div className="col-span-3">{node('tuan')}</div>
            {/* Director to the two managers */}
            <div className="relative col-span-3 h-8" aria-hidden="true">
              <span className="absolute top-0 left-1/2 h-1/2 w-px bg-line-strong" />
              <span className="absolute top-1/2 right-[16.667%] left-[16.667%] h-px bg-line-strong" />
              <span className="absolute top-1/2 left-[16.667%] h-1/2 w-px bg-line-strong" />
              <span className="absolute top-1/2 right-[16.667%] h-1/2 w-px bg-line-strong" />
            </div>
            {node('lan')}
            <div />
            {node('minh')}
            {/* Managers to their agents: dashed, the path a proposal travels up */}
            <div className="relative col-span-3 h-14" aria-hidden="true">
              <span className="absolute top-0 left-[16.667%] h-full border-l border-dashed border-accent/70" />
              <span className="absolute top-0 right-[16.667%] h-full border-l border-dashed border-accent/70" />
              <span className="absolute top-1/2 left-1/2 hidden -translate-x-1/2 -translate-y-1/2 text-[11px] whitespace-nowrap text-subtle sm:block">{a.edgeLabel}</span>
            </div>
            <div className="relative col-span-3 grid grid-cols-3 gap-x-2 sm:gap-x-4">
              <span className="absolute top-1/2 right-[16.667%] left-[16.667%] border-t border-dashed border-line-strong" aria-hidden="true" />
              {node('acc')}
              {node('tasks')}
              {node('social')}
            </div>
          </div>
        </div>
      </div>

      <div className="min-w-0 p-5" aria-live="polite">
        <div className="text-xs text-subtle">{panel.kicker}</div>
        <h3 className="font-display text-xl font-semibold">{panel.title}</h3>
        <p className="mt-1 text-sm text-muted">{panel.sub}</p>
        {byId[selected].budget ? (
          <div className="mt-4 rounded-md border border-line p-3">
            <div className="text-xs text-subtle">{a.budget}</div>
            <div className="num mt-1 font-mono text-[13px] text-fg">
              {byId[selected].budget?.used} / {byId[selected].budget?.total}
            </div>
            <div className="mt-2 h-1.5 rounded-full bg-surface-2">
              <div className="h-full rounded-full bg-accent" style={{ width: `${byId[selected].budget?.pct ?? 0}%` }} />
            </div>
            <div className="mt-3 flex items-center gap-2 text-xs text-subtle">
              {a.risk}
              <span className="rounded-sm border border-accent/50 px-1 font-medium text-accent-ink">{byId[selected].budget?.risk}</span>
            </div>
          </div>
        ) : null}
        <div className="mt-5 text-xs text-subtle">{a.waitingFor}</div>
        <ul className="mt-2 flex flex-col gap-2">
          {panel.items.map((item) => (
            <li key={item.title} className={`rounded-md border border-line p-3 ${item.tone === 'warn' ? 'shadow-[inset_2px_0_0_var(--warn)]' : item.tone === 'ok' ? 'shadow-[inset_2px_0_0_var(--ok)]' : ''}`}>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm font-medium">{item.title}</span>
                {item.amount ? <span className="num shrink-0 font-mono text-[13px]">{item.amount}</span> : null}
              </div>
              <div className="text-xs text-subtle">{item.sub}</div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Chip tone={toneOf(item.tone)} wrap>
                  {item.tone === 'warn' ? <TriangleAlert className="size-3 shrink-0" aria-hidden="true" /> : null}
                  {item.chip}
                </Chip>
                {item.note ? <span className="text-xs text-subtle">{item.note}</span> : null}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
