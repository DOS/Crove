import type { Dictionary } from '../../content/vi';
import { DOCS_URL, SIGN_IN_URL } from '../../content/site';
import { ThemeToggle } from './theme-toggle';
import { CroveMark } from './ui';

export function SiteHeader({ dict }: { dict: Dictionary }) {
  const { nav } = dict;
  const home = dict.lang === 'vi' ? '/' : '/en';
  return (
    <header className="sticky top-[env(safe-area-inset-top,0px)] z-40 border-b border-line bg-bg">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2 focus:text-sm">
        {nav.skip}
      </a>
      <div className="wrap flex h-15 items-center gap-6">
        <a href={home} className="flex items-center gap-2 text-fg" aria-label="Crove">
          <CroveMark className="size-6 text-accent" />
          <span className="font-display text-lg font-semibold tracking-[-0.01em]">Crove</span>
        </a>
        <nav aria-label={nav.label} className="hidden items-center gap-1 md:flex">
          {[
            [nav.product, '#san-pham'],
            [nav.openSource, '#ma-nguon-mo'],
            [nav.pricing, '#bang-gia'],
            [nav.docs, DOCS_URL],
          ].map(([label, href]) => (
            <a key={href} href={href} className="rounded-md px-3 py-2 text-sm text-muted transition-colors hover:text-fg">
              {label}
            </a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-1 sm:gap-2">
          <a
            href={nav.otherLangHref}
            hrefLang={dict.lang === 'vi' ? 'en' : 'vi'}
            aria-label={nav.otherLangLabel}
            title={nav.otherLangLabel}
            className="inline-flex h-9 items-center rounded-md px-2 text-xs font-semibold text-muted transition-colors hover:bg-surface-2 hover:text-fg"
          >
            {nav.otherLang}
          </a>
          <ThemeToggle toLight={nav.toLight} toDark={nav.toDark} />
          <a href={SIGN_IN_URL} className="hidden h-9 items-center rounded-md px-3 text-sm text-muted transition-colors hover:text-fg sm:inline-flex">
            {nav.signIn}
          </a>
          <a href="#tu-host" className="inline-flex h-9 items-center rounded-md bg-fg px-3 text-sm font-medium whitespace-nowrap text-bg transition-colors hover:bg-fg/85">
            {nav.cta}
          </a>
        </div>
      </div>
    </header>
  );
}
