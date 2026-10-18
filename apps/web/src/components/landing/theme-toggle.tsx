'use client';

import { Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';

type Theme = 'light' | 'dark';

function currentTheme(): Theme {
  const picked = document.documentElement.getAttribute('data-theme');
  if (picked === 'light' || picked === 'dark') return picked;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

// Flips between light and dark and remembers the choice; until the visitor picks, the system setting applies.
export function ThemeToggle({ toLight, toDark }: { toLight: string; toDark: string }) {
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    setTheme(currentTheme());
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const follow = () => setTheme(currentTheme());
    media.addEventListener('change', follow);
    return () => media.removeEventListener('change', follow);
  }, []);

  const flip = () => {
    const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem('crove-theme', next);
    } catch {
      // Storage may be blocked; the choice then lasts for this page view.
    }
    setTheme(next);
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
