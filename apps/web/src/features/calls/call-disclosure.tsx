import type { SessionView } from '@foundry/contracts';
import { AudioLines, Ban, History, LifeBuoy, Phone, Sparkles, Video, type LucideIcon } from 'lucide-react';

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

import type { CallKind } from './call-kind';

type SessionPrivacy = SessionView['privacy'];

/** What is kept of the call's sound, by its conversation's privacy. */
const AUDIO_KEPT: Record<SessionPrivacy | 'unknown', string> = {
  standard: 'No audio is kept unless you record the call; the transcript is saved here like chat.',
  ephemeral: 'This call is private: no audio is kept and it can’t be recorded.',
  unknown:
    'No audio is kept unless you record the call (a private call can’t be recorded); the transcript is saved here like chat.',
};

interface Fact {
  readonly id: string;
  readonly icon: LucideIcon;
  readonly text: string;
}

/**
 * The facts a person reads before their first call of a kind (and may re-read from the call settings): who they
 * are talking to, what is synthetic, what happens to their voice and what is remembered, that a person is there,
 * and what the mentor will not do. Said once here, calmly, instead of on every message; the call tile keeps its
 * "AI avatar" and "AI voice" labels. `kind` null: both kinds (re-reading from the settings). `privacy`: the call's
 * conversation, when known (a private one keeps no audio and cannot be recorded; null: not chosen yet, or any call).
 */
export function disclosureFacts(
  name: string,
  kind: CallKind | null,
  privacy: SessionPrivacy | null = null,
): readonly Fact[] {
  const synthetic =
    kind === 'voice'
      ? 'The voice you hear is AI-generated.'
      : kind === 'video'
        ? 'On video, the face you see is an AI avatar, and the voice is AI-generated.'
        : 'The voice you hear is AI-generated. On video, the face you see is an AI avatar.';
  return [
    { id: 'ai', icon: Sparkles, text: `${name} is an AI mentor, not a person. ${synthetic}` },
    {
      id: 'voice',
      icon: AudioLines,
      text: `Your voice is turned into text as you speak (Amazon Transcribe). ${AUDIO_KEPT[privacy ?? 'unknown']}`,
    },
    {
      id: 'memory',
      icon: History,
      text: 'What you talk about is remembered for next time. Choose Private before a call to keep nothing from it.',
    },
    {
      id: 'person',
      icon: LifeBuoy,
      text: 'A person from the program is there whenever you want one: ask in Human help.',
    },
    {
      id: 'limits',
      icon: Ban,
      text: `${name} can’t pass on messages or schedule anything, and doesn’t give legal, medical or financial advice.`,
    },
  ];
}

interface CallDisclosureDialogProps {
  open: boolean;
  /** The vEIR's display name ("Thomas"), from the persona. */
  name: string;
  /** The call about to start; null when re-read from the call settings (no call starts). */
  kind: CallKind | null;
  /** The call's conversation (private or remembered), when known. */
  privacy?: SessionPrivacy | null;
  /** Start call (the first call of this kind): stores that it was read, then the call starts. */
  onConfirm?: () => void;
  /** Cancel or Close (Escape too). */
  onCancel: () => void;
  /** What Start says when the call is already live (turning video on); default "Start call". */
  confirmLabel?: string;
}

/**
 * A clear, calm disclosure before the first voice or video call (owner, 2026-11-05): the facts in five short
 * lines, then Start call or Cancel. Remembered per person (call-kind.ts); the call settings open it again to read.
 */
export function CallDisclosureDialog({
  open,
  name,
  kind,
  privacy = null,
  onConfirm,
  onCancel,
  confirmLabel = 'Start call',
}: CallDisclosureDialogProps) {
  const facts = disclosureFacts(name, kind, privacy);
  const title =
    kind === null
      ? `About calls with ${name}`
      : kind === 'video'
        ? `Before your video call with ${name}`
        : `Before your voice call with ${name}`;
  const StartIcon = kind === 'video' ? Video : Phone;
  const starting = kind !== null && onConfirm !== undefined;
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <AlertDialogContent data-slot="call-disclosure" className="max-w-[28rem] gap-5 sm:p-7">
        <AlertDialogHeader>
          <AlertDialogTitle className="text-heading">{title}</AlertDialogTitle>
          <AlertDialogDescription className="sr-only">
            {facts.map((fact) => fact.text).join(' ')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul aria-label="What to know" className="grid gap-3.5">
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
          {starting ? (
            <>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={(event) => {
                  // The parent closes the dialog as the call starts.
                  event.preventDefault();
                  onConfirm();
                }}
              >
                <StartIcon aria-hidden />
                {confirmLabel}
              </AlertDialogAction>
            </>
          ) : (
            <AlertDialogCancel>Close</AlertDialogCancel>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
