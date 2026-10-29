'use client';

import { Moon, Sun } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

type Theme = 'light' | 'dark';

// Light unless the visitor picked dark; the system setting is not followed (light is the default look).
function currentTheme(): Theme {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

// Flips between light and dark and remembers the choice; until the visitor picks, the page is light.
export function ThemeToggle({ toLight, toDark }: { toLight: string; toDark: string }) {
  const [theme, setTheme] = useState<Theme | null>(null);
  // The theme the last click asked for, which the page may not show yet (see flip).
  const wanted = useRef<Theme | null>(null);

  useEffect(() => {
    setTheme(currentTheme());
  }, []);

  const flip = () => {
    const next: Theme = (wanted.current ?? currentTheme()) === 'dark' ? 'light' : 'dark';
    wanted.current = next;
    try {
      localStorage.setItem('crove-theme', next);
    } catch {
      // Storage may be blocked; the choice then lasts for this page view.
    }
    setTheme(next);
    // The new theme restyles every element of the page, which takes 100 ms and more on a slow phone (#1668). The
    // button's own icon answers the click first; the page follows in the task after the next paint, so the click is
    // not held up by the restyle.
    requestAnimationFrame(() =>
      setTimeout(() => {
        if (wanted.current === next) document.documentElement.setAttribute('data-theme', next);
      }, 0),
    );
  };

  const label = theme === 'dark' ? toLight : toDark;
  return (
    <button
      type="button"
      onClick={flip}
      aria-label={label}
      title={label}
      className="inline-flex size-9 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-fg"
    >
      {theme === 'dark' ? <Sun className="size-4" aria-hidden="true" /> : <Moon className="size-4" aria-hidden="true" />}
    </button>
  );
}
