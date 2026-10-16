import { useVenture } from '@/lib/api/hooks/ventures';
import { veirDisplay } from '@/lib/veir';

/** Neutral name for the venture's vEIR while its persona is loading or when none is assigned. */
export const NEUTRAL_VEIR_NAME = 'your vEIR';

/**
 * The name of the venture's vEIR for page copy and credits ("Files Corin’s vEIR can cite", "Suggested by
 * Corin’s vEIR"): always the name that says it is the AI (lib/veir naming rule), never the EIR's own name, and
 * "your vEIR" until the venture (and its assigned persona) is known.
 */
export function useVeirName(ventureId: string): string {
  const venture = useVenture(ventureId);
  return veirDisplay(venture.data)?.name ?? NEUTRAL_VEIR_NAME;
}

/** Capitalises the first letter, for a name that opens a sentence ("Your vEIR …"). */
export function sentenceStart(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
