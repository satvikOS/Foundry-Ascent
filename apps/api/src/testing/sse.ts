/** One parsed SSE frame (tests only; the web client has its own WHATWG-compliant parser). */
export interface SseFrame {
  readonly event: string;
  readonly data: string;
}

export interface ParsedStream {
  readonly frames: SseFrame[];
  /** Comment lines (`: keep-alive`). */
  readonly comments: string[];
}

export function parseSse(text: string): ParsedStream {
  const frames: SseFrame[] = [];
  const comments: string[] = [];
  for (const block of text.split(/\n\n/)) {
    if (block.trim() === '') continue;
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) comments.push(line.slice(1).trim());
      else if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (data.length > 0) frames.push({ event, data: data.join('\n') });
  }
  return { frames, comments };
}
