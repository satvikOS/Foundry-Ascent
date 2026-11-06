import { VeirWelcomeAcknowledgement, veirIntroductionKey, type Me } from '@foundry/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { api, createIdempotencyKey } from '@/lib/api/client';
import { meQueryOptions } from '@/lib/api/hooks/auth';
import { queryKeys } from '@/lib/api/query-keys';
import { veirWelcome, type VeirDisplay } from '@/lib/veir';

/**
 * What tells one mentor's introduction from another: the persona and how it presents itself. Without a persona id
 * (a placeholder before the mentor is known) only the person's one acknowledgement counts.
 */
type IntroducedVeir = Pick<VeirDisplay, 'presentation'> & { readonly personaId?: string | undefined };

/**
 * The welcome a call's start screen says to someone who has not read it yet (they opened a call first): the
 * coach's own, a vEIR's or the program's neutral guide's, once the coach is known and the person can talk to it.
 */
export function inlineWelcome(
  seen: boolean,
  writable: boolean,
  veir: Pick<VeirDisplay, 'kind' | 'presentation' | 'name' | 'eirFirstName' | 'eirSeesWork'> | null,
): ReturnType<typeof veirWelcome> | null {
  return !seen && writable && veir !== null ? veirWelcome(veir) : null;
}

/**
 * Whether this person has read the introduction of this mentor (`Me.veirWelcomeIntroductions`, migration 0029):
 * once per mentor and presentation, so someone who met "Corin's vEIR" meets Thomas when the persona became him
 * (ADR-0021). With no mentor known there is nothing to introduce. An older API sends no list: then its one
 * acknowledgement counts (absent counts as read, only an explicit null shows the welcome).
 */
export function welcomeSeen(me: Me, veir: IntroducedVeir | null): boolean {
  if (veir === null) return true;
  if (me.veirWelcomeIntroductions === undefined || veir.personaId === undefined) {
    return me.veirWelcomeAcknowledgedAt !== null;
  }
  return me.veirWelcomeIntroductions.includes(veirIntroductionKey(veir.personaId, veir.presentation));
}

/**
 * Whether this person has read the welcome that introduces this mentor, and a way to say they have. The server
 * keeps it with the person, so it shows once in any browser. Acknowledging closes it at once (the cached
 * principal is updated first) and stores it (idempotent); if that fails, the principal is read again, so the
 * welcome may show once more next time.
 */
export function useVeirWelcome(
  signedIn: Me,
  veir: IntroducedVeir | null,
): [seen: boolean, acknowledge: () => void] {
  // The cached principal (read, never fetched here), which acknowledging updates; else the one given.
  const { data } = useQuery({ ...meQueryOptions(), enabled: false });
  const me = data ?? signedIn;
  const client = useQueryClient();
  const seen = welcomeSeen(me, veir);
  const personaId = veir?.personaId ?? null;
  const key = veir === null || personaId === null ? null : veirIntroductionKey(personaId, veir.presentation);

  const acknowledge = useCallback(() => {
    if (seen) return;
    client.setQueryData<Me | null>(queryKeys.me(), (previous) =>
      previous
        ? {
            ...previous,
            veirWelcomeAcknowledgedAt: previous.veirWelcomeAcknowledgedAt ?? new Date().toISOString(),
            ...(previous.veirWelcomeIntroductions === undefined || key === null
              ? {}
              : { veirWelcomeIntroductions: [...previous.veirWelcomeIntroductions, key] }),
          }
        : previous,
    );
    void api
      .post(
        '/me/veir-welcome/acknowledge',
        VeirWelcomeAcknowledgement,
        // Without a persona, every mentor the person meets today counts as introduced.
        personaId === null ? undefined : { personaId },
        { idempotencyKey: createIdempotencyKey() },
      )
      .then(({ acknowledgedAt, introductions }) => {
        client.setQueryData<Me | null>(queryKeys.me(), (previous) =>
          previous
            ? {
                ...previous,
                veirWelcomeAcknowledgedAt: acknowledgedAt,
                ...(introductions === undefined ? {} : { veirWelcomeIntroductions: introductions }),
              }
            : previous,
        );
      })
      .catch(() => {
        void client.invalidateQueries({ queryKey: queryKeys.me() });
      });
  }, [client, seen, personaId, key]);

  return [seen, acknowledge];
}
