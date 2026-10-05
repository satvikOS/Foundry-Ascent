import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Kbd } from '@/components/ui/kbd';
import { formatHotkey } from '@/lib/hooks/use-hotkeys';

import { VENTURE_SECTIONS } from './nav';

export const GLOBAL_SHORTCUTS: { binding: string; label: string }[] = [
  { binding: 'mod+k', label: 'Open the command palette' },
  { binding: '?', label: 'Show keyboard shortcuts' },
  { binding: '[', label: 'Collapse or expand the sidebar' },
  { binding: 'g h', label: 'Go to Home' },
  { binding: 'g v', label: 'Go to Ventures' },
  { binding: 'g e', label: 'Go to EIR studio' },
  { binding: 'g p', label: 'Go to Program' },
  { binding: 'g a', label: 'Go to Admin' },
];

export const VENTURE_SHORTCUTS = VENTURE_SECTIONS.filter((s) => s.shortcut).map((s) => ({
  binding: s.shortcut ?? '',
  label: `Go to ${s.label}`,
}));

function Binding({ binding }: { binding: string }) {
  const chords = formatHotkey(binding);
  return (
    <span className="flex items-center gap-1">
      {chords.map((chord, i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 ? <span className="text-xs text-muted-foreground">then</span> : null}
          {chord.map((key) => (
            <Kbd key={key}>{key}</Kbd>
          ))}
        </span>
      ))}
    </span>
  );
}

function ShortcutList({
  title,
  shortcuts,
}: {
  title: string;
  shortcuts: { binding: string; label: string }[];
}) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</h3>
      <dl className="divide-y divide-border rounded-lg border border-border">
        {shortcuts.map((s) => (
          <div key={s.binding} className="flex items-center justify-between gap-4 px-3 py-2 text-sm">
            <dt>{s.label}</dt>
            <dd>
              <Binding binding={s.binding} />
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Single-key shortcuts are paused while you type in a field. Everything is also reachable with Tab.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-5">
          <ShortcutList title="Everywhere" shortcuts={GLOBAL_SHORTCUTS} />
          <ShortcutList title="Inside a venture" shortcuts={VENTURE_SHORTCUTS} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
