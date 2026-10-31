import type { FaceVendorView } from '@foundry/contracts';
import { useId, useState, type ReactNode } from 'react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { SectionCard } from '@/components/ui/section-card';
import { Switch } from '@/components/ui/switch';
import type { UpdateSettingsInput } from '@/lib/api/hooks/admin';

import { MutationErrorAlert } from '../shared/form';

export type FeatureSwitchPatch = Pick<
  UpdateSettingsInput,
  'callsEnabled' | 'streamingEnabled' | 'facesEnabled' | 'clonedVoiceEnabled'
>;

interface FeatureSwitchesProps {
  callsEnabled: boolean;
  streamingEnabled: boolean;
  /** The vEIR's video face on calls (off by default). */
  facesEnabled: boolean;
  /** The EIRs' cloned voices on calls (off by default). */
  clonedVoiceEnabled: boolean;
  /** The face this deployment wired: its mode, price and audience (null: none). */
  faceVendor?: FaceVendorView | null;
  /** Sends one switch change; the switches always show the server's value. */
  onChange: (patch: FeatureSwitchPatch) => void;
  pending?: boolean;
  error?: unknown;
}

function SwitchRow({
  label,
  description,
  checked,
  disabled,
  onCheckedChange,
}: {
  label: string;
  description: ReactNode;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (next: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4 py-3.5 first:pt-0 last:pb-0">
      <div className="grid gap-0.5">
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        <p id={`${id}-description`} className="text-small text-muted-foreground">
          {description}
        </p>
      </div>
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        aria-describedby={`${id}-description`}
        onCheckedChange={onCheckedChange}
        className="mt-0.5"
      />
    </div>
  );
}

/** The face's price per minute, as the settings say it ("$0.19/min"; the sandbox is free). */
export function facePrice(vendor: Pick<FaceVendorView, 'usdPerMinute' | 'sandbox'>): string {
  if (vendor.sandbox) return 'free sandbox';
  return `$${vendor.usdPerMinute.toFixed(2)}/min`;
}

/** What the wired face is: its mode, who sees it and its price, in a line. */
export function faceSummary(vendor: FaceVendorView): string {
  const what = vendor.mode === 'full' ? 'Stock AI avatar' : 'EIR’s face';
  const who = vendor.audience === 'admins' ? 'admins only' : 'everyone';
  return `${what} · ${who} · ${facePrice(vendor)}`;
}

/** What turning on the face or the cloned voice means, said before it happens (they cost money per use). */
const TURN_ON: Record<
  'facesEnabled' | 'clonedVoiceEnabled',
  { title: string; description: string; action: string }
> = {
  facesEnabled: {
    title: 'Turn on video faces?',
    description: 'Faces show where ready. About $0.09 a minute, within the video limits.',
    action: 'Turn on faces',
  },
  clonedVoiceEnabled: {
    title: 'Turn on cloned voices?',
    description: 'Cloned voices speak where ready. About $0.04 per 1,000 characters.',
    action: 'Turn on voices',
  },
};

/**
 * Kill switches narrower than the AI switch: voice calls (new calls refused, live calls end at their next
 * heartbeat), streamed replies (off: replies appear whole, once validated), the vEIR's video face and the EIRs'
 * cloned voices (off by default; off again stops them on live calls within seconds). All apply platform-wide.
 */
export function FeatureSwitches({
  callsEnabled,
  streamingEnabled,
  facesEnabled,
  clonedVoiceEnabled,
  faceVendor = null,
  onChange,
  pending = false,
  error,
}: FeatureSwitchesProps) {
  const [confirmCallsOff, setConfirmCallsOff] = useState(false);
  const [confirmOn, setConfirmOn] = useState<'facesEnabled' | 'clonedVoiceEnabled' | null>(null);
  const turnOn =
    confirmOn === null
      ? null
      : confirmOn === 'facesEnabled' && faceVendor !== null
        ? {
            ...TURN_ON.facesEnabled,
            description: faceSummary(faceVendor),
          }
        : TURN_ON[confirmOn];
  return (
    <SectionCard title="Calls and streaming">
      <div className="grid gap-4">
        <div className="divide-y divide-border">
          <SwitchRow
            label="Voice calls"
            description={callsEnabled ? 'Founders can call their vEIR.' : 'Calls are off. Chat still works.'}
            checked={callsEnabled}
            disabled={pending}
            onCheckedChange={(next) => {
              if (next) onChange({ callsEnabled: true });
              else setConfirmCallsOff(true);
            }}
          />
          <SwitchRow
            label="Streamed replies"
            description={
              streamingEnabled
                ? 'Replies appear sentence by sentence as each passes validation.'
                : 'Replies appear whole, once validated.'
            }
            checked={streamingEnabled}
            disabled={pending}
            onCheckedChange={(next) => {
              onChange({ streamingEnabled: next });
            }}
          />
          <SwitchRow
            label="Video faces"
            description={
              faceVendor === null
                ? facesEnabled
                  ? 'On where a face is ready.'
                  : 'Off.'
                : `${facesEnabled ? 'On' : 'Off'} · ${faceSummary(faceVendor)}`
            }
            checked={facesEnabled}
            disabled={pending}
            onCheckedChange={(next) => {
              if (next) setConfirmOn('facesEnabled');
              else onChange({ facesEnabled: false });
            }}
          />
          <SwitchRow
            label="Cloned voices"
            description={clonedVoiceEnabled ? 'On where a voice is ready.' : 'Off.'}
            checked={clonedVoiceEnabled}
            disabled={pending}
            onCheckedChange={(next) => {
              if (next) setConfirmOn('clonedVoiceEnabled');
              else onChange({ clonedVoiceEnabled: false });
            }}
          />
        </div>
        <MutationErrorAlert error={error} title="The setting wasn’t changed" />
      </div>

      <AlertDialog open={confirmCallsOff} onOpenChange={setConfirmCallsOff}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Turn off voice calls?</AlertDialogTitle>
            <AlertDialogDescription>
              New calls are refused and live calls end within seconds. Chat keeps working.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep calls on</AlertDialogCancel>
            <AlertDialogAction
              destructive
              onClick={() => {
                onChange({ callsEnabled: false });
              }}
            >
              Turn off calls
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={confirmOn !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmOn(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{turnOn?.title ?? ''}</AlertDialogTitle>
            <AlertDialogDescription>{turnOn?.description ?? ''}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Not now</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmOn) onChange({ [confirmOn]: true });
                setConfirmOn(null);
              }}
            >
              {turnOn?.action ?? ''}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SectionCard>
  );
}
