<img src="brand/logo-256.png" alt="Dream Arena" width="88" />

# Dream Arena

An autonomous agent trading binary prediction markets on Somnia testnet, and a
place to watch it do so.

> **Vision — make judgement measurable: one future, every forecaster, settled on-chain.**

**MIRA** forecasts volatility from live spot prices, prices each market from that
forecast, and trades only where its probability and the order book disagree by
more than fees, spread and noise. **ECHO** is a second agent that quotes both
sides so there is a counterparty — these venues launched with a trade count of
zero, so without it the tape is empty by construction.

Every order either agent signs, and every fill it takes, lands on Somnia testnet
and links to the block explorer from the trade tape.

---

## How it fits together

```mermaid
%%{init: {'theme':'base','themeVariables':{'background':'#0b0c10','primaryColor':'#1b1e24','primaryTextColor':'#f2efe9','primaryBorderColor':'#5ecfc0','lineColor':'#5ecfc0','secondaryColor':'#241a1e','tertiaryColor':'#1d1a24','noteBkgColor':'#1b1e24','noteTextColor':'#a8a49c','noteBorderColor':'#e8b464','actorBkg':'#1b1e24','actorBorder':'#5ecfc0','actorTextColor':'#f2efe9','signalColor':'#a8a49c','signalTextColor':'#f2efe9','labelBoxBkgColor':'#1b1e24','labelBoxBorderColor':'#e8b464','labelTextColor':'#f2efe9','altBackground':'#151f1c','sequenceNumberColor':'#0b0c10'}}}%%
flowchart LR
  subgraph feed[" "]
    SPOT["Binance spot<br/>real prices"]
    ORACLE["Somnia price feed<br/>opening prices"]
  end
  subgraph agent["MIRA — one process"]
    ING["Ingester"]
    VOL["EWMV<br/>volatility F4"]
    PRICE["Pricer<br/>F1 · F2"]
    SIG["Signal<br/>hysteresis"]
    RISK{"Risk guard"}
    Q["Tx queue<br/>one nonce stream"]
  end
  subgraph chain["Somnia testnet · 50312"]
    VENUE["DreamDEX<br/>binary CLOB"]
  end
  ECHO["ECHO<br/>own key, own process"]
  UI["Arena<br/>WS + REST"]

  SPOT --> ING --> VOL --> PRICE --> SIG --> RISK
  ORACLE -->|"opening price = the boundary"| PRICE
  RISK -->|"passes"| Q --> VENUE
  RISK -->|"vetoed"| UI
  VENUE -->|"book, fills, positions"| PRICE
  ECHO <-->|"quotes both sides"| VENUE
  VENUE -->|"fills"| UI
  ING -.->|"every event"| UI

  classDef src fill:#1b1e24,stroke:#e8b464,color:#f2efe9
  classDef core fill:#1b1e24,stroke:#5ecfc0,color:#f2efe9
  classDef risk fill:#241a1e,stroke:#e8737f,color:#f2efe9
  classDef net fill:#151f1c,stroke:#6ec98d,color:#f2efe9
  classDef ui fill:#1d1a24,stroke:#b98ee0,color:#f2efe9
  class SPOT,ORACLE src
  class ING,VOL,PRICE,SIG,Q core
  class RISK risk
  class VENUE,ECHO net
  class UI ui
```

### One tick, end to end

```mermaid
%%{init: {'theme':'base','themeVariables':{'background':'#0b0c10','primaryColor':'#1b1e24','primaryTextColor':'#f2efe9','primaryBorderColor':'#5ecfc0','lineColor':'#5ecfc0','secondaryColor':'#241a1e','tertiaryColor':'#1d1a24','noteBkgColor':'#1b1e24','noteTextColor':'#a8a49c','noteBorderColor':'#e8b464','actorBkg':'#1b1e24','actorBorder':'#5ecfc0','actorTextColor':'#f2efe9','signalColor':'#a8a49c','signalTextColor':'#f2efe9','labelBoxBkgColor':'#1b1e24','labelBoxBorderColor':'#e8b464','labelTextColor':'#f2efe9','altBackground':'#151f1c','sequenceNumberColor':'#0b0c10'}}}%%
sequenceDiagram
  autonumber
  participant S as Spot feed
  participant E as Engine
  participant V as Venue
  participant C as Chain
  participant U as Arena

  S->>E: price tick
  E->>E: update volatility (F4)
  E->>V: read the book
  V-->>E: bid / ask
  E->>E: price it (F1), invert the book (F2)
  alt no volatility explains that price
    E-->>U: SKIP — reason named, nothing traded
  else edge above entry threshold
    E->>E: size at quarter-Kelly
    E->>E: risk guard
    alt a cap binds
      E-->>U: held back — the gap you can read on screen
    else allowed
      E->>V: place (serialised, one nonce)
      V->>C: signed transaction
      C-->>V: receipt + fills
      V-->>E: fills → position, so the caps mean something
      V-->>U: tape row, with its explorer link
    end
  end
```

