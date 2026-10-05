import {
  buildEvidenceBlock,
  buildMessages,
  evidenceIdsInBlock,
  type ChatMessage,
  type HistoryTurn,
} from '@foundry/ai';
import { type EvidenceItem } from '@foundry/contracts';

/** Conservative token estimate (≈ 3.6 characters per token for English prose and markup). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.6);
}

export interface AssembledContext {
  readonly messages: ChatMessage[];
  /** Evidence keys actually rendered into the prompt (the only ids the model may cite). */
  readonly shownKeys: ReadonlySet<string>;
  readonly historyTurns: number;
  readonly estimatedInputTokens: number;
}

const EVIDENCE_STEPS = [24_000, 16_000, 10_000, 6_000, 3_000, 0];

/**
 * Fits system prompt + evidence + history + founder message into `maxInputTokens` (system design §7
 * step 4, ≤ 12k). Trims history first (oldest turns), then the evidence total (lowest-ranked items are
 * omitted by `buildEvidenceBlock`), keeping at least the founder message and the system prompt.
 */
export function assembleContext(args: {
  readonly system: string;
  readonly evidence: readonly EvidenceItem[];
  readonly history: readonly HistoryTurn[];
  readonly founderText: string;
  readonly maxInputTokens: number;
  readonly maxHistoryTurns: number;
}): AssembledContext {
  const systemTokens = estimateTokens(args.system);
  let best: AssembledContext | null = null;
  for (const evidenceChars of EVIDENCE_STEPS) {
    const evidenceBlock =
      evidenceChars === 0 && args.evidence.length > 0
        ? buildEvidenceBlock([], {})
        : buildEvidenceBlock(args.evidence, { maxTotalChars: Math.max(1, evidenceChars) });
    for (let turns = Math.min(args.maxHistoryTurns, args.history.length); turns >= 0; turns -= 1) {
      const messages = buildMessages(args.history, args.founderText, {
        evidenceBlock,
        maxHistoryTurns: turns,
      });
      const tokens = systemTokens + messages.reduce((acc, m) => acc + estimateTokens(m.content), 0);
      const candidate: AssembledContext = {
        messages,
        shownKeys: new Set(evidenceIdsInBlock(evidenceBlock)),
        historyTurns: turns,
        estimatedInputTokens: tokens,
      };
      best = candidate;
      if (tokens <= args.maxInputTokens) return candidate;
      // Dropping history is tried before shrinking evidence, but never below 2 turns while evidence is large.
      if (turns <= 2 && evidenceChars > 6_000) break;
    }
  }
  // Nothing fits (enormous founder message): send the smallest variant; the gateway bounds output.
  if (best === null) throw new Error('assembleContext produced no candidate');
  return best;
}
