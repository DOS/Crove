import { Check } from 'lucide-react';
import type { Dictionary } from '../../content/vi';
import { Chip, Section, SectionHead } from './ui';

const TONES = ['neutral', 'ok', 'accent', 'ok'] as const;

// How it works: the real four-step sequence (numbered because it is one), each step with who handled it, when, and
// the state it left the document in, as the app shows it.
export function HowItWorks({ dict }: { dict: Dictionary }) {
  const { flow } = dict;
  return (
    <Section id="san-pham" labelledBy="flow-title">
      <SectionHead id="flow-title" title={flow.title} lead={flow.lead} />
      <ol className="relative grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {flow.steps.map((step, i) => (
          <li key={step.name} className="flex min-w-0 flex-col rounded-lg border border-line bg-surface p-5">
            <div className="flex items-center gap-3">
              <span
                className={`inline-flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${
                  step.final ? 'bg-accent text-accent-fg' : 'bg-surface-2 text-fg'
                }`}
                aria-hidden="true"
              >
                {step.final ? <Check className="size-4" /> : i + 1}
              </span>
              <h3 className="font-display text-lg font-semibold">{step.name}</h3>
            </div>
            <p className="mt-3 text-sm text-muted">{step.body}</p>
            <div className="mt-auto pt-5">
              <div className="rounded-md border border-line bg-bg px-3 py-2.5 text-[13px]">
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5">
                  <dt className="text-subtle">{flow.actorLabel}</dt>
                  <dd className="truncate font-medium">{step.actor}</dd>
                  <dt className="text-subtle">{flow.timeLabel}</dt>
                  <dd className="num">{step.time}</dd>
                </dl>
                <Chip tone={TONES[i] ?? 'neutral'} className="mt-2">
                  {step.confirm}
                </Chip>
              </div>
            </div>
          </li>
        ))}
      </ol>
    </Section>
  );
}
