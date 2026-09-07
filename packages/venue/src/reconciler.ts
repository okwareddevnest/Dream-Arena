// Position reconciler (FR-X3, GWT-6).
//
// The "ghost PnL" leg of the integrity quartet (WP §7), and the one rule that
// makes it work is uncomfortable but absolute: THE CHAIN ALWAYS WINS.
//
// Local state is a cache of what we believe happened. It goes wrong in ways
// that are invisible from the inside — a transaction we sent that never landed,
// a fill event we missed while reconnecting, a settlement we did not see. Every
// one of those shows up as a position we think we have and do not, and every
// one of them poisons PnL on screen and sizing in the engine.
//
// So the reconciler diffs and ADOPTS. It never writes to the venue: no
// corrective orders, no cancels, nothing that could turn a read-model
// disagreement into a real trade. The bot kit's own advice is the same —
// "treat the chain as the source of truth for anything you act on", because
// the indexer lags by seconds.
import type {
  AgentId, Bus, DriftItem, Ms, Position, ReconcileReport, Venue,
} from '@arena/shared';

/** The local view being checked. Deliberately a narrow interface: the
 *  reconciler must not be able to reach anything it could mutate. */
export interface LocalPositions {
  positions(agent?: AgentId): Position[];
  /** Replace local state for one market with the chain's version. */
  adopt(p: Position): void;
  /** Drop a market that the chain says we have no position in. */
  drop(marketId: string, agent: AgentId): void;
}

export interface ReconcilerOptions {
  venue: Venue;
  local: LocalPositions;
  agent: AgentId;
  bus?: Bus;
  /** Tolerance for a float comparison on average price. */
  priceEpsilon?: number;
  /** Called for each report, e.g. to journal it. */
  onReport?: (r: ReconcileReport) => void;
  onError?: (e: Error) => void;
}

export class Reconciler {
  private readonly venue: Venue;
  private readonly local: LocalPositions;
  private readonly agent: AgentId;
  private readonly bus: Bus | undefined;
  private readonly eps: number;
  private readonly onReport: ((r: ReconcileReport) => void) | undefined;
  private readonly onError: ((e: Error) => void) | undefined;
  private passes = 0;
  private adopted = 0;
  private failures = 0;
  private lastReport: ReconcileReport | null = null;

  constructor(o: ReconcilerOptions) {
    this.venue = o.venue;
    this.local = o.local;
    this.agent = o.agent;
    this.bus = o.bus;
    this.eps = o.priceEpsilon ?? 1e-9;
    this.onReport = o.onReport;
    this.onError = o.onError;
  }

  get stats(): { passes: number; adopted: number; failures: number } {
    return { passes: this.passes, adopted: this.adopted, failures: this.failures };
  }

  get last(): ReconcileReport | null { return this.lastReport; }

  /**
   * One reconciliation pass.
   *
   * On an RPC failure local state is left ENTIRELY untouched. That is the safe
   * direction: acting on a failed read would let a transient network problem
   * wipe a real position, which is a worse outcome than briefly trusting a
   * stale cache.
   */
  async reconcile(): Promise<ReconcileReport> {
    const started = this.venue.now();
    const t0 = Date.now();
    this.passes++;

    let chain: Position[];
    try {
      chain = await this.venue.positions(this.agent);
    } catch (e) {
      this.failures++;
      const err = e instanceof Error ? e : new Error(String(e));
      this.onError?.(err);
      this.bus?.publish({ t: 'error', d: { where: 'reconciler', msg: err.message, tsMs: started } });
      const report: ReconcileReport = {
        tsMs: started, checked: 0, drifted: [], correctedFrom: 'chain', durationMs: Date.now() - t0,
      };
      this.lastReport = report;
      return report;
    }

    const localList = this.local.positions(this.agent);
    const byId = new Map<string, Position>();
    for (const p of localList) byId.set(p.marketId, p);

    const drifted: DriftItem[] = [];
    const seen = new Set<string>();

    // Markets the chain knows about.
    for (const c of chain) {
      seen.add(c.marketId);
      const l = byId.get(c.marketId);
      const localNet = l?.netContracts ?? 0;
      const localAvg = l?.avgPrice ?? 0;
      if (localNet !== c.netContracts || Math.abs(localAvg - c.avgPrice) > this.eps) {
        drifted.push({
          marketId: c.marketId,
          localNet, chainNet: c.netContracts,
          localAvg, chainAvg: c.avgPrice,
          action: 'ADOPT_CHAIN',
        });
        this.local.adopt(c);
        this.adopted++;
      }
    }

    // Markets we believe in that the chain has never heard of. These are the
    // ghosts: a transaction that looked accepted and never landed.
    for (const l of localList) {
      if (seen.has(l.marketId)) continue;
      if (l.netContracts === 0) continue;              // already flat, nothing to correct
      drifted.push({
        marketId: l.marketId,
        localNet: l.netContracts, chainNet: 0,
        localAvg: l.avgPrice, chainAvg: 0,
        action: 'ADOPT_CHAIN',
      });
      this.local.drop(l.marketId, this.agent);
      this.adopted++;
    }

    const report: ReconcileReport = {
      tsMs: started,
      checked: chain.length + localList.length - seen.size,
      drifted,
      correctedFrom: 'chain',
      durationMs: Date.now() - t0,
    };
    this.lastReport = report;
    this.bus?.publish({ t: 'reconcile', d: report });
    this.onReport?.(report);
    return report;
  }

  /**
   * Poll on a cadence. Returns a stop function.
   *
   * The interval is measured (T-S4: `reconcilePollMs` 3 000 ms against an RPC
   * p50 of 244 ms), and three polls have to fit inside GWT-6's 10-second
   * self-correction budget — which is the constraint that fixed the number.
   */
  start(everyMs: number, setInterval: (fn: () => void, ms: number) => number,
        clearInterval: (h: number) => void): () => void {
    const h = setInterval(() => { void this.reconcile(); }, everyMs);
    return () => clearInterval(h);
  }
}
