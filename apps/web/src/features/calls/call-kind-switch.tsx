import { Video, VideoOff } from 'lucide-react';

import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

import type { CallKind } from './call-kind';

/**
 * Switches the call between voice and video, beside the call settings (top right). From video to voice always (the
 * face is given up for the rest of the call); from voice to video only while this person is offered a face and the
 * call has not had one yet. When it cannot, it stays in place, says why in its tooltip and name, and does nothing.
 */
export function CallKindSwitch({
  kind,
  blockedReason,
  onSwitch,
}: {
  kind: CallKind;
  /** Why switching is not possible now; null when it is. */
  blockedReason: string | null;
  onSwitch: () => void;
}) {
  const toVideo = kind === 'voice';
  const label = toVideo ? 'Switch to video' : 'Switch to voice';
  const tip = blockedReason ?? label;
  const Icon = toVideo ? Video : VideoOff;
  return (
    <SimpleTooltip content={tip} side="bottom">
      <button
        type="button"
        data-slot="call-kind-switch"
        aria-label={blockedReason ? `${label}: ${blockedReason}` : label}
        aria-disabled={blockedReason !== null || undefined}
        onClick={() => {
          if (blockedReason === null) onSwitch();
        }}
        className={cn(
          'fa-call-focus inline-flex size-11 items-center justify-center rounded-full text-muted-foreground transition-colors duration-150 hover:text-foreground',
          blockedReason !== null && 'cursor-not-allowed opacity-45 hover:text-muted-foreground',
        )}
      >
        <Icon aria-hidden className="size-5" />
      </button>
    </SimpleTooltip>
  );
}
