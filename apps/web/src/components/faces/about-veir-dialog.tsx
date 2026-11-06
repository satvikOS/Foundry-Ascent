import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { veirFacts, type VeirName } from '@/lib/veir';

/**
 * About the mentor: the plain facts, calm and complete (what it is, that a call's face and voice are AI-generated,
 * what is remembered and the Private option, that a person from the program is there, and its limits). Reachable at
 * any time from the right context panel; the transcript itself never carries it.
 */
export function AboutVeirDialog({
  veir,
  open,
  onOpenChange,
}: {
  veir: VeirName;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const facts = veirFacts(veir);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-slot="veir-about" className="max-w-md">
        <DialogHeader>
          <DialogTitle>About {veir.name}</DialogTitle>
          <DialogDescription className="sr-only">
            What {veir.name} is, what is remembered, and who else is there.
          </DialogDescription>
        </DialogHeader>
        <dl className="grid gap-4 text-small">
          {facts.map((fact) => (
            <div key={fact.id} className="grid gap-1">
              <dt className="font-medium text-foreground">{fact.title}</dt>
              <dd className="text-pretty text-muted-foreground">{fact.text}</dd>
            </div>
          ))}
        </dl>
        <DialogFooter>
          <Button
            variant="secondary"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
