import { KeyRound, ShieldAlert } from 'lucide-react';
import { useId, useState } from 'react';

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { CopyButton } from '@/components/ui/copy-button';
import { Label } from '@/components/ui/label';
import type { IssuedAccessCode } from '@/lib/api/hooks/team';
import { formatDate } from '@/lib/format';

interface AccessCodeRevealDialogProps {
  /** The freshly issued code. The dialog is open while this is non-null. */
  issued: IssuedAccessCode | null;
  /**
   * Called once the person confirms they stored the code. The caller MUST drop the code from its
   * state (and reset the mutation) here — it is never shown again.
   */
  onDone: () => void;
  /** Context line under the title, e.g. "Invitation to Northwind Robotics as founder". */
  context?: string;
}

/**
 * One-time reveal of a plaintext access code (admin "issue code", program "invite founder").
 *
 * Security properties:
 *  - the code is rendered only while `issued` is set and is never logged, announced or toasted;
 *  - the dialog cannot be dismissed (Escape / outside click) until the person confirms they stored
 *    it, so a stray key press can't lose an unrecoverable secret;
 *  - the server keeps only a scrypt hash, so the copy says plainly that a lost code means a new code.
 */
export function AccessCodeRevealDialog({ issued, onDone, context }: AccessCodeRevealDialogProps) {
  return (
    <AlertDialog open={issued !== null}>
      {issued ? (
        // Remount per code so the acknowledgement never carries over between codes.
        <RevealContent key={issued.accessCodeId} issued={issued} onDone={onDone} context={context} />
      ) : null}
    </AlertDialog>
  );
}

function RevealContent({
  issued,
  onDone,
  context,
}: {
  issued: IssuedAccessCode;
  onDone: () => void;
  context: string | undefined;
}) {
  const [stored, setStored] = useState(false);
  const ids = { code: useId(), ack: useId(), hint: useId() } as const;
  const name = issued.principal.displayName;

  return (
    <AlertDialogContent
      className="max-w-lg"
      onEscapeKeyDown={(event) => {
        if (!stored) event.preventDefault();
      }}
    >
      <AlertDialogHeader>
        <AlertDialogTitle className="flex items-center gap-2">
          <KeyRound aria-hidden className="size-4" />
          Access code for {name}
        </AlertDialogTitle>
        <AlertDialogDescription>
          {context ? `${context}. ` : null}
          Share it with {name} privately — they use it to sign in.
        </AlertDialogDescription>
      </AlertDialogHeader>

      <Alert variant="warning" icon={ShieldAlert} title="Store it now — it won’t be shown again">
        Foundry Ascent keeps only a one-way hash of this code. If it is lost, revoke it and issue a new one.
        Don’t paste it into shared channels or tickets.
      </Alert>

      <div className="grid gap-2">
        <Label htmlFor={ids.code} className="text-[13px] text-muted-foreground">
          One-time access code
        </Label>
        <div className="flex items-center gap-2 rounded-lg border border-border-strong bg-muted/50 py-2 pr-2 pl-3">
          <output
            id={ids.code}
            aria-describedby={ids.hint}
            data-testid="access-code-value"
            className="min-w-0 flex-1 font-mono text-base font-semibold tracking-wider break-all select-all sm:text-lg"
          >
            {issued.accessCode}
          </output>
          <CopyButton value={issued.accessCode} label="Copy code" showLabel variant="secondary" />
        </div>
        <p id={ids.hint} className="text-[13px] text-muted-foreground">
          {issued.expiresAt ? `Expires ${formatDate(issued.expiresAt)}.` : 'Does not expire.'} Codes are
          case-insensitive; the dashes are optional when typing.
        </p>
      </div>

      <div className="flex items-start gap-2.5 rounded-lg border border-border px-3 py-2.5">
        <Checkbox
          id={ids.ack}
          checked={stored}
          onCheckedChange={(checked) => {
            setStored(checked === true);
          }}
          className="mt-0.5"
        />
        <Label htmlFor={ids.ack} className="leading-5 font-normal">
          I’ve stored this code somewhere safe or handed it over.
        </Label>
      </div>

      <AlertDialogFooter>
        {stored ? null : (
          <p className="self-center text-[13px] text-muted-foreground sm:mr-auto">
            Confirm you’ve stored it to close.
          </p>
        )}
        <Button onClick={onDone} disabled={!stored} className="sm:min-w-24">
          Done
        </Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  );
}
