import { Phone, Video } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

import { markChoiceInView } from '../chat/privacy-choice';
import type { VideoAvailability } from './call-kind';
import { CallLink, type CallTarget } from './call-link';

/**
 * The chat header's two call buttons: Voice call (the sphere) and Video call (the vEIR's face). When video is not
 * offered to this person, Video stays in place, quiet, and says why (tooltip, its name, and a short note on tap)
 * instead of disappearing, so the two kinds of call are always where people look for them.
 */
export function CallButtons({
  tenant,
  ventureId,
  sessionId,
  name,
  video,
  choiceInView = false,
  className,
}: CallTarget & {
  name: string;
  video: VideoAvailability | null;
  /** New chat: Remember or Private is in view beside the buttons, so the call starts at once with it. */
  choiceInView?: boolean;
  className?: string;
}) {
  const target = { tenant, ventureId, sessionId };
  const mark = choiceInView
    ? () => {
        markChoiceInView(ventureId);
      }
    : undefined;
  const blocked = video?.available === false ? video.reason : null;
  return (
    <div
      data-slot="call-buttons"
      role="group"
      aria-label="Call"
      className={cn('flex items-center', className)}
    >
      <SimpleTooltip content={`Voice call with ${name}`}>
        <Button
          asChild
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground hover:text-foreground"
        >
          <CallLink {...target} kind="voice" onClick={mark} aria-label={`Voice call with ${name}`}>
            <Phone aria-hidden />
          </CallLink>
        </Button>
      </SimpleTooltip>
      {blocked ? (
        <SimpleTooltip content={blocked}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-disabled
            aria-label={`Video call with ${name}: ${blocked}`}
            onClick={() => {
              toast(blocked);
            }}
            className="cursor-not-allowed text-muted-foreground opacity-45 aria-disabled:pointer-events-auto hover:bg-transparent"
          >
            <Video aria-hidden />
          </Button>
        </SimpleTooltip>
      ) : (
        <SimpleTooltip content={`Video call with ${name}`}>
          <Button
            asChild
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground hover:text-foreground"
          >
            <CallLink {...target} kind="video" onClick={mark} aria-label={`Video call with ${name}`}>
              <Video aria-hidden />
            </CallLink>
          </Button>
        </SimpleTooltip>
      )}
    </div>
  );
}
