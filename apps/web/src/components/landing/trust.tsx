import type { Dictionary } from '../../content/vi';
import { CopyCommand } from './copy-command';
import { Section, SectionHead } from './ui';

// Why the numbers can be trusted, the audit log that proves it, and the one command that runs Ludy locally.
export function Trust({ dict }: { dict: Dictionary }) {
  const { trust } = dict;
  return (
    <Section id="ma-nguon-mo" labelledBy="trust-title" tinted>
      <SectionHead id="trust-title" title={trust.title} lead={trust.lead} />
      <dl className="grid gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-4">
        {trust.points.map((point) => (
          <div key={point.title} className="border-t border-line-strong/60 pt-4">
            <dt className="font-medium">{point.title}</dt>
            <dd className="mt-2 text-sm text-muted">{point.body}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-14 grid gap-8 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] lg:gap-10">
        <div className="min-w-0 rounded-lg border border-line bg-surface">
          <h3 id="trust-log-title" className="border-b border-line px-4 py-3 text-sm font-semibold">
            {trust.logTitle}
          </h3>
          {/* Scrolls sideways at phone width, so it takes keyboard focus to scroll with the arrow keys (WCAG 2.1.1, #1629). */}
          <div role="group" aria-labelledby="trust-log-title" tabIndex={0} className="overflow-x-auto">
            <table className="w-full min-w-[520px] border-collapse text-[13px]">
              <thead>
                <tr className="border-b border-line text-left text-xs text-subtle">
                  {trust.logCols.map((col) => (
                    <th key={col} scope="col" className="px-4 py-2 font-medium">
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {trust.log.map(([at, who, what]) => (
                  <tr key={`${at}-${who}`} className="border-b border-line last:border-b-0">
                    <td className="num px-4 py-2.5 whitespace-nowrap text-subtle">{at}</td>
                    <td className="px-4 py-2.5 font-medium whitespace-nowrap">{who}</td>
                    <td className="px-4 py-2.5 text-muted">{what}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div id="tu-host" className="min-w-0 scroll-mt-24">
          <h3 className="font-display text-xl font-semibold">{trust.selfHostTitle}</h3>
          <p className="mt-2 text-sm text-muted">{trust.selfHostBody}</p>
          <div className="mt-4">
            <CopyCommand command={trust.command} copy={trust.copy} copied={trust.copied} copyFail={trust.copyFail} />
          </div>
          <p className="mt-3 text-xs text-subtle">{trust.openHint}</p>
        </div>
      </div>
    </Section>
  );
}