### The round, and what each person gets

```mermaid
%%{init: {'theme':'base','themeVariables':{'background':'#0b0c10','primaryColor':'#1b1e24','primaryTextColor':'#f2efe9','primaryBorderColor':'#5ecfc0','lineColor':'#5ecfc0','secondaryColor':'#241a1e','tertiaryColor':'#1d1a24','noteBkgColor':'#1b1e24','noteTextColor':'#a8a49c','noteBorderColor':'#e8b464','actorBkg':'#1b1e24','actorBorder':'#5ecfc0','actorTextColor':'#f2efe9','signalColor':'#a8a49c','signalTextColor':'#f2efe9','labelBoxBkgColor':'#1b1e24','labelBoxBorderColor':'#e8b464','labelTextColor':'#f2efe9','altBackground':'#151f1c','sequenceNumberColor':'#0b0c10'}}}%%
stateDiagram-v2
  [*] --> Open: markets with time on them
  Open --> Open: people call markets
  Open --> Scoring: the clock runs out
  Scoring --> Settled: chain says how markets resolved
  Settled --> Open: next round
  Settled --> [*]: nothing left to trade

  note right of Scoring
    Unresolved markets score nobody.
    A round waits rather than guessing.
  end note
  note right of Settled
    Per person: Brier, calibration
    (reliability vs resolution),
    and head-to-head with MIRA
    on shared markets only.
  end note
```

## Run it

