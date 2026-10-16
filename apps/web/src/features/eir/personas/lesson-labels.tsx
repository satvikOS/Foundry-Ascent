import type { LessonView } from '@foundry/contracts';
import { Sparkles } from 'lucide-react';

import { Badge } from '@/components/ui/badge';

export type LessonStatus = LessonView['status'];

export const LESSON_STATUS: Record<
  LessonStatus,
  { label: string; variant: 'muted' | 'info' | 'success' | 'outline' }
> = {
  draft: { label: 'Draft', variant: 'info' },
  in_review: { label: 'In review', variant: 'info' },
  published: { label: 'Published', variant: 'success' },
  withdrawn: { label: 'Withdrawn', variant: 'muted' },
};

/** Drafts and lessons in review wait for a curator. */
export function needsReview(lesson: Pick<LessonView, 'status'>): boolean {
  return lesson.status === 'draft' || lesson.status === 'in_review';
}

export function LessonStatusBadge({ status }: { status: LessonStatus }) {
  const def = LESSON_STATUS[status];
  return <Badge variant={def.variant}>{def.label}</Badge>;
}

/** A lesson the distillation job proposed from conversations (de-identified; a person checks it). */
export function DistilledBadge() {
  return (
    <Badge variant="outline">
      <Sparkles aria-hidden />
      Distilled
    </Badge>
  );
}
