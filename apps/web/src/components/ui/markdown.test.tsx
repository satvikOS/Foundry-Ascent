import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Markdown, urlTransform } from './markdown';

describe('Markdown links', () => {
  it('allows only https: and mailto: links (and evidence citations)', () => {
    expect(urlTransform('https://example.org/guide')).toBe('https://example.org/guide');
    expect(urlTransform('mailto:support@example.org')).toBe('mailto:support@example.org');
    expect(urlTransform('evidence:E2')).toBe('evidence:E2');
    for (const unsafe of [
      'http://example.org',
      'javascript:alert(1)',
      'data:text/html,hi',
      '/relative',
      '//x.org',
    ]) {
      expect(urlTransform(unsafe), unsafe).toBe('');
    }
  });

  it('renders unsafe links as plain text and never renders raw HTML', () => {
    render(
      <Markdown>
        {'[safe](https://example.org) [plain](http://example.org) <b>bold</b> [bad](javascript:alert(1))'}
      </Markdown>,
    );
    expect(screen.getByRole('link', { name: /safe/ })).toHaveAttribute('href', 'https://example.org');
    expect(screen.queryByRole('link', { name: /plain/ })).toBeNull();
    expect(screen.getByText('plain')).toBeVisible();
    expect(screen.queryByRole('link', { name: /bad/ })).toBeNull();
    expect(document.querySelector('b')).toBeNull();
  });
});
