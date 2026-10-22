// The assisted sync from the tax portal on the reconciliation screen (issue #325): who sees it, and the order of its
// steps after the login. The kernel decides every rule; the portal session it answers is held in the screen's memory
// for the length of one sync and then dropped.
import { PORTAL_XML_PER_SYNC, PORTAL_XML_PER_REQUEST, type PortalListResult, type PortalXmlResult } from '@crove/kernel-contract';

// The roles that may run it (the kernel's finance.portal_sync.* commands check again), on a deployment that turned it on.
export function canSyncFromPortal(role: string | null | undefined, enabled: boolean | undefined): boolean {
  return enabled === true && (role === 'owner' || role === 'admin' || role === 'member');
}

// A login refusal after which the CAPTCHA shown is spent: the portal takes each CAPTCHA once.
export function needsNewCaptcha(code: string | null | undefined): boolean {
  return code !== null && code !== undefined && code.startsWith('PORTAL_') && code !== 'PORTAL_SYNC_DISABLED';
}

export interface SyncProgress {
  phase: 'xml' | 'done';
  rows: number;
  unchanged: boolean;
  skipped: number;
  // Invoices of the list the portal has an XML for; the downloads skip those Crove already has.
  withXml: number;
  downloaded: number;
  duplicates: number;
  failed: number;
  remaining: number;
  // The worker had not recorded the list when the screen stopped waiting: the downloads did not start.
  listPending: boolean;
}

export interface SyncSteps {
  fetchList(): Promise<PortalListResult>;
  fetchXml(listId: string): Promise<PortalXmlResult>;
}

export interface SyncTiming {
  waitMs: number;
  maxWaits: number;
  sleep: (ms: number) => Promise<void>;
}

const DEFAULT_TIMING: SyncTiming = { waitMs: 1500, maxWaits: 60, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };

// Fetches the list, then the XML a few at a time until the kernel says done, waiting while the worker records the list.
// A step that fails throws and ends the sync; what was recorded before stays recorded.
export async function runPortalSync(steps: SyncSteps, onProgress: (p: SyncProgress) => void, timing: SyncTiming = DEFAULT_TIMING): Promise<SyncProgress> {
  const list = await steps.fetchList();
  let progress: SyncProgress = {
    phase: list.withXml > 0 ? 'xml' : 'done',
    rows: list.rows,
    unchanged: list.unchanged,
    skipped: list.skipped,
    withXml: list.withXml,
    downloaded: 0,
    duplicates: 0,
    failed: 0,
    remaining: 0,
    listPending: false,
  };
  onProgress(progress);
  // Bounds on the rounds, whatever the kernel answers: every download round settles at least one invoice or ends.
  const rounds = Math.ceil(PORTAL_XML_PER_SYNC / PORTAL_XML_PER_REQUEST) + 2;
  let waits = 0;
  for (let round = 0; progress.phase === 'xml' && round < rounds; ) {
    const xml = await steps.fetchXml(list.listId);
    if (xml.waiting) {
      waits += 1;
      if (waits > timing.maxWaits) {
        progress = { ...progress, phase: 'done', listPending: true };
        break;
      }
      await timing.sleep(timing.waitMs);
      continue;
    }
    round += 1;
    const settled = xml.downloaded + xml.duplicates + xml.failed;
    progress = {
      ...progress,
      downloaded: progress.downloaded + xml.downloaded,
      duplicates: progress.duplicates + xml.duplicates,
      failed: progress.failed + xml.failed,
      remaining: xml.remaining,
      phase: xml.done || settled === 0 ? 'done' : 'xml',
    };
    onProgress(progress);
  }
  return { ...progress, phase: 'done' };
}
