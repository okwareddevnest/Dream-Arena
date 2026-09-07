// jsdom has no ResizeObserver, and the charts measure their container before
// drawing (that measurement is what keeps them sharp). Without a stub they would
// render nothing under test and the chart would be verified only in maths, never
// in the DOM. The stub reports a fixed, realistic box.
class StubResizeObserver {
  constructor(private readonly cb: ResizeObserverCallback) {}
  observe(target: Element) {
    this.cb(
      [{ target, contentRect: { width: 320, height: 120, top: 0, left: 0, bottom: 120, right: 320, x: 0, y: 0, toJSON: () => ({}) } } as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= StubResizeObserver as unknown as typeof ResizeObserver;
