import { useTranslations } from 'use-intl';
import type { DocumentCorrection } from '@crove/kernel-contract';

// The correction links of a document, both ways (#916): the invoice a replacement or an adjustment corrects, and the
// replacement and adjustment invoices recorded for this one. Shown on the documents list and in the journal.
export function InvoiceCorrections({ corrects, correctedBy }: { corrects?: DocumentCorrection | null | undefined; correctedBy?: readonly DocumentCorrection[] | undefined }) {
  const t = useTranslations('documents.correction');
  const invoice = (c: DocumentCorrection) => `${c.series ? `${c.series}-` : ''}${c.number}`;
  const lines = [
    ...(corrects ? [t(corrects.kind === 'replacement' ? 'replaces' : 'adjusts', { invoice: invoice(corrects) }) + (corrects.documentId ? '' : ` ${t('notInBooks')}`)] : []),
    ...(correctedBy ?? []).map((c) => t(c.kind === 'replacement' ? 'replacedBy' : 'adjustedBy', { invoice: invoice(c) })),
  ];
  if (lines.length === 0) return null;
  return (
    <p className="mt-1 text-xs text-muted-foreground">
      {lines.map((line, i) => (
        <span key={i} className="block">
          {line}
        </span>
      ))}
    </p>
  );
}
