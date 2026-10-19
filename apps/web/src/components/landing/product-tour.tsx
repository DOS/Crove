import type { Dictionary } from '../../content/vi';
import { AppShell } from './app-shell';
import { Kbd, Section, SectionHead } from './ui';

// The product at work (from option B): the AI Inbox with the command-palette approval, and the keys that drive it.
export function ProductTour({ dict }: { dict: Dictionary }) {
  const { tour, keys } = dict;
  return (
    <Section id="san-pham" labelledBy="tour-title" tinted>
      <SectionHead id="tour-title" title={tour.title} lead={tour.lead} />
      <AppShell dict={dict} />
      <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-4 lg:gap-8">
        {keys.items.map((item) => (
          <div key={item.label} className="min-w-0">
            <div className="flex gap-1">
              {item.keys.map((k) => (
                <Kbd key={k}>{k}</Kbd>
              ))}
            </div>
            <div className="mt-3 text-sm font-medium text-fg">{item.label}</div>
            <p className="mt-1 text-sm text-muted">{item.body}</p>
          </div>
        ))}
      </div>
    </Section>
  );
}
