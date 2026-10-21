// @mentions in post comments (#793): typing @ lists the org's members; a picked name is kept as @name in the box and
// stored as the member's token, so the server knows whom to tell. A stored comment shows each mention as @name.
import { useQuery } from '@tanstack/react-query';
import { useId, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Textarea } from '@crove/ui/components/textarea';
import { commentParts, mentionLabels, mentionQuery } from '@crove/mod-social/contract';
import { orpc } from '../lib/api.ts';

export type Picked = Array<[string, string]>;
const SHOWN = 6;

// The org's members as comments name them: name for showing a comment, label (unique, with the email where two
// members share a name) for the comment box.
export function useMemberNames() {
  const org = useQuery(orpc.org.get.queryOptions());
  const people = (org.data?.members ?? []).map((m) => ({ userId: m.userId, name: m.displayName ?? m.email, email: m.email }));
  const labels = mentionLabels(people);
  const members = people.map((m) => ({ ...m, label: labels.get(m.userId) ?? m.name }));
  const names = new Map(members.map((m) => [m.userId, m.name]));
  return { members, nameOf: (userId: string) => names.get(userId) ?? null, labelOf: (userId: string) => labels.get(userId) ?? null };
}

export function MentionBox({
  value,
  onChange,
  picked,
  onPicked,
  rows,
  maxLength,
  label,
  placeholder,
}: {
  value: string;
  onChange: (text: string) => void;
  picked: Picked;
  onPicked: (picked: Picked) => void;
  rows: number;
  maxLength: number;
  label: string;
  placeholder?: string;
}) {
  const t = useTranslations('social.activity');
  const { members } = useMemberNames();
  const box = useRef<HTMLTextAreaElement>(null);
  const listId = useId();
  const [caret, setCaret] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const query = caret === null ? null : mentionQuery(value, caret);
  const q = query?.query.toLowerCase() ?? '';
  const matches = query ? members.filter((m) => m.label.toLowerCase().includes(q)).slice(0, SHOWN) : [];
  const pick = (m: { userId: string; label: string }) => {
    if (!query || caret === null) return;
    const inserted = `@${m.label} `;
    const next = `${value.slice(0, query.start)}${inserted}${value.slice(caret)}`;
    if (next.length > maxLength) return;
    onChange(next);
    if (!picked.some(([label]) => label === m.label)) onPicked([...picked, [m.label, m.userId]]);
    const at = query.start + inserted.length;
    setCaret(null);
    requestAnimationFrame(() => {
      box.current?.focus();
      box.current?.setSelectionRange(at, at);
    });
  };
  return (
    <div className="relative">
      <Textarea
        ref={box}
        value={value}
        maxLength={maxLength}
        rows={rows}
        placeholder={placeholder}
        aria-label={label}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={matches.length > 0}
        aria-controls={matches.length > 0 ? listId : undefined}
        aria-activedescendant={matches.length > 0 ? `${listId}-${active}` : undefined}
        onChange={(e) => {
          onChange(e.target.value);
          setCaret(e.target.selectionStart);
          setActive(0);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onBlur={() => setTimeout(() => setCaret(null), 150)}
        onKeyDown={(e) => {
          if (matches.length === 0) return;
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length);
          } else if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault();
            pick(matches[active] ?? (matches[0] as { userId: string; label: string }));
          } else if (e.key === 'Escape') {
            setCaret(null);
          }
        }}
      />
      {matches.length > 0 && (
        <ul id={listId} role="listbox" aria-label={t('mentionList')} className="absolute z-10 mt-1 max-h-56 w-64 overflow-auto rounded-md border border-border bg-popover p-1 text-sm shadow-md">
          {matches.map((m, i) => (
            <li
              key={m.userId}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={`cursor-pointer rounded px-2 py-1 ${i === active ? 'bg-accent text-accent-foreground' : 'text-foreground'}`}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(m);
              }}
            >
              {m.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// A stored comment with each mention shown as @name.
export function CommentBody({ body }: { body: string }) {
  const t = useTranslations('social.activity');
  const { nameOf } = useMemberNames();
  return (
    <p className="whitespace-pre-wrap break-words text-foreground">
      {commentParts(body).map((p, i) =>
        'text' in p ? (
          <span key={i}>{p.text}</span>
        ) : (
          <span key={i} className="font-medium text-primary">
            @{nameOf(p.mention) ?? t('formerMember')}
          </span>
        ),
      )}
    </p>
  );
}
