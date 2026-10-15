// Module slots in the SPA (plan Decision 12): a module the deployment leaves out answers not_installed.
import { describe, expect, it } from 'vitest';
import { installedItems, slot } from '../src/lib/modules.ts';

describe('module slots', () => {
  it('answers ok for an installed module and not_installed otherwise', () => {
    expect(slot(['kernel', 'finance'], 'finance', 'Bút toán')).toEqual({ status: 'ok', value: 'Bút toán' });
    expect(slot(['kernel'], 'finance', 'Bút toán')).toEqual({ status: 'not_installed', module: 'finance' });
  });

  it('keeps only the menu items of installed modules, in order', () => {
    const nav = [
      { module: 'kernel', to: 'inbox' },
      { module: 'finance', to: 'journal' },
      { module: 'kernel', to: 'settings' },
    ];
    expect(installedItems(['kernel'], nav).map((item) => item.to)).toEqual(['inbox', 'settings']);
    expect(installedItems(['kernel', 'finance'], nav)).toEqual(nav);
  });
});
