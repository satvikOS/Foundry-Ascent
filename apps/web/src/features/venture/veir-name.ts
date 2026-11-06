import { useVenture } from '@/lib/api/hooks/ventures';
import { NEUTRAL_MENTOR_NAME, veirDisplay } from '@/lib/veir';

/** Neutral name for the venture's mentor while its persona is loading or when none is assigned. */
export const NEUTRAL_VEIR_NAME = NEUTRAL_MENTOR_NAME;

/**
 * The name of the venture's mentor for page copy and credits ("Files Thomas can cite", "Suggested by Thomas"): the
 * persona's display name (lib/veir naming rule), and "your mentor" until the venture (and its persona) is known.
 */
export function useVeirName(ventureId: string): string {
  const venture = useVenture(ventureId);
  return veirDisplay(venture.data)?.name ?? NEUTRAL_VEIR_NAME;
}

/** Capitalises the first letter, for a name that opens a sentence ("Your mentor …"). */
export function sentenceStart(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
