import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SelectableRow } from './selectable-row';

/*
 * A master list's open item must read as selected without relying on a near-identical fill: it carries
 * the cue bar (tokens.test.ts measures its contrast in both themes); hover only tints, more faintly, and
 * never draws the bar.
 */

function renderRows() {
  render(
    <ul>
      <li>
        <SelectableRow selected>QuietQuad</SelectableRow>
      </li>
      <li>
        <SelectableRow selected={false}>EmberLoop</SelectableRow>
      </li>
    </ul>,
  );
  return {
    selected: screen.getByRole('button', { name: 'QuietQuad' }),
    other: screen.getByRole('button', { name: 'EmberLoop' }),
  };
}

describe('SelectableRow', () => {
  it('marks the selected row for assistive technology and with the cue bar', () => {
    const { selected, other } = renderRows();
    expect(selected).toHaveAttribute('aria-current', 'true');
    expect(selected).toHaveAttribute('data-selected');
    expect(selected).toHaveClass('bg-accent', 'before:bg-selected-cue', 'before:w-0.5');
    expect(other).not.toHaveAttribute('aria-current');
    expect(other).not.toHaveAttribute('data-selected');
    expect(other).not.toHaveClass('before:bg-selected-cue');
  });

  it('hover only tints the other rows, more faintly than the selected fill', () => {
    const { selected, other } = renderRows();
    expect(other).toHaveClass('hover:bg-accent/50');
    expect(other).not.toHaveClass('bg-accent');
    // The selected row does not change on hover: it already shows its state.
    expect(selected.className).not.toMatch(/hover:bg-/);
  });

  it('is a button that never submits a form, with its focus ring inside the row', () => {
    const { selected } = renderRows();
    expect(selected).toHaveAttribute('type', 'button');
    expect(selected).toHaveClass('focus-visible:-outline-offset-2');
  });
});
