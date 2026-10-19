import type { Dictionary } from '../../content/vi';
import { GITHUB_URL } from '../../content/site';
import { OrgChart } from './org-chart';
import { ButtonLink } from './ui';

// The hero (option E, the owner's pick): AI agents as positions in the org chart, next to the promise. The chart is
// live: each position opens what is waiting there.
export function Hero({ dict }: { dict: Dictionary }) {
  const { hero } = dict;
  return (
    <section aria-labelledby="hero-title" className="pt-12 pb-16 sm:pt-16 sm:pb-20">
      <div className="wrap grid items-center gap-10 lg:grid-cols-[360px_minmax(0,1fr)] lg:gap-12">
        <div className="min-w-0">
          <h1 id="hero-title" className="font-display text-[2.375rem] leading-[1.12] font-semibold tracking-[-0.025em] text-fg sm:text-5xl lg:text-[3.125rem]">
            {hero.title}
          </h1>
          <p className="mt-6 max-w-[56ch] text-base text-muted sm:text-lg">{hero.lead}</p>
          <div className="mt-8 flex flex-wrap gap-3">
            <ButtonLink href="#tu-host">{hero.primary}</ButtonLink>
            <ButtonLink href={GITHUB_URL} variant="secondary">
              {hero.secondary}
            </ButtonLink>
          </div>
          <p className="mt-6 max-w-[52ch] text-sm text-subtle">{hero.note}</p>
        </div>
        <div className="min-w-0">
          <OrgChart dict={dict} />
        </div>
      </div>
    </section>
  );
}
