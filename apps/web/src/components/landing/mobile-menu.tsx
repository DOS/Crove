'use client';

import { Menu, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

type Link = { label: string; href: string };

// The phone header's menu (below md): the section links and sign-in in a disclosure panel under the header. It closes
// on Esc (focus goes back to the button), on a link, and on a tap outside.
export function MobileMenu({ links, openLabel, closeLabel }: { links: Link[]; openLabel: string; closeLabel: string }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    const onPointer = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  return (
    <div ref={root} className="md:hidden">
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={open ? closeLabel : openLabel}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex size-9 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-fg"
      >
        {open ? <X className="size-5" aria-hidden="true" /> : <Menu className="size-5" aria-hidden="true" />}
      </button>
      <div id={panelId} hidden={!open} className="absolute inset-x-0 top-full border-b border-line bg-bg">
        <ul className="wrap flex flex-col py-2">
          {links.map((link) => (
            <li key={link.href}>
              <a href={link.href} onClick={() => setOpen(false)} className="flex min-h-11 items-center rounded-md px-2 text-base text-fg hover:bg-surface-2">
                {link.label}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
