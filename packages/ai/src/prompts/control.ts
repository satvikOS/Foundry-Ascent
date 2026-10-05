import { CoachMode, RiskCategory } from '@foundry/contracts';

/**
 * Machine-readable control block at the top of every system prompt. It tells the model the turn's
 * mode and flags, and lets deterministic components (the mock gateway, evals) read the same
 * settings without re-deriving them. Values are escaped single-line strings.
 */
export interface PromptControl {
  policyVersion: string;
  mode: CoachMode;
  riskFlags: RiskCategory[];
  crisis: boolean;
  rehearsalCounterpart: string | null;
}

const BEGIN = '[control]';
const END = '[/control]';

export function renderControlBlock(control: PromptControl): string {
  return [
    BEGIN,
    `policy_version: ${control.policyVersion}`,
    `mode: ${control.mode}`,
    `risk_flags: ${control.riskFlags.length > 0 ? control.riskFlags.join(',') : 'none'}`,
    `crisis: ${control.crisis ? 'yes' : 'no'}`,
    `rehearsal_counterpart: ${control.rehearsalCounterpart ?? 'none'}`,
    END,
  ].join('\n');
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
  const mode = CoachMode.safeParse(fields.get('mode'));
  if (!mode.success) return null;
  const flags = (fields.get('risk_flags') ?? 'none')
    .split(',')
    .map((f) => f.trim())
    .filter((f) => f !== '' && f !== 'none');
  const riskFlags = flags.flatMap((f) => {
    const parsed = RiskCategory.safeParse(f);
    return parsed.success ? [parsed.data] : [];
  });
  const counterpart = fields.get('rehearsal_counterpart') ?? 'none';
  return {
    policyVersion: fields.get('policy_version') ?? '',
    mode: mode.data,
    riskFlags,
    crisis: fields.get('crisis') === 'yes',
    rehearsalCounterpart: counterpart === 'none' || counterpart === '' ? null : counterpart,
  };
}
