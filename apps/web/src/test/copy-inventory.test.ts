import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  countWords,
  extractCopy,
  inventory,
  screenOf,
  totalsByScreen,
  type CopyKind,
} from './copy-inventory';

/*
 * Fewer words, and they stay fewer. Every screen's visible words (read from the source: JSX text, visible
 * props, toasts, copy properties, sentence literals) are held to the budget in copy-budget.json, recorded
 * after the wave-6 copy pass against the count before it (base 90cebac). Accessible names, screen-reader
 * text and info-button detail are counted apart: shortening the screen never means dropping those.
 *
 * Grew a screen on purpose? Cut elsewhere on it, or raise its budget in copy-budget.json in the same change
 * and say why in the commit. The founder screens' budgets must stay below their "before".
 */

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..');

interface ScreenBudget {
  before: number;
  /** The count when the budget was set (after the wave-6 copy pass). */
  after: number;
  /** Null: another stream owns this screen's copy (the vEIR's identity); it is not held to a budget here. */
  budget: number | null;
}

const BUDGET = JSON.parse(readFileSync(join(here, 'copy-budget.json'), 'utf8')) as {
  founderScreens: string[];
  screens: Record<string, ScreenBudget>;
};

/** Visible words by kind in `source` (a component written for the test). */
function wordsByKind(source: string): Partial<Record<CopyKind, number>> {
  const totals: Partial<Record<CopyKind, number>> = {};
  for (const item of extractCopy(source, 'features/chat/sample.tsx')) {
    totals[item.kind] = (totals[item.kind] ?? 0) + item.words;
  }
  return totals;
}

describe('copy inventory', () => {
  it('counts words, not punctuation or separators', () => {
    expect(countWords('Sources & reasoning · 2 sources')).toBe(4);
    expect(countWords('— · /')).toBe(0);
    expect(countWords('Up to {…} min')).toBe(4);
  });

  it('counts what is shown, and keeps names, screen-reader text and tooltips apart', () => {
    const source = `
      export function Sample({ busy }: { busy: boolean }) {
        return (
          <div className="flex gap-2 text-muted-foreground" aria-label="Hidden name">
            <h1>Knowledge base</h1>
            <button type="button" title="Save it now">Save</button>
            <span className="sr-only">Screen reader only words</span>
            <input placeholder="Search memory" />
            <InfoTip label="memory">Rarely needed detail here</InfoTip>
            <PageHeader title="Documents" info="Files it can cite" />
            {busy ? 'Saving…' : 'Save changes'}
          </div>
        );
      }
      toast.success('Conversation deleted', { description: 'It is gone now' });
      const LABELS = { founder: { label: 'Founder only', description: 'Visible to founders.' } };
      const KEY = 'founder_private';
      const css = cn('px-4 py-2', 'hover:bg-accent');
    `;
    expect(wordsByKind(source)).toEqual({
      text: 3, // Knowledge base, Save
      attribute: 3, // Search memory, Documents
      expression: 3, // Saving…, Save changes
      toast: 6, // Conversation deleted, It is gone now
      property: 5, // Founder only, Visible to founders.
      name: 6, // Hidden name, Screen reader only words
      tooltip: 11, // Save it now, Rarely needed detail here, Files it can cite
    });
  });

  it('never counts class lists, keys, imports or type literals as words', () => {
    const source = `
      import { Button } from '@/components/ui/button';
      type Tone = 'warning' | 'Not a word either';
      const classes = cn('inline-flex h-9 items-center', pressed && 'bg-foreground text-background');
      if (status === 'Waiting for founder') void 0;
      export const X = () => <Button variant="ghost" size="sm" className="rounded-full" data-testid="x" />;
    `;
    expect(extractCopy(source, 'features/chat/sample.tsx')).toEqual([]);
  });

  it('assigns every source file to a screen', () => {
    expect(screenOf('features/chat/new-chat-page.tsx')).toBe('New chat');
    expect(screenOf('features/chat/composer.tsx')).toBe('Conversation');
    expect(screenOf('features/calls/call-live.tsx')).toBe('Call');
    expect(screenOf('features/memory/memory-dialogs.tsx')).toBe('Knowledge');
    expect(screenOf('features/documents/viewer/viewer-dialog.tsx')).toBe('Documents');
    expect(screenOf('routes/index.tsx')).toBe('Landing');
    // The vEIR's identity (name, badge, first-visit welcome, disclosure) is another stream's copy: new files
    // there never land in Shared UI or Other, whose budgets are this pass's.
    for (const file of [
      'lib/veir.ts',
      'components/faces/veir-badge.tsx',
      'components/faces/veir-name.tsx',
      'components/disclosure-banner.tsx',
      'features/veir/veir-welcome.tsx',
      'features/veir/welcome.ts',
    ]) {
      expect(screenOf(file), file).toBe('vEIR identity');
    }
    expect(screenOf('components/faces/persona-avatar.tsx')).toBe('Shared UI');
    expect(screenOf('components/ui/popover.tsx')).toBe('Shared UI');
    const unassigned = inventory(src).filter((item) => screenOf(item.file) === 'Other');
    expect(unassigned.map((item) => item.file).filter((file) => file !== 'main.tsx')).toEqual([]);
  });
});

