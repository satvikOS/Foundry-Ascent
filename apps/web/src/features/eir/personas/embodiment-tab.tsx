import { DEFAULT_SPEECH_VOICE_ID, SPEECH_VOICE_IDS, type PersonaView } from '@foundry/contracts';
import { useState } from 'react';

import { announce } from '@/components/a11y/live-announcer';
import { PersonaAvatar } from '@/components/faces/persona-avatar';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/error-state';
import { LoadingRegion, Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { MutationErrorAlert, SelectField } from '@/features/admin/shared/form';
import { usePersonaEmbodiment, useUpdateEmbodiment } from '@/lib/api/hooks/veir-pools';

const PLATFORM_DEFAULT = 'default';

/** The platform default, then every voice the speech service accepts (and a saved one it no longer does). */
function voiceOptions(saved: string | null): { value: string; label: string }[] {
  const offered: readonly string[] = SPEECH_VOICE_IDS;
  return [
    { value: PLATFORM_DEFAULT, label: `Platform default (${DEFAULT_SPEECH_VOICE_ID})` },
    ...offered.map((voice) => ({ value: voice, label: voice })),
    ...(saved !== null && !offered.includes(saved) ? [{ value: saved, label: `${saved} (retired)` }] : []),
  ];
}

/** Voice & face: how the vEIR appears and sounds on calls. A chosen voice needs voice consent. */
export function EmbodimentTab({
  persona,
  shortName,
  onOpenConsent,
}: {
  persona: PersonaView;
  shortName: string;
  onOpenConsent: () => void;
}) {
  const embodiment = usePersonaEmbodiment(persona.id);
  const update = useUpdateEmbodiment(persona.id);
  const [voice, setVoice] = useState<string | null>(null);
  const canEdit = persona.canCurate === true && persona.status !== 'retired';

  if (embodiment.isPending) {
    return (
      <LoadingRegion label="Loading voice and face">
        <Skeleton className="h-48 rounded-xl" />
      </LoadingRegion>
    );
  }
  if (embodiment.isError) {
    return (
      <ErrorState
        error={embodiment.error}
        onRetry={() => void embodiment.refetch()}
        retrying={embodiment.isRefetching}
      />
    );
  }

  const e = embodiment.data;
  const needsConsent = persona.kind === 'eir_persona' && !e.voiceConsented;
  const saved = e.voiceId ?? PLATFORM_DEFAULT;
  const selected = voice ?? saved;

  return (
    <div className="grid max-w-2xl gap-10">
      <section aria-labelledby="face-heading" className="grid gap-4">
        <h2 id="face-heading" className="font-serif text-subheading font-normal">
          Face
        </h2>
        <div className="flex items-center gap-4">
          <PersonaAvatar name={shortName} portraitUrl={e.portraitUrl} size="xl" decorative />
          <p className="text-small text-muted-foreground">
            {e.portraitUrl ? 'Portrait' : 'Monogram'}, shown in chat and inside the built-in call presence.
          </p>
        </div>
      </section>

      <section aria-labelledby="voice-heading" className="grid gap-4">
        <h2 id="voice-heading" className="font-serif text-subheading font-normal">
          Voice
        </h2>
        <SelectField
          label="Voice on calls"
          value={selected}
          onChange={(next) => {
            setVoice(next);
            update.reset();
          }}
          options={voiceOptions(e.voiceId)}
          disabled={!canEdit || needsConsent}
          description={
            needsConsent
              ? `${persona.eirProfile?.displayName ?? 'The EIR'}’s consent doesn’t cover voice, so calls use the platform default.`
              : undefined
          }
          className="max-w-sm"
        />
        {needsConsent && persona.canManageConsent ? (
          <Button variant="secondary" className="w-fit" onClick={onOpenConsent}>
            Update consent
          </Button>
        ) : null}
        <MutationErrorAlert error={update.error} title="Voice not saved" />
        {canEdit && !needsConsent ? (
          <Button
            className="w-fit"
            disabled={selected === saved}
            loading={update.isPending}
            loadingText="Saving…"
            onClick={() => {
              update.mutate(
                { voiceId: selected === PLATFORM_DEFAULT ? null : selected },
                {
                  onSuccess: () => {
                    setVoice(null);
                    toast.success('Voice saved');
                    announce('Voice saved');
                  },
                },
              );
            }}
          >
            Save voice
          </Button>
        ) : null}
      </section>
    </div>
  );
}
