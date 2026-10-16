import { CoachMode, RiskCategory, TurnChannel } from '@foundry/contracts';

/** The model picks the mode itself, within the allowed modes (no mode sent by the client). */
export const AUTO_MODE = 'auto';
/** A turn's mode as the prompt sees it: a fixed coaching mode, or `auto`. */
export type PromptMode = CoachMode | typeof AUTO_MODE;

/**
 * Machine-readable control block at the top of every system prompt. It tells the model the turn's
 * mode, flags and channel, and lets deterministic components (the mock gateway, evals) read the same
 * settings without re-deriving them. Values are escaped single-line strings.
 */
export interface PromptControl {
  policyVersion: string;
  mode: PromptMode;
  /** The modes the model may choose from in `auto` mode (empty otherwise). */
  allowedModes: CoachMode[];
  riskFlags: RiskCategory[];
  crisis: boolean;
  rehearsalCounterpart: string | null;
  /** How the founder reached the coach this turn: typed chat or a voice call. */
  channel: TurnChannel;
  /** Persona display name ("Foundry Guide", "Corin's vEIR"). */
  persona: string | null;
  /** The founder's first name, when known. */
  founder: string | null;
}

const BEGIN = '[control]';
const END = '[/control]';

/** Makes a value safe for one control line: no line breaks, no brackets, no key separators. */
export function controlValue(value: string, maxChars: number): string {
  const single = value
    .replace(/[[\]:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return single.length > maxChars ? single.slice(0, maxChars).trim() : single;
}

export function renderControlBlock(control: PromptControl): string {
  return [
    BEGIN,
    `policy_version: ${control.policyVersion}`,
    `mode: ${control.mode}`,
    `allowed_modes: ${control.allowedModes.length > 0 ? control.allowedModes.join(',') : 'none'}`,
    `risk_flags: ${control.riskFlags.length > 0 ? control.riskFlags.join(',') : 'none'}`,
    `crisis: ${control.crisis ? 'yes' : 'no'}`,
    `rehearsal_counterpart: ${control.rehearsalCounterpart ?? 'none'}`,
    `channel: ${control.channel}`,
    `persona: ${control.persona ?? 'none'}`,
    `founder: ${control.founder ?? 'none'}`,
    END,
  ].join('\n');
}

function optional(value: string | undefined): string | null {
  return value === undefined || value === '' || value === 'none' ? null : value;
}

function list<T>(
  value: string | undefined,
  schema: { safeParse(v: unknown): { success: boolean; data?: T } },
): T[] {
  return (value ?? 'none')
    .split(',')
    .map((f) => f.trim())
    .filter((f) => f !== '' && f !== 'none')
    .flatMap((f) => {
      const parsed = schema.safeParse(f);
      return parsed.success && parsed.data !== undefined ? [parsed.data] : [];
    });
}

/** Parses the control block from a system prompt; returns null when absent or malformed. */
export function parseControlBlock(system: string): PromptControl | null {
  const start = system.indexOf(BEGIN);
  const end = system.indexOf(END, start + BEGIN.length);
  if (start < 0 || end < 0) return null;
  const fields = new Map<string, string>();
  for (const line of system.slice(start + BEGIN.length, end).split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) fields.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
  }
  const rawMode = fields.get('mode');
  const mode = rawMode === AUTO_MODE ? AUTO_MODE : CoachMode.safeParse(rawMode).data;
  if (mode === undefined) return null;
  const channel = TurnChannel.safeParse(fields.get('channel'));
  return {
    policyVersion: fields.get('policy_version') ?? '',
    mode,
    allowedModes: list<CoachMode>(fields.get('allowed_modes'), CoachMode),
    riskFlags: list<RiskCategory>(fields.get('risk_flags'), RiskCategory),
    crisis: fields.get('crisis') === 'yes',
    rehearsalCounterpart: optional(fields.get('rehearsal_counterpart')),
    channel: channel.success ? channel.data : 'text',
    persona: optional(fields.get('persona')),
    founder: optional(fields.get('founder')),
  };
}
