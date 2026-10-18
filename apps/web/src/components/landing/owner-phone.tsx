import { Check, Lock, TriangleAlert } from 'lucide-react';
import type { Dictionary } from '../../content/vi';
import { Chip, Section } from './ui';

// For owners who are not accountants: the same flow on a phone, ending on the proposed entry and the approve button.
export function OwnerPhone({ dict }: { dict: Dictionary }) {
  const { owner, entry } = dict;
  const p = owner.phone;
  return (
    <Section id="chu-shop" labelledBy="owner-title" tinted>
      <div className="grid items-center gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-16">
        <div className="min-w-0">
          <h2 id="owner-title" className="font-display text-[1.75rem] leading-[1.15] font-semibold tracking-[-0.02em] sm:text-4xl">
            {owner.title}
          </h2>
          <p className="mt-5 max-w-[56ch] text-base text-muted sm:text-lg">{owner.lead}</p>
          <ul className="mt-8 flex flex-col gap-3">
            {owner.points.map((point) => (
              <li key={point} className="flex items-start gap-3">
                <Check className="mt-1 size-4 shrink-0 text-ok" aria-hidden="true" />
                <span>{point}</span>
              </li>
            ))}
          </ul>
        </div>

        <figure className="mx-auto w-full max-w-[340px]" aria-label={p.label}>
          <div className="rounded-[2.25rem] border-[10px] border-fg bg-surface p-3 shadow-xl">
            <div className="flex items-center justify-between px-2 pt-1 text-[11px] font-semibold">
              <span className="num">{p.time}</span>
              <span>Crove</span>
            </div>
            <div className="mt-2 flex items-baseline justify-between border-b border-line px-2 pb-2">
              <span className="text-sm font-semibold">{p.app}</span>
              <span className="text-xs text-subtle">{p.org}</span>
            </div>
            <div className="mt-3 rounded-xl border border-line bg-surface-2/50 p-3 text-[13px]">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-semibold">{p.cardTitle}</div>
                  <div className="text-xs text-subtle">{p.cardSub}</div>
                </div>
                <Chip tone="ok">{dict.shell.detail.balanced}</Chip>
              </div>
              <ul className="mt-2">
                {entry.lines.map((line) => (
                  <li key={line.account} className="grid grid-cols-[1.75rem_minmax(0,1fr)_auto] gap-x-2 border-t border-line py-2">
                    <span className="text-subtle">{line.side === 'credit' ? entry.credit : entry.debit}</span>
                    <span className="min-w-0">
                      <span className="num block font-mono text-xs">{line.account}</span>
                      <span className="block text-xs leading-snug text-subtle">{line.name}</span>
                    </span>
                    <span className="num font-mono text-xs font-medium">{line.amount}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-xs text-muted">{dict.shell.detail.learn}</p>
              <div className="mt-3 grid grid-cols-2 gap-2" aria-hidden="true">
                <span className="inline-flex h-10 items-center justify-center rounded-md border border-line-strong/60 bg-surface font-medium">{p.edit}</span>
                <span className="inline-flex h-10 items-center justify-center rounded-md bg-accent font-medium text-accent-fg">{p.approve}</span>
              </div>
              <div className="mt-2 flex items-center justify-center gap-1.5 text-[11px] text-subtle">
                <Lock className="size-3" aria-hidden="true" />
                {p.lock}
              </div>
            </div>
            <div className="mt-3 rounded-xl border border-warn/40 bg-warn-soft p-3 text-[13px]">
              <div className="text-[11px] text-warn">{p.next}</div>
              <div className="mt-1 flex items-baseline justify-between gap-2">
                <span className="font-semibold">{p.nextParty}</span>
                <span className="num font-mono text-xs">{p.nextAmount}</span>
              </div>
              <span className="mt-2 inline-flex items-center gap-1 rounded-sm border border-warn/50 px-1.5 py-0.5 text-[11px] font-medium text-warn">
                <TriangleAlert className="size-3" aria-hidden="true" />
                {p.nextFlag}
              </span>
            </div>
          </div>
          <ol className="mt-4 flex justify-center gap-2 text-xs" aria-hidden="true">
            {p.steps.map((step, i) => (
              <li key={step} className={`rounded-md border px-2.5 py-1 ${i === p.steps.length - 1 ? 'border-accent/50 bg-accent-soft text-accent-ink' : 'border-line text-muted'}`}>
                {step}
              </li>
            ))}
          </ol>
        </figure>
      </div>
    </Section>
  );
}
