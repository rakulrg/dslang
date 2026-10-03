import type { CSSProperties } from 'react';

/**
 * Full-screen two-corner celebration for the post-order confirmation.
 *
 * WHAT THIS IS
 *   Two cannons at the bottom corners of the DISPLAY, firing on the same frame,
 *   throwing paper up and inward until it covers the whole viewport, then fading
 *   out and stopping at exactly 3s. One burst, not a rain: nothing regenerates,
 *   nothing loops, and there is no JS here at all (see ONE SHOT below).
 *
 * VIEWPORT, NOT CARD
 *   The layer is `position: fixed; inset: 0` and every offset is in vw/vh from
 *   `bottom: 0`, so the emitters sit on the real screen edges at any width and
 *   nothing is measured against the confirmation card. See the `.confetti-wrap`
 *   note in index.css for why that layer is clipped rather than allowed to
 *   overflow the document.
 *
 * ONE SHOT, NO LOOP, NO TIMERS — WHY THERE IS NO useEffect HERE
 *   The celebration is pure declarative CSS: it starts when the element mounts
 *   and `animation-fill-mode: both` parks every piece on the 100% frame, whose
 *   opacity is 0. There is consequently no interval, no timeout, no
 *   requestAnimationFrame and no unmount cleanup to leak or to fire twice — a
 *   timer-based version could double-fire on a re-render, and this cannot,
 *   because "re-trigger" would require re-mounting the element. Duplication is
 *   therefore prevented at the call site, which mounts it exactly once, and
 *   `scripts/confetti-celebration.test.mjs` pins that count.
 *
 * ONE TABLE, TWO EMITTERS
 *   The right cannon is the left cannon's trajectory table run through
 *   `--dir: -1` (see `.confetti-cannon--right` in index.css). The two bursts
 *   are simultaneous and identical by construction rather than by eye, and
 *   `scripts/confetti-celebration.test.mjs` asserts the mirror holds.
 *
 * WHY THE TRAJECTORIES ARE GENERATED, NOT TYPED OUT
 *   A hand-written table of 52 rows per side is easy to get subtly wrong in a
 *   way nothing catches: an early draft mixed in negative `dx` values, which
 *   aimed half of every burst off the side of the screen where it was clipped
 *   at the viewport edge, so the burst read as thinner than the paper count
 *   suggested. Here the geometry is derived from `spread`, so "tall pieces are
 *   near-vertical and shallow pieces are the wide flankers" is a property of the
 *   formula and cannot drift out of sync with the art direction.
 *
 * COLOUR
 *   A celebration palette, deliberately not the ten-colour rainbow an earlier
 *   draft carried and not the four-colour version before that. DSLANG crimson
 *   leads, warm gold and bright ivory carry the bulk, and lime and cyan are
 *   accents at one piece in eight each so the screen reads as premium paper
 *   rather than a neon wash. Nothing here is dark: there is no black or near-
 *   black particle, because a dark chip over the dark page reads as dirt rather
 *   than as celebration. These values sit outside the `--color-` namespace on
 *   purpose — `scripts/palette.test.mjs` asserts the THEME is black / white /
 *   crimson, and a one-shot flourish should not be able to move that.
 *
 * ACCESSIBILITY
 *   Purely decorative: `aria-hidden`, pointer-events off, and the
 *   `prefers-reduced-motion` rule in index.css removes the movement entirely
 *   rather than freezing it mid-flight.
 */

/**
 * Paper shapes: [width, height, border-radius]. Chips, strips in both
 * orientations, discs and a square that reads as a diamond once it tumbles, so
 * the burst is not one rectangle stamped N times. The width/height ratio varies
 * by 3x across the list, which is what makes a fast tumble read as fluttering
 * paper rather than as falling pixels.
 */
const SHAPES: [string, string, string][] = [
  ['6px', '9px', '1px'],
  ['11px', '4px', '2px'],
  ['4px', '12px', '2px'],
  ['5px', '5px', '50%'],
  ['7px', '7px', '50%'],
  ['9px', '9px', '2px'],
  ['4px', '4px', '1px'],
  ['8px', '3px', '2px'],
];

/**
 * Celebration stock, sampled by `index % length`, so the list doubles as the
 * weighting: 8 entries gives crimson 2, gold 2, ivory 2, lime 1, cyan 1 — the
 * brand colour leads, the two accents stay rare. NOT `--color-`-prefixed, so the
 * theme lock cannot see them.
 *
 * `edge` is the hairline that keeps ivory legible on a light surface. It is set
 * on ivory alone: a shadow on crimson or gold only muddies them. It is a warm
 * sepia rather than black so that even the outline never reads as a dark
 * particle.
 */
const STOCK: { fill: string; edge?: string }[] = [
  { fill: '#D20A2E' }, // DSLANG red, the brand accent leading both bursts
  { fill: '#F2B417' }, // warm gold
  { fill: '#FFF6E6', edge: '0 0 0 0.5px rgba(90, 60, 30, 0.22)' }, // bright ivory
  { fill: '#D20A2E' },
  { fill: '#8AC63C' }, // fresh lime / green accent
  { fill: '#F2B417' },
  { fill: '#57C4DC' }, // subtle sky / cyan accent
  { fill: '#FFF6E6', edge: '0 0 0 0.5px rgba(90, 60, 30, 0.22)' },
];

/**
 * Fixed-seed LCG rather than `Math.random()`.
 *
 * `Math.random()` would hand back a different burst on every render, which
 * breaks two things at once: the element tree React sees would change between
 * renders, and the trajectories could not be asserted in a test at all. A seeded
 * generator gives the same celebration every time while still looking scattered.
 */
function makeRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Pieces per cannon. 52 x 2 = 104 animated elements, all off the compositor's
 *  hands after 3s because nothing is left running. */
const PER_CANNON = 52;

/** The whole celebration, in ms. Every piece's delay + duration sums to this. */
const TOTAL_MS = 3000;

/** Widest piece, in vw inward from the corner. Past 50 the cones cross the
 *  midline, which is deliberate: capping them short of centre left a visible
 *  dead band down the middle of the screen at desktop widths. */
const MAX_REACH_VW = 56;

/** Stagger inside ONE burst, in ms. Both cannons use the same values. */
const MAX_STAGGER_MS = 150;

/** Share of pieces re-thrown high regardless of their spread, as a fraction.
 *  Named because it is the one number that decides whether the upper half of the
 *  screen is covered or bare, and scripts/confetti-celebration.test.mjs reads it. */
const SKY_CHANCE = 0.34;

/** Tallest piece, in vh upward from the corner. Stopping at -92 rather than
 *  -100 keeps every piece clear of the top edge: the apex frame is where the
 *  burst is widest, so a piece aimed at exactly -100vh is half-clipped by the
 *  viewport and reads as a crop rather than as paper. */
const MAX_HEIGHT_VH = 92;

/** Shallowest piece, in vh. The cone is deliberately only about 2:1 rather than
 *  the 3:1 a real ballistic cone would give: the widest flankers still have to
 *  climb high enough to carry paper across the middle of a wide screen. */
const MIN_HEIGHT_VH = 46;

/** [ dx, apex, drift, rotation, duration, delay ], one piece. See PIECES. */
type Piece = [number, number, number, number, number, number];

/**
 * Trajectories for the LEFT cannon; the right cannon is this run through
 * `--dir: -1`. Read a horizontal value as "inward from the left edge".
 *   [ dx,   apex, drift, rotation, duration, delay ]
 *     dx     launch X in vw, INWARD, and always positive. Values run out to
 *            MAX_REACH_VW so the two cones overlap through the middle of the
 *            screen instead of leaving a gap there.
 *     apex   height reached, in vh. NEGATIVE is upward. The cone is tall and
 *            narrow near vertical and shallower at the flanks. The falloff is
 *            gentle on purpose: a steeper one leaves the wide flankers crawling
 *            along the bottom edge, and then the centre of a wide screen gets
 *            paper at knee height and nowhere else. A third of the pieces are
 *            then re-thrown high (`skyChance`) regardless of spread, which is
 *            what actually populates the UPPER band — including the upper middle
 *            that a cone fired from the corners leaves bare by construction.
 *     drift  fraction of `apex` still travelled at the 100% frame. Always
 *            positive and always < 1, so every piece finishes ABOVE its own
 *            corner and fades out while still on screen — a piece that fell past
 *            the bottom edge would be clipped by the viewport and read as exactly
 *            the sudden stop this effect must not have.
 *     rotation  total spin, up to about three and a half turns, so pieces tumble
 *            at visibly different rates.
 *     duration + delay  always sums to TOTAL_MS, so the celebration ends crisply
 *            at 3s instead of trailing off over the slowest piece.
 */
function buildPieces(seed: number, count: number): Piece[] {
  const rand = makeRandom(seed);
  const out: Piece[] = [];
  for (let i = 0; i < count; i++) {
    const spread = count === 1 ? 0 : i / (count - 1);

    // Cone geometry: inward reach grows with `spread`, apex height falls with it.
    const dx = 5 + (MAX_REACH_VW - 5) * spread + (rand() - 0.5) * 3;

    // A third of the pieces are thrown into the upper band regardless of spread.
    const sky = rand() < SKY_CHANCE;
    const apex = sky
      ? -(MIN_HEIGHT_VH + 6 + rand() * (MAX_HEIGHT_VH - MIN_HEIGHT_VH - 6))
      : -(MAX_HEIGHT_VH - (MAX_HEIGHT_VH - MIN_HEIGHT_VH) * spread);

    const delay = Math.round(rand() * MAX_STAGGER_MS);
    const drift = 0.26 + rand() * 0.38;
    const rotation = Math.round((rand() * 2 - 1) * (360 + rand() * 900));
    out.push([+dx.toFixed(2), +apex.toFixed(1), +drift.toFixed(2), rotation, TOTAL_MS - delay, delay]);
  }
  return out;
}

/** Identical for both cannons, so the bursts are simultaneous by construction. */
const PIECES = buildPieces(20251014, PER_CANNON);

type Side = 'left' | 'right';

function Burst({ side }: { side: Side }) {
  return (
    <span className={`confetti-cannon confetti-cannon--${side}`}>
      {PIECES.map(([dx, apex, drift, r, dur, delay], i) => {
        const shape = SHAPES[i % SHAPES.length];
        const stock = STOCK[i % STOCK.length];
        return (
          <span
            key={i}
            className="confetti"
            style={
              {
                '--dx': `${dx}vw`,
                '--apex': `${apex}vh`,
                '--drift': drift,
                '--r': `${r}deg`,
                '--dur': `${dur}ms`,
                '--delay': `${delay}ms`,
                '--w': shape[0],
                '--h': shape[1],
                '--radius': shape[2],
                '--fill': stock.fill,
                '--edge': stock.edge ?? 'none',
              } as CSSProperties
            }
          />
        );
      })}
    </span>
  );
}

export function ConfettiBurst() {
  return (
    <div className="confetti-wrap" aria-hidden="true">
      <Burst side="left" />
      <Burst side="right" />
    </div>
  );
}
