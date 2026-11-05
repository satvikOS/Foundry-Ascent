import { useQuery } from '@tanstack/react-query';
import { Info, Phone, Video } from 'lucide-react';
import { lazy, Suspense, useState, type ReactElement, type ReactNode } from 'react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SimpleTooltip } from '@/components/ui/tooltip';

import { CALL_KIND_LABEL, videoAvailability, type CallKind, type VideoAvailability } from './call-kind';
import { CallLink } from './call-link';
import { callsOn } from './calls-available';
import { callConfigQueryOptions, useCallVeir } from './use-call-veir';

/** The disclosure, read from the menu now and then: loaded when first opened (the side panel is in the first load). */
const CallDisclosureDialog = lazy(() =>
  import('./call-disclosure').then((module) => ({ default: module.CallDisclosureDialog })),
);

/** What every Call entry point needs for a venture. */
export interface CallEntry {
  /** The person may call now (they write to the venture, and AI and calls are on): the entries show. */
  readonly callable: boolean;
  /** The vEIR's display name ("Thomas"). */
  readonly name: string;
  /** Whether a video call can start; null while the call settings load. */
  readonly video: VideoAvailability | null;
}

/**
 * The venture's call settings as the Call entries read them (one query, shared with the call screen): whether to show
 * the entries at all, who is called, and whether Video can start or is shown disabled with why.
 */
export function useCallEntry(ventureId: string | null | undefined, writable: boolean): CallEntry {
  const enabled = writable && Boolean(ventureId);
  const config = useQuery({ ...callConfigQueryOptions(ventureId ?? ''), enabled });
  const veir = useCallVeir(enabled ? (ventureId ?? null) : null, config.data?.veir);
  return {
    callable: enabled && callsOn(config.data) && veir !== null,
    name: veir?.name ?? 'your mentor',
    video: enabled ? videoAvailability(config.data) : null,
  };
}

const KIND_ICON = { voice: Phone, video: Video } as const;

/**
 * "Call Thomas" as a choice (the side panel's row): Voice call, Video call (disabled with why when not offered),
 * and the call's disclosure to read. A call from here starts a new conversation and waits on its start screen,
 * where Remember or Private is chosen.
 */
export function CallMenu({
  tenant,
  ventureId,
  name,
  video,
  trigger,
  tooltip,
  onNavigate,
  side = 'right',
  align = 'start',
}: {
  tenant: string;
  ventureId: string;
  name: string;
  video: VideoAvailability | null;
  /** The row that opens the menu (rendered as the menu's trigger). */
  trigger: ReactElement;
  /** A tooltip on the trigger (the side panel's rail, where the row shows its icon only). */
  tooltip?: ReactNode;
  onNavigate?: () => void;
  side?: 'right' | 'bottom' | 'top' | 'left';
  align?: 'start' | 'center' | 'end';
}) {
  const [about, setAbout] = useState(false);
  const target = { tenant, ventureId, sessionId: null };
  const blocked = video?.available === false ? video.reason : null;
  const item = (kind: CallKind) => {
    const Icon = KIND_ICON[kind];
    return (
      <DropdownMenuItem asChild className="min-h-9 pointer-coarse:min-h-11">
        <CallLink {...target} kind={kind} onClick={onNavigate}>
          <Icon aria-hidden />
          {CALL_KIND_LABEL[kind]}
          {kind === 'voice' ? <DropdownMenuShortcut>G V</DropdownMenuShortcut> : null}
        </CallLink>
      </DropdownMenuItem>
    );
  };
  return (
    <>
      <DropdownMenu>
        <SimpleTooltip content={tooltip} side="right" disabled={tooltip === undefined}>
          <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
        </SimpleTooltip>
        <DropdownMenuContent side={side} align={align} className="w-64" aria-label={`Call ${name}`}>
          {item('voice')}
          {blocked ? (
            <DropdownMenuItem disabled className="items-start">
              <Video aria-hidden className="mt-0.5" />
              <span className="grid gap-0.5">
                <span>{CALL_KIND_LABEL.video}</span>
                <span className="text-caption text-muted-foreground">{blocked}</span>
              </span>
            </DropdownMenuItem>
          ) : (
            item('video')
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => {
              setAbout(true);
            }}
          >
            <Info aria-hidden />
            About calls with {name}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {about ? (
        <Suspense fallback={null}>
          <CallDisclosureDialog
            open
            name={name}
            kind={null}
            onCancel={() => {
              setAbout(false);
            }}
          />
        </Suspense>
      ) : null}
    </>
  );
}
