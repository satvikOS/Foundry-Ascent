import { Circle, LockKeyhole, MonitorPlay, Trash2, type LucideIcon } from 'lucide-react';

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

interface Fact {
  readonly id: string;
  readonly icon: LucideIcon;
  readonly text: string;
}

/**
 * What a person reads before their first recording: what is recorded, where it is kept, how to delete it. `screen`:
 * the browser can share this tab and asks to once they start (else the call view is recorded). Only this tab is ever
 * recorded, and only while the call is open: minimized, the call view is.
 */
export function recordingFacts(name: string, video: boolean, screen: boolean): readonly Fact[] {
  const picture = video ? `${name}’s AI avatar` : 'the call’s sphere';
  return [
    {
      id: 'what',
      icon: MonitorPlay,
      text: screen
        ? 'This tab is recorded as you see it, with both voices. Minimized, only the call view is. Your browser asks you to share the tab first.'
        : `The call view is recorded: ${picture}, the conversation and both voices.`,
    },
    {
      id: 'where',
      icon: LockKeyhole,
      text: 'It’s kept privately in this conversation and under Recordings. Only you can watch it.',
    },
    {
      id: 'delete',
      icon: Trash2,
      text: 'Delete it there any time. Deleting the conversation deletes it too; otherwise it’s kept for a year.',
    },
  ];
}

interface RecordingNoticeDialogProps {
  open: boolean;
  /** The vEIR's display name ("Thomas"). */
  name: string;
  /** A video call: the face is in the picture. */
  video: boolean;
  /** The browser can share this tab (it asks once they start). */
  screen: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Before a person's first recording (remembered per person): the three facts, then Start recording or Not now. */
export function RecordingNoticeDialog({
  open,
  name,
  video,
  screen,
  onConfirm,
  onCancel,
}: RecordingNoticeDialogProps) {
  const facts = recordingFacts(name, video, screen);
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <AlertDialogContent data-slot="recording-notice" className="max-w-[28rem] gap-5 sm:p-7">
        <AlertDialogHeader>
          <AlertDialogTitle className="text-heading">Record this call?</AlertDialogTitle>
          <AlertDialogDescription className="sr-only">
            {facts.map((fact) => fact.text).join(' ')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul aria-label="About recordings" className="grid gap-3.5">
          {facts.map((fact) => (
            <li key={fact.id} data-fact={fact.id} className="flex items-start gap-3 text-small text-pretty">
              <span
                aria-hidden
                className="mt-px grid size-7 shrink-0 place-items-center rounded-full bg-secondary text-foreground"
              >
                <fact.icon className="size-3.5" />
              </span>
              <span className="pt-1 text-muted-foreground">{fact.text}</span>
            </li>
          ))}
        </ul>
        <AlertDialogFooter className="pt-1">
          <AlertDialogCancel>Not now</AlertDialogCancel>
          <AlertDialogAction
            onClick={(event) => {
              event.preventDefault();
              onConfirm();
            }}
          >
            <Circle aria-hidden className="fill-current text-destructive" />
            Start recording
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
