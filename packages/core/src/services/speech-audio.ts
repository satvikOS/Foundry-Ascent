/**
 * The audio of one synthesis as the caller reads it: the same bytes, in order. `onFirstChunk` runs when the
 * first bytes are handed over (the time to first audio); `beforeClose`, when given, is awaited before the
 * stream ends, so bookkeeping started alongside the audio finishes inside the response (a Lambda invocation
 * is not frozen while its response is still open). A cancelled read cancels the source and still waits for
 * the bookkeeping.
 */
export function observedAudio(
  audio: ReadableStream<Uint8Array>,
  hooks: { readonly onFirstChunk?: () => void; readonly beforeClose?: () => Promise<void> },
): ReadableStream<Uint8Array> {
  const reader = audio.getReader();
  let first = true;
  let settled: Promise<void> | null = null;
  const settle = (): Promise<void> => (settled ??= hooks.beforeClose?.() ?? Promise.resolve());
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let next: Awaited<ReturnType<typeof reader.read>>;
      try {
        next = await reader.read();
      } catch (err) {
        await settle();
        controller.error(err);
        return;
      }
      if (next.done) {
        await settle();
        controller.close();
        return;
      }
      if (first) {
        first = false;
        hooks.onFirstChunk?.();
      }
      controller.enqueue(next.value);
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        await settle();
      }
    },
  });
}
