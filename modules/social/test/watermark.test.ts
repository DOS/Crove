import { describe, expect, it } from 'vitest';
import { SOCIAL_WATERMARK_CORNERS as STORED } from '@crove/db';
import { SOCIAL_WATERMARK_CORNERS as SENT } from '@crove/kernel-contract';

describe('watermark corners (#834)', () => {
  // check-unions compares the database's CHECK with the db copy; the API's copy must say the same.
  it('lists the same corners in the database types and the API contract', () => {
    expect([...SENT]).toEqual([...STORED]);
  });
});
