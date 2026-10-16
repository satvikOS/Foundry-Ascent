/** Follow-up questions of the latest answer, as chips just above the composer: one tap sends one. */
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
      className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-0.5 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0"
    >
      {questions.map((question) => (
        <li key={question} className="shrink-0 sm:max-w-full sm:shrink">
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              onPick(question);
            }}
            className="rounded-full border border-border bg-background px-3.5 py-1.5 text-left text-small whitespace-nowrap sm:whitespace-normal text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50"
          >
            {question}
          </button>
        </li>
      ))}
    </ul>
  );
}
