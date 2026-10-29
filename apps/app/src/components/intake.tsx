// Bulk intake in the Inbox (issue #314): upload many documents or ZIP archives at once and follow every file until it
// is read. The batch state lives in lib/intake.ts; this wires it to the uploads, the files.batch query and the screen.
import { useQueries } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { ClientError, errorMessage, orpc, queryClient, uploadDocument } from '../lib/api.ts';
import {
  INTAKE_CONCURRENCY,
  INTAKE_POLL_MS,
  MAX_INTAKE_FILES,
  applyBatch,
  eachLimited,
  isSettled,
  newItem,
  fitsBatch,
  pollGroups,
  precheck,
  summarize,
  uploaded,
  type IntakeItem,
  type IntakeState,
} from '../lib/intake.ts';
import { useChosenEntity } from './entity-switcher.tsx';

// Waits after a RATE_LIMITED refusal before the same upload is tried again, and how many times.
const RATE_LIMIT_WAIT_MS = 10_000;
const RATE_LIMIT_TRIES = 6;

async function uploadWithRetry(file: File, legalEntityId: string | undefined) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await uploadDocument(file, legalEntityId);
    } catch (error) {
      if ((error as { code?: string } | null)?.code !== 'RATE_LIMITED' || attempt + 1 >= RATE_LIMIT_TRIES) throw error;
      await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_WAIT_MS));
    }
  }
}

export interface Intake {
  items: IntakeItem[];
  uploading: boolean;
  start: (files: File[]) => void;
  clear: () => void;
  // Set when a batch was refused whole (too many files).
  refused: unknown;
}

export function useIntake(): Intake {
  const [items, setItems] = useState<IntakeItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [refused, setRefused] = useState<unknown>(null);
  const counter = useRef(0);
  // The list as last rendered, for the size check in start (the updates below are functional).
  const current = useRef<IntakeItem[]>(items);
  current.current = items;
  // The entity the shell works in when the batch starts: its documents are booked there (#1764).
  const chosen = useChosenEntity();
  const entity = useRef<string | undefined>(chosen.legalEntityId);
  entity.current = chosen.legalEntityId;

  const update = useCallback((key: string, change: (item: IntakeItem) => IntakeItem) => {
    setItems((current) => current.map((item) => (item.key === key ? change(item) : item)));
  }, []);

  const start = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      // With the files still in flight, so files.batch never has to answer for more than it takes.
      if (!fitsBatch(current.current, files.length)) {
        setRefused(new ClientError('inbox.intake.tooMany', (t) => t('inbox.intake.tooMany', { max: MAX_INTAKE_FILES })));
        return;
      }
      setRefused(null);
      const batch = files.map((file) => {
        counter.current += 1;
        const item = newItem(`f${counter.current}`, file.name);
        const check = precheck(file);
        if (check === 'ok') return { file, item };
        const uploadError =
          check === 'too_large'
            ? new ClientError('inbox.fileTooLarge', (t) => t('inbox.fileTooLarge', { name: file.name }))
            : new ClientError('inbox.intake.unsupported', (t) => t('inbox.intake.unsupported'));
        return { file, item: { ...item, state: 'upload_failed' as const, uploadError } };
      });
      // A finished batch makes way for the new one; files still in flight stay on the list.
      setItems((current) => [...batch.map((b) => b.item), ...(isSettled(current) ? [] : current)]);
      setUploading(true);
      void eachLimited(
        batch.filter((b) => b.item.state === 'queued'),
        INTAKE_CONCURRENCY,
        async ({ file, item }) => {
          update(item.key, (i) => ({ ...i, state: 'uploading' }));
          try {
            const result = await uploadWithRetry(file, entity.current);
            update(item.key, (i) => uploaded(i, result));
          } catch (error) {
            update(item.key, (i) => ({ ...i, state: 'upload_failed', uploadError: error }));
          }
        },
      ).finally(() => {
        setUploading(false);
        void queryClient.invalidateQueries();
      });
    },
    [update],
  );

  // One call per group, so an answer never has to cut an archive's entries short.
  const polls = useQueries({
    queries: pollGroups(items).map((ids) => ({ ...orpc.files.batch.queryOptions({ input: { ids } }), refetchInterval: INTAKE_POLL_MS })),
  });
  // Applied when any answer arrives; stamp changes exactly then.
  const stamp = polls.map((poll) => poll.dataUpdatedAt).join(',');
  const latest = useRef(polls);
  latest.current = polls;
  useEffect(() => {
    const answers = latest.current.flatMap((poll) => poll.data ?? []);
    if (answers.length > 0) setItems((list) => applyBatch(list, answers));
  }, [stamp]);

  const clear = useCallback(() => {
    setItems([]);
    setRefused(null);
  }, []);

  return { items, uploading, start, clear, refused };
}

