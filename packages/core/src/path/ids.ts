import { createHash } from 'node:crypto';

/**
 * The id of a step: a UUID (version 5's shape) of the venture, the play, where it came from and how often the venture
 * already closed that play. The same step is the same id before it is stored and in every conversation, so a reply can
 * name it before anything is written, and two turns that give it at once write one row.
 */
export function stepIdFor(args: {
  readonly ventureId: string;
  readonly playId: string;
  readonly origin: 'path' | 'founder' | 'coach';
  readonly attempt: number;
}): string {
  const digest = createHash('sha256')
    .update(
      `foundry-path-step\n${args.ventureId.toLowerCase()}\n${args.playId}\n${args.origin}\n${String(args.attempt)}`,
    )
    .digest()
    .subarray(0, 16);
  digest.writeUInt8((digest.readUInt8(6) & 0x0f) | 0x50, 6);
  digest.writeUInt8((digest.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = digest.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
