import { Check, ChevronRight } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import type { Dictionary } from '../../content/vi';
import { Chip, Section, SectionHead } from './ui';

const TONES = ['neutral', 'ok', 'accent', 'ok'] as const;

// How it works (option E, the owner's pick): one invoice through the four real steps, numbered because they are a
// sequence. Each stage shows what that step produces, as a small piece of the app. The stages share their rows through
// a subgrid, so the four boxes and the parts inside them line up at the same height whatever the text length.
export function HowItWorks({ dict }: { dict: Dictionary }) {
  const { flow, entry } = dict;
  const { invoice, checks, proposal, approve } = flow;
  const mocks: ReactNode[] = [
    <div key="invoice" className="flex h-full flex-col">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="font-semibold text-fg">{invoice.kind}</span>
        <span className="num text-subtle">{invoice.series}</span>
      </div>
      <div className="mt-0.5 text-xs text-subtle">{invoice.meta}</div>
      <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
        <dt className="text-subtle">{invoice.sellerLabel}</dt>
        <dd className="truncate">{invoice.seller}</dd>
        <dt className="text-subtle">{invoice.taxIdLabel}</dt>
        <dd className="num">{invoice.taxId}</dd>
      </dl>
      <ul className="mt-3 flex flex-col gap-1 border-t border-line pt-2 text-xs">
        {invoice.lines.map((line) => (
          <li key={line.name} className="flex justify-between gap-3">
            <span className="min-w-0 text-muted">{line.name}</span>
            <span className="num shrink-0">{line.amount}</span>
          </li>
        ))}
      </ul>
      <div className="mt-auto flex justify-between gap-3 border-t border-line pt-2 text-xs font-semibold">
        <span>{invoice.totalLabel}</span>
        <span className="num">{invoice.total}</span>
      </div>
    </div>,
    <div key="checks" className="flex h-full flex-col">
      <ul className="flex flex-col gap-2 text-xs">
        {checks.items.map((item, i) => (
          <li key={item} className="flow-check flex items-center gap-2" style={{ '--i': i } as CSSProperties}>
            <span className="inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-ok-soft text-ok">
              <Check className="size-3" strokeWidth={3} aria-hidden="true" />
            </span>
            {item}
          </li>
        ))}
      </ul>
      <p className="mt-auto border-t border-line pt-2 text-xs text-subtle">{checks.foot}</p>
    </div>,
    <div key="proposal" className="flex h-full flex-col">
      <ul className="flex flex-col gap-2 text-xs">
        {entry.lines.map((line) => (
          <li key={line.account} className={`grid grid-cols-[minmax(0,1fr)_auto] gap-x-2 ${line.side === 'credit' ? 'pl-4' : ''}`}>
            <span className="num font-semibold">
              {line.side === 'credit' ? entry.credit : entry.debit} {line.account}
            </span>
            <span className="num">{line.amount}</span>
            <span className="col-span-2 text-subtle">{line.name}</span>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex items-center gap-2 text-xs">
        <Chip tone="ok">{proposal.balanced}</Chip>
        <span className="text-subtle">{proposal.balancedNote}</span>
      </div>
      <p className="mt-auto border-t border-line pt-2 text-xs text-subtle">{proposal.foot}</p>
    </div>,
    <div key="approve" className="flex h-full flex-col">
      <div className="text-xs font-semibold">{approve.title}</div>
      <div className="mt-0.5 text-xs text-subtle">{approve.sub}</div>
      <div className="mt-3 flex gap-1.5" aria-hidden="true">
        {approve.code.split('').map((digit, i) => (
          <span key={i} className="num inline-flex h-8 w-7 items-center justify-center rounded-sm border border-line-strong/60 bg-surface text-sm font-semibold">
            {digit}
          </span>
        ))}
      </div>
      <div className="mt-auto pt-3" aria-hidden="true">
        <span className="flex h-8 items-center justify-center rounded-md bg-accent text-xs font-semibold text-accent-fg">{approve.button}</span>
      </div>
    </div>,
  ];

  return (
    <Section id="cach-lam" labelledBy="flow-title">
      <SectionHead id="flow-title" title={flow.title} lead={flow.lead} />
      <ol className="grid gap-5 md:grid-cols-2 lg:grid-cols-4">
        {flow.steps.map((step, i) => (
          <li
            key={step.name}
            className="relative grid min-w-0 grid-rows-[auto_auto_1fr_auto] gap-y-3 rounded-lg border border-line bg-surface p-4 md:row-span-4 md:grid-rows-subgrid"
          >
            <div className="flex items-center gap-3">
              <span
                className={`inline-flex size-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${
                  step.final ? 'bg-ok text-bg' : 'bg-accent-soft text-accent-ink'
                }`}
                aria-hidden="true"
              >
                {step.final ? <Check className="size-4" strokeWidth={3} /> : i + 1}
              </span>
              <h3 className="font-display text-lg font-semibold">{step.name}</h3>
            </div>
            <p className="text-sm text-muted">{step.body}</p>
            <div className="min-h-0 rounded-md border border-line bg-bg p-3">{mocks[i]}</div>
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-t border-line pt-3 text-xs">
              <span className="min-w-0">
                <span className="text-subtle">{flow.actorLabel} </span>
                <span className="font-medium">{step.actor}</span>
                <span className="num block text-subtle">{step.time}</span>
              </span>
              <Chip tone={TONES[i] ?? 'neutral'}>{step.confirm}</Chip>
            </div>
            {i < flow.steps.length - 1 ? (
              <span
                className="absolute top-1/2 -right-[19px] z-10 hidden size-6 -translate-y-1/2 items-center justify-center rounded-full border border-line bg-surface text-subtle lg:inline-flex"
                aria-hidden="true"
              >
                <ChevronRight className="size-3.5" />
              </span>
            ) : null}
          </li>
        ))}
      </ol>
    </Section>
  );
}
