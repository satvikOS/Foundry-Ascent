import type { PathStepView } from '@foundry/contracts';
import { FileText } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '@/components/ui/dialog';

/** The step's ready-made words: copied in one press, or opened whole. */
export function StepTemplate({ template }: { template: NonNullable<PathStepView['template']> }) {
  return (
    <div
      data-slot="step-template"
      className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-muted/60 py-1.5 pr-1.5 pl-3"
    >
      <FileText aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="text-caption text-muted-foreground">Use this template</p>
        <p className="truncate text-small font-medium">{template.title}</p>
      </div>
      <CopyButton value={template.body} label="Copy template" />
      <Dialog>
        <DialogTrigger asChild>
          <Button variant="ghost" size="sm" aria-label={`Open template: ${template.title}`}>
            Open
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogTitle className="pr-8 text-subheading font-semibold">{template.title}</DialogTitle>
          <DialogDescription className="sr-only">The whole template, ready to copy.</DialogDescription>
          <div
            data-slot="template-body"
            className="max-h-[60dvh] overflow-y-auto rounded-lg border border-border bg-muted/60 p-4 text-small leading-6 whitespace-pre-wrap [overflow-wrap:anywhere]"
            tabIndex={0}
            role="region"
            aria-label={template.title}
          >
            {template.body}
          </div>
          <div className="flex justify-end">
            <CopyButton value={template.body} label="Copy" showLabel variant="default" />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
