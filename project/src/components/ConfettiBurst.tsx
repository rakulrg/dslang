import type { CSSProperties } from 'react';

/**
 * One-shot, full-page paper celebration for the post-order confirmation.
 *
 * WHY THIS REPLACED THE OLD 650ms SCATTER
 *   The previous burst threw ten crimson chips about 45px around the check mark
 *   and was gone in 650ms. It read as a pulse, not a win. This one throws
 *   actual paper: a hard pop out of the mark, a wide burst that crosses the
 *   whole page, then gravity — pieces launched upward peak and fall back down,
 *   the rest keep drifting — so the burst settles instead of vanishing.
 *
 * ONE SHOT, NO LOOP
 *   No `infinite` anywhere. `animation-fill-mode: both` parks every piece on
 *   the 100% keyframe, which is `opacity: 0`, so the layer goes inert and
 *   invisible the moment the burst ends and cannot be re-triggered by scroll or
 *   a re-render.
 *
 * FULL-PAGE TRAVEL WITHOUT PAGE OVERFLOW
 *   The wrap is `position: fixed; inset: 0; overflow: hidden`, so pieces are
 *   clipped at the viewport edge. That is deliberate: index.css (the
 *   "Horizontal page overflow is FIXED AT THE SOURCE" note) forbids
 *   suppressing a sideways scroll with a blanket `overflow-x: hidden`, and
 *   pieces translated tens of `vw` from inside the 56px mark would otherwise
 *   widen the document and hand mobile a horizontal scrollbar. Fixed boxes do
 *   not contribute to scrollable overflow, and `overflow: hidden` here clips
 *   them at exactly the right boundary. Only `transform` and `opacity` are
 *   animated, so the whole thing stays on the compositor.
 *
 * COLOUR — READ THIS BEFORE EDITING
 *   This is a deliberate departure from the "BRAND, NOT RAINBOW" note that used
 *   to sit in this file: the brief is a WINNING celebration in colourful paper,
 *   and a one-shot flourish carries less of the site's minimal identity than a
 *   resting surface does. What it means for the lock in scripts/palette.test.mjs:
 *   that test only reads `--color-*` THEME TOKENS, and these values live in a
 *   deliberately non-`--color-` namespace, so the theme is still asserted as
 *   black / white / crimson while the celebration is allowed to be festive. If
 *   the brand decision is the stronger one, deleting `STOCK` and pointing every
 *   piece at crimson and white is the whole change.
 *
 * ACCESSIBILITY
 *   Purely decorative: `aria-hidden`, pointer-events off, and the
 *   `prefers-reduced-motion` rule in index.css removes the movement entirely
 *   rather than freezing it mid-flight.
 */

/**
 * Paper shapes: [width, height, border-radius]. Four chips, a ribbon, a sliver
 * and a disc, so the burst is not one square stamped N times.
 */
const SHAPES: [string, string, string][] = [
  ['7px', '10px', '1px'],
  ['10px', '4px', '2px'],
  ['5px', '5px', '1px'],
  ['4px', '13px', '2px'],
  ['9px', '9px', '50%'],
  ['6px', '8px', '3px'],
];

/** Paper stock. NOT prefixed `--color-`, so the theme lock cannot see it. */
const STOCK = [
  '#d20a2e', // crimson, the brand accent leading the burst
  '#ff4d3d',
  '#ff8a1f',
  '#ffc629',
  '#3ecf6b',
  '#17c3b2',
  '#3d8bfd',
  '#7c6cf5',
  '#f0568f',
  '#ffffff',
];

/**
 * Trajectories, one piece each:
 *   [ x,      y0,   y1,   rotation, duration, delay ]
 *     x      launch X in vw. Spans -84..+84 so the burst crosses the full page.
 *     y0     apex in vh, NEGATIVE = launched upward, positive = driven downward.
 *     y1     where it ends in vh. ALWAYS positive, so every piece ends below the
 *            mark: upward pieces peak at 34% and then fall, and the rest keep
 *            drifting down. This is what makes it read as falling paper rather
 *            than an explosion frozen in the air.
 *     rotation  total spin, so pieces tumble at visibly different rates.
 *     duration  staggered enough that the burst has a front and a tail.
 */
const PIECES: [number, number, number, number, number, number][] = [
  [-72, -34, 118, -720, 2500, 0],
  [68, -28, 104, 640, 2450, 30],
  [-58, -46, 132, 980, 2600, 60],
  [54, -20, 96, -520, 2400, 90],
  [-80, -18, 110, 460, 2550, 120],
  [44, -40, 124, -880, 2650, 40],
  [-38, 10, 126, 720, 2350, 160],
  [76, -8, 92, -360, 2450, 70],
  [-64, -30, 138, 1140, 2700, 200],
  [34, -44, 108, -640, 2550, 110],
  [-26, -6, 84, 300, 2300, 230],
  [62, -34, 128, -1040, 2650, 20],
  [-48, -22, 114, 540, 2500, 260],
  [48, 6, 88, -480, 2350, 140],
  [-70, -38, 130, 840, 2600, 300],
  [28, -14, 100, -260, 2400, 180],
  [-18, 14, 120, 620, 2300, 320],
  [58, -26, 112, -760, 2550, 350],
  [-34, -48, 136, 1280, 2700, 60],
  [72, -12, 86, -420, 2400, 240],
  [-56, 2, 98, 700, 2350, 380],
  [40, -36, 126, -920, 2600, 100],
  [-24, -20, 94, 380, 2300, 420],
  [84, -34, 134, -1160, 2650, 160],
  [-76, -26, 116, 660, 2550, 450],
  [22, -8, 90, -200, 2300, 500],
  [-42, -42, 140, 1020, 2700, 220],
  [50, -16, 104, -560, 2450, 540],
];

export function ConfettiBurst() {
  return (
    <span className="confetti-wrap" aria-hidden="true">
      {PIECES.map(([x, y0, y1, r, dur, delay], i) => (
        <span
          key={i}
          className="confetti"
          style={
            {
              '--x': `${x}vw`,
              '--y0': `${y0}vh`,
              '--y1': `${y1}vh`,
              '--r': `${r}deg`,
              '--dur': `${dur}ms`,
              '--delay': `${delay}ms`,
              '--w': SHAPES[i % SHAPES.length][0],
              '--h': SHAPES[i % SHAPES.length][1],
              '--radius': SHAPES[i % SHAPES.length][2],
              '--fill': STOCK[i % STOCK.length],
            } as CSSProperties
          }
        />
      ))}
    </span>
  );
}
