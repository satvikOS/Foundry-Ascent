import { announce } from '@/components/a11y/live-announcer';
import { Alert } from '@/components/ui/alert';
import { ErrorState } from '@/components/ui/error-state';
import { PageContainer, PageHeader } from '@/components/ui/page-header';
import { LoadingRegion, Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { usePlatformSettings, useUpdatePlatformSettings } from '@/lib/api/hooks/admin';

import { FeatureSwitches, type FeatureSwitchPatch } from './feature-switches';
import { AiKillSwitch } from './kill-switch';
import { LimitsCard, toLimitsFormValues } from './limits-form';

/** What a switch change says once saved. */
function switchMessage(patch: FeatureSwitchPatch): string {
  if (patch.callsEnabled !== undefined) return `Voice calls ${patch.callsEnabled ? 'on' : 'off'}`;
  if (patch.facesEnabled !== undefined) return `Video faces ${patch.facesEnabled ? 'on' : 'off'}`;
  if (patch.clonedVoiceEnabled !== undefined)
    return `Cloned voices ${patch.clonedVoiceEnabled ? 'on' : 'off'}`;
  return `Streamed replies ${patch.streamingEnabled ? 'on' : 'off'}`;
}

/** Admin → Settings: the AI kill switch, calls and streaming, spend and call caps, and thresholds. */
export function SettingsPage() {
  const settings = usePlatformSettings();
  // Separate mutation instances so each card reports its own state.
  const killSwitch = useUpdatePlatformSettings();
  const features = useUpdatePlatformSettings();
  const limits = useUpdatePlatformSettings();

  return (
    <PageContainer size="narrow">
      <PageHeader title="Settings" description="Platform-wide controls. Audited." />
      {settings.isPending ? (
        <LoadingRegion label="Loading settings">
          <div className="grid gap-6">
            <Skeleton className="h-48 rounded-xl" />
            <Skeleton className="h-80 rounded-xl" />
          </div>
        </LoadingRegion>
      ) : settings.isError ? (
        <ErrorState
          error={settings.error}
          onRetry={() => void settings.refetch()}
          retrying={settings.isRefetching}
        />
      ) : (
        <div className="grid gap-12">
          {settings.data.aiEnabled ? null : (
            <Alert variant="warning" live="status" title="AI coaching is paused platform-wide" />
          )}
          <AiKillSwitch
            aiEnabled={settings.data.aiEnabled}
            pending={killSwitch.isPending}
            error={killSwitch.error}
            onConfirm={(next) => {
              killSwitch.mutate(
                { aiEnabled: next },
                {
                  onSuccess: () => {
                    const message = next ? 'AI coaching resumed' : 'AI coaching paused for everyone';
                    toast.success(message);
                    announce(message, 'assertive');
                  },
                },
              );
            }}
          />
          <FeatureSwitches
            callsEnabled={settings.data.callsEnabled ?? true}
            streamingEnabled={settings.data.streamingEnabled ?? true}
            facesEnabled={settings.data.facesEnabled ?? false}
            clonedVoiceEnabled={settings.data.clonedVoiceEnabled ?? false}
            pending={features.isPending}
            error={features.error}
            onChange={(patch) => {
              features.mutate(patch, {
                onSuccess: () => {
                  const message = switchMessage(patch);
                  toast.success(message);
                  announce(message, 'assertive');
                },
              });
            }}
          />
          <LimitsCard
            // Re-initialise the form whenever the saved limits change (after a save or a refetch).
            key={JSON.stringify(toLimitsFormValues(settings.data))}
            settings={settings.data}
            pending={limits.isPending}
            error={limits.error}
            onSave={(patch, callbacks) => {
              limits.mutate(patch, callbacks);
            }}
          />
        </div>
      )}
    </PageContainer>
  );
}
