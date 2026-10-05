import { toast } from 'sonner';

import { announce } from '@/components/a11y/live-announcer';
import { Alert } from '@/components/ui/alert';
import { ErrorState } from '@/components/ui/error-state';
import { PageContainer, PageHeader } from '@/components/ui/page-header';
import { LoadingRegion, Skeleton } from '@/components/ui/skeleton';
import { usePlatformSettings, useUpdatePlatformSettings } from '@/lib/api/hooks/admin';

import { AiKillSwitch } from './kill-switch';
import { LimitsCard } from './limits-form';

/** Admin → Settings: global kill switch, spend caps and safety thresholds. */
export function SettingsPage() {
  const settings = usePlatformSettings();
  // Separate mutation instances so the kill switch and the limits form report their own state.
  const killSwitch = useUpdatePlatformSettings();
  const limits = useUpdatePlatformSettings();

  return (
    <PageContainer size="narrow">
      <PageHeader
        title="Settings"
        description="Platform-wide safety controls. Changes apply to every tenant within seconds and are audited."
      />
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
        <div className="grid gap-6">
          {settings.data.aiEnabled ? null : (
            <Alert variant="warning" live="status" title="AI coaching is paused platform-wide">
              Founders can’t start sessions or get answers until you resume it below.
            </Alert>
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
          <LimitsCard
            // Re-initialise the form whenever the saved values change (after a save or a refetch).
            key={JSON.stringify(settings.data)}
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
