/**
 * Follow-up questions of the latest answer, as chips just above the composer: one tap sends one. They stay on one
 * line at every width (a real model's questions run to 15–20 words, and wrapped chips grew the composer area to
 * ~290 px, over the answer: LAB-U1): the row scrolls sideways, edge to edge of the column, fading out at its ends,
 * and a chip longer than most of the row ends in an ellipsis, so the next one always shows at the edge. The full
 * question is the chip's text (what screen readers hear and what is sent) and its tooltip.
 */
export function FollowUps({
  questions,
  disabled,
  onPick,
}: {
  questions: readonly string[];
  disabled: boolean;
  onPick: (question: string) => void;
}) {
  return (
    <ul
      aria-label="Follow-up questions"
      className="-mx-4 flex gap-2 overflow-x-auto overscroll-x-contain px-4 pb-0.5 [mask-image:linear-gradient(to_right,transparent,black_1rem,black_calc(100%-2rem),transparent)] [scrollbar-width:none] sm:-mx-6 sm:px-6 pointer-fine:[scrollbar-width:thin]"
    >
      {questions.map((question) => (
        <li key={question} className="max-w-[85%] shrink-0">
          <button
            type="button"
            disabled={disabled}
            title={question}
            onClick={() => {
              onPick(question);
            }}
            className="block max-w-full truncate rounded-full border border-border bg-background px-3.5 py-1.5 text-left text-small text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:opacity-50"
          >
            {question}
          </button>
        </li>
      ))}
    </ul>
  );
}
