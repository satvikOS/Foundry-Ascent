import { ChartBar, Table2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export type VizView = 'chart' | 'table';

/**
 * Chart ⇄ table switch for a chart card. The table is the accessible equivalent of every chart
 * (WCAG 1.1.1), so every chart in the consoles offers one.
 */
export function ViewToggle({
  value,
  onChange,
  label,
}: {
  value: VizView;
  onChange: (next: VizView) => void;
  /** Names what is being toggled, e.g. "Ventures by stage". */
  label: string;
}) {
  return (
    <div role="group" aria-label={`${label}: view as`} className="flex rounded-md border border-border p-0.5">
      {(
        [
          ['chart', 'Chart', ChartBar],
          ['table', 'Table', Table2],
        ] as const
      ).map(([id, text, Icon]) => (
        <Button
          key={id}
          variant="ghost"
          size="xs"
          aria-pressed={value === id}
          className={cn('h-6 px-1.5', value === id && 'bg-accent text-foreground')}
          onClick={() => {
            onChange(id);
          }}
        >
          <Icon aria-hidden className="size-3.5" />
          {text}
        </Button>
      ))}
    </div>
  );
}
