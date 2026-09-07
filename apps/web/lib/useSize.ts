'use client';
// Measure a container so charts can draw in true pixel space.
// A chart that guesses its size and then stretches to fit is the reason
// SVG lines look soft; measuring first is what makes them sharp.
import { useEffect, useRef, useState } from 'react';

export function useSize<T extends HTMLElement>(): [React.RefObject<T | null>, { width: number; height: number }] {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      // Round to whole pixels: a fractional viewBox reintroduces the softness.
      setSize((p) => {
        const w = Math.round(width), h = Math.round(height);
        return p.width === w && p.height === h ? p : { width: w, height: h };
      });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}
