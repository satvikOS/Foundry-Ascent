import { Link } from '@tanstack/react-router';

import { cn } from '@/lib/utils';

import type { UploadItem } from '../upload-queue';

/**
 * The name of a file in an upload tray (the composer's attached-file chips): once its upload is done it
 * opens the document in the viewer over the conversation; before that it is plain text.
 */
export function UploadedFileName({ item, className }: { item: UploadItem; className?: string }) {
  const documentId = item.status === 'done' ? (item.resume?.documentId ?? null) : null;
  if (documentId === null) return <span className={className}>{item.file.name}</span>;
  return (
    <Link
      to="."
      search={(previous) => ({ ...previous, doc: documentId, src: undefined, passage: undefined })}
      state={(previous) => ({ ...previous, documentViewer: true })}
      resetScroll={false}
      data-opens-document
      title={`Open ${item.file.name}`}
      className={cn(
        className,
        'rounded-sm underline decoration-transparent underline-offset-[3px] hover:decoration-foreground',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
      )}
    >
      {item.file.name}
    </Link>
  );
}
