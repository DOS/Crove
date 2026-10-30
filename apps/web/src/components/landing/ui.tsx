import type { ReactNode } from 'react';
import type { Tone } from '../../content/vi';

const CHIP_TONES: Record<Tone, string> = {
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  accent: 'bg-accent-soft text-accent-ink',
  neutral: 'bg-surface-2 text-muted',
};

export function toneOf(value: string): Tone {
  return value === 'ok' || value === 'warn' || value === 'accent' ? value : 'neutral';
}

export function Chip({ tone = 'neutral', wrap = false, children, className = '' }: { tone?: Tone; wrap?: boolean; children: ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${wrap ? 'max-w-full' : 'whitespace-nowrap'} ${CHIP_TONES[tone]} ${className}`}>
      {children}
    </span>
  );
}

export function Kbd({ children, small = false }: { children: ReactNode; small?: boolean }) {
  return (
    <kbd
      className={`inline-flex items-center justify-center rounded-sm border border-line-strong/60 bg-surface font-mono font-medium text-muted ${
        small ? 'h-5 min-w-5 px-1 text-[11px]' : 'h-7 min-w-7 px-1.5 text-xs'
      }`}
    >
      {children}
    </kbd>
  );
}

export function SectionHead({ id, title, lead, children }: { id: string; title: string; lead?: string; children?: ReactNode }) {
  return (
    <div className="mb-10 grid gap-4 md:mb-12 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:items-end md:gap-12">
      <h2 id={id} className="font-display text-[1.75rem] leading-[1.15] font-semibold tracking-[-0.02em] text-fg sm:text-4xl">
        {title}
      </h2>
      {lead ? <p className="max-w-[62ch] text-base text-muted sm:text-lg">{lead}</p> : null}
      {children}
    </div>
  );
}

const BUTTON = 'inline-flex h-10 items-center justify-center gap-2 rounded-md px-4 text-sm font-medium whitespace-nowrap transition-colors';

export function ButtonLink({ href, children, variant = 'primary', className = '' }: { href: string; children: ReactNode; variant?: 'primary' | 'secondary'; className?: string }) {
  const look =
    variant === 'primary'
      ? 'bg-accent text-accent-fg hover:bg-accent/90'
      : 'border border-line-strong/70 bg-surface text-fg hover:bg-surface-2';
  return (
    <a href={href} className={`${BUTTON} ${look} ${className}`}>
      {children}
    </a>
  );
}

export function Section({ id, labelledBy, children, tinted = false }: { id?: string; labelledBy: string; children: ReactNode; tinted?: boolean }) {
  return (
    <section id={id} aria-labelledby={labelledBy} className={`py-16 sm:py-24 ${tinted ? 'border-y border-line bg-surface-2/40' : ''}`}>
      <div className="wrap">{children}</div>
    </section>
  );
}

// The brand mark: three tiles in an L (the suite's apps) and Vy's spark in the fourth slot, in the brand colors.
// The same paths as public/favicon.svg and public/brand/ludy-mark.svg.
export function LudyMark({ className = 'size-6' }: { className?: string }) {
  return (
    <svg viewBox="0 0 92 92" className={className} aria-hidden="true">
      <path className="fill-brand" d="M0 11A11 11 0 0 1 11 0H31A11 11 0 0 1 42 11V31A11 11 0 0 1 31 42H11A11 11 0 0 1 0 31ZM0 61A11 11 0 0 1 11 50H31A11 11 0 0 1 42 61V81A11 11 0 0 1 31 92H11A11 11 0 0 1 0 81ZM50 61A11 11 0 0 1 61 50H81A11 11 0 0 1 92 61V81A11 11 0 0 1 81 92H61A11 11 0 0 1 50 81Z" />
      <path className="fill-brand-spark" d="M71 0C73.27 15.5 76.5 18.73 92 21C76.5 23.27 73.27 26.5 71 42C68.73 26.5 65.5 23.27 50 21C65.5 18.73 68.73 15.5 71 0Z" />
    </svg>
  );
}
