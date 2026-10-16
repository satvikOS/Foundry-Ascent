import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Kbd } from '@/components/ui/kbd';
import { formatHotkey } from '@/lib/hooks/use-hotkeys';

import { VENTURE_DESTINATIONS } from './nav';

export const GLOBAL_SHORTCUTS: { binding: string; label: string }[] = [
  { binding: 'mod+k', label: 'Search and jump anywhere' },
  { binding: '?', label: 'Show keyboard shortcuts' },
  { binding: '[', label: 'Collapse or expand the sidebar' },
  { binding: 'g e', label: 'Go to EIR studio' },
  { binding: 'g p', label: 'Go to Program' },
  { binding: 'g a', label: 'Go to Admin' },
];

export const VENTURE_SHORTCUTS: { binding: string; label: string }[] = [
  { binding: 'g n', label: 'New chat' },
  ...VENTURE_DESTINATIONS.map((d) => ({ binding: d.shortcut, label: `Go to ${d.label}` })),
];

export const CONVERSATION_SHORTCUTS: { binding: string; label: string }[] = [
  { binding: '/', label: 'Focus the message box' },
  { binding: 'Enter', label: 'Send the message' },
  { binding: 'shift+Enter', label: 'New line in the message' },
  { binding: 'Esc', label: 'Stop an answer that is being written' },
];

function Binding({ binding }: { binding: string }) {
  const chords = formatHotkey(binding);
  return (
    <span className="flex items-center gap-1">
      {chords.map((chord, i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 ? <span className="text-caption text-muted-foreground">then</span> : null}
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
      <h3 className="label-mono mb-2">{title}</h3>
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
      <DialogContent className="max-h-[85dvh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Single-key shortcuts pause while you type in a field.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-5">
          <ShortcutList title="Everywhere" shortcuts={GLOBAL_SHORTCUTS} />
          <ShortcutList title="In a venture" shortcuts={VENTURE_SHORTCUTS} />
          <ShortcutList title="In a conversation" shortcuts={CONVERSATION_SHORTCUTS} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
