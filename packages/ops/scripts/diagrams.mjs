#!/usr/bin/env node
// Diagrams as PNG.
//
// GitHub renders mermaid; DoraHacks does not — it shows the fence as a code
// block, which is worse than no diagram. These are hand-laid SVG in the arena
// palette, rendered to PNG so they work on any surface that can show an image.
// System faces only: an export must not depend on a webfont being installed.
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';

mkdirSync('brand/diagrams', { recursive: true });

const BG = '#0b0c10', CARD = '#1b1e24', LINE = '#2a2f38';
const INK = '#f2efe9', MUTED = '#a8a49c', FAINT = '#6b6862';
const AQUA = '#5ecfc0', HOT = '#9df0e2', RED = '#e8737f', GREEN = '#6ec98d', GOLD = '#e8b464';
const SANS = "Helvetica, Arial, sans-serif";
const SERIF = "Georgia, serif";

/** A rounded box with centred, optionally two-line, label. */
const box = (x, y, w, h, label, { stroke = AQUA, fill = CARD, color = INK, size = 15, sub = null } = {}) => {
  const lines = Array.isArray(label) ? label : [label];
  const startY = y + h / 2 - ((lines.length - 1) * (size + 4)) / 2 + size / 3;
  return `<g>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>
    ${lines.map((l, i) => `<text x="${x + w / 2}" y="${startY + i * (size + 4)}" font-family="${SANS}" font-size="${size}" fill="${color}" text-anchor="middle">${l}</text>`).join('')}
    ${sub ? `<text x="${x + w / 2}" y="${y + h - 9}" font-family="${SANS}" font-size="11" fill="${FAINT}" text-anchor="middle">${sub}</text>` : ''}
  </g>`;
};

/** A diamond decision node. */
const diamond = (cx, cy, w, h, lines) => `<g>
  <path d="M${cx} ${cy - h / 2} L${cx + w / 2} ${cy} L${cx} ${cy + h / 2} L${cx - w / 2} ${cy} Z" fill="${CARD}" stroke="${GOLD}" stroke-width="1.5"/>
  ${lines.map((l, i) => `<text x="${cx}" y="${cy - (lines.length - 1) * 8 + i * 16 + 5}" font-family="${SANS}" font-size="14" fill="${INK}" text-anchor="middle">${l}</text>`).join('')}
</g>`;

const arrow = (x1, y1, x2, y2, { color = MUTED, label = null, lx = 0, ly = 0, dash = null } = {}) => `<g>
  <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="1.5"
        marker-end="url(#a-${color.slice(1)})" ${dash ? `stroke-dasharray="${dash}"` : ''}/>
  ${label ? `<text x="${(x1 + x2) / 2 + lx}" y="${(y1 + y2) / 2 + ly}" font-family="${SANS}" font-size="12" fill="${color}" text-anchor="middle">${label}</text>` : ''}
</g>`;

// Every colour used by an arrow needs its own marker: a marker-end pointing at
// an id that was never defined renders a line with no head, silently.
const defs = [MUTED, RED, GREEN, AQUA, GOLD, HOT, FAINT, '#b98ee0'].map((c) =>
  `<marker id="a-${c.slice(1)}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
     <path d="M0 0 L10 5 L0 10 z" fill="${c}"/></marker>`).join('');

