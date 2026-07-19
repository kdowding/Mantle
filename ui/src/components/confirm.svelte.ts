// Promise-based confirm — the kit replacement for MantleUI.confirm. Any room
// or lib module calls confirmDialog() and awaits true/false; Confirm.svelte
// (mounted once in App) renders the active request. Module state rather than
// props so asking never requires wiring.
export interface ConfirmOptions {
  title?: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

interface ActiveConfirm {
  title: string;
  message: string;
  confirmText: string;
  cancelText: string;
  danger: boolean;
  resolve: (ok: boolean) => void;
}

export const confirmState = $state({ active: null as ActiveConfirm | null });

export function confirmDialog(opts: ConfirmOptions = {}): Promise<boolean> {
  confirmState.active?.resolve(false); // a newer request supersedes a pending one
  return new Promise((resolve) => {
    confirmState.active = {
      title: opts.title ?? 'Confirm',
      message: opts.message ?? '',
      confirmText: opts.confirmText ?? 'Confirm',
      cancelText: opts.cancelText ?? 'Cancel',
      danger: opts.danger ?? false,
      resolve,
    };
  });
}

export function settleConfirm(ok: boolean): void {
  confirmState.active?.resolve(ok);
  confirmState.active = null;
}
