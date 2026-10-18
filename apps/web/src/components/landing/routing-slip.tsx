import type { Dictionary } from '../../content/vi';
import { Section, SectionHead } from './ui';

// How it works, drawn as the routing slip an accounting office passes around: four steps, who handled each one and
// when, and a confirmation box. The last box carries the approver's signature.
export function RoutingSlip({ dict }: { dict: Dictionary }) {
  const { flow } = dict;
  return (
    <Section id="san-pham" labelledBy="flow-title">
      <SectionHead id="flow-title" title={flow.title} lead={flow.lead} />
      <div className="overflow-hidden rounded-lg border border-line-strong/50 bg-surface">
        <div className="flex flex-col gap-1 border-b border-line-strong/50 px-5 py-4 sm:flex-row sm:items-baseline sm:justify-between">
          <h3 className="font-display text-base font-semibold">{flow.slipTitle}</h3>
          <span className="num text-sm text-subtle">{flow.slipRef}</span>
        </div>
        <ol className="grid gap-px bg-line md:grid-cols-2 lg:grid-cols-4">
          {flow.steps.map((step, i) => (
            <li key={step.name} className="flex min-w-0 flex-col gap-4 bg-surface p-5">
              <div className="flex items-baseline gap-2.5">
                <span className="num font-display text-2xl font-semibold text-accent-ink" aria-hidden="true">
                  {i + 1}
                </span>
                <h4 className="font-display text-lg font-semibold">{step.name}</h4>
              </div>
              <p className="text-sm text-muted">{step.body}</p>
              <dl className="mt-auto grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 border-t border-line pt-3 text-sm">
                <dt className="text-subtle">{flow.actorLabel}</dt>
                <dd className="font-medium">{step.actor}</dd>
                <dt className="text-subtle">{flow.timeLabel}</dt>
                <dd className="num font-medium">{step.time}</dd>
              </dl>
              <div className={`min-h-[84px] rounded-sm border px-3 py-2 ${step.signed ? 'border-accent/60' : 'border-line'}`}>
                <div className="text-xs text-subtle">{flow.confirmLabel}</div>
                {step.signed ? (
                  <svg viewBox="0 0 120 28" className="mt-1 h-6 w-28 text-accent-ink" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
                    <path d="M3 21c5-9 8-14 10-14s-3 14 1 14 6-12 9-12-1 11 3 11 5-9 8-9 1 8 5 8c6 0 12-9 22-11 9-2 20-1 30-3" />
                  </svg>
                ) : null}
                <div className={`text-sm ${step.signed ? 'font-medium text-fg' : 'mt-1 text-muted'}`}>{step.confirm}</div>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </Section>
  );
}
