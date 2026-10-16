import type { SessionView } from '@foundry/contracts';
import { EyeOff, History, type LucideIcon } from 'lucide-react';
import { useCallback, useId, useSyncExternalStore } from 'react';

import { cn } from '@/lib/utils';
import { sentenceStart } from '@/features/venture/veir-name';

/** How a new conversation is kept: remembered (the default) or private, a one-off nothing is kept from. */
export type ConversationPrivacy = SessionView['privacy'];

/*
 * The choice made on New chat before a conversation exists, per venture and in memory only. New chat and the
 * call screen opened over it (`?call=1`) read the same choice, so a call started from a private New chat is
 * private too. It is never stored: every fresh New chat starts at Remember.
 */
const choices = new Map<string, ConversationPrivacy>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The privacy the next conversation in this venture starts with (Remember unless Private was chosen). */
export function startPrivacy(ventureId: string): ConversationPrivacy {
  return choices.get(ventureId) ?? 'standard';
}

export function setStartPrivacy(ventureId: string, privacy: ConversationPrivacy): void {
  if (startPrivacy(ventureId) === privacy) return;
  if (privacy === 'standard') choices.delete(ventureId);
  else choices.set(ventureId, privacy);
  for (const listener of listeners) listener();
}

/*
 * A call that starts a new conversation offers the choice before it starts, on the call's own start screen,
 * unless it was started from New chat's Call button, right beside the choice: that call starts at once with it.
 * The mark is set by that button and taken (once) when the call screen opens.
 */
const choiceInView = new Set<string>();

/** New chat's Call button: the founder saw Remember or Private beside it, so the call starts at once. */
export function markChoiceInView(ventureId: string): void {
  choiceInView.add(ventureId);
}

/** Whether the call screen opening now was opened beside the choice (and forgets it: one opening, one mark). */
export function takeChoiceInView(ventureId: string): boolean {
  return choiceInView.delete(ventureId);
}

/** The New chat choice for a venture, shared by New chat and its call screen. */
export function useStartPrivacy(
  ventureId: string,
): [ConversationPrivacy, (privacy: ConversationPrivacy) => void] {
  const privacy = useSyncExternalStore(
    subscribe,
    () => startPrivacy(ventureId),
    () => 'standard' as const,
  );
  const set = useCallback(
    (next: ConversationPrivacy) => {
      setStartPrivacy(ventureId, next);
    },
    [ventureId],
  );
  return [privacy, set];
}

interface Option {
  value: ConversationPrivacy;
  label: string;
  /** The full name, starting with the visible label ("Remember this conversation"). */
  name: (what: string) => string;
  icon: LucideIcon;
}

const OPTIONS: readonly Option[] = [
  { value: 'standard', label: 'Remember', name: (what) => `Remember this ${what}`, icon: History },
  { value: 'ephemeral', label: 'Private', name: () => 'Private, a one-off', icon: EyeOff },
];

/** The one plain sentence under the choice. */
export function privacyExplanation(
  privacy: ConversationPrivacy,
  veirName: string,
  what: 'conversation' | 'call',
): string {
  return privacy === 'ephemeral'
    ? 'A one-off: nothing is remembered, and it’s erased when it ends.'
    : `${sentenceStart(veirName)} will remember this ${what} and pick up from it next time.`;
}

interface PrivacyChoiceProps {
  value: ConversationPrivacy;
  onChange: (privacy: ConversationPrivacy) => void;
  /** The vEIR's full name ("Corin's vEIR"). */
  veirName: string;
  what?: 'conversation' | 'call';
  disabled?: boolean;
  className?: string;
}

/**
 * Remember (the default) or Private, chosen before a conversation or call starts: a small segmented pair of
 * radio buttons (arrow keys move between them) and one plain sentence saying what the choice means.
 */
export function PrivacyChoice({
  value,
  onChange,
  veirName,
  what = 'conversation',
  disabled = false,
  className,
}: PrivacyChoiceProps) {
  const name = useId();
  const described = useId();
  return (
    <fieldset
      aria-describedby={described}
      disabled={disabled}
      className={cn(
        'flex min-w-0 flex-col items-center gap-x-3 gap-y-1.5 sm:flex-row sm:justify-center',
        className,
      )}
    >
      <legend className="sr-only">Memory for this {what}</legend>
      <div className="inline-flex shrink-0 items-center rounded-full border border-border p-0.5">
        {OPTIONS.map((option) => {
          const Icon = option.icon;
          const checked = value === option.value;
          return (
            <label
              key={option.value}
              data-state={checked ? 'checked' : 'unchecked'}
              className={cn(
                'relative inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full px-3 text-small transition-colors duration-150 select-none',
                'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-1 has-[:focus-visible]:outline-ring',
                // The chosen option is a solid pill (well over 3:1 against the page in both themes, WCAG 1.4.11),
                // the other plain text: which one is on never rests on a faint tint.
                checked ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground',
                disabled && 'cursor-not-allowed opacity-50',
              )}
            >
              <input
                type="radio"
                name={name}
                value={option.value}
                aria-label={option.name(what)}
                checked={checked}
                onChange={() => {
                  onChange(option.value);
                }}
                // The whole pill is the radio: it lies over the icon and label, invisible.
                className="absolute inset-0 z-10 m-0 size-full cursor-pointer appearance-none rounded-full opacity-0 disabled:cursor-not-allowed"
              />
              <Icon aria-hidden className="size-3.5" />
              <span aria-hidden>{option.label}</span>
            </label>
          );
        })}
      </div>
      <p id={described} className="text-center text-caption text-pretty text-muted-foreground">
        {privacyExplanation(value, veirName, what)}
      </p>
    </fieldset>
  );
}
