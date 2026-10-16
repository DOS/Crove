import { describe, expect, it } from 'vitest';
import { findStale, nextVersion } from '../ci/migration-order.mjs';

const m = (version: string, name = 'crove_kernel_x') => `supabase/migrations/${version}_${name}.sql`;

describe('migration order check', () => {
  const base = [m('20261017160000'), m('20261018000000'), 'supabase/migrations/README.md'];

  it('passes a PR whose new migration is newer than the base', () => {
    expect(findStale(base, [m('20261018010000')])).toEqual({ newest: '20261018000000', stale: [] });
  });

  it('fails a migration equal to or older than the base newest', () => {
    const added = [m('20261018000000', 'crove_kernel_y'), m('20261017180000'), m('20261018020000')];
    expect(findStale(base, added).stale).toEqual([added[0], added[1]]);
  });

  it('ignores PRs without migrations and files outside the naming rule', () => {
    expect(findStale(base, []).stale).toEqual([]);
    expect(findStale(base, ['supabase/migrations/notes.md']).stale).toEqual([]);
  });

  it('suggests a version after the newest', () => {
    expect(nextVersion('20261018000000', new Date('2026-10-16T12:00:00Z'))).toBe('20261018000100');
    expect(nextVersion('20261018000000', new Date('2026-10-19T08:30:05Z'))).toBe('20261019083005');
  });
});
