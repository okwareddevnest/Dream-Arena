#!/usr/bin/env node
// Brand asset generation.
//
// One source of geometry — the same axis-and-span mark the app renders — exported
// at every size a submission or a README needs. Regenerating from code rather
// than hand-editing exports means the PNGs can never drift from the palette in
// lib/theme.ts.
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';

const OUT = 'brand';
mkdirSync(OUT, { recursive: true });

// bg #0b0c10 · line #a8a49c · accent #5ecfc0 · accent-hot #9df0e2 — lib/theme.ts
// Legibility notes, learned by rendering it:
//  · the span must be LIGHTER than the two marks, or all three fuse into an "H"
//  · the marks must differ in height, or the shape reads symmetrical and inert
//  · the axis has to be visible BEYOND both marks — it is the thing they sit on,
//    and without the overhang there is no axis, only a barbell
const MARK = `
  <line x1="3" y1="16" x2="29" y2="16" stroke="#6b6862" stroke-width="1.25"/>
  <line x1="11" y1="16" x2="21" y2="16" stroke="#5ecfc0" stroke-width="2.5" stroke-linecap="round"/>
  <line x1="11" y1="11.5" x2="11" y2="20.5" stroke="#a8a49c" stroke-width="2.25" stroke-linecap="round"/>
  <line x1="21" y1="6" x2="21" y2="26" stroke="#9df0e2" stroke-width="3" stroke-linecap="round"/>
  <circle cx="21" cy="16" r="1.6" fill="#0b0c10"/>
  <circle cx="21" cy="16" r="1.6" fill="none" stroke="#9df0e2" stroke-width="1"/>`;

const square = (withBg) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 32 32" fill="none">` +
  (withBg ? '<rect width="32" height="32" rx="7" fill="#0b0c10"/>' : '') + MARK + '</svg>';

for (const size of [64, 128, 256, 512, 1024]) {
  await sharp(Buffer.from(square(true))).resize(size, size).png().toFile(`${OUT}/logo-${size}.png`);
}
await sharp(Buffer.from(square(false))).resize(1024, 1024).png().toFile(`${OUT}/logo-mark-transparent.png`);

// Cover card. System faces only — an exported PNG must not depend on a webfont
// being installed on whatever machine runs this.
const cover = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#0b0c10"/>
  <g transform="translate(96,168) scale(7)" fill="none">${MARK}</g>
  <text x="372" y="286" font-family="Georgia, serif" font-size="88" fill="#f2efe9">Dream Arena</text>
  <text x="374" y="344" font-family="Helvetica, Arial, sans-serif" font-size="30" fill="#a8a49c">An autonomous agent trading prediction markets on Somnia.</text>
  <text x="374" y="392" font-family="Helvetica, Arial, sans-serif" font-size="30" fill="#5ecfc0">Every trade on-chain. Every refusal explained.</text>
  <rect x="96" y="486" width="1008" height="1" fill="#2a2f38"/>
  <text x="96" y="536" font-family="Helvetica, Arial, sans-serif" font-size="24" fill="#6b6862">Somnia testnet · chain 50312</text>
</svg>`;
await sharp(Buffer.from(cover)).png().toFile(`${OUT}/cover-1200x630.png`);

console.log(`\n  brand assets written to ${OUT}/\n`);
