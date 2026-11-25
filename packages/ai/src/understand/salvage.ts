import {
  UNDERSTAND_SCHEMAS,
  type JudgeReading,
  type RouteReading,
  type SumsReading,
  type UnderstandPart,
} from './schema.js';

/** `…","w":…` inside a string: the rest of the object was written into it. */
const SWALLOWED = /"\s*,\s*"[a-z]"\s*:/u;
/** What a cut-off object may end with. */
const ENDINGS = ['', '}', '"}', ']}', '"]}', '}]}', '"}]}'] as const;

/** An answer with the fields one of its strings swallowed put back; as it is when none did. */
export function salvaged(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw;
  const given = raw as Readonly<Record<string, unknown>>;
  for (const [key, written] of Object.entries(given)) {
    if (typeof written !== 'string') continue;
    const value = written.replace(/\\"/gu, '"').replace(/[\n\r\t]/gu, ' ');
    const at = SWALLOWED.exec(value)?.index;
    if (at === undefined) continue;
    const text = `{${JSON.stringify(key)}:"${value.trim()}`;
    for (const end of ENDINGS) {
      try {
        const read: unknown = JSON.parse(text + end);
        if (typeof read === 'object' && read !== null) return { ...given, ...read };
      } catch {
        // Not this ending.
      }
    }
    // Nothing of the rest can be read: the field is what stands before it.
    return { ...given, [key]: value.slice(0, at) };
  }
  return raw;
}

/** A part's answer as it is used. */
export const readRoute = (raw: unknown): RouteReading => UNDERSTAND_SCHEMAS.route.parse(salvaged(raw));
export const readSums = (raw: unknown): SumsReading => UNDERSTAND_SCHEMAS.sums.parse(salvaged(raw));
export const readJudge = (raw: unknown): JudgeReading => UNDERSTAND_SCHEMAS.judge.parse(salvaged(raw));
export const PART_READERS = { route: readRoute, sums: readSums, judge: readJudge } as const satisfies Record<
  UnderstandPart,
  (raw: unknown) => unknown
>;
