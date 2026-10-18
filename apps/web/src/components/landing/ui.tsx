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

// The Crove mark: a ring "C" with two sparkles, drawn in the current text color.
export function CroveMark({ className = 'size-6' }: { className?: string }) {
  return (
    <svg viewBox="0 0 144 144" className={className} fill="currentColor" aria-hidden="true">
      <path d="M141.5 33.7c-4-1.1-7.5-2.4-11.1-3.2-6-1.3-9.4-4.8-10.7-10.7-0.8-3.4-1.9-6.7-2.9-10.1 0-0.2-0.2-0.3-0.3-0.7-1.2 4.1-2.4 8-3.6 11.9-0.3 1-0.7 2.1-1.1 3.1-0.9 2.3-2.5 4.1-4.9 4.9-4.3 1.4-8.7 2.7-13.1 4.1-0.6 0.2-1.3 0.4-2.3 0.7 3.7 1.1 7 2 10.4 3 1.5 0.4 3 0.9 4.4 1.4 2.9 1 4.8 2.9 5.8 5.8 1.5 4.7 2.9 9.4 4.4 14.2 0.1-0.3 0.3-0.6 0.4-0.9 1.3-4.3 2.6-8.6 3.9-12.9 1-3.4 3.3-5.6 6.7-6.6 4.3-1.1 8.8-2.5 13.8-4z" />
      <path d="M98.1 4c-0.7 2.2-1.3 4-1.7 5.8-0.6 2.3-2 3.6-4.2 4.1-1.8 0.5-3.7 1.1-5.9 1.7 2.3 0.7 4.2 1.3 6.2 1.8 2.1 0.6 3.3 1.8 3.9 3.9 0.5 1.9 1.1 3.7 1.8 5.9 0.6-2.1 1.2-3.7 1.6-5.4 0.6-2.4 2-4 4.5-4.6 1.8-0.4 3.5-1 5.7-1.6-1.2-0.4-2-0.6-2.8-0.9-6.6-1.9-6.2-1.6-8.1-7.9C98.7 6.1 98.4 5.3 98.1 4z" />
      <path d="M56.4 33.7C26.9 33.7 3 57.6 3 87.2c0 23 14.7 43.4 36.6 50.7 2.7 0.5 3.7-1.1 3.7-2.5 0-0.8 0.1-8.4 0.1-15.5 0-4.4 0.8-7 2.8-8.6-10.3-4.1-17.6-14.2-17.6-25.9 0-15.4 12.5-27.9 27.9-27.9 15.4 0 27.9 12.5 27.9 27.9 0 11.8-7.3 21.8-17.6 25.9 1.4 1.3 3.3 3.3 3.1 9.4-0.3 7.1-0.1 12.9-0.1 14.7 0 1.4 1 3.1 3.7 2.5 21.8-7.3 36.4-27.8 36.4-50.7C109.9 57.6 86 33.7 56.4 33.7z" />
    </svg>
  );
}
