import { useEffect, useRef } from 'react';

/**
 * Keyboard shortcuts. Binding syntax:
 *   'mod+k'  → ⌘K on macOS, Ctrl+K elsewhere      '?' → a single printable key
 *   'g h'    → press g, then h within 1 s           'shift+d', 'alt+n' → modifiers
 * Shortcuts without a modifier are ignored while typing in inputs, textareas, selects and
 * contenteditable regions (WCAG 2.1.4: single-character shortcuts must not hijack typing).
 */
export type HotkeyMap = Record<string, (event: KeyboardEvent) => void>;

const SEQUENCE_TIMEOUT_MS = 1000;

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (target as HTMLInputElement).type;
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color'].includes(type);
  }
  return target.closest('[role="combobox"], [role="textbox"], [cmdk-input]') !== null;
}

interface ParsedChord {
  key: string;
  mod: boolean;
  shift: boolean;
  alt: boolean;
}

function parseChord(chord: string): ParsedChord {
  const parts = chord.split('+');
  const key = (parts.pop() ?? '').toLowerCase();
  return {
    key,
    mod: parts.includes('mod'),
    shift: parts.includes('shift'),
    alt: parts.includes('alt'),
  };
}

function isMacPlatform(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

function chordMatches(chord: ParsedChord, event: KeyboardEvent, mac: boolean): boolean {
  const key = event.key.toLowerCase();
  const modPressed = mac ? event.metaKey : event.ctrlKey;
  if (chord.mod !== modPressed) return false;
  if (chord.alt !== event.altKey) return false;
  // For punctuation like "?" the shift state is implied by the character itself.
  const printable = chord.key.length === 1 && !/[a-z0-9]/.test(chord.key);
  if (!printable && chord.shift !== event.shiftKey) return false;
  if (!chord.mod && (mac ? event.ctrlKey : event.metaKey)) return false;
  return key === chord.key;
}

export function useHotkeys(bindings: HotkeyMap, enabled = true): void {
  const bindingsRef = useRef(bindings);
  useEffect(() => {
    bindingsRef.current = bindings;
  }, [bindings]);

  useEffect(() => {
    if (!enabled) return;
    const mac = isMacPlatform();
    let pending: { key: string; at: number } | null = null;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.repeat) return;
      const typing = isTypingTarget(event.target);
      const entries = Object.entries(bindingsRef.current);
      const now = Date.now();

      for (const [binding, handler] of entries) {
        const steps = binding.split(' ');
        if (steps.length === 2) {
          const [first, second] = steps as [string, string];
          if (typing) continue;
          if (pending && now - pending.at < SEQUENCE_TIMEOUT_MS && pending.key === first) {
            if (chordMatches(parseChord(second), event, mac)) {
              event.preventDefault();
              pending = null;
              handler(event);
              return;
            }
          }
          continue;
        }
        const chord = parseChord(binding);
        if (typing && !chord.mod) continue;
        if (chordMatches(chord, event, mac)) {
          event.preventDefault();
          pending = null;
          handler(event);
          return;
        }
      }

      // Remember a potential sequence prefix (e.g. "g").
      if (!typing && !event.metaKey && !event.ctrlKey && !event.altKey && event.key.length === 1) {
        const key = event.key.toLowerCase();
        const isPrefix = entries.some(([binding]) => binding.split(' ')[0] === key && binding.includes(' '));
        pending = isPrefix ? { key, at: now } : null;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [enabled]);
}

/** Display a binding with platform symbols, e.g. "mod+k" → ["⌘", "K"]. */
export function formatHotkey(binding: string): string[][] {
  const mac = isMacPlatform();
  return binding.split(' ').map((chord) =>
    chord.split('+').map((part) => {
      switch (part) {
        case 'mod':
          return mac ? '⌘' : 'Ctrl';
        case 'shift':
          return mac ? '⇧' : 'Shift';
        case 'alt':
          return mac ? '⌥' : 'Alt';
        default:
          return part.length === 1 ? part.toUpperCase() : part;
      }
    }),
  );
}
