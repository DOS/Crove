import type { ReactElement, ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@crove/ui/components/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@crove/ui/components/dialog';

// A question asked before an action (#1512), in place of window.confirm: `render` is the button that opens it, Cancel,
// Escape or the close button leave things as they were, and the confirm button, named for the action, runs `onConfirm`.
// Focus starts on Cancel and returns to the button once the dialog closes.
export function ConfirmDialog({
  render,
  children,
  disabled = false,
  title,
  description,
  confirm,
  destructive = false,
  onConfirm,
}: {
  render: ReactElement;
  children: ReactNode;
  disabled?: boolean;
  title: string;
  description: string;
  confirm: string;
  destructive?: boolean;
  onConfirm: () => void;
}) {
  const common = useTranslations('common');
  return (
    <Dialog>
      <DialogTrigger render={render} disabled={disabled}>
        {children}
      </DialogTrigger>
      <DialogContent variant={destructive ? 'destructive' : 'default'} closeLabel={common('close')}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>{common('cancel')}</DialogClose>
          <DialogClose render={<Button variant={destructive ? 'destructive' : 'default'} />} onClick={onConfirm}>
            {confirm}
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
