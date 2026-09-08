// Dream Arena identity.
//
// The mark is the product's thesis in its simplest geometry: a probability axis,
// two marks on it — what the model believes and what the market prices — and the
// span between them. That span is the edge MIRA trades. Nothing here is
// decoration; every stroke is a thing the system measures.
//
// Flat strokes only, no gradients, no emoji. Colour comes from `currentColor` so
// the mark inherits whatever theme token its container sets, which keeps
// lib/theme.ts the single source of colour.

export function Logo({ className = '', title = 'Dream Arena' }: { className?: string; title?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      role="img"
      aria-label={title}
      className={className}
      fill="none"
      strokeLinecap="round"
    >
      {/* the probability axis, 0 -> 1 */}
      <line data-part="axis" x1="3" y1="16" x2="29" y2="16" stroke="currentColor" strokeWidth="1.5" opacity="0.28" />
      {/* the span between belief and price — the edge, and the weight of the mark */}
      <line data-part="span" x1="10" y1="16" x2="22" y2="16" stroke="currentColor" strokeWidth="6" />
      {/* market: where the book is */}
      <line data-part="market" x1="10" y1="7" x2="10" y2="25" stroke="currentColor" strokeWidth="3" opacity="0.5" />
      {/* model: where MIRA thinks it should be */}
      <line data-part="model" x1="22" y1="3" x2="22" y2="29" stroke="currentColor" strokeWidth="3.5" />
    </svg>
  );
}

/** The name, set once, in one weight. The mark carries the identity. */
export function Wordmark({ className = '' }: { className?: string }) {
  return (
    <span className={`inline-flex items-baseline gap-[0.45em] ${className}`}>
      <span className="text-ink tracking-[-0.01em]">Dream Arena</span>
    </span>
  );
}

/** Mark + name, the lockup used in the arena header. */
export function Brand({ className = '' }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <Logo className="h-6 w-6 text-accent" />
      <Wordmark className="text-base" />
    </span>
  );
}
