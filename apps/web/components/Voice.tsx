'use client';
// MIRA speaking.
//
// The persona feed substitutes live numbers into its lines, so even with no
// language model attached it says specific things — "I make it 63%. The book
// says 48%." — rather than generic filler. Giving it the top of the rail is a
// deliberate choice: it is the difference between watching an agent and reading
// a dashboard.
// spec: PRD F-A9 · FR-U4 · IF §14

export interface Quip { quipId: string; text: string; trigger: string; tsMs: number }

const PAST = 5;
const clock = (ms: number) => new Date(ms).toISOString().slice(11, 19);

export function Voice({ quips }: { quips: Quip[] }) {
  if (!quips.length) {
    return (
      <p data-testid="voice-idle" className="text-base leading-relaxed text-ink-faint">
        MIRA is watching the book. It speaks when it has something worth saying.
      </p>
    );
  }
  const [latest, ...rest] = quips;
  return (
    <div>
      {/* The key makes React replace the node, so the entrance actually plays. */}
      <blockquote
        key={latest!.quipId}
        data-testid="voice-latest"
        data-quip={latest!.quipId}
        className="land rounded-md border-l-2 border-accent bg-raised px-4 py-3.5 font-display text-xl leading-snug text-ink"
      >
        {latest!.text}
      </blockquote>
      {rest.length ? (
        <ul data-testid="voice-past" className="mt-3 space-y-2">
          {rest.slice(0, PAST).map((q) => (
            <li
              key={q.quipId}
              data-testid={`voice-line-${q.quipId}`}
              className="flex gap-3 text-sm leading-relaxed text-ink-faint"
            >
              <time className="shrink-0 font-mono">{clock(q.tsMs)}</time>
              <span className="text-ink-muted">{q.text}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
