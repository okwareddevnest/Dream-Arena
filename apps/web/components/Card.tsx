// A panel.
//
// Three weights, not one: the divergence board is the page's subject and gets a
// lifted surface and a stronger edge; ordinary panels sit flat on the ground;
// rail panels are quieter still. Identical cards everywhere would flatten the
// hierarchy the layout exists to express. No shadows and no gradients — depth
// comes from the surface step and the border.
import type { ReactNode } from 'react';

export type CardWeight = 'feature' | 'panel' | 'quiet';

const SURFACE: Record<CardWeight, string> = {
  feature: 'bg-raised border-line',
  panel: 'bg-surface border-line',
  quiet: 'bg-surface/60 border-line',
};

export function Card({
  title, note, weight = 'panel', children, className = '', bodyClassName = '',
}: {
  title?: string;
  note?: ReactNode;
  weight?: CardWeight;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section
      aria-label={title}
      className={`flex flex-col rounded-card border ${SURFACE[weight]} ${className}`}
    >
      {title ? (
        <header className="flex items-baseline justify-between gap-3 border-b border-line px-4 py-3">
          <h2 className={weight === 'feature' ? 'text-lg text-ink' : 'text-sm text-ink'}>{title}</h2>
          {note ? <span className="shrink-0 text-xs text-ink-faint">{note}</span> : null}
        </header>
      ) : null}
      <div className={`flex-1 px-4 py-3.5 ${bodyClassName}`}>{children}</div>
    </section>
  );
}
