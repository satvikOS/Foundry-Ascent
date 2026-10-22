import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { PersonaAvatar } from './persona-avatar';
import { UserAvatar, VentureMark } from './user-avatar';
import { VeirBadge } from './veir-badge';

describe('PersonaAvatar', () => {
  it('shows a serif monogram named after the vEIR when there is no portrait', () => {
    render(<PersonaAvatar name="Corin" size="xl" />);
    const face = screen.getByRole('img', { name: 'Corin' });
    expect(face).toHaveTextContent('C');
    expect(face.querySelector('img')).toBeNull();
  });

  it('shows the consented portrait and falls back to the monogram if it fails to load', () => {
    render(<PersonaAvatar name="Ruth" portraitUrl="/portraits/ruth.webp" />);
    const face = screen.getByRole('img', { name: 'Ruth' });
    const portrait = face.querySelector('img');
    expect(portrait).not.toBeNull();
    expect(portrait).toHaveAttribute('alt', '');
    if (portrait) fireEvent.error(portrait);
    expect(face.querySelector('img')).toBeNull();
    expect(face).toHaveTextContent('R');
  });

  it('marks the speaking state and can be decorative', () => {
    const { container } = render(<PersonaAvatar name="Foundry Guide" speaking decorative />);
    expect(screen.queryByRole('img')).toBeNull();
    const face = container.querySelector('[data-slot="persona-avatar"]');
    expect(face).toHaveAttribute('data-speaking', 'true');
    expect(face).toHaveAttribute('aria-hidden', 'true');
    expect(face).toHaveTextContent('FG');
  });
});

describe('UserAvatar and VentureMark', () => {
  it('render initials only, drawn rather than written (never part of a control’s visible label)', () => {
    render(
      <>
        <UserAvatar name="Maya Okafor-Lindqvist" />
        <VentureMark name="QuietQuad" decorative={false} />
      </>,
    );
    const person = screen.getByRole('img', { name: 'Maya Okafor-Lindqvist' });
    const venture = screen.getByRole('img', { name: 'QuietQuad' });
    expect(person).toHaveAttribute('data-initials', 'MO');
    expect(venture).toHaveAttribute('data-initials', 'Q');
    expect(person).toBeEmptyDOMElement();
    expect(venture).toBeEmptyDOMElement();
  });
});

describe('VeirBadge', () => {
  it('says vEIR and AI for an EIR persona, AI for the neutral guide', () => {
    const { rerender } = render(<VeirBadge kind="eir_persona" />);
    // The brand keeps its casing: never "VEIR".
    expect(screen.getByText('vEIR · AI')).not.toHaveClass('uppercase');
    rerender(<VeirBadge kind="neutral_guide" />);
    expect(screen.getByText('AI')).toBeInTheDocument();
  });
});
