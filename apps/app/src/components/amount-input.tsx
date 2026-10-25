// An amount field (#1391): as typed while it has the focus, grouped as the reader's language groups digits otherwise.
// The value the form keeps is what was typed; normalizeAmount reads either back as the same digits.
import { useState, type ComponentProps } from 'react';
import { Input } from '@crove/ui/components/input';
import { useLocaleSetting } from '../i18n/provider.tsx';
import { groupAmount } from '../lib/amount-input.ts';

type Passed = Omit<ComponentProps<typeof Input>, 'value' | 'onChange' | 'type'>;

export function AmountInput({ value, onChange, onFocus, onBlur, ...props }: Passed & { value: string; onChange: (value: string) => void }) {
  const { locale } = useLocaleSetting();
  const [focused, setFocused] = useState(false);
  return (
    <Input
      {...props}
      inputMode="numeric"
      autoComplete="off"
      value={focused ? value : groupAmount(value, locale)}
      onChange={(e) => onChange(e.target.value)}
      onFocus={(e) => {
        setFocused(true);
        onFocus?.(e);
      }}
      onBlur={(e) => {
        setFocused(false);
        onBlur?.(e);
      }}
    />
  );
}