Both agents need their own funded Somnia testnet wallet — the venue blocks
self-matching, so one key means the two can never trade with each other.
`npm run fund` reports what is missing on both and pulls tUSDC from the on-chain
faucet. STT is gas and cannot be self-served: paste the address into the
[Google Web3 faucet](https://cloud.google.com/application/web3/faucet/somnia/shannon)
or [Stakely](https://stakely.io/faucet/somnia-testnet-stt). Each wallet needs
**0.6 STT** clear, which is one write plus real margin.

Copy `.env.example` if it is present, or take the full variable list from
`render.yaml` — it carries every non-secret value the agents read.

```bash
npm install
npm run fund                 # check STT + tUSDC on both wallets
npm run agent                # MIRA — also serves the API and WebSocket on :8080
npm run echo                 # ECHO — the counterparty
npm run web                  # the site on :3000
```

`VENUE_MODE=LIVE` is the default (RFC-003). `Ctrl-C` on either agent cancels its
resting orders before exiting.

One process instead of five — the whole arena behind a single port, which is
what deployment runs:

```bash
npm run web:build && npm start    # site + MIRA + ECHO on :10000
```

With Docker: `docker compose up --build`.

Deployed on Render's free tier from [`render.yaml`](render.yaml), which is
commented in full. It is **one** service on purpose: Render's free tier has no
background workers, and grants 750 instance-hours per month against a 720-hour
month — so exactly one service can stay up around the clock. `packages/ops/src/boot.ts`
supervises the three processes behind a single proxied port, and each agent
keeps its own signer, nonce stream and transaction queue. Only the two private
keys are entered by hand; everything else is in the blueprint.

| route | what it is |
|---|---|
| `/` | what the system is, with live figures from the running agent |
| `/arena` | the live board, tape, MIRA's commentary, your own record |
| `/mira` | how the agent prices a market — the actual formulas |
| `/console` | operator controls, token-gated |

## Verify it yourself

Nothing here asks to be believed.

```bash
npm run smoke:live -- --dry  # read the live venue without trading
npm run smoke:live           # place a real far-from-mid order and cancel it
npm run test:live            # the G4 suite against the real chain
npm run replay               # reconstruct any recorded session from its journal
npm run gates                # G1..G6
```

Every fill on the tape carries its transaction hash and opens on the
[Shannon explorer](https://shannon-explorer.somnia.network).

## How it decides

| step | what happens |
|---|---|
| **F4** volatility | exponentially-weighted moving variance over log returns, updated every tick |
| **F1** price | `P = N(d₂)`, `d₂ = [ln(S/K) − σ²τ/2] / (σ√τ)` — the Itô term matters; without it the edge at the money is overstated by ~0.60 |
| **F2** invert | read the book back as an implied volatility; where no volatility produces the quoted price, the market is refused rather than traded |
| signal | enter above `EDGE_IN`, hold until below `EDGE_OUT` — two thresholds, so noise cannot cause churn |
| size | quarter-Kelly on the measured edge, then whichever hard cap binds first |

`edge` is measured in **volatility**, not probability: `sigmaForecast − sigmaImplied`.

## What it does not claim

- **Not proven profitable.** Over a short session, profit and loss says more about
  the market than about the model.
- **The testnet book is thin.** These venues have no organic flow; prices there are
  not what a deep market would produce.
- **Spot comes from an exchange.** Real prices, read from Binance, not from the venue.
- **A skip is not a failure.** Most markets are refused most of the time — that is
  the model declining to guess.

## Layout

```
packages/shared   frozen types, config, maths, clocks
packages/data     event bus, JSONL journal, spot ingester, store projections
packages/core     EWMV, pricer, signals, sizing, risk guard, engine, ECHO, persona
packages/venue    Venue interface, SimulatedVenue, DreamDEXVenue, tx queue, reconciler
packages/api      WebSocket broadcaster, REST, hunt settlement, MIRROR, calibration
packages/ops      agent + ECHO entrypoints, arena server, scripts
apps/web          the site
brand/            logo, cover and architecture diagrams, all generated from code
state/journal/    one JSONL per run — every decision, replayable
```

## Brand assets

`brand/` holds the mark at 64–1024 px, a transparent variant, and a 1200×630
cover; `brand/diagrams/` holds the three architecture diagrams as PNG.

```
npm run brand       # logo + cover
npm run diagrams    # the three diagrams as PNG
npm run dorahacks   # submission draft → DoraHacks variant, mermaid swapped for images
```

All of it renders from the same geometry and palette the app uses, so an export
cannot drift. The DoraHacks variant exists because that platform shows a mermaid
fence as a plain code block — GitHub renders them, DoraHacks does not.

## Design record

Three assumptions did not survive contact with the live venue, and each was
amended in writing before any code moved. They are referenced by number
throughout the source:

- **RFC-001** — what the venue actually enforces. Winnings are *claimed*, not
  received, so an unclaimed win is invisible until something sweeps it (A5).
  Self-matching is blocked, so two agents need two funded keys or they can never
  trade with each other (A7). Reference-mode markets carry no strike until a
  boundary is posted, so the opening price has to be resolved from the oracle
  candle or every market skips unpriced (A4).
- **RFC-002** — the two pricing formulas in the whitepaper disagreed. `F1` was
  written as `Φ(ln(S/K) / σ√τ)`, but `F2`'s implied-vol inversion solves for
  `(ln(S/K) − σ²τ/2) / σ√τ` — they invert different functions, so a probability
  and the vol implied back out of it were never consistent. `F1` became the full
  `Φ(d₂)`. The `−σ²τ/2` is not a drift assumption, it is Itô's correction, and
  dropping it is simply wrong.
- **RFC-003** — **live-first**. The simulator was demoted to a test rig and the
  demo path is the real chain. Everything the site shows is a transaction you
  can open on the explorer; `VENUE_MODE=LIVE` is the default because a run that
  is quietly simulated looks identical on every screen until someone checks.

Interface contracts were frozen before implementation and every lane built
against them. The full engineering record — product spec, whitepaper, frozen
interfaces, the RFCs in full, spike reports, the test plan and a build ledger of
every correction made along the way — is kept privately and is not part of this
repository. What is here is the system it produced, and the commands above
check it against the chain rather than against a fixture.

## Licence

MIT © 2026 Dedan Okware. See [LICENSE](LICENSE).

This software trades on a **test network** with valueless tokens. It is a
research and demonstration project, not financial advice and not audited for
production use with real funds.