const wrap = (w, h, title, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>${defs}</defs>
  <rect width="${w}" height="${h}" fill="${BG}"/>
  <text x="40" y="52" font-family="${SERIF}" font-size="30" fill="${INK}">${title}</text>
  ${body}
</svg>`;

// ── 1. The decision: refusals are first-class outcomes ──────────────────────
// One column, top to bottom, with every refusal branching right. An earlier
// two-column version put the acting path beside the pipeline and the arrows
// crossed — a diagram whose lines mislead is worse than none.
const W1 = 1000, H1 = 1180;
const CX = 200;                       // the spine
const RX = 470;                       // where refusals sit
const d1 = wrap(W1, H1, 'How MIRA decides — and how often it declines', `
  <text x="40" y="78" font-family="${SANS}" font-size="15" fill="${MUTED}">Four of the six outcomes are refusals. Each one is named on screen.</text>

  ${box(CX - 110, 110, 220, 52, 'price tick', { stroke: AQUA })}
  ${arrow(CX, 162, CX, 196, {})}
  ${box(CX - 110, 196, 220, 56, 'forecast volatility', { stroke: AQUA, sub: 'EWMV · F4' })}
  ${arrow(CX, 252, CX, 292, {})}

  ${diamond(CX, 332, 250, 80, ['is the settlement', 'boundary published?'])}
  ${arrow(CX + 125, 332, RX, 332, { color: RED, label: 'no', ly: -8 })}
  ${box(RX, 306, 260, 56, 'SKIP', { stroke: RED, color: RED, sub: 'boundary not posted' })}
  ${arrow(CX, 372, CX, 414, { color: GREEN, label: 'yes', lx: 24 })}

  ${box(CX - 110, 414, 220, 56, 'price it', { stroke: AQUA, sub: 'P = N(d₂)' })}
  ${arrow(CX, 470, CX, 510, {})}

  ${diamond(CX, 550, 250, 80, ['can any volatility', 'produce that price?'])}
  ${arrow(CX + 125, 550, RX, 550, { color: RED, label: 'no', ly: -8 })}
  ${box(RX, 524, 260, 56, 'SKIP', { stroke: RED, color: RED, sub: 'unattainable quote' })}
  ${arrow(CX, 590, CX, 632, { color: GREEN, label: 'yes', lx: 24 })}

  ${diamond(CX, 672, 270, 80, ['disagree by more', 'than fees + noise?'])}
  ${arrow(CX + 135, 672, RX, 672, { color: RED, label: 'no', ly: -8 })}
  ${box(RX, 646, 260, 56, 'HOLD', { stroke: RED, color: RED, sub: 'nothing worth doing' })}
  ${arrow(CX, 712, CX, 754, { color: GREEN, label: 'yes', lx: 24 })}

  ${box(CX - 110, 754, 220, 56, 'size', { stroke: AQUA, sub: 'quarter-Kelly' })}
  ${arrow(CX, 810, CX, 850, {})}

  ${diamond(CX, 890, 220, 80, ['risk guard'])}
  ${arrow(CX + 110, 890, RX, 890, { color: RED, label: 'a cap binds', ly: -8 })}
  ${box(RX, 864, 260, 56, 'HELD BACK', { stroke: RED, color: RED, sub: 'the gap you see on screen' })}
  ${arrow(CX, 930, CX, 972, { color: GREEN, label: 'allowed', lx: 36 })}

  ${box(CX - 110, 972, 220, 56, 'sign', { stroke: GREEN, sub: 'one nonce stream' })}
  ${arrow(CX, 1028, CX, 1068, { color: GREEN })}
  ${box(CX - 110, 1068, 220, 62, 'on-chain fill', { stroke: GREEN, color: GREEN, sub: 'verifiable from the page' })}

  <rect x="${RX}" y="990" width="440" height="140" rx="8" fill="${CARD}" stroke="${LINE}" stroke-width="1.5"/>
  <text x="${RX + 24}" y="1026" font-family="${SANS}" font-size="15" fill="${INK}">Measured on a live run</text>
  <text x="${RX + 24}" y="1058" font-family="${SANS}" font-size="14" fill="${MUTED}">299 valuations · 69 skipped · 6 wanted</text>
  <text x="${RX + 24}" y="1082" font-family="${SANS}" font-size="14" fill="${MUTED}">5 placed · 1 held back by the guard</text>
  <text x="${RX + 24}" y="1110" font-family="${SANS}" font-size="13" fill="${FAINT}">Refusing is the common case, by design.</text>
`);
await sharp(Buffer.from(d1)).png().toFile('brand/diagrams/01-decision.png');

// ── 2. Architecture ─────────────────────────────────────────────────────────
const W2 = 1200, H2 = 560;
const d2 = wrap(W2, H2, 'Architecture', `
  <text x="40" y="78" font-family="${SANS}" font-size="15" fill="${MUTED}">Two agents, each with its own key — the venue blocks an account from matching itself.</text>
  ${box(50, 130, 200, 58, 'Binance spot', { stroke: GOLD, sub: 'real prices' })}
  ${box(50, 214, 200, 58, 'Somnia oracle', { stroke: GOLD, sub: 'opening prices' })}
  ${arrow(250, 159, 320, 175, {})}
  ${arrow(250, 243, 320, 210, {})}
  ${box(320, 160, 200, 58, 'EWMV volatility', { stroke: AQUA, sub: 'F4' })}
  ${arrow(420, 218, 420, 254, {})}
  ${box(320, 254, 200, 58, 'pricer', { stroke: AQUA, sub: 'F1 · F2' })}
  ${arrow(420, 312, 420, 348, {})}
  ${box(320, 348, 200, 58, 'signal', { stroke: AQUA, sub: 'hysteresis' })}
  ${arrow(520, 377, 590, 377, {})}
  ${diamond(690, 377, 190, 76, ['risk guard'])}
  ${arrow(690, 339, 690, 292, { color: GREEN, label: 'passes', lx: 46 })}
  ${box(590, 234, 200, 58, 'tx queue', { stroke: GREEN, sub: 'one nonce stream' })}
  ${arrow(790, 263, 870, 263, { color: GREEN })}
  ${box(870, 200, 280, 90, ['DreamDEX'], { stroke: GREEN, color: GREEN, sub: 'binary CLOB · Somnia 50312' })}
  ${box(870, 360, 280, 58, 'ECHO', { stroke: '#b98ee0', color: '#b98ee0', sub: 'own key · quotes both sides' })}
  ${arrow(1010, 360, 1010, 292, { color: '#b98ee0' })}
  ${box(320, 448, 470, 58, 'Arena — WebSocket + REST', { stroke: AQUA, sub: 'board · tape · commentary · your record' })}
  ${arrow(872, 292, 800, 452, { color: MUTED, dash: '3 3', label: 'fills', lx: -26, ly: -4 })}
  ${arrow(640, 408, 556, 448, { color: RED, label: 'vetoed', lx: -26, ly: 4 })}
`);
await sharp(Buffer.from(d2)).png().toFile('brand/diagrams/02-architecture.png');

// ── 3. Scoring ──────────────────────────────────────────────────────────────
const W3 = 1100, H3 = 470;
const lane = (x, label, color) => `<g>
  ${box(x - 90, 100, 180, 46, label, { stroke: color, color })}
  <line x1="${x}" y1="146" x2="${x}" y2="410" stroke="${LINE}" stroke-width="1.5"/>
</g>`;
const step = (x1, x2, y, label, { color = MUTED, dash = null } = {}) => `<g>
  ${arrow(x1, y, x2, y, { color, dash })}
  <text x="${(x1 + x2) / 2}" y="${y - 10}" font-family="${SANS}" font-size="14" fill="${INK}" text-anchor="middle">${label}</text>
</g>`;
const d3 = wrap(W3, H3, 'What a person gets that nobody else does', `
  <text x="40" y="78" font-family="${SANS}" font-size="15" fill="${MUTED}">MIRA's number is the same for everyone. Your record is not.</text>
  ${lane(180, 'You', HOT)}
  ${lane(550, 'Arena', AQUA)}
  ${lane(940, 'Somnia', GREEN)}
  ${step(180, 550, 190, 'sign in — off-chain, no gas', { color: HOT })}
  ${step(550, 180, 232, 'session: address proven, not claimed', { color: AQUA, dash: '4 3' })}
  ${step(180, 550, 278, 'call a market, 0 to 1', { color: HOT })}
  ${step(940, 550, 324, 'the market resolves', { color: GREEN })}
  ${step(550, 180, 370, 'your Brier — calibration vs discrimination', { color: AQUA, dash: '4 3' })}
  ${step(550, 180, 412, 'head-to-head with MIRA, shared markets only', { color: AQUA, dash: '4 3' })}
`);
await sharp(Buffer.from(d3)).png().toFile('brand/diagrams/03-scoring.png');

console.log('\n  diagrams written to brand/diagrams/\n');
