'use client';

import { BookOpen, Bot, Building2, Check, ChevronDown, FileText, Inbox, ListChecks, Lock, Megaphone, Percent, RotateCcw, Search, Sparkles, Table2, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dictionary } from '../../content/vi';
import { Chip, Kbd } from './ui';

type Phase = 'wait' | 'open' | 'otp' | 'ok' | 'done';
const OTP_DIGITS = ['4', '8', '2', '9', '1', '3'];
const NAV_ICONS = [FileText, BookOpen, Table2, Building2, Percent, ListChecks, Bot, Megaphone];

// The hero's product picture: the AI Inbox with the example invoice. Once it scrolls into view it plays the one
// orchestrated moment of the page: the command palette approves the entry with a two-factor code and the row is
// posted. Without JavaScript, or with reduced motion, it stays in the waiting state and the button shows the result.
export function AppShell({ dict }: { dict: Dictionary }) {
  const { shell, entry, hero } = dict;
  const [phase, setPhase] = useState<Phase>('wait');
  const [typed, setTyped] = useState(0);
  const [digits, setDigits] = useState(0);
  const [canReplay, setCanReplay] = useState(false);
  const root = useRef<HTMLElement>(null);
  const timers = useRef<number[]>([]);

  const clearTimers = () => {
    for (const id of timers.current) window.clearTimeout(id);
    timers.current = [];
  };

  const play = useCallback(() => {
    clearTimers();
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setPhase('done');
      setCanReplay(true);
      return;
    }
    setPhase('wait');
    setTyped(0);
    setDigits(0);
    const at = (ms: number, step: () => void) => timers.current.push(window.setTimeout(step, ms));
    let t = 700;
    at(t, () => setPhase('open'));
    for (let i = 1; i <= shell.palette.query.length; i++) {
      t += 110;
      const n = i;
      at(t, () => setTyped(n));
    }
    t += 500;
    at(t, () => setPhase('otp'));
    for (let i = 1; i <= OTP_DIGITS.length; i++) {
      t += 150;
      const n = i;
      at(t, () => setDigits(n));
    }
    t += 350;
    at(t, () => setPhase('ok'));
    t += 850;
    at(t, () => {
      setPhase('done');
      setCanReplay(true);
    });
  }, [shell.palette.query]);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setCanReplay(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          observer.disconnect();
          play();
        }
      },
      { threshold: 0.35 },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      clearTimers();
    };
  }, [play]);

  const done = phase === 'done';
  const paletteOpen = phase === 'open' || phase === 'otp' || phase === 'ok';
  const d = shell.detail;

  return (
    <figure ref={root} className="mx-auto mt-14 w-full max-w-[1200px] sm:mt-16">
      <div role="group" aria-label={shell.label} className="relative overflow-hidden rounded-lg border border-line bg-surface text-[13px] leading-normal text-fg">
        <div className="grid md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:grid-cols-[220px_minmax(0,1fr)_minmax(0,1.15fr)]">
          {/* Sidebar */}
          <aside className="hidden min-w-0 flex-col gap-0.5 border-r border-line bg-surface-2/50 p-3 lg:flex" aria-hidden="true">
            <div className="mb-2 flex items-center gap-2 rounded-md px-2 py-1.5 font-semibold">
              <span className="inline-flex size-5 items-center justify-center rounded-sm bg-fg text-[11px] text-bg">G</span>
              <span className="truncate">{shell.org}</span>
              <ChevronDown className="ml-auto size-3.5 text-subtle" />
            </div>
            <div className="mb-2 flex items-center gap-2 rounded-md border border-line bg-surface px-2 py-1.5 text-subtle">
              <Search className="size-3.5" />
              {shell.search}
              <span className="ml-auto flex gap-0.5">
                <Kbd small>⌘</Kbd>
                <Kbd small>K</Kbd>
              </span>
            </div>
            <div className="flex items-center gap-2 rounded-md bg-accent-soft px-2 py-1.5 font-medium text-accent-ink">
              <Inbox className="size-3.5" />
              {shell.inbox}
              <span className="num ml-auto text-xs">{done ? 3 : 4}</span>
            </div>
            {shell.groups.map((group, gi) => (
              <div key={group.label} className="mt-3">
                <div className="px-2 pb-1 text-xs text-subtle">{group.label}</div>
                {group.items.map((item, ii) => {
                  const Icon = NAV_ICONS[gi * 5 + ii] ?? FileText;
                  return (
                    <div key={item} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-muted">
                      <Icon className="size-3.5" />
                      {item}
                    </div>
                  );
                })}
              </div>
            ))}
            <div className="mt-auto border-t border-line px-2 pt-3">
              <div className="font-medium">{shell.user.name}</div>
              <div className="text-xs text-subtle">{shell.user.role}</div>
            </div>
          </aside>

          {/* Inbox list */}
          <div className="flex min-w-0 flex-col border-b border-line md:border-r md:border-b-0">
            <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
              <span className="font-semibold">{shell.inbox}</span>
              <span className="text-xs text-subtle">{done ? shell.metaDone : shell.metaWait}</span>
            </div>
            <div className="flex gap-1 border-b border-line px-3 py-2">
              {shell.tabs.map((tab, i) => (
                <span key={tab} className={`rounded-sm px-2 py-1 text-xs ${i === 0 ? 'bg-surface-2 font-medium text-fg' : 'text-subtle'}`}>
                  {tab}
                </span>
              ))}
            </div>
            <ul className="flex-1">
              {shell.rows.map((row, i) => (
                <li
                  key={row.party}
                  className={`flex items-start justify-between gap-3 border-b border-line px-4 py-3 ${i === 0 ? 'bg-accent-soft/50 shadow-[inset_2px_0_0_var(--accent)]' : ''}`}
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium">{row.party}</div>
                    <div className="truncate text-xs text-subtle">{row.sub}</div>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <span className="num font-mono text-xs">{row.amount}</span>
                    <span className="flex items-center gap-1">
                      <span className="text-[11px] text-subtle">{row.account}</span>
                      {row.flag ? (
                        <Chip tone="warn">
                          <TriangleAlert className="size-3" aria-hidden="true" />
                          {row.flag}
                        </Chip>
                      ) : i === 0 && done ? (
                        <Chip tone="ok">
                          <Check className="size-3" aria-hidden="true" />
                          {shell.approved}
                        </Chip>
                      ) : (
                        <Chip>{shell.waiting}</Chip>
                      )}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
            <div className="hidden items-center gap-4 border-t border-line px-4 py-2.5 text-xs text-subtle md:flex">
              <span className="flex items-center gap-1.5">
                <Kbd small>J</Kbd>
                <Kbd small>K</Kbd>
                {shell.move}
              </span>
              <span className="flex items-center gap-1.5">
                <Kbd small>A</Kbd>
                {shell.approve}
              </span>
              <span className="flex items-center gap-1.5">
                <Kbd small>E</Kbd>
                {shell.edit}
              </span>
            </div>
          </div>

          {/* Detail */}
          <div className="flex min-w-0 flex-col gap-3 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold">{d.title}</div>
                <div className="text-xs text-subtle">{d.sub}</div>
              </div>
              {done ? <Chip tone="ok">{d.posted}</Chip> : <Chip>{shell.waiting}</Chip>}
            </div>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
              {d.meta.map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-subtle">{k}</dt>
                  <dd className="num truncate">{v}</dd>
                </div>
              ))}
            </dl>
            <div className="rounded-md border border-line">
              {d.lines.map((line) => (
                <div key={line.name} className="flex justify-between gap-3 border-b border-line px-3 py-2">
                  <div className="min-w-0">
                    <div className="truncate">{line.name}</div>
                    <div className="num text-xs text-subtle">{line.qty}</div>
                  </div>
                  <span className="num font-mono text-xs">{line.amount}</span>
                </div>
              ))}
              <div className="space-y-0.5 px-3 py-2">
                {d.totals.map(([k, v]) => (
                  <div key={k} className="flex justify-between text-muted">
                    <span>{k}</span>
                    <span className="num font-mono text-xs">{v}</span>
                  </div>
                ))}
                <div className="flex justify-between font-semibold">
                  <span>{d.grand[0]}</span>
                  <span className="num font-mono text-xs">{d.grand[1]}</span>
                </div>
              </div>
            </div>
            <div className="rounded-md border border-line px-3 py-2">
              <div className="mb-1.5 flex items-center justify-between font-medium">
                {d.checksTitle}
                <Chip tone="ok">{d.checksBadge}</Chip>
              </div>
              <ul className="grid gap-x-4 gap-y-0.5 sm:grid-cols-2">
                {d.checks.map((c) => (
                  <li key={c} className="flex items-center gap-1.5 text-muted">
                    <Check className="size-3.5 shrink-0 text-ok" aria-hidden="true" />
                    {c}
                  </li>
                ))}
              </ul>
            </div>
            <div className="rounded-md border border-line px-3 py-2">
              <div className="mb-1.5 flex items-center justify-between font-medium">
                {d.entryTitle}
                <Chip tone="ok">{d.balanced}</Chip>
              </div>
              <ul>
                {entry.lines.map((line) => (
                  <li key={line.account} className="grid grid-cols-[2rem_3rem_minmax(0,1fr)_auto] items-baseline gap-2 py-0.5">
                    <span className={line.side === 'credit' ? 'pl-2 text-subtle' : 'text-subtle'}>{line.side === 'credit' ? entry.credit : entry.debit}</span>
                    <span className="num font-mono text-xs">{line.account}</span>
                    <span className="truncate text-muted">{line.name}</span>
                    <span className="num font-mono text-xs">{line.amount}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-1.5 flex items-center gap-1.5 text-xs text-subtle">
                <Sparkles className="size-3.5 shrink-0" aria-hidden="true" />
                {d.learn}
              </div>
            </div>
            {done ? (
              <div className="flex items-start gap-2 rounded-md bg-ok-soft px-3 py-2 text-ok">
                <Check className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <span>{d.postedNote}</span>
              </div>
            ) : (
              <div className="flex gap-2" aria-hidden="true">
                <span className="inline-flex h-8 items-center gap-2 rounded-md bg-accent px-3 font-medium text-accent-fg">
                  {d.approve}
                  <span className="rounded-sm bg-accent-fg/20 px-1 font-mono text-[11px]">A</span>
                </span>
                <span className="inline-flex h-8 items-center gap-2 rounded-md border border-line-strong/60 px-3 font-medium">
                  {d.edit}
                  <span className="rounded-sm bg-surface-2 px-1 font-mono text-[11px] text-muted">E</span>
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Command palette */}
        {paletteOpen ? (
          <div className="absolute inset-0 flex justify-center bg-scrim px-3 pt-16 md:pt-[12%]" aria-hidden="true">
            <div className="h-fit w-full max-w-[540px] overflow-hidden rounded-lg border border-line bg-surface shadow-2xl">
              {phase === 'open' ? (
                <>
                  <div className="flex items-center gap-2 border-b border-line px-4 py-3 text-sm">
                    <Search className="size-4 text-subtle" />
                    {typed > 0 ? (
                      <span>
                        {shell.palette.query.slice(0, typed)}
                        <span className="ml-px inline-block h-4 w-px translate-y-0.5 bg-fg" />
                      </span>
                    ) : (
                      <span className="text-subtle">{shell.palette.placeholder}</span>
                    )}
                  </div>
                  <div className="px-4 pt-2.5 pb-1 text-xs text-subtle">{shell.palette.group}</div>
                  <ul className="px-1.5 pb-1.5">
                    {shell.palette.commands.map((cmd, i) => (
                      <li key={cmd.label} className={`flex items-center gap-2.5 rounded-md px-2.5 py-2 ${i === 0 ? 'bg-accent-soft text-accent-ink' : ''}`}>
                        {i === 0 ? <Check className="size-3.5" /> : i === 1 ? <Table2 className="size-3.5 text-subtle" /> : <FileText className="size-3.5 text-subtle" />}
                        <span className="font-medium">{cmd.label}</span>
                        <span className="ml-auto text-xs text-subtle">{i === 0 ? <Kbd small>{cmd.meta}</Kbd> : cmd.meta}</span>
                      </li>
                    ))}
                  </ul>
                  <div className="flex gap-4 border-t border-line bg-surface-2/50 px-4 py-2 text-xs text-subtle">
                    <span className="flex items-center gap-1">
                      <Kbd small>↑</Kbd>
                      <Kbd small>↓</Kbd>
                      {shell.palette.pick}
                    </span>
                    <span className="flex items-center gap-1">
                      <Kbd small>↵</Kbd>
                      {shell.palette.run}
                    </span>
                    <span className="flex items-center gap-1">
                      <Kbd small>esc</Kbd>
                      {shell.palette.close}
                    </span>
                  </div>
                </>
              ) : (
                <div className="p-5">
                  <div className="text-sm font-semibold">{shell.palette.otpTitle}</div>
                  <p className="mt-1 text-muted">{shell.palette.otpBody}</p>
                  <div className="mt-4 flex gap-2">
                    {OTP_DIGITS.map((digit, i) => (
                      <span
                        key={i}
                        className={`inline-flex size-10 items-center justify-center rounded-md border font-mono text-base ${i < digits ? 'border-line-strong text-fg' : 'border-line text-transparent'}`}
                      >
                        {i < digits ? digit : '0'}
                      </span>
                    ))}
                  </div>
                  <div className={`mt-3 flex h-4 items-center gap-1.5 text-xs text-ok ${phase === 'ok' ? '' : 'invisible'}`}>
                    <Lock className="size-3.5" />
                    {shell.palette.otpOk}
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : null}
      </div>
      <figcaption className="mt-3 flex items-center justify-between gap-3 text-xs text-subtle">
        <span>{hero.sample}</span>
        {canReplay ? (
          <button type="button" onClick={play} className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-muted transition-colors hover:bg-surface-2 hover:text-fg">
            <RotateCcw className="size-3.5" aria-hidden="true" />
            {hero.replay}
          </button>
        ) : null}
      </figcaption>
    </figure>
  );
}
