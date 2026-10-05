import { CircleAlert, CircleCheck, Info, LoaderCircle, TriangleAlert } from 'lucide-react';
import type { CSSProperties } from 'react';
import { Toaster as SonnerToaster, toast } from 'sonner';

import { useTheme } from '@/lib/theme';

/**
 * App-wide toaster (mounted once in __root). Toasts are for transient confirmations only — never
 * the sole place an error or a required decision appears. Sonner renders them in an aria-live region.
 */
export function Toaster() {
  const { resolved } = useTheme();
  return (
    <SonnerToaster
      theme={resolved}
      position="bottom-right"
      closeButton
      visibleToasts={4}
      offset={16}
      gap={8}
      containerAriaLabel="Notifications"
      icons={{
        success: <CircleCheck className="size-4 text-success" aria-hidden />,
        error: <CircleAlert className="size-4 text-destructive" aria-hidden />,
        warning: <TriangleAlert className="size-4 text-warning" aria-hidden />,
        info: <Info className="size-4 text-info" aria-hidden />,
        loading: <LoaderCircle className="size-4 animate-spin text-muted-foreground" aria-hidden />,
      }}
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
          '--border-radius': 'var(--radius)',
          '--width': '360px',
        } as CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: 'font-sans shadow-lg',
          title: 'text-[13px] font-medium',
          description: '!text-muted-foreground text-[13px]',
          actionButton: '!bg-primary !text-primary-foreground !font-medium',
          cancelButton: '!bg-secondary !text-secondary-foreground',
          closeButton: '!bg-popover !border-border !text-muted-foreground hover:!text-foreground',
        },
      }}
    />
  );
}

export { toast };
