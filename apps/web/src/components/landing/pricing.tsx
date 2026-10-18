import { Check } from 'lucide-react';
import type { Dictionary } from '../../content/vi';
import { GITHUB_URL } from '../../content/site';
import { ButtonLink, Section, SectionHead } from './ui';

// Only what is decided: self-hosting is free, the cloud version is coming. No invented prices.
export function Pricing({ dict }: { dict: Dictionary }) {
  const { pricing } = dict;
  return (
    <Section id="bang-gia" labelledBy="pricing-title">
      <SectionHead id="pricing-title" title={pricing.title} lead={pricing.lead} />
      <div className="grid gap-4 md:grid-cols-2">
        {pricing.plans.map((plan) => (
          <div key={plan.name} className={`flex flex-col rounded-lg border bg-surface p-6 ${plan.primary ? 'border-line-strong/70' : 'border-line'}`}>
            <h3 className="text-sm font-semibold text-muted">{plan.name}</h3>
            <div className="mt-2 font-display text-3xl font-semibold tracking-[-0.015em]">{plan.price}</div>
            <p className="mt-3 text-muted">{plan.body}</p>
            <ul className="mt-5 flex flex-col gap-2 text-sm">
              {plan.items.map((item) => (
                <li key={item} className="flex items-start gap-2">
                  <Check className="mt-0.5 size-4 shrink-0 text-ok" aria-hidden="true" />
                  {item}
                </li>
              ))}
            </ul>
            <div className="mt-6 pt-2 md:mt-auto">
              <ButtonLink href={plan.href === 'github' ? GITHUB_URL : plan.href} variant={plan.primary ? 'primary' : 'secondary'}>
                {plan.cta}
              </ButtonLink>
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}
