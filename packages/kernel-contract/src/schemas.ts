import { z } from 'zod';

// Wire conventions: snake_case is not used on the wire for the MVP API; decimals are strings,
// accounting dates are YYYY-MM-DD, ids are UUIDs.
export const zId = z.uuid();
export const zMoney = z.string().regex(/^-?\d+(\.\d+)?$/, 'decimal string');
export const zLocalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
export const zAccountCode = z.string().regex(/^\d{3,5}$/);
export const zRole = z.enum(['owner', 'admin', 'member', 'viewer']);
export const zSlug = z.string().regex(/^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/);

export const zCheck = z.object({
  id: z.string(),
  status: z.enum(['pass', 'warn', 'fail']),
  message: z.string(),
});

export const zPartyRef = z.object({
  name: z.string(),
  taxCode: z.string().nullable(),
  address: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
});

export const zProposedLine = z.object({
  lineNo: z.number().int().positive(),
  description: z.string(),
  unit: z.string().nullable(),
  quantity: zMoney.nullable(),
  unitPrice: zMoney.nullable(),
  amount: zMoney,
  vatRate: z.string().nullable(),
  debitAccount: zAccountCode,
  reason: z.string(),
});

export const zJournalLineDraft = z.object({
  lineNo: z.number().int().positive(),
  accountCode: zAccountCode,
  debit: zMoney,
  credit: zMoney,
  memo: z.string(),
});

// Payload stored on a finance.purchase proposal and executed by finance.purchase.record.
export const zPurchaseProposal = z.object({
  seller: zPartyRef,
  buyer: zPartyRef,
  invoice: z.object({
    template: z.string().nullable(),
    series: z.string(),
    number: z.string(),
    issueDate: zLocalDate,
    currency: z.string(),
    paymentMethod: z.string().nullable(),
    taxAuthorityCode: z.string().nullable(),
    subtotal: zMoney,
    vatTotal: zMoney,
    total: zMoney,
  }),
  lines: z.array(zProposedLine).min(1),
  journal: z.array(zJournalLineDraft).min(2),
  checks: z.array(zCheck),
  sourceFileId: zId,
  extractionMethod: z.enum(['einvoice_xml', 'pdf_text_ai', 'image_ai']),
});
export type PurchaseProposal = z.infer<typeof zPurchaseProposal>;

export const zOrgSummary = z.object({ orgId: zId, slug: z.string(), name: z.string(), role: zRole });
export const zMe = z.object({
  userId: zId,
  email: z.string(),
  displayName: z.string().nullable(),
  orgs: z.array(zOrgSummary),
});

export const zOrgDetail = z.object({
  orgId: zId,
  slug: z.string(),
  name: z.string(),
  role: zRole,
  inboundAddress: z.string().nullable(),
  members: z.array(z.object({ userId: zId, email: z.string(), displayName: z.string().nullable(), role: zRole })),
});

export const zProposalStatus = z.enum(['pending', 'executed', 'rejected', 'failed']);

export const zInboxItem = z.object({
  id: zId,
  kind: z.string(),
  status: zProposalStatus,
  title: z.string(),
  sellerName: z.string().nullable(),
  total: zMoney.nullable(),
  issueDate: zLocalDate.nullable(),
  failedChecks: z.number().int(),
  warnChecks: z.number().int(),
  duplicateOf: zId.nullable(),
  createdAt: z.string(),
});

export const zInboxDetail = zInboxItem.extend({
  revision: z.number().int(),
  payload: zPurchaseProposal.nullable(),
  error: z.string().nullable(),
  file: z.object({ id: zId, filename: z.string(), contentType: z.string(), sizeBytes: z.string() }).nullable(),
  decidedAt: z.string().nullable(),
  decisionNote: z.string().nullable(),
  result: z.object({ documentId: zId, journalEntryId: zId }).nullable(),
});

export const zFileStatus = z.object({
  id: zId,
  filename: z.string(),
  contentType: z.string(),
  status: z.enum(['processing', 'proposed', 'failed', 'duplicate']),
  error: z.string().nullable(),
  proposalId: zId.nullable(),
  createdAt: z.string(),
});

export const zParty = z.object({
  id: zId,
  name: z.string(),
  taxCode: z.string().nullable(),
  address: z.string().nullable(),
  documentCount: z.number().int(),
});

export const zPurchaseDocument = z.object({
  id: zId,
  partyId: zId,
  partyName: z.string(),
  series: z.string(),
  number: z.string(),
  issueDate: zLocalDate,
  subtotal: zMoney,
  vatAmount: zMoney,
  total: zMoney,
  journalEntryId: zId.nullable(),
  sourceFileId: zId.nullable(),
});

export const zJournalEntry = z.object({
  id: zId,
  entryDate: zLocalDate,
  description: z.string(),
  sourceType: z.string(),
  sourceId: zId,
  lines: z.array(
    z.object({ lineNo: z.number().int(), accountCode: z.string(), accountName: z.string(), debit: zMoney, credit: zMoney }),
  ),
});

export const zAccount = z.object({ code: z.string(), name: z.string(), parentCode: z.string().nullable() });
