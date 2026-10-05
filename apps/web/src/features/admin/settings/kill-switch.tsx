import { Power, PowerOff } from 'lucide-react';
import { useId, useState } from 'react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { SectionCard } from '@/components/ui/section-card';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

import { MutationErrorAlert } from '../shared/form';

interface AiKillSwitchProps {
  /** Current server value of `platform_settings.ai_enabled`. */
  aiEnabled: boolean;
  /** Called only after the person confirms in the dialog. */
  onConfirm: (next: boolean) => void;
  pending?: boolean;
  error?: unknown;
}

/**
 * Global AI kill switch (system-design §4.3). The switch never changes state on click: it opens a
 * confirmation that explains exactly what happens, and only the confirmed choice is sent. The control
 * always reflects the server's value, not an optimistic guess.
 */
export function AiKillSwitch({ aiEnabled, onConfirm, pending = false, error }: AiKillSwitchProps) {
  // `next` survives the close animation so the dialog content doesn't flip while fading out.
  const [confirm, setConfirm] = useState<{ open: boolean; next: boolean }>({ open: false, next: false });
  const switchId = useId();
  const descriptionId = useId();
  const StateIcon = aiEnabled ? Power : PowerOff;

  return (
    <SectionCard
      title="AI kill switch"
      description="Stops every model call across all tenants, immediately"
      icon={Power}
      className={cn(!aiEnabled && 'border-warning/60')}
    >
      <div className="grid gap-4">
        <div
          className={cn(
            'flex flex-col gap-3 rounded-lg border px-4 py-3 sm:flex-row sm:items-center sm:justify-between',
            aiEnabled ? 'border-border' : 'border-dashed border-warning/60 bg-warning/[0.08]',
          )}
        >
          <div className="flex items-start gap-3">
            <span
              className={cn(
                'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border',
                aiEnabled ? 'border-success/45 text-success' : 'border-warning/60 text-warning',
              )}
            >
              <StateIcon aria-hidden className="size-4" />
            </span>
            <div>
              <p className="font-semibold" data-testid="ai-state">
                {aiEnabled ? 'AI coaching is on' : 'AI coaching is paused for everyone'}
              </p>
              <p id={descriptionId} className="text-[13px] text-muted-foreground">
                {aiEnabled
                  ? 'Founders can start sessions and get answers, within the daily spend caps.'
                  : 'No model calls are made. Founders can still read their workspace and reach a human.'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2.5">
            <label htmlFor={switchId} className="text-sm font-medium">
              AI coaching enabled
            </label>
            <Switch
              id={switchId}
              checked={aiEnabled}
              disabled={pending}
              aria-describedby={descriptionId}
              onCheckedChange={(next) => {
                setConfirm({ open: true, next });
              }}
            />
          </div>
        </div>
        <p className="text-[13px] text-muted-foreground">
          Use it when the coach behaves unsafely, during a model or vendor incident, or if spend is running
          away. Every change is recorded in the audit log. To pause a single persona instead, suspend it in
          the EIR studio.
        </p>
        <MutationErrorAlert error={error} title="The kill switch wasn’t changed" />
      </div>

      <AlertDialog
        open={confirm.open}
        onOpenChange={(open) => {
          setConfirm((prev) => ({ ...prev, open }));
        }}
      >
        <AlertDialogContent className={cn(!confirm.next && 'border-destructive/50')}>
          {!confirm.next ? (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle className="flex items-center gap-2">
                  <PowerOff aria-hidden className="size-4 text-destructive" />
                  Pause AI coaching for everyone?
                </AlertDialogTitle>
                <AlertDialogDescription asChild>
                  <div className="grid gap-2">
                    <p>This takes effect immediately, in every venture and every tenant:</p>
                    <ul className="list-disc space-y-1 pl-5">
                      <li>New sessions and the next message in any open session are refused.</li>
                      <li>
                        Founders see that AI coaching is paused. Their sessions, memory, documents and
                        escalations stay available, and they can still escalate to a human.
                      </li>
                      <li>No model calls are made, so AI spend stops.</li>
                      <li>It stays paused until an admin turns it back on here.</li>
                    </ul>
                  </div>
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep AI on</AlertDialogCancel>
                <AlertDialogAction
                  destructive
                  onClick={() => {
                    onConfirm(false);
                  }}
                >
                  Pause AI coaching
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          ) : (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle className="flex items-center gap-2">
                  <Power aria-hidden className="size-4" />
                  Resume AI coaching?
                </AlertDialogTitle>
                <AlertDialogDescription>
                  Coaching resumes for every venture with an active persona and assignment. Suspended personas
                  stay suspended and the daily spend caps still apply.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep paused</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => {
                    onConfirm(true);
                  }}
                >
                  Resume AI coaching
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </SectionCard>
  );
}
