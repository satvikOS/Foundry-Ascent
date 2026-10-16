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

interface FeatureSwitchesProps {
  callsEnabled: boolean;
  streamingEnabled: boolean;
  /** Sends one switch change; the switches always show the server's value. */
  onChange: (patch: Pick<UpdateSettingsInput, 'callsEnabled' | 'streamingEnabled'>) => void;
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

/**
 * Kill switches narrower than the AI switch: voice calls (new calls refused, live calls end at their next
 * heartbeat) and streamed replies (off: replies appear whole, once validated). Both apply platform-wide.
 */
export function FeatureSwitches({
  callsEnabled,
  streamingEnabled,
  onChange,
  pending = false,
  error,
}: FeatureSwitchesProps) {
  const [confirmCallsOff, setConfirmCallsOff] = useState(false);
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
    </SectionCard>
  );
}
