import { Lock } from 'lucide-react';
import type { Dictionary } from '../../content/vi';
import { Section, SectionHead } from './ui';

// What an agent may do (the org chart itself is the hero): which risk levels it handles alone and which go to a
// person, plus what agents can never touch.
export function Agents({ dict }: { dict: Dictionary }) {
  const a = dict.agents;
  const m = a.matrix;
  return (
    <Section id="agents" labelledBy="agents-title">
      <SectionHead id="agents-title" title={m.title} lead={m.lead} />
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-10">
        <div className="min-w-0">
          {/* Scrolls sideways at phone width, so it takes keyboard focus to scroll with the arrow keys (WCAG 2.1.1, #1629). */}
          <div role="group" aria-labelledby="agents-title" tabIndex={0} className="overflow-x-auto rounded-lg border border-line bg-surface">
            <table className="w-full min-w-[640px] border-collapse text-sm">
              <thead>
                <tr className="text-left text-xs">
                  <th scope="col" rowSpan={2} className="border-b border-line px-4 py-2 align-bottom font-medium text-subtle">
                    {m.taskCol}
                  </th>
                  <th scope="colgroup" colSpan={2} className="border-b border-line bg-accent-soft/60 px-3 pt-2.5 pb-1 font-medium text-accent-ink">
                    {m.selfLabel}
                  </th>
                  <th scope="colgroup" colSpan={2} className="border-b border-l-2 border-line border-l-accent/60 px-3 pt-2.5 pb-1 font-medium text-warn">
                    {m.humanLabel}
                  </th>
                </tr>
                <tr className="text-left">
                  {m.levels.map((level, i) => (
                    <th key={level.code} scope="col" className={`border-b border-line px-3 pt-1 pb-2.5 align-top font-normal ${i < 2 ? 'bg-accent-soft/60' : ''} ${i === 2 ? 'border-l-2 border-l-accent/60' : ''}`}>
                      <span className="block font-display text-base font-semibold">{level.code}</span>
                      <span className="block text-xs text-subtle">{level.label}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {m.rows.map((row) => (
                  <tr key={row.task} className="border-b border-line last:border-b-0">
                    <th scope="row" className="px-4 py-3 text-left font-normal">
                      {row.task}
                    </th>
                    {m.levels.map((level, i) => (
                      <td key={level.code} className={`px-3 py-3 ${i < 2 ? 'bg-accent-soft/60' : ''} ${i === 2 ? 'border-l-2 border-l-accent/60' : ''}`}>
                        {row.level === i ? (
                          <span
                            className={`inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-xs font-medium whitespace-nowrap ${
                              i < 2 ? 'border-accent/50 text-accent-ink' : 'border-warn/50 bg-warn-soft text-warn'
                            }`}
                          >
                            {i === 3 ? <Lock className="size-3" aria-hidden="true" /> : null}
                            {row.label}
                          </span>
                        ) : null}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-subtle">{m.note}</p>
        </div>
        <aside className="h-fit rounded-lg border border-line bg-surface p-5">
          <h3 className="font-display text-lg font-semibold">{m.neverTitle}</h3>
          <ul className="mt-4 flex flex-col gap-4">
            {m.never.map((item) => (
              <li key={item.title} className="flex gap-3">
                <Lock className="mt-1 size-4 shrink-0 text-muted" aria-hidden="true" />
                <div>
                  <div className="text-sm font-medium">{item.title}</div>
                  <p className="text-sm text-muted">{item.body}</p>
                </div>
              </li>
            ))}
          </ul>
        </aside>
      </div>
    </Section>
  );
}
