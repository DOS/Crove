import type { Dictionary } from '../../content/vi';
import { GITHUB_URL } from '../../content/site';
import { AppShell } from './app-shell';
import { ButtonLink, Kbd } from './ui';

export function Hero({ dict }: { dict: Dictionary }) {
  const { hero, keys } = dict;
  return (
    <section aria-labelledby="hero-title" className="pt-14 pb-14 sm:pt-20 sm:pb-16">
      <div className="wrap">
        <div className="mx-auto max-w-[860px] text-center">
          <h1 id="hero-title" className="font-display text-[2.375rem] leading-[1.12] font-semibold tracking-[-0.025em] text-fg sm:text-5xl lg:text-[3.75rem]">
            <span className="block">{hero.line1}</span>
            <span className="block text-muted">{hero.line2}</span>
          </h1>
          <p className="mx-auto mt-6 max-w-[62ch] text-base text-muted sm:text-lg">{hero.lead}</p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <ButtonLink href="#tu-host">{hero.primary}</ButtonLink>
            <ButtonLink href={GITHUB_URL} variant="secondary">
              {hero.secondary}
            </ButtonLink>
          </div>
        </div>

        <AppShell dict={dict} />

        <div className="mt-14 grid gap-6 border-t border-line pt-10 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.3fr)_repeat(4,minmax(0,1fr))] lg:gap-8">
          <h2 className="font-display text-xl leading-snug font-semibold tracking-[-0.01em] sm:col-span-2 lg:col-span-1">{keys.title}</h2>
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
      </div>
    </section>
  );
}
