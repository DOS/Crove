import type { Dictionary } from '../../content/vi';
import { GITHUB_URL } from '../../content/site';
import { OrgChart } from './org-chart';
import { ButtonLink } from './ui';

// The hero (option E, the owner's pick): the promise centered on top, and under it the org chart with AI agents at
// full width. The chart is live: each position opens what is waiting there.
export function Hero({ dict }: { dict: Dictionary }) {
  const { hero } = dict;
  return (
    <section aria-labelledby="hero-title" className="pt-14 pb-16 sm:pt-20 sm:pb-24">
      <div className="wrap">
        <div className="mx-auto max-w-[880px] text-center">
          <h1 id="hero-title" className="font-display text-[2.375rem] leading-[1.12] font-semibold tracking-[-0.025em] text-fg sm:text-5xl lg:text-[3.75rem]">
            {hero.title}
          </h1>
          <p className="mx-auto mt-6 max-w-[62ch] text-base text-muted sm:text-lg">{hero.lead}</p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <ButtonLink href="#tu-host">{hero.primary}</ButtonLink>
            <ButtonLink href={GITHUB_URL} variant="secondary">
              {hero.secondary}
            </ButtonLink>
          </div>
          <p className="mx-auto mt-5 max-w-[60ch] text-sm text-subtle">{hero.note}</p>
        </div>
        <div className="mt-12 sm:mt-14">
          <OrgChart dict={dict} />
        </div>
      </div>
    </section>
  );
}