const VARIANT: Record<IntakeState, 'secondary' | 'brand' | 'success' | 'warning' | 'destructive'> = {
  queued: 'secondary',
  uploading: 'brand',
  upload_failed: 'destructive',
  processing: 'brand',
  waiting: 'warning',
  proposed: 'success',
  duplicate: 'warning',
  failed: 'destructive',
  expanded: 'success',
  rejected: 'destructive',
};

function Row({ item, nested = false }: { item: IntakeItem; nested?: boolean }) {
  const t = useTranslations('inbox.intake');
  const why =
    item.state === 'upload_failed'
      ? errorMessage(item.uploadError)
      : item.state === 'rejected' && item.reason
        ? t(`reasons.${item.reason}`)
        : item.state === 'failed'
          ? item.error
          : item.state === 'duplicate' && item.existing
            ? t('alreadyReceived')
            : null;
  return (
    <li className={nested ? 'pl-5' : undefined} data-testid="intake-item" data-state={item.state}>
      <div className="flex items-center gap-2 py-1 text-xs">
        <span className="min-w-0 flex-1 truncate text-muted-foreground" title={item.name}>
          {item.name}
        </span>
        <Badge variant={VARIANT[item.state]}>
          {item.state === 'expanded' ? t('expandedCount', { count: item.entries.length }) : t(`states.${item.state}`)}
        </Badge>
      </div>
      {why && <p className="pb-1 text-xs break-words text-destructive">{why}</p>}
      {item.entries.length > 0 && (
        <ul>
          {item.entries.map((entry) => (
            <Row key={entry.key} item={entry} nested />
          ))}
        </ul>
      )}
    </li>
  );
}

export function IntakePanel({ intake }: { intake: Intake }) {
  const t = useTranslations('inbox.intake');
  // One document read as usual shows in the recent files below; the panel is for a batch, an archive, or a refusal.
  const shown = intake.items.length > 1 || intake.items.some((item) => item.archive || item.state === 'upload_failed');
  if (!shown && !intake.refused) return null;
  const summary = summarize(intake.items);
  const done = isSettled(intake.items) && !intake.uploading;
  return (
    <Card className="mt-6 block p-4" data-testid="intake-panel">
      {intake.refused ? <p className="text-xs text-destructive">{errorMessage(intake.refused)}</p> : null}
      {intake.items.length > 0 && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm font-medium text-foreground" data-testid="intake-summary">
              {done ? t('done', { total: summary.total }) : t('progress', { settled: summary.settled, total: summary.total })}
            </p>
            <p className="text-xs text-subtle-foreground">
              {t('counts', { proposed: summary.proposed, duplicate: summary.duplicate, failed: summary.failed })}
            </p>
            {done && (
              <Button variant="outline" size="sm" className="ml-auto" onClick={intake.clear}>
                {t('close')}
              </Button>
            )}
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded bg-muted" aria-hidden>
            <div className="h-full bg-primary transition-all" style={{ width: `${summary.total ? Math.round((summary.settled / summary.total) * 100) : 0}%` }} />
          </div>
          <ul className="mt-3 max-h-80 overflow-y-auto pr-1">
            {intake.items.map((item) => (
              <Row key={item.key} item={item} />
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}
