import { useVenture } from '@/lib/api/hooks/ventures';
import { veirDisplay, type VeirDisplay } from '@/lib/veir';

/** Neutral name for the venture's vEIR while its persona is loading or when none is assigned. */
export const NEUTRAL_VEIR_NAME = 'your vEIR';

/**
 * The short name of the venture's vEIR for page copy ("Files Corin can cite"), never a hard-coded
 * persona: "your vEIR" until the venture (and its assigned persona) is known.
 */
export function useVeirName(ventureId: string): string {
  const venture = useVenture(ventureId);
  return veirDisplay(venture.data)?.shortName ?? NEUTRAL_VEIR_NAME;
}

/**
 * Who AI work is credited to ("Suggested by Corin’s vEIR"): the vEIR's full name, which always says it
 * is the AI, so a suggestion or note is never read as the human EIR's. A neutral guide keeps its own
 * name; an EIR persona released without the "…’s vEIR" form gets it.
 */
export function veirAuthor(veir: Pick<VeirDisplay, 'name' | 'shortName' | 'kind'> | null): string {
  if (!veir) return NEUTRAL_VEIR_NAME;
  if (veir.kind === 'neutral_guide' || /\bvEIR$/i.test(veir.name.trim())) return veir.name.trim();
  return `${veir.shortName}’s vEIR`;
}

/** {@link veirAuthor} for the venture's assigned vEIR. */
export function useVeirAuthor(ventureId: string): string {
  const venture = useVenture(ventureId);
  return veirAuthor(veirDisplay(venture.data));
}

/** Capitalises the first letter, for a name that opens a sentence ("Your vEIR …"). */
export function sentenceStart(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
