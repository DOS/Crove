import { describe, expect, it } from 'vitest';
import { findStale, nextVersions, suggestRenames } from '../ci/migration-order.mjs';
import { rerunDecision, stalePrs, staleSummary } from '../ci/migration-recheck.mjs';

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

  it('passes anything when the base has no migrations yet', () => {
    expect(findStale([], [m('20200101000000')])).toEqual({ newest: '', stale: [] });
  });

  it('suggests whole hours after a version, across days', () => {
    expect(nextVersions('20261018000000')).toEqual(['20261018010000']);
    expect(nextVersions('20261018023015', 2)).toEqual(['20261018030000', '20261018040000']);
    expect(nextVersions('20261231230000', 2)).toEqual(['20270101000000', '20270101010000']);
  });

  it('suggests renames above the base newest and above every file the PR adds', () => {
    const added = [m('20261017180000', 'crove_kernel_a'), m('20261018000000', 'crove_kernel_b'), m('20261018050000', 'crove_kernel_c')];
    const { newest, stale } = findStale(base, added);
    expect(suggestRenames(newest, added, stale)).toEqual([
      { from: added[0], to: m('20261018060000', 'crove_kernel_a') },
      { from: added[1], to: m('20261018070000', 'crove_kernel_b') },
    ]);
  });
});

describe('migration re-check after the base moves', () => {
  const base = [m('20261018000000'), m('20261018020000')];

  it('picks only the open PRs whose added migrations fell behind', () => {
    const prs = [
      { number: 1, sha: 'a'.repeat(40), added: [m('20261018010000')] },
      { number: 2, sha: 'b'.repeat(40), added: [m('20261018030000')] },
      { number: 3, sha: 'c'.repeat(40), added: [] },
      { number: 4, sha: 'd'.repeat(40), added: [m('20261018020000', 'crove_kernel_y'), m('20261018040000')] },
    ];
    expect(stalePrs(base, prs)).toEqual([
      { number: 1, sha: 'a'.repeat(40), newest: '20261018020000', stale: [m('20261018010000')] },
      { number: 4, sha: 'd'.repeat(40), newest: '20261018020000', stale: [m('20261018020000', 'crove_kernel_y')] },
    ]);
  });

  it('re-runs a finished passing Docs check and leaves the rest alone', () => {
    expect(rerunDecision({ id: 7, status: 'completed', conclusion: 'success' }).action).toBe('rerun');
    expect(rerunDecision({ id: 7, status: 'completed', conclusion: 'cancelled' }).action).toBe('rerun');
    expect(rerunDecision({ id: 7, status: 'completed', conclusion: 'failure' }).action).toBe('skip');
    expect(rerunDecision({ id: 7, status: 'completed', conclusion: 'action_required' }).action).toBe('skip');
    expect(rerunDecision({ id: 7, status: 'in_progress', conclusion: null }).action).toBe('wait');
    expect(rerunDecision({ id: 7, status: 'queued', conclusion: null }).action).toBe('wait');
    expect(rerunDecision(undefined).action).toBe('skip');
  });

  it('names every stale file and the base newest in the fallback check run', () => {
    const pr = { number: 1, sha: 'a'.repeat(40), newest: '20261018020000', stale: [m('20261018010000'), m('20261018000000', 'crove_kernel_y')] };
    const text = staleSummary(pr);
    expect(text).toContain('not newer than 20261018020000');
    expect(text).toContain(`- ${m('20261018010000')}\n- ${m('20261018000000', 'crove_kernel_y')}`);
  });
});
