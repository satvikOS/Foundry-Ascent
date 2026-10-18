/**
 * Follow-up questions of the latest answer, as chips just above the composer: one tap sends one. They stay on one
 * line at every width (a real model's questions run to 15–20 words, and wrapped chips grew the composer area to
 * ~290 px, over the answer: LAB-U1): the row scrolls sideways, edge to edge of the column, fading out at its ends.
 * Every chip shows its whole question on that line, never cut short: a tap sends at once, so what the founder can
 * read by scrolling the row is exactly what is sent (and what screen readers hear).
 */
/**
 * A focused chip is read from its start. The browser centres a focused chip in the row, and a chip wider than the
 * row (a long question on a phone) then shows only its middle: once that scroll is done, the row is brought back
 * so the chip's first word sits at the row's padding edge.
 */
function showStart(chip: HTMLElement): void {
  const row = chip.closest('ul');
  if (!row) return;
  const edge = row.getBoundingClientRect().left + (parseFloat(getComputedStyle(row).paddingLeft) || 0);
  const by = chip.getBoundingClientRect().left - edge;
  if (by < -1) row.scrollBy({ left: by, behavior: 'instant' });
}

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
        <li key={question} className="shrink-0">
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              onPick(question);
            }}
            onFocus={(event) => {
              const chip = event.currentTarget;
              requestAnimationFrame(() => {
                showStart(chip);
              });
            }}
            className="block rounded-full whitespace-nowrap border border-border bg-background px-3.5 py-1.5 text-left text-small text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:opacity-50"
          >
            {question}
          </button>
        </li>
      ))}
    </ul>
  );
}
