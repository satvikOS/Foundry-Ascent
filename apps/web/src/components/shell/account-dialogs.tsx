import { DEFAULT_DISCLOSURE, type Me } from '@foundry/contracts';
import { useRouterState } from '@tanstack/react-router';
import { useId, useMemo, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useHealth } from '@/lib/api/hooks/health';

import { shortVersion } from './account-menu';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-1.5">
      <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
      <div className="text-small text-muted-foreground [&_p]:leading-relaxed">{children}</div>
    </section>
  );
}

/** What the product keeps, who can see it, and the AI disclosure, in plain language. */
export function DataUseDialog({
  me,
  open,
  onOpenChange,
}: {
  me: Me;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const disclosure = me.disclosure.trim() || DEFAULT_DISCLOSURE;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Data use &amp; privacy</DialogTitle>
          <DialogDescription className="sr-only">
            How your conversations and venture data are used.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-5">
          <Section title="You’re talking to an AI">
            <p>{disclosure}</p>
          </Section>
          <Section title="What is remembered">
            <p>
              What your vEIR learns in conversations and calls goes into Knowledge on its own, with its notes
              and summaries, so it picks up where you left off. Your team can see, edit and forget any of it.
            </p>
            <p className="mt-2">
              Private chats are never remembered. They are erased when they end, or after 24 hours idle.
            </p>
          </Section>
          <Section title="Who can see your venture">
            <p>
              Your team sees conversations, memory and documents. Advisors see only the memory and documents
              shared with them. Your EIR reads your vEIR’s notes and a sample of answers. Program staff see
              totals. Nothing else is shared unless you approve a help request.
            </p>
          </Section>
        </div>
        <DialogFooter>
          <Button
            variant="secondary"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function browserSummary(): string {
  if (typeof navigator === 'undefined') return 'unknown';
  const ua = navigator.userAgent;
  const browser =
    /Edg\/(\d+)/.exec(ua)?.[0] ??
    /Chrome\/(\d+)/.exec(ua)?.[0] ??
    /Firefox\/(\d+)/.exec(ua)?.[0] ??
    /Version\/(\d+).*Safari/.exec(ua)?.[0]?.replace(/ .*Safari/, ' Safari') ??
    'browser';
  const platform = /Mac|iPhone|iPad/.test(ua)
    ? 'Apple'
    : ua.includes('Windows')
      ? 'Windows'
      : ua.includes('Android')
        ? 'Android'
        : ua.includes('Linux')
          ? 'Linux'
          : 'other';
  return `${browser} on ${platform}`;
}

/**
 * Report a problem with the app: the person describes it and copies a short report (page, time,
 * version, browser) to send to their program team. The report never includes conversation, memory
 * or document content, and nothing is sent or logged by the app.
 */
export function ReportProblemDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const fieldId = useId();
  const [description, setDescription] = useState('');
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const health = useHealth({ enabled: open });
  const openedAt = useMemo(() => (open ? new Date().toISOString() : ''), [open]);

  const details = [
    `Page: ${pathname}`,
    `Time: ${openedAt}`,
    `Version: ${health.data ? shortVersion(health.data.version) : 'unknown'}`,
    `Browser: ${browserSummary()}`,
  ];
  const report = [description.trim() ? `What happened: ${description.trim()}` : null, ...details]
    .filter(Boolean)
    .join('\n');

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setDescription('');
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Report a problem</DialogTitle>
          <DialogDescription>
            Copy it to your program team. It never includes your conversations or documents.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor={fieldId}>What happened?</Label>
            <Textarea
              id={fieldId}
              value={description}
              maxLength={1000}
              minRows={3}
              maxRows={8}
              placeholder="What you did, expected and saw"
              onChange={(event) => {
                setDescription(event.target.value);
              }}
            />
          </div>
          <dl className="grid gap-1 rounded-lg border border-border bg-muted/50 px-3 py-2.5 font-mono text-caption text-muted-foreground">
            {details.map((line) => {
              const [label, ...rest] = line.split(': ');
              return (
                <div key={label} className="flex gap-2">
                  <dt className="w-16 shrink-0">{label}</dt>
                  <dd className="min-w-0 break-all text-foreground">{rest.join(': ')}</dd>
                </div>
              );
            })}
          </dl>
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Close
          </Button>
          <CopyButton value={report} label="Copy report" showLabel variant="default" size="default" />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