describe('word budgets', () => {
  const totals = new Map(totalsByScreen(inventory(src)).map((row) => [row.screen, row.visible]));

  it('records a cut on every founder screen (its budget is below what it showed before)', () => {
    for (const screen of BUDGET.founderScreens) {
      const budget = BUDGET.screens[screen];
      expect(budget, `${screen} has a budget`).toBeDefined();
      expect(budget?.budget ?? Infinity, `${screen}: budget below before`).toBeLessThan(budget?.before ?? 0);
    }
  });

  it('keeps every screen within its budget', () => {
    const over = [...totals].flatMap(([screen, words]) => {
      const budget = BUDGET.screens[screen]?.budget;
      if (budget === null) return [];
      return budget === undefined || words > budget
        ? [`${screen}: ${words} words (budget ${budget ?? 'none'})`]
        : [];
    });
    expect(over).toEqual([]);
  });

  it('holds every screen but the vEIR identity to a budget, and has none for a screen that is gone', () => {
    for (const [screen, budget] of Object.entries(BUDGET.screens)) {
      expect(budget.budget === null, `${screen}: unbudgeted`).toBe(screen === 'vEIR identity');
      expect(totals.has(screen), `${screen} still has copy`).toBe(true);
    }
  });

  it('records every budget with room above the count it was set at', () => {
    // A budget equal to the count fails the next word anyone adds (another stream's merge, a new state).
    for (const [screen, budget] of Object.entries(BUDGET.screens)) {
      if (budget.budget === null) continue;
      expect(budget.budget, `${screen}: room above ${budget.after}`).toBeGreaterThan(budget.after);
    }
  });
});

describe('buttons', () => {
  /** Founder-screen buttons longer than two words, each kept on purpose (and why). */
  const LONGER: Record<string, string> = {
    'Ask a person': 'the way to a real person, set apart from the vEIR; also the crisis panel’s action',
    'Switch to chat': 'leaves the call, in the crisis alert too, where it must be unmistakable',
    'Push to talk': 'the name of a talk mode (the dock’s control has the same name)',
    'Hold to talk': 'the gesture the button needs',
    'Listening… release to send': 'the gesture, while the button is held',
  };
  const founder = new Set(BUDGET.founderScreens);
  const buttons = inventory(src).filter(
    (item) =>
      founder.has(screenOf(item.file)) &&
      (item.context === 'Button' || item.context === 'button') &&
      (item.kind === 'text' || item.kind === 'expression'),
  );

  it('keeps founder-screen buttons to one or two words, apart from named exceptions', () => {
    const long = buttons.filter((item) => item.words > 2 && !(item.text in LONGER));
    expect(long.map((item) => `${item.file}:${String(item.line)} ${item.text}`)).toEqual([]);
  });

  it('names no exception that no button uses any more', () => {
    for (const text of Object.keys(LONGER)) {
      expect(
        buttons.some((item) => item.text === text),
        text,
      ).toBe(true);
    }
  });
});
