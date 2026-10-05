import { EscalationStatus } from '@foundry/contracts';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { STATUS_DEFINITIONS, StatusBadge, type StatusKind } from './status-badge';

const KINDS = Object.keys(STATUS_DEFINITIONS) as StatusKind[];

describe('StatusBadge', () => {
  it.each(
    KINDS.flatMap((kind) =>
      Object.entries(STATUS_DEFINITIONS[kind]).map(([status, def]) => ({ kind, status, def })),
    ),
  )('$kind/$status renders a visible label, an icon and a shape', ({ kind, status, def }) => {
    const { container } = render(<StatusBadge kind={kind} status={status as never} />);
    const badge = container.querySelector('[data-slot="status-badge"]');
    expect(badge).not.toBeNull();

    // 1. Label: always rendered as visible text (never colour or icon alone).
    const label = screen.getByText(def.label);
    expect(label).toBeVisible();
    expect(label).not.toHaveClass('sr-only');

    // 2. Icon: present and decorative (the label carries the meaning).
    const icon = badge?.querySelector('svg[data-slot="status-icon"]');
    expect(icon).not.toBeNull();
    expect(icon).toHaveAttribute('aria-hidden', 'true');

    // 3. Shape: a border style that differs between pending / active / inactive states.
    expect(badge).toHaveAttribute('data-shape', def.shape);
    expect(badge?.className).toMatch(/border-(solid|dashed|dotted)/);
    expect(badge).toHaveAttribute('data-status', status);
  });

  it.each(KINDS)('uses a distinct icon for every %s status', (kind) => {
    const icons = Object.values(STATUS_DEFINITIONS[kind]).map((def) => def.icon);
    expect(new Set(icons).size).toBe(icons.length);
  });

  it.each(KINDS)('uses a distinct label for every %s status', (kind) => {
    const labels = Object.values(STATUS_DEFINITIONS[kind]).map((def) => def.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('pending states use a dashed outline and confirmed states a solid one', () => {
    expect(STATUS_DEFINITIONS.memory.proposed.shape).toBe('dashed');
    expect(STATUS_DEFINITIONS.memory.confirmed.shape).toBe('solid');
    expect(STATUS_DEFINITIONS.document.processing.shape).toBe('dashed');
    expect(STATUS_DEFINITIONS.escalationStatus.awaiting_consent.shape).toBe('dashed');
    expect(STATUS_DEFINITIONS.escalationStatus.awaiting_assignment.shape).toBe('dashed');
  });

  it('defines every escalation status of the contract, and nothing else', () => {
    expect(Object.keys(STATUS_DEFINITIONS.escalationStatus).sort()).toEqual(
      [...EscalationStatus.options].sort(),
    );
    render(<StatusBadge kind="escalationStatus" status="awaiting_assignment" />);
    expect(screen.getByText('Waiting for assignment')).toBeVisible();
  });

  it('P0 is filled with an octagon icon; lower priorities are outlined', () => {
    const { container, rerender } = render(<StatusBadge kind="escalationPriority" status="P0" />);
    expect(screen.getByText('P0 · Critical')).toBeVisible();
    expect(container.firstElementChild).toHaveAttribute('data-shape', 'filled');
    rerender(<StatusBadge kind="escalationPriority" status="P3" />);
    expect(screen.getByText('P3 · Low')).toBeVisible();
    expect(container.firstElementChild).toHaveAttribute('data-shape', 'dashed');
  });

  it('falls back to a humanised label for unknown statuses', () => {
    render(<StatusBadge kind="memory" status={'needs_review' as never} />);
    expect(screen.getByText('Needs review')).toBeVisible();
  });

  it('allows the label to be overridden while keeping icon and shape', () => {
    const { container } = render(<StatusBadge kind="document" status="ready" label="Indexed" />);
    expect(screen.getByText('Indexed')).toBeVisible();
    expect(container.querySelector('svg')).not.toBeNull();
    expect(container.firstElementChild).toHaveAttribute('data-shape', 'solid');
  });
});
