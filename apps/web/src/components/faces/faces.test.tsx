import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { PersonaAvatar } from './persona-avatar';
import { UserAvatar, VentureMark } from './user-avatar';
import { VeirBadge } from './veir-badge';

describe('PersonaAvatar', () => {
  it('shows the small sphere named after the mentor when there is no portrait, never a letter', () => {
    render(<PersonaAvatar name="Thomas" size="xl" />);
    const face = screen.getByRole('img', { name: 'Thomas' });
    expect(face).toHaveTextContent('');
    expect(face.querySelector('[data-slot="persona-orb"]')).not.toBeNull();
    expect(face.querySelector('img')).toBeNull();
  });

  it('shows the consented portrait and falls back to the sphere if it fails to load', () => {
    render(<PersonaAvatar name="Ruth" portraitUrl="/portraits/ruth.webp" />);
    const face = screen.getByRole('img', { name: 'Ruth' });
    const portrait = face.querySelector('img');
    expect(portrait).not.toBeNull();
    expect(portrait).toHaveAttribute('alt', '');
    if (portrait) fireEvent.error(portrait);
    expect(face.querySelector('img')).toBeNull();
    expect(face.querySelector('[data-slot="persona-orb"]')).not.toBeNull();
    expect(face).toHaveTextContent('');
  });

  it('marks the speaking state and can be decorative', () => {
    const { container } = render(<PersonaAvatar name="Foundry Guide" speaking decorative />);
    expect(screen.queryByRole('img')).toBeNull();
    const face = container.querySelector('[data-slot="persona-avatar"]');
    expect(face).toHaveAttribute('data-speaking', 'true');
    expect(face).toHaveAttribute('aria-hidden', 'true');
    expect(face).toHaveTextContent('');
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

describe('VeirBadge (the studio’s AI marker)', () => {
  it('says AI for every persona, with no vEIR label beside the name', () => {
    const { rerender } = render(<VeirBadge kind="eir_persona" />);
    expect(screen.getByText('AI')).toBeInTheDocument();
    expect(screen.queryByText(/vEIR/)).toBeNull();
    rerender(<VeirBadge kind="neutral_guide" />);
    expect(screen.getByText('AI')).toBeInTheDocument();
  });
});
