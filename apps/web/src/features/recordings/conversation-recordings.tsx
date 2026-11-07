import { useState } from 'react';

import { useRecordings } from '@/lib/api/hooks/recordings';

import { RecordingsList } from './recordings-list';

/**
 * The recordings the person made of this conversation's calls, at the end of its transcript (nothing when there are
 * none, and never for a private conversation, which is never recorded). Only the person who recorded them sees them.
 */
export function ConversationRecordings({
  sessionId,
  privacy,
}: {
  sessionId: string;
  privacy: 'standard' | 'ephemeral';
}) {
  const recordings = useRecordings({ sessionId }, { enabled: privacy === 'standard' });
  const [playing, setPlaying] = useState<string | null>(null);
  const items = recordings.data?.items ?? [];
  if (privacy !== 'standard' || items.length === 0) return null;
  return (
    <section
      aria-labelledby={`recordings-${sessionId}`}
      data-slot="conversation-recordings"
      className="grid gap-1"
    >
      <h2 id={`recordings-${sessionId}`} className="text-small font-medium text-muted-foreground">
        Recordings
      </h2>
      <RecordingsList
        items={items}
        playing={playing}
        onPlay={setPlaying}
        label="Recordings of this conversation"
      />
    </section>
  );
}
