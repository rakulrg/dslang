import { useCallback, useState } from 'react';

export interface ConfirmRequest {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
}

/**
 * Drop-in replacement for the browser `confirm()` dialog, styled to match the
 * admin panel. Returns `{ confirm, dialog }` — call `confirm({...})` to open a
 * prompt, and render `{dialog}` once inside the component's JSX.
 */
export function useConfirm() {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);

  const confirm = useCallback((req: ConfirmRequest) => setRequest(req), []);
  const close = useCallback(() => setRequest(null), []);

  const dialog = request ? (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close"
        onClick={close}
        className="absolute inset-0 bg-ink/60 cursor-default"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        className="relative w-full max-w-sm bg-white border border-line rounded-lg p-5 sm:p-6 shadow-xl animate-fade-in"
      >
        {request.title && (
          <h3
            id="confirm-dialog-title"
            className="font-label text-sm uppercase tracking-wide-2 text-bone font-semibold"
          >
            {request.title}
          </h3>
        )}
        <p className="text-sm text-grey mt-2">{request.message}</p>
        <div className="flex justify-end gap-3 mt-5">
          <button
            type="button"
            onClick={close}
            className="inline-flex items-center gap-2 border border-line text-bone-dim hover:border-bone-dim hover:text-bone text-[11px] uppercase tracking-wide-2 font-semibold px-4 py-2.5 rounded transition-colors"
          >
            {request.cancelLabel ?? 'Cancel'}
          </button>
          <button
            type="button"
            onClick={() => {
              request.onConfirm();
              close();
            }}
            className="inline-flex items-center gap-2 bg-bone text-white text-[11px] uppercase tracking-wide-2 font-semibold px-4 py-2.5 rounded hover:bg-ink transition-colors"
          >
            {request.confirmLabel ?? 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return { confirm, dialog };
}