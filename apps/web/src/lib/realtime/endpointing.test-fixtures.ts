/**
 * Transcript event fixtures for end-of-speech detection: what the microphone and Amazon Transcribe deliver, frame by
 * frame, while a founder says a line, as raw `TranscriptEvent` payloads (parsed by the same `transcriptResults` the
 * call uses). Imported by *.test.ts files only.
 *
 * The timings are modelled on Transcribe streaming with partial-results stabilisation (`high`), as the call engine
 * receives it: a partial update every 250–350 ms while the founder speaks, each about 250 ms behind the voice, the
 * leading words marked stable about a second after they were said; after the voice stops, one more partial within
 * 150–250 ms (the last words, stable), and the final result (punctuated) 500–900 ms after the voice stopped. The
 * founder's voice is the VAD's 50 ms frames. No recording of a person is used: the lines are written for the tests.
 */

/** One Transcribe item: a word or a punctuation mark, with its stability flag. */
interface RawItem {
  readonly Content: string;
  readonly Type: 'pronunciation' | 'punctuation';
  readonly Stable: boolean;
}

/** A `TranscriptEvent` payload as AWS sends it (one result). */
export interface TranscriptPayload {
  readonly Transcript: {
    readonly Results: readonly {
      readonly ResultId: string;
      readonly IsPartial: boolean;
      readonly Alternatives: readonly { readonly Transcript: string; readonly Items: readonly RawItem[] }[];
    }[];
  };
}

export interface EndpointFixture {
  readonly name: string;
  /** What the case is about. */
  readonly about: string;
  /** The founder's voice, as [from, to) spans in ms (the VAD's voiced frames). */
  readonly voice: readonly (readonly [number, number])[];
  /** Transcript events at their arrival time (ms). */
  readonly events: readonly { readonly at: number; readonly payload: TranscriptPayload }[];
  /**
   * When the founder has really finished the line (the end of their last voice span): a turn sent before it cuts
   * them off. Every fixture is one line, however many pauses it has.
   */
  readonly finishedAt: number;
  /** The words the turn must carry, in order (punctuation aside). */
  readonly line: string;
}

/**
 * A result: `text` as Transcribe renders it (punctuation attached to words), the first `stable` words marked stable
 * (all when omitted on a final result).
 */
function result(id: string, text: string, partial: boolean, stable?: number): TranscriptPayload {
  const items: RawItem[] = [];
  let word = 0;
  for (const token of text.split(/\s+/).filter(Boolean)) {
    const match = /^(.*?)([.,?!]*)$/.exec(token);
    const content = match?.[1] ?? token;
    const marks = match?.[2] ?? '';
    const isStable = !partial || word < (stable ?? 0);
    if (content !== '') {
      items.push({ Content: content, Type: 'pronunciation', Stable: isStable });
      word += 1;
    }
    for (const mark of marks) items.push({ Content: mark, Type: 'punctuation', Stable: isStable });
  }
  return {
    Transcript: {
      Results: [{ ResultId: id, IsPartial: partial, Alternatives: [{ Transcript: text, Items: items }] }],
    },
  };
}

const partial = (at: number, id: string, text: string, stable = 0) => ({
  at,
  payload: result(id, text, true, stable),
});
const final = (at: number, id: string, text: string) => ({ at, payload: result(id, text, false) });

