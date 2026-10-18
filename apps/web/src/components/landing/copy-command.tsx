'use client';

import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

// The self-host command with a copy button. When the clipboard is refused, the command is selected so it can be
// copied by hand, and the message says so.
export function CopyCommand({ command, copy, copied, copyFail }: { command: string; copy: string; copied: string; copyFail: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const pre = useRef<HTMLPreElement>(null);

  // "Copied" goes back to the button label after two seconds; the timer is cleared if the component unmounts first.
  useEffect(() => {
    if (state !== 'copied') return;
    const id = window.setTimeout(() => setState('idle'), 2000);
    return () => window.clearTimeout(id);
  }, [state]);

  const selectText = () => {
    const el = pre.current;
    const selection = window.getSelection();
    if (!el || !selection) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
  };

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setState('copied');
    } catch {
      selectText();
      setState('failed');
    }
  };

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface">
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2">
        <span className="text-xs text-subtle">bash</span>
        <button
          type="button"
          onClick={onCopy}
          className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg"
        >
          {state === 'copied' ? <Check className="size-3.5 text-ok" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
          {state === 'copied' ? copied : copy}
        </button>
      </div>
      <pre ref={pre} className="overflow-x-auto px-4 py-4 font-mono text-[13px] leading-relaxed text-fg">
        <code>{command}</code>
      </pre>
      <p role="status" className={`px-4 pb-3 text-xs text-warn ${state === 'failed' ? '' : 'sr-only'}`}>
        {state === 'failed' ? copyFail : state === 'copied' ? copied : ''}
      </p>
    </div>
  );
}
