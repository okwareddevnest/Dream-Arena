'use client';
// Your record.
//
// MIRA's probability is the same for everyone who loads the page, so a "unique
// prediction per user" is not a thing this product can honestly offer. What IS
// unique is what you said and how it turned out — and, more useful than a score,
// the SHAPE of your error. A confident forecaster and a timid one can share a
// Brier score and need opposite advice.

export interface Bucket { lo: number; hi: number; stated: number; observed: number | null; n: number }
export interface ScoreData {
  userAddr: string;
  record: { n: number; brier: number | null; reliability: number; resolution: number; uncertainty: number; baseRate: number };
  calibration: Bucket[];
  versusMira: { n: number; userBrier: number | null; miraBrier: number | null; verdict: string };
  forecasts: number;
  pending: number;
}

/** Stated confidence against what actually happened. The diagonal is perfection. */
export function CalibrationCurve({ buckets }: { buckets: Bucket[] }) {
  const pts = buckets.filter((b) => b.n > 0 && b.observed !== null);
  if (!pts.length) {
    return (
      <p data-testid="cal-empty" className="py-6 text-sm text-ink-faint">
        Your calibration curve appears once some of your calls have settled.
      </p>
    );
  }
  const S = 200, pad = 22;
  const X = (v: number) => pad + v * (S - pad * 2);
  const Y = (v: number) => S - pad - v * (S - pad * 2);
  return (
    <svg viewBox={`0 0 ${S} ${S}`} className="w-full max-w-[15rem]" role="img" aria-label="Calibration curve">
      <line
        data-testid="cal-ideal"
        x1={X(0)} y1={Y(0)} x2={X(1)} y2={Y(1)}
        stroke="currentColor" strokeWidth="1" strokeDasharray="3 3" className="text-ink-faint"
      />
      {[0, 0.5, 1].map((t) => (
        <g key={t} className="text-grid">
          <line x1={X(0)} y1={Y(t)} x2={X(1)} y2={Y(t)} stroke="currentColor" strokeWidth="1" />
        </g>
      ))}
      {pts.map((b) => (
        <circle
          key={b.lo}
          data-testid={`cal-pt-${b.lo}`}
          cx={X(b.stated)} cy={Y(b.observed!)}
          r={Math.min(7, 3 + Math.sqrt(b.n))}
          className="fill-accent"
        />
      ))}
      <text x={X(0)} y={S - 4} className="fill-ink-faint font-mono text-[9px]">you said</text>
      <text x={2} y={Y(1) - 6} className="fill-ink-faint font-mono text-[9px]">happened</text>
    </svg>
  );
}

/** Plain-language reading of the Murphy terms. */
function diagnose(r: ScoreData['record']): string {
  if (r.n < 5) return 'A few more settled calls and this becomes a real estimate rather than noise.';
  const miscalibrated = r.reliability > 0.02;
  const undiscriminating = r.resolution < 0.01;
  if (miscalibrated && undiscriminating) {
    return 'Your confidence does not match your hit rate, and your calls are not yet separating likely outcomes from unlikely ones. Try moving your numbers toward what you would actually bet.';
  }
  if (miscalibrated) {
    return 'You are picking winners, but your stated confidence runs ahead of your hit rate. The direction is right; the numbers are too strong.';
  }
  if (undiscriminating) {
    return 'You are well calibrated — your numbers mean what they say — but you are hedging toward the middle. Being decisive when you have a view is where the score is.';
  }
  return 'Well calibrated and separating the likely from the unlikely. This is what a good forecaster looks like.';
}

export function Scorecard({ data }: { data: ScoreData | null }) {
  if (!data) {
    return (
      <p data-testid="score-connect" className="text-base leading-relaxed text-ink-muted">
        Connect a wallet and call a market. Once it settles, this becomes your own record —
        how well calibrated you are, and how you compare with MIRA on the same questions.
      </p>
    );
  }
  const { record, versusMira } = data;
  if (!record.n || record.brier === null) {
    return (
      <div data-testid="score-empty" className="text-base leading-relaxed text-ink-muted">
        <p>
          {data.forecasts
            ? `${data.pending} of your calls are still open. Nothing is scored until a market settles.`
            : 'No calls yet. Forecast a market and your record starts here.'}
        </p>
      </div>
    );
  }
  return (
    <div className="grid gap-6 sm:grid-cols-[minmax(0,1fr)_auto]">
      <div>
        <div className="flex flex-wrap items-baseline gap-x-8 gap-y-3">
          <div data-testid="score-brier">
            <div className="font-mono text-3xl tabular-nums text-ink">{record.brier.toFixed(3)}</div>
            <div className="mt-1 text-sm text-ink-faint">your Brier, over {record.n} settled</div>
          </div>
          <div>
            <div className="font-mono text-2xl tabular-nums text-gold">{record.reliability.toFixed(3)}</div>
            <div className="mt-1 text-sm text-ink-faint">calibration error, lower better</div>
          </div>
          <div>
            <div className="font-mono text-2xl tabular-nums text-accent">{record.resolution.toFixed(3)}</div>
            <div className="mt-1 text-sm text-ink-faint">discrimination, higher better</div>
          </div>
        </div>

        <p data-testid="score-diagnosis" className="mt-5 max-w-[54ch] text-base leading-relaxed text-ink-muted">
          {diagnose(record)}
        </p>

        <p data-testid="score-vs" className="mt-4 text-base text-ink-muted">
          {versusMira.n
            ? <>Against MIRA on the {versusMira.n} markets you both called, you are{' '}
                <span className={versusMira.verdict === 'ahead' ? 'text-long' : versusMira.verdict === 'behind' ? 'text-short' : 'text-ink'}>
                  {versusMira.verdict}
                </span>
                {' '}({versusMira.userBrier!.toFixed(3)} against {versusMira.miraBrier!.toFixed(3)}).</>
            : 'You and MIRA have not yet called the same settled market.'}
        </p>

        <p data-testid="score-pending" className="mt-2 text-sm text-ink-faint">
          {data.pending} call{data.pending === 1 ? '' : 's'} still open.
        </p>
      </div>

      <CalibrationCurve buckets={data.calibration} />
    </div>
  );
}
