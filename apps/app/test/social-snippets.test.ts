import { describe, expect, it } from 'vitest';
import { insertAt } from '../src/lib/social-snippets.ts';

describe('putting a snippet in the text (#584)', () => {
  it('puts it at the cursor, on its own line after other text, and replaces a selection', () => {
    expect(insertAt('', 0, 0, '#crove')).toEqual({ text: '#crove', cursor: 6 });
    expect(insertAt('Khai trương', 11, 11, '#crove')).toEqual({ text: 'Khai trương\n#crove', cursor: 18 });
    expect(insertAt('Khai trương\n', 12, 12, '#crove')).toEqual({ text: 'Khai trương\n#crove', cursor: 18 });
    expect(insertAt('Mở cửa hôm nay', 0, 0, 'Tin vui:')).toEqual({ text: 'Tin vui: Mở cửa hôm nay', cursor: 8 });
    expect(insertAt('Giá XX đồng', 4, 6, '99.000')).toEqual({ text: 'Giá 99.000 đồng', cursor: 10 });
  });
});