import type { Dictionary } from '../../content/vi';
import { Chip, Section, SectionHead, toneOf } from './ui';

// The modules as one compact list: what each covers, next to a real row from it.
export function Modules({ dict }: { dict: Dictionary }) {
  const { modules } = dict;
  return (
    <Section labelledBy="modules-title">
      <SectionHead id="modules-title" title={modules.title} lead={modules.lead} />
      <ul className="divide-y divide-line border-y border-line">
        {modules.items.map((item) => (
          <li key={item.name} className="grid gap-4 py-6 md:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_minmax(0,22rem)] md:items-center md:gap-8">
            <h3 className="font-display text-lg font-semibold">{item.name}</h3>
            <p className="text-muted">{item.body}</p>
            <div className="flex min-w-0 items-center justify-between gap-3 rounded-md border border-line bg-surface px-3 py-2.5 text-[13px]">
              <div className="min-w-0">
                <div className="truncate font-medium">{item.sample.primary}</div>
                <div className="num truncate text-xs text-subtle">{item.sample.secondary}</div>
              </div>
              <span className="flex shrink-0 gap-1">
                {item.sample.chips.map((chip) => (
                  <Chip key={chip.label} tone={toneOf(chip.tone)}>
                    {chip.label}
                  </Chip>
                ))}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </Section>
  );
}
