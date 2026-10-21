// Pages that print (the client report #643, the content plan #978): paper gets the light theme while printing,
// whatever the screen uses, and the dark theme comes back after.
import { useEffect } from 'react';

export function usePrintInLight(): void {
  useEffect(() => {
    const root = document.documentElement;
    let dark = false;
    const before = () => {
      dark = root.classList.contains('dark');
      root.classList.remove('dark');
    };
    const after = () => {
      if (dark) root.classList.add('dark');
    };
    window.addEventListener('beforeprint', before);
    window.addEventListener('afterprint', after);
    return () => {
      window.removeEventListener('beforeprint', before);
      window.removeEventListener('afterprint', after);
    };
  }, []);
}
