import type { KnowledgeSourceKind, PersonaKnowledgeSourceView } from '@foundry/contracts';
import {
  AudioLines,
  BriefcaseBusiness,
  FileText,
  MessageCircleQuestion,
  NotebookPen,
  type LucideIcon,
} from 'lucide-react';

/** Kinds a person writes in the studio (documents are uploaded instead). */
export const AUTHORED_KINDS = ['note', 'case', 'faq', 'transcript'] as const;
export type AuthoredKind = (typeof AUTHORED_KINDS)[number];

export function isAuthoredKind(kind: KnowledgeSourceKind): kind is AuthoredKind {
  return (AUTHORED_KINDS as readonly string[]).includes(kind);
}

export const SOURCE_KINDS: Record<
  KnowledgeSourceKind,
  { label: string; plural: string; icon: LucideIcon; description: string }
> = {
  note: {
    label: 'Note',
    plural: 'Notes',
    icon: NotebookPen,
    description: 'Guidance in the EIR’s own words.',
  },
  case: {
    label: 'Case',
    plural: 'Cases',
    icon: BriefcaseBusiness,
    description: 'An annotated example from the EIR’s experience.',
  },
  faq: {
    label: 'FAQ',
    plural: 'FAQs',
    icon: MessageCircleQuestion,
    description: 'A question founders ask, with the EIR’s answer.',
  },
  transcript: {
    label: 'Transcript',
    plural: 'Transcripts',
    icon: AudioLines,
    description: 'An excerpt from a consented interview.',
  },
  document: { label: 'Document', plural: 'Documents', icon: FileText, description: 'An uploaded file.' },
};

export const SOURCE_KIND_ORDER: readonly KnowledgeSourceKind[] = [
  'note',
  'case',
  'faq',
  'transcript',
  'document',
];

/** Library counts for the overview: sources in retrieval, still processing, and failed. */
export function librarySummary(sources: readonly PersonaKnowledgeSourceView[]): {
  active: number;
  processing: number;
  failed: number;
} {
  return {
    active: sources.filter((s) => s.status === 'active' || s.status === 'stale').length,
    processing: sources.filter((s) => s.status === 'processing').length,
    failed: sources.filter((s) => s.status === 'failed').length,
  };
}
