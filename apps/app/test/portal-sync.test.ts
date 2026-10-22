// The tax portal sync on the reconciliation screen (#325): who sees it, when a new CAPTCHA is needed, and the order of
// the steps after the login.
import { describe, expect, it } from 'vitest';
import type { PortalListResult, PortalXmlResult } from '@crove/kernel-contract';
import { canSyncFromPortal, needsNewCaptcha, runPortalSync, type SyncProgress } from '../src/lib/portal-sync.ts';

const LIST = '00000000-0000-7000-8000-000000000001';
const list = (extra: Partial<PortalListResult> = {}): PortalListResult => ({ listId: LIST, unchanged: false, rows: 5, skipped: 0, ownSales: 0, otherBuyers: 0, withXml: 0, ...extra });

describe('canSyncFromPortal', () => {
  it('offers the sync to editors on a deployment that turned it on', () => {
    expect(canSyncFromPortal('owner', true)).toBe(true);
    expect(canSyncFromPortal('member', true)).toBe(true);
    expect(canSyncFromPortal('viewer', true)).toBe(false);
    expect(canSyncFromPortal('admin', false)).toBe(false);
    expect(canSyncFromPortal('admin', undefined)).toBe(false);
  });
});

describe('needsNewCaptcha', () => {
  it('asks for a new CAPTCHA after any portal refusal of the login', () => {
    expect(needsNewCaptcha('PORTAL_WRONG_CAPTCHA')).toBe(true);
    expect(needsNewCaptcha('PORTAL_WRONG_PASSWORD')).toBe(true);
    expect(needsNewCaptcha('PORTAL_CHALLENGE_INVALID')).toBe(true);
    expect(needsNewCaptcha('PORTAL_SYNC_DISABLED')).toBe(false);
    expect(needsNewCaptcha('FORBIDDEN')).toBe(false);
    expect(needsNewCaptcha(undefined)).toBe(false);
  });
});

describe('runPortalSync', () => {
  it('fetches the list, then the XML until the kernel says done', async () => {
    const answers: PortalXmlResult[] = [
      { downloaded: 0, duplicates: 0, failed: 0, remaining: 0, done: false, waiting: true },
      { downloaded: 4, duplicates: 1, failed: 0, remaining: 3, done: false, waiting: false },
      { downloaded: 2, duplicates: 0, failed: 1, remaining: 0, done: true, waiting: false },
    ];
    const seen: SyncProgress[] = [];
    const calls: string[] = [];
    const result = await runPortalSync(
      {
        fetchList: async () => {
          calls.push('list');
          return list({ withXml: 8 });
        },
        fetchXml: async (listId) => {
          calls.push(`xml:${listId}`);
          return answers.shift() as PortalXmlResult;
        },
      },
      (p) => seen.push(p),
      { waitMs: 0, maxWaits: 5, sleep: async () => {} },
    );
    expect(calls).toEqual(['list', `xml:${LIST}`, `xml:${LIST}`, `xml:${LIST}`]);
    expect(seen.map((p) => p.phase)).toEqual(['xml', 'xml', 'done']);
    expect(result).toMatchObject({ phase: 'done', rows: 5, withXml: 8, downloaded: 6, duplicates: 1, failed: 1, remaining: 0, listPending: false });
  });

  it('stops when nothing needs downloading, and when a round settles nothing', async () => {
    let xml = 0;
    const none = await runPortalSync({ fetchList: async () => list(), fetchXml: async () => (xml++, { downloaded: 0, duplicates: 0, failed: 0, remaining: 0, done: true, waiting: false }) }, () => {});
    expect(none.phase).toBe('done');
    expect(xml).toBe(0);
    const stuck = await runPortalSync({ fetchList: async () => list({ withXml: 2 }), fetchXml: async () => (xml++, { downloaded: 0, duplicates: 0, failed: 0, remaining: 2, done: false, waiting: false }) }, () => {});
    expect(stuck).toMatchObject({ phase: 'done', remaining: 2 });
    expect(xml).toBe(1);
  });

  it('stops waiting for the worker after a while, and says so', async () => {
    let waited = 0;
    const result = await runPortalSync(
      { fetchList: async () => list({ withXml: 3 }), fetchXml: async () => ({ downloaded: 0, duplicates: 0, failed: 0, remaining: 0, done: false, waiting: true }) },
      () => {},
      { waitMs: 10, maxWaits: 3, sleep: async () => void waited++ },
    );
    expect(result).toMatchObject({ phase: 'done', listPending: true, downloaded: 0 });
    expect(waited).toBe(3);
  });

  it('lets a failed step end the sync', async () => {
    await expect(runPortalSync({ fetchList: async () => list({ withXml: 1 }), fetchXml: async () => Promise.reject(new Error('PORTAL_SESSION_EXPIRED')) }, () => {})).rejects.toThrow('PORTAL_SESSION_EXPIRED');
  });
});
