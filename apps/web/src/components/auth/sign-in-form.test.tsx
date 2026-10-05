import type { Me } from '@foundry/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SignInForm, validateAccessCodeField } from './sign-in-form';

const ME: Me = {
  principal: {
    id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    displayName: 'Avery Example',
    title: 'Founder',
    synthetic: true,
  },
  tenant: { id: '6ba7b810-9dad-41d1-80b4-00c04fd430c8', slug: 'ain', name: 'Ain Foundry', kind: 'home' },
  roles: [],
  memberships: [],
  assignedVentureIds: [],
  disclosure: 'You are working with Foundry Guide, an AI coach.',
  aiEnabled: true,
};

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
let fetchMock: ReturnType<typeof vi.fn<FetchFn>>;

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const onSignedIn = vi.fn<(me: Me) => void>();
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={client}>
      <SignInForm onSignedIn={onSignedIn} />
    </QueryClientProvider>,
  );
  const input = screen.getByLabelText('Access code');
  const submit = screen.getByRole('button', { name: /sign in/i });
  return { user, input, submit, onSignedIn };
}

function sentBody(call = 0): unknown {
  const init = fetchMock.mock.calls[call]?.[1];
  return JSON.parse(new TextDecoder().decode(init?.body as Uint8Array)) as unknown;
}

beforeEach(() => {
  fetchMock = vi.fn<FetchFn>();
  vi.stubGlobal('fetch', fetchMock);
});

describe('SignInForm', () => {
  it('requires a code and announces the error on the field', async () => {
    const { user, input, submit } = setup();
    await user.click(submit);
    expect(await screen.findByText('Enter your access code.')).toBeVisible();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveFocus();
    expect(input.getAttribute('aria-describedby')).toContain(
      screen.getByText('Enter your access code.').closest('p')?.id ?? 'missing',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('masks typed input into groups of five and reports incomplete codes', async () => {
    const { user, input, submit } = setup();
    await user.type(input, 'ab cd e fgh');
    expect(input).toHaveValue('ABCDE-FGH');
    expect(screen.getByText('8/20')).toBeInTheDocument();
    await user.click(submit);
    expect(await screen.findByText(/you’ve entered 8/)).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps Crockford look-alikes and drops invalid characters', async () => {
    const { user, input } = setup();
    await user.type(input, 'oilu!');
    expect(input).toHaveValue('011');
  });

  it('accepts a pasted code with prefix, lower case and spaces, then signs in', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(ME), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const { user, input, submit, onSignedIn } = setup();
    await user.click(input);
    await user.paste('  fa-abcde fghjk-mnpqr  stvwx ');
    expect(input).toHaveValue('ABCDE-FGHJK-MNPQR-STVWX');
    expect(screen.getByText('20/20')).toBeInTheDocument();

    await user.click(submit);
    await waitFor(() => {
      expect(onSignedIn).toHaveBeenCalledWith(ME);
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/auth/sign-in');
    expect(sentBody()).toEqual({ accessCode: 'FA-ABCDE-FGHJK-MNPQR-STVWX' });
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get('x-requested-with')).toBe('foundry-ascent');
    expect(headers.get('x-amz-content-sha256')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('shows the server error on the field for an invalid code', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          type: 'about:blank',
          title: 'Invalid access code',
          status: 401,
          code: 'invalid_access_code',
          requestId: 'req-1',
        }),
        { status: 401, headers: { 'content-type': 'application/problem+json' } },
      ),
    );
    const { user, input, submit, onSignedIn } = setup();
    await user.click(input);
    await user.paste('FA-ABCDE-FGHJK-MNPQR-STVWX');
    await user.click(submit);
    expect(await screen.findByText(/That access code isn’t valid/)).toBeVisible();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it('explains lockouts and pauses submission', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          type: 'about:blank',
          title: 'Locked out',
          status: 429,
          code: 'locked_out',
          requestId: 'req-2',
          retryAfterSeconds: 900,
        }),
        { status: 429, headers: { 'content-type': 'application/problem+json' } },
      ),
    );
    const { user, input, submit } = setup();
    await user.click(input);
    await user.paste('FA-ABCDE-FGHJK-MNPQR-STVWX');
    await user.click(submit);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Sign-in paused');
    expect(alert).toHaveTextContent('15 minutes');
    expect(submit).toBeDisabled();
  });
});

describe('validateAccessCodeField', () => {
  it('accepts exactly 20 symbols', () => {
    expect(validateAccessCodeField('ABCDE-FGHJK-MNPQR-STVWX')).toBe(true);
    expect(validateAccessCodeField('')).toMatch(/Enter your access code/);
    expect(validateAccessCodeField('ABCDE')).toMatch(/entered 5/);
  });
});
