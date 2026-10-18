import type { Dictionary } from '../../content/vi';
import { DOCS_URL, GITHUB_URL, LICENSE_URL, SECURITY_URL } from '../../content/site';
import { CroveMark } from './ui';

export function SiteFooter({ dict }: { dict: Dictionary }) {
  const { footer } = dict;
  return (
    <footer className="border-t border-line pt-12 pb-[max(3rem,env(safe-area-inset-bottom,0px))]">
      <div className="wrap flex flex-col gap-8 md:flex-row md:items-start md:justify-between">
        <div className="max-w-[40ch]">
          <div className="flex items-center gap-2">
            <CroveMark className="size-5 text-accent" />
            <span className="font-display font-semibold">Crove</span>
          </div>
          <p className="mt-3 text-sm text-muted">{footer.tagline}</p>
        </div>
        <nav aria-label={footer.docs} className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <a href={GITHUB_URL} className="text-muted hover:text-fg">
            {footer.github}
          </a>
          <a href={DOCS_URL} className="text-muted hover:text-fg">
            {footer.docs}
          </a>
          <a href={SECURITY_URL} className="text-muted hover:text-fg">
            {footer.security}
          </a>
          <a href={LICENSE_URL} className="text-muted hover:text-fg">
            AGPL-3.0
          </a>
        </nav>
      </div>
      <div className="wrap mt-10 flex flex-col gap-1 text-xs text-subtle sm:flex-row sm:justify-between">
        <span>{footer.copyright}</span>
        <span>{footer.license}</span>
      </div>
    </footer>
  );
}
