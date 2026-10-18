import type { Page } from '@playwright/test';

/*
 * Real-model-sized answers from the mock (LAB-U1): the conversation lab's real answers run to four paragraphs and
 * come with three follow-up questions of 15–20 words, where the mock writes one or two short paragraphs and short
 * chips. `feedLongAnswers` lengthens every answer the page receives, through the app's own stream: the mock's turn
 * stream is passed on as it arrives, then the extra paragraphs follow as further validated units (`turn.delta`),
 * one every `unitDelayMs`, before the turn completes with the long answer and the long questions. The session's
 * stored detail (`GET /sessions/:id`) is lengthened the same way, so a refetch shows what the stream showed.
 */

/** Four paragraphs in the lab's shape: the reasoning, an option, the step, the question back. */
export const LONG_PARAGRAPHS: readonly string[] = [
  'Libraries buy on evidence they can show their own committee, so the pilot has to produce a number a head of service can repeat in a budget meeting. Footfall alone will not do it: every library counts visitors already, and a quiet-study product competes with everything else that brings people through the door. What they do not have is a measure of whether students who came to study stayed, came back, and would have gone elsewhere without the space. That is the gap a two-library pilot can fill, and it is the story that turns a trial into a line in next year’s budget.',
  'There are two ways to price it. A flat campus fee is simple to approve and easy to compare with what they pay for databases and software, but it hides the value of each extra branch and invites a discount the moment a second campus joins. Per-branch pricing ties the fee to something a library already budgets for, makes the second branch an obvious expansion, and keeps your first price honest. For a first pilot I would lean per-branch, set at a level a branch manager can sign off without going to committee.',
  'The step that matters this week is to ask each of the two libraries for a small paid commitment before the pilot starts, at the per-branch price you would actually charge. A paid commitment, however small, tells you more than any survey: it shows who holds the budget, how long their sign-off takes, and whether the problem is painful enough to pay for. Write down what each library says, word for word, and note who else they had to ask before they could answer.',
  'Before you send that ask, it helps to know what each library pays today for the workaround you would replace, whether that is extra staff hours in exam season, booking software, or simply turning students away at the door. Once you have that number, the price stops being a guess and becomes a comparison they can make themselves.',
];

/** Three long follow-up chips (16–19 words), the lab's real-model shape. */
export const LONG_FOLLOW_UPS: readonly string[] = [
  'How should we word the paid commitment ask so a branch manager can say yes without going to committee first?',
  'What should we measure during the two-library pilot so the head of service has a number to repeat in budget meetings?',
  'If one library pays and the other asks for a free trial, should we still run both branches as planned?',
];

export interface LongAnswerOptions {
  paragraphs?: readonly string[];
  followUps?: readonly string[];
  /** Pause before each extra unit (the mock streams its own every ~40 ms). */
  unitDelayMs?: number;
}

/** Lengthen every answer this page receives (see the file comment). Call before the page loads the app. */
export async function feedLongAnswers(page: Page, options: LongAnswerOptions = {}): Promise<void> {
  await page.addInitScript(
    ({ paragraphs, followUps, unitDelayMs }) => {
      interface TurnLike {
        id?: string;
        status?: string;
        response?: { answer?: string; follow_up_questions?: string[] } | null;
      }
      const lengthened = new Set<string>();
      const lengthen = (turn: TurnLike | undefined): void => {
        if (!turn?.response || turn.status !== 'completed') return;
        const answer = turn.response.answer ?? '';
        if (!answer.includes(paragraphs[0] ?? '')) {
          turn.response.answer = [answer, ...paragraphs].join('\n\n');
        }
        turn.response.follow_up_questions = [...followUps];
        if (turn.id) lengthened.add(turn.id);
      };
      const frame = (event: string, data: unknown): string =>
        `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      const original = window.fetch.bind(window);
      const encoder = new TextEncoder();
      const sleep = (ms: number) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, ms);
        });

      window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
        const response = await original(input, init);
        const path = new URL(url, window.location.href).pathname;
        if (
          method === 'POST' &&
          /\/sessions\/[0-9a-f-]{36}\/turns$/.test(path) &&
          response.ok &&
          response.body
        ) {
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          const stream = new ReadableStream<Uint8Array>({
            async pull(controller) {
              const { value, done } = await reader.read();
              if (done) {
                if (buffer) controller.enqueue(encoder.encode(buffer));
                controller.close();
                return;
              }
              buffer += decoder.decode(value, { stream: true });
              const parts = buffer.split(/\r?\n\r?\n/);
              buffer = parts.pop() ?? '';
              for (const part of parts) {
                const data = part
                  .split(/\r?\n/)
                  .filter((line) => line.startsWith('data:'))
                  .map((line) => line.slice(5).trimStart())
                  .join('\n');
                let payload: { event?: string; turn?: TurnLike } | null;
                try {
                  payload = data ? (JSON.parse(data) as { event?: string; turn?: TurnLike }) : null;
                } catch {
                  payload = null;
                }
                if (payload?.event !== 'turn.completed' || !payload.turn?.id) {
                  controller.enqueue(encoder.encode(`${part}\n\n`));
                  continue;
                }
                // The extra paragraphs arrive as validated units, then the turn completes with all of them.
                for (const [index, paragraph] of paragraphs.entries()) {
                  await sleep(unitDelayMs);
                  controller.enqueue(
                    encoder.encode(
                      frame('turn.delta', {
                        event: 'turn.delta',
                        turnId: payload.turn.id,
                        seq: 1000 + index,
                        text: `\n\n${paragraph}`,
                      }),
                    ),
                  );
                }
                lengthen(payload.turn);
                controller.enqueue(encoder.encode(frame('turn.completed', payload)));
              }
            },
            cancel(reason) {
              void reader.cancel(reason);
            },
          });
          return new Response(stream, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        }
        if (method === 'GET' && /\/sessions\/[0-9a-f-]{36}$/.test(path) && response.ok) {
          const detail = (await response.clone().json()) as { turns?: TurnLike[] };
          for (const turn of detail.turns ?? []) {
            if (turn.id && lengthened.has(turn.id)) lengthen(turn);
          }
          return new Response(JSON.stringify(detail), {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        }
        return response;
      };
    },
    {
      paragraphs: [...(options.paragraphs ?? LONG_PARAGRAPHS)],
      followUps: [...(options.followUps ?? LONG_FOLLOW_UPS)],
      unitDelayMs: options.unitDelayMs ?? 120,
    },
  );
}