export const ENDPOINT_FIXTURES: readonly EndpointFixture[] = [
  {
    name: 'fast_question',
    about: 'a quick question; the last partial carries the question mark',
    voice: [[0, 1400]],
    events: [
      partial(300, 'q1', 'How'),
      partial(600, 'q1', 'How do I', 1),
      partial(900, 'q1', 'How do I price', 2),
      partial(1200, 'q1', 'How do I price the', 3),
      partial(1600, 'q1', 'How do I price the pilot?', 6),
      final(2100, 'q1', 'How do I price the pilot?'),
    ],
    finishedAt: 1400,
    line: 'How do I price the pilot',
  },
  {
    name: 'fast_statement',
    about: 'a finished statement; Transcribe puts the full stop only on the final result',
    voice: [[0, 1800]],
    events: [
      partial(300, 's1', 'We'),
      partial(600, 's1', 'We interviewed', 1),
      partial(900, 's1', 'We interviewed twelve', 1),
      partial(1250, 's1', 'We interviewed twelve clinics', 2),
      partial(1550, 's1', 'We interviewed twelve clinics last', 3),
      partial(2000, 's1', 'We interviewed twelve clinics last week', 6),
      final(2500, 's1', 'We interviewed twelve clinics last week.'),
    ],
    finishedAt: 1800,
    line: 'We interviewed twelve clinics last week',
  },
  {
    name: 'short_answer',
    about: 'a one-word answer to the vEIR’s question',
    voice: [[0, 450]],
    events: [partial(400, 'a1', 'Yes'), partial(650, 'a1', 'Yes.', 1), final(1100, 'a1', 'Yes.')],
    finishedAt: 450,
    line: 'Yes',
  },
  {
    name: 'open_unpunctuated',
    about: 'a finished line with no punctuation and no question word until the final result',
    voice: [[0, 1500]],
    events: [
      partial(300, 'o1', 'The'),
      partial(650, 'o1', 'The clinics', 1),
      partial(1000, 'o1', 'The clinics pay monthly', 2),
      partial(1300, 'o1', 'The clinics pay monthly today', 3),
      partial(1700, 'o1', 'The clinics pay monthly today', 5),
      final(2300, 'o1', 'The clinics pay monthly today.'),
    ],
    finishedAt: 1500,
    line: 'The clinics pay monthly today',
  },
  {
    name: 'slow_speaker_mid_clause',
    about: 'a slow speaker pausing 900 ms mid-clause ("the main thing is …")',
    voice: [
      [0, 1300],
      [2200, 3600],
    ],
    events: [
      partial(300, 'w1', 'So'),
      partial(700, 'w1', 'So the main', 1),
      partial(1100, 'w1', 'So the main thing', 2),
      partial(1500, 'w1', 'So the main thing is', 4),
      partial(2500, 'w1', 'So the main thing is that', 5),
      partial(2900, 'w1', 'So the main thing is that clinics', 5),
      partial(3300, 'w1', "So the main thing is that clinics don't have", 6),
      partial(3800, 'w1', "So the main thing is that clinics don't have budget", 9),
      final(4300, 'w1', "So the main thing is that clinics don't have budget."),
    ],
    finishedAt: 3600,
    line: "So the main thing is that clinics don't have budget",
  },
  {
    name: 'slow_speaker_long_pause',
    about: 'a slow speaker who pauses 1.2 s after a finished sentence and adds to it ("And three said yes.")',
    voice: [
      [0, 1500],
      [2700, 3900],
    ],
    events: [
      partial(300, 'l1', 'We'),
      partial(650, 'l1', 'We talked to', 1),
      partial(1000, 'l1', 'We talked to twelve', 2),
      partial(1300, 'l1', 'We talked to twelve clinics', 3),
      partial(1700, 'l1', 'We talked to twelve clinics.', 5),
      final(2200, 'l1', 'We talked to twelve clinics.'),
      partial(3000, 'l2', 'And'),
      partial(3350, 'l2', 'And three', 1),
      partial(3700, 'l2', 'And three said', 2),
      partial(4100, 'l2', 'And three said yes.', 4),
      final(4600, 'l2', 'And three said yes.'),
    ],
    finishedAt: 3900,
    line: 'We talked to twelve clinics And three said yes',
  },
  {
    name: 'self_correction',
    about: 'a self-correction: "about fifty, I mean …" then a 700 ms pause before the corrected figure',
    voice: [
      [0, 1700],
      [2400, 3500],
    ],
    events: [
      partial(300, 'c1', 'We need'),
      partial(650, 'c1', 'We need about', 1),
      partial(1000, 'c1', 'We need about fifty,', 2),
      partial(1400, 'c1', 'We need about fifty, I', 3),
      partial(1900, 'c1', 'We need about fifty, I mean', 5),
      partial(2700, 'c1', 'We need about fifty, I mean fifteen', 6),
      partial(3100, 'c1', 'We need about fifty, I mean fifteen pilot', 6),
      partial(3700, 'c1', 'We need about fifty, I mean fifteen pilot sites.', 9),
      final(4200, 'c1', 'We need about fifty, I mean fifteen pilot sites.'),
    ],
    finishedAt: 3500,
    line: 'We need about fifty I mean fifteen pilot sites',
  },
  {
    name: 'trailing_um',
    about: 'a trailing "um" and an 800 ms pause before the founder goes on',
    voice: [
      [0, 1900],
      [2700, 3700],
    ],
    events: [
      partial(300, 'u1', 'I think'),
      partial(700, 'u1', 'I think the price', 2),
      partial(1100, 'u1', 'I think the price is too', 3),
      partial(1500, 'u1', 'I think the price is too high,', 4),
      partial(2100, 'u1', 'I think the price is too high, um', 6),
      partial(3000, 'u1', 'I think the price is too high, um for', 7),
      partial(3400, 'u1', 'I think the price is too high, um for small', 7),
      partial(3900, 'u1', 'I think the price is too high, um for small clinics.', 10),
      final(4400, 'u1', 'I think the price is too high, um for small clinics.'),
    ],
    finishedAt: 3700,
    line: 'I think the price is too high um for small clinics',
  },
  {
    name: 'trailing_and',
    about: 'a line that stops on "and" for 650 ms',
    voice: [
      [0, 1500],
      [2150, 3100],
    ],
    events: [
      partial(300, 'n1', 'We built'),
      partial(700, 'n1', 'We built the dashboard', 2),
      partial(1700, 'n1', 'We built the dashboard and', 4),
      partial(2450, 'n1', 'We built the dashboard and the', 5),
      partial(2850, 'n1', 'We built the dashboard and the reporting', 5),
      partial(3300, 'n1', 'We built the dashboard and the reporting tool.', 8),
      final(3800, 'n1', 'We built the dashboard and the reporting tool.'),
    ],
    finishedAt: 3100,
    line: 'We built the dashboard and the reporting tool',
  },
  {
    name: 'lagging_transcript',
    about: 'a noisy line: the transcript stops 600 ms before the voice does (a breath, a chair)',
    voice: [[0, 1700]],
    events: [
      partial(300, 'g1', 'Our'),
      partial(700, 'g1', 'Our churn is', 1),
      partial(1100, 'g1', 'Our churn is eight percent', 3),
      final(2400, 'g1', 'Our churn is eight percent.'),
    ],
    finishedAt: 1700,
    line: 'Our churn is eight percent',
  },
  // The three below follow how production calls cut a founder off on 2026-11-08 (an iPad, half duplex): a pause
  // inside a question that had no question mark yet, inside a greeting, and after "so my".
  {
    name: 'question_opening_pause',
    about:
      'a 1.1 s pause inside a question whose opening already reads as one ("What are the unit … economics")',
    voice: [
      [0, 1300],
      [2400, 3700],
    ],
    events: [
      partial(300, 'p1', 'What'),
      partial(650, 'p1', 'What are the', 1),
      partial(1000, 'p1', 'What are the unit', 2),
      partial(1450, 'p1', 'What are the unit', 4),
      partial(2700, 'p1', 'What are the unit economics', 4),
      partial(3100, 'p1', 'What are the unit economics for', 5),
      partial(3500, 'p1', 'What are the unit economics for this', 6),
      partial(3900, 'p1', 'What are the unit economics for this?', 7),
      final(4400, 'p1', 'What are the unit economics for this?'),
    ],
    finishedAt: 3700,
    line: 'What are the unit economics for this',
  },
  {
    name: 'greeting_then_question',
    about: 'a greeting, then a 1 s pause after the first word of the question ("Hi, Thomas. How … are you?")',
    voice: [
      [0, 1500],
      [2500, 3300],
    ],
    events: [
      partial(300, 'h1', 'Hi'),
      partial(700, 'h1', 'Hi, Thomas.', 1),
      partial(1100, 'h1', 'Hi, Thomas. How', 2),
      partial(1650, 'h1', 'Hi, Thomas. How', 3),
      partial(2800, 'h1', 'Hi, Thomas. How are', 3),
      partial(3150, 'h1', 'Hi, Thomas. How are you', 4),
      partial(3500, 'h1', 'Hi, Thomas. How are you?', 5),
      final(4000, 'h1', 'Hi, Thomas. How are you?'),
    ],
    finishedAt: 3300,
    line: 'Hi Thomas How are you',
  },
  {
    name: 'thinking_after_so_my',
    about: 'a founder who stops to think for 1.6 s after "Yeah, so my"',
    voice: [
      [0, 900],
      [2500, 4200],
    ],
    events: [
      partial(300, 't1', 'Yeah,'),
      partial(700, 't1', 'Yeah, so', 1),
      partial(1050, 't1', 'Yeah, so my', 2),
      partial(1200, 't1', 'Yeah, so my', 3),
      partial(2800, 't1', 'Yeah, so my question', 3),
      partial(3300, 't1', 'Yeah, so my question is about', 4),
      partial(3800, 't1', 'Yeah, so my question is about pricing', 6),
      partial(4400, 't1', 'Yeah, so my question is about pricing.', 7),
      final(4900, 't1', 'Yeah, so my question is about pricing.'),
    ],
    finishedAt: 4200,
    line: 'Yeah so my question is about pricing',
  },
];
