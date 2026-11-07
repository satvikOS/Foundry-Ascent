import { Captions, Circle, LockKeyhole, Trash2, type LucideIcon } from 'lucide-react';

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

/** What a person reads before their first recording: what is recorded, where it is kept, how to delete it. */
export function recordingFacts(name: string, video: boolean): readonly Fact[] {
  return [
    {
      id: 'what',
      icon: Captions,
      text: video
        ? `Both voices, ${name}’s AI avatar and the captions are recorded.`
        : `Both voices and the captions are recorded, with the call’s sphere as the picture.`,
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
  onConfirm: () => void;
  onCancel: () => void;
}

/** Before a person's first recording (remembered per person): the three facts, then Start recording or Not now. */
export function RecordingNoticeDialog({
  open,
  name,
  video,
  onConfirm,
  onCancel,
}: RecordingNoticeDialogProps) {
  const facts = recordingFacts(name, video);
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
