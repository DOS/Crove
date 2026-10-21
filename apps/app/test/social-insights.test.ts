import { describe, expect, it } from 'vitest';
import { barWidth } from '../src/lib/social-insights.ts';

describe('what works bars (#705)', () => {
  it('puts the channel median in the middle and caps at twice it', () => {
    expect(barWidth(1)).toBe(50);
    expect(barWidth(0.5)).toBe(25);
    expect(barWidth(1.5)).toBe(75);
    expect(barWidth(3)).toBe(100);
    expect(barWidth(0)).toBe(0);
    expect(barWidth(null)).toBe(0);
  });
});
