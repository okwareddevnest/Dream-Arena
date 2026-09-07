// Concurrency-limited execution lane.
//
// Two different limits exist and they are NOT the same number:
//   • INDEXER — 1 in flight. T-S4 measured that concurrency is what breaks it.
//   • RPC     — THROTTLE.rpcMaxInFlight (4). `eth_call`s are cheap and parallel.
// Running both on one serial lane starved the write path: a placeOrder's
// on-chain status read queued behind every quote refresh, so a call that takes
// 2.8s alone exceeded the 30s TxQueue timeout under load.
export class ConcurrentGate {
  private readonly limit: number;
  private active = 0;
  private readonly queue: (() => void)[] = [];

  constructor(limit: number) {
    this.limit = Math.max(1, Math.floor(limit) || 1);
  }

  get inFlight(): number { return this.active; }
  get waiting(): number { return this.queue.length; }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      // Free the slot before waking the next task, so a throwing task can never
      // strand the lane at full occupancy.
      this.active--;
      this.queue.shift()?.();
    }
  }
}
