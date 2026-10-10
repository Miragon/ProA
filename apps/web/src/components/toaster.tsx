import { cn } from 'cn';
import { XIcon } from 'lucide-react';
import { Toast as ToastPrimitive } from 'radix-ui';
import { useSyncExternalStore } from 'react';

import { dismissToast, getToasts, subscribeToasts, type ToastTone } from '@/lib/toast';

/**
 * Toasts per modeler-tool-design §8/§9: bottom centre, surface card with a
 * coloured left edge and dot in the status colour plus text; success and
 * info close after ~2.8 s, errors after ~5 s. Never silent, never `alert()`.
 */
const EDGE: Record<ToastTone, string> = {
  success: 'border-l-success',
  info: 'border-l-info',
  warning: 'border-l-warning',
  danger: 'border-l-danger',
};
const DOT: Record<ToastTone, string> = {
  success: 'bg-success',
  info: 'bg-info',
  warning: 'bg-warning',
  danger: 'bg-danger',
};

export function Toaster() {
  const toasts = useSyncExternalStore(subscribeToasts, getToasts, getToasts);
  return (
    <ToastPrimitive.Provider swipeDirection="down" label="Benachrichtigung">
      {toasts.map((t) => (
        <ToastPrimitive.Root
          key={t.id}
          data-testid="toast"
          data-tone={t.tone}
          duration={t.tone === 'danger' ? 5000 : 2800}
          type={t.tone === 'danger' ? 'foreground' : 'background'}
          onOpenChange={(open) => {
            if (!open) dismissToast(t.id);
          }}
          className={cn(
            'flex w-full items-start gap-3 rounded-lg border border-l-4 bg-card px-4 py-3 text-sm shadow-lg',
            'data-[state=open]:animate-in data-[state=open]:fade-in data-[state=open]:slide-in-from-bottom-2',
            'data-[state=closed]:animate-out data-[state=closed]:fade-out',
            EDGE[t.tone],
          )}
        >
          <span aria-hidden className={cn('mt-1.5 size-2 shrink-0 rounded-full', DOT[t.tone])} />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <ToastPrimitive.Title className="font-semibold">{t.title}</ToastPrimitive.Title>
            {t.description ? (
              <ToastPrimitive.Description className="break-words text-muted-foreground">
                {t.description}
              </ToastPrimitive.Description>
            ) : null}
          </div>
          <ToastPrimitive.Close
            aria-label="Schließen"
            className="rounded-sm text-muted-foreground hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <XIcon className="size-4" />
          </ToastPrimitive.Close>
        </ToastPrimitive.Root>
      ))}
      <ToastPrimitive.Viewport className="fixed bottom-4 left-1/2 z-[60] flex w-[min(420px,calc(100vw-32px))] -translate-x-1/2 flex-col gap-2 outline-none" />
    </ToastPrimitive.Provider>
  );
}
