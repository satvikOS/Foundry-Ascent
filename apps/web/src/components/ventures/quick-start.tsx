import type { CoachMode, VentureSummary } from '@foundry/contracts';
import { useNavigate } from '@tanstack/react-router';
import { Play } from 'lucide-react';
import { useId, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useStartSession } from '@/lib/api/hooks/sessions';
import { errorMessage } from '@/lib/api/errors';
import { MODE_LABELS } from '@/lib/labels';

const MODES = Object.keys(MODE_LABELS) as CoachMode[];

interface QuickStartProps {
  tenant: string;
  /** Ventures the person can start sessions in (founder/team). */
  ventures: VentureSummary[];
  aiEnabled: boolean;
}

/** "Start a session" form for the home page: pick a venture, a mode and an optional goal. */
export function QuickStart({ tenant, ventures, aiEnabled }: QuickStartProps) {
  const navigate = useNavigate();
  const startSession = useStartSession();
  const [ventureId, setVentureId] = useState(ventures[0]?.id ?? '');
  const [mode, setMode] = useState<CoachMode>('diagnose');
  const [goal, setGoal] = useState('');
  const ids = { venture: useId(), mode: useId(), goal: useId(), modeHint: useId() };

  if (!aiEnabled) {
    return (
      <Alert variant="warning" title="Coaching is paused">
        An administrator has turned off AI coaching. You can still review memory, documents and past sessions.
      </Alert>
    );
  }

  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ventureId) return;
        startSession.mutate(
          { ventureId, input: { mode, goal: goal.trim() || null } },
          {
            onSuccess: (session) =>
              void navigate({
                to: '/$tenant/app/ventures/$ventureId/coach/$sessionId',
                params: { tenant, ventureId, sessionId: session.id },
              }),
          },
        );
      }}
    >
      {ventures.length > 1 ? (
        <div className="grid gap-2">
          <Label htmlFor={ids.venture}>Venture</Label>
          <Select value={ventureId} onValueChange={setVentureId}>
            <SelectTrigger id={ids.venture} className="w-full">
              <SelectValue placeholder="Choose a venture" />
            </SelectTrigger>
            <SelectContent>
              {ventures.map((v) => (
                <SelectItem key={v.id} value={v.id}>
                  {v.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
      <div className="grid gap-2">
        <Label htmlFor={ids.mode}>Mode</Label>
        <Select
          value={mode}
          onValueChange={(value) => {
            setMode(value as CoachMode);
          }}
        >
          <SelectTrigger id={ids.mode} className="w-full" aria-describedby={ids.modeHint}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MODES.map((m) => {
              const Icon = MODE_LABELS[m].icon;
              return (
                <SelectItem key={m} value={m}>
                  <Icon aria-hidden />
                  {MODE_LABELS[m].label}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
        <p id={ids.modeHint} className="text-[13px] text-muted-foreground">
          {MODE_LABELS[mode].description}
        </p>
      </div>
      <div className="grid gap-2">
        <Label htmlFor={ids.goal}>
          Goal <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        <Textarea
          id={ids.goal}
          value={goal}
          onChange={(e) => {
            setGoal(e.target.value);
          }}
          minRows={2}
          maxRows={5}
          maxLength={500}
          placeholder="e.g. Decide whether to run a paid pilot before fundraising"
        />
      </div>
      {startSession.isError ? (
        <Alert variant="destructive" live="alert" title="Couldn’t start a session">
          {errorMessage(startSession.error)}
        </Alert>
      ) : null}
      <Button type="submit" loading={startSession.isPending} loadingText="Starting…" disabled={!ventureId}>
        <Play aria-hidden />
        {ventures.length === 1 ? `Start a session · ${ventures[0]?.name ?? ''}` : 'Start a session'}
      </Button>
    </form>
  );
}
