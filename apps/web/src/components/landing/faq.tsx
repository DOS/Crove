import { ChevronDown } from 'lucide-react';
import type { Dictionary } from '../../content/vi';
import { Section } from './ui';

// Native details/summary: keyboard accessible and readable without JavaScript.
export function Faq({ dict }: { dict: Dictionary }) {
  const { faq } = dict;
  return (
    <Section id="hoi-dap" labelledBy="faq-title" tinted>
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] lg:gap-16">
        <h2 id="faq-title" className="font-display text-[1.75rem] leading-[1.15] font-semibold tracking-[-0.02em] sm:text-4xl">
          {faq.title}
        </h2>
        <div className="divide-y divide-line border-y border-line">
          {faq.items.map((item) => (
            <details key={item.q} className="group">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-5 font-medium [&::-webkit-details-marker]:hidden">
                {item.q}
                <ChevronDown className="size-4 shrink-0 text-subtle transition-transform group-open:rotate-180" aria-hidden="true" />
              </summary>
              <p className="max-w-[68ch] pb-5 text-muted">{item.a}</p>
            </details>
          ))}
        </div>
      </div>
    </Section>
  );
}
