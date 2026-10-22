import { describe, expect, it } from 'vitest';
import { STORY_FINAL_FROM_MS, STORY_LIFETIME_MS, storyCapture } from '../src/domain/story-metrics.ts';
import { METRICS_INTERVAL_SECONDS, METRICS_SWEEP_MS } from '../src/metrics.ts';

const HOUR = 3_600_000;
const INTERVAL = METRICS_INTERVAL_SECONDS * 1000;
const published = new Date('2026-10-23T08:00:00.000Z');
const at = (hours: number) => new Date(published.getTime() + hours * HOUR);

describe('Story captures before expiry (#1082)', () => {
  it('captures as usual while the next regular capture still comes before the end', () => {
    expect(storyCapture(published, at(0.1), INTERVAL)).toBe('regular');
    expect(storyCapture(published, at(6.5), INTERVAL)).toBe('regular');
    expect(storyCapture(published, at(17), INTERVAL)).toBe('regular');
  });

  it('waits once a regular capture would push the next one past the end, then takes the final one', () => {
    expect(storyCapture(published, at(17.25), INTERVAL)).toBe('wait');
    expect(storyCapture(published, at(21.9), INTERVAL)).toBe('wait');
    expect(storyCapture(published, at(22), INTERVAL)).toBe('final');
    expect(storyCapture(published, at(23.9), INTERVAL)).toBe('final');
  });

  it('marks a Story expired once its insights are over', () => {
    expect(storyCapture(published, at(24), INTERVAL)).toBe('expired');
    expect(storyCapture(published, at(30 * 24), INTERVAL)).toBe('expired');
  });

  // Whatever time a Story's captures fall at, the sweep (every 15 minutes, again 6 hours after the last capture) takes
  // one in its final window and none after the end.
  it('always lands a capture in the last two hours, for every start of the cadence', () => {
    for (let first = 0; first < 6 * HOUR; first += METRICS_SWEEP_MS) {
      const kinds: string[] = [];
      let last: number | null = null;
      for (let t = first; t < 30 * HOUR; t += METRICS_SWEEP_MS) {
        if (last !== null && t - last < INTERVAL) continue;
        const kind = storyCapture(published, new Date(published.getTime() + t), INTERVAL);
        if (kind === 'wait') continue;
        kinds.push(kind);
        if (kind === 'expired') break;
        last = t;
        if (kind === 'final') expect(t).toBeGreaterThanOrEqual(STORY_FINAL_FROM_MS);
        expect(t).toBeLessThan(STORY_LIFETIME_MS);
      }
      expect(kinds.filter((k) => k === 'final')).toHaveLength(1);
      expect(kinds.at(-1)).toBe('expired');
    }
  });
});
