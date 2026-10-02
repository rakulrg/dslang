/**
 * Payment-brand marks for the checkout "Online Payment" card.
 *
 * Cashfree's hosted Web Checkout (the drop-in this store uses) accepts Google
 * Pay, PhonePe, Paytm, Visa and Mastercard. This row is a quiet "we accept"
 * signal — one compact line of marks on a single even gap, so it reads as a
 * band rather than a wall of logos.
 *
 * COLOUR. Every mark is real brand artwork in its real brand colour. A shopper
 * identifies their method by colour first, so draining these to one ink would
 * make the row both less useful and less trustworthy. The restraint here is
 * carried by COUNT, by SIZE, by GAP and by the absence of chip borders — not by
 * desaturating the artwork. Leaving the marks unboxed also keeps the row from
 * competing with the solid crimson SAVE badge in the card's top-right.
 *
 * PROVENANCE. *  - Google Pay, PhonePe and Paytm are the brand's own files, in /logos.
 *  - Visa + Mastercard is the supplied combined mark in visa-mastercard.png
 *    (750x250, exactly 3:1, fully opaque to all four edges so it needs no
 *    cropping). It carries both brands in the artwork, so it counts as ONE mark
 *    in this row rather than two.
 *
 * OPTICAL SIZING is the whole point of this component. The marks have very
 * different natural proportions (PhonePe and Paytm are square app marks, the
 * Visa + Mastercard lockup is 3:1, G Pay 1.17:1), and each shipped file also
 * carried its own transparent margin — Google's had 9px of dead space top and
 * bottom, and Mastercard's previous official artboard had ~12% on every side.
 * Left alone, "set every logo to 22px" would make them visibly different sizes,
 * because it would be scaling the FILE, not the ARTWORK.
 *
 * So every asset here is cropped to its own opaque bounding box (done once,
 * at build-prep time, in the source files) and the row is sized by height with
 * `width: auto`. That makes MARK_H mean visible ink at a constant height, and
 * `auto` width makes distortion structurally impossible — the browser keeps
 * each file's intrinsic ratio, and the numbers in MARKS below exist only to
 * reserve space before the files load so the row never reflows.
 *
 * The G Pay, PhonePe and Paytm files are the brands' compact/app marks rather
 * than horizontal wordmarks, so those three read as near-square marks beside
 * the wide card lockup; that is internally consistent, but see the note on the
 * checkout page before swapping to wordmarks.
 *
 * SIZE. 26px of visible ink, up from 22px. The marks are the reassurance that
 * the customer's own app will work, and at 22px inside a card whose price had
 * just grown they were the first thing to look under-scaled. Height is set
 * here rather than per-call-site so every surface showing this row stays in
 * step; the only caller is the checkout's online card.
 */

import type { CSSProperties } from 'react';

/** Shared VISIBLE mark height, in px. Widths follow from each file's ratio. */
const MARK_H = 26;

/** One even gap for the whole band, in px. */
const MARK_GAP = 11;

/**
 * Intrinsic pixel size of each file AFTER cropping to its opaque bounding box.
 * Used only for the width/height attributes, which reserve the box before the
 * image loads (no layout shift) and let the browser keep the ratio.
 */
const MARKS = [
  { src: '/logos/gpay.png', w: 96, h: 82, name: 'Google Pay' },
  { src: '/logos/phonepe.png', w: 256, h: 256, name: 'PhonePe' },
  { src: '/logos/paytm.png', w: 254, h: 256, name: 'Paytm' },
  { src: '/logos/visa-mastercard.png', w: 750, h: 250, name: 'Visa and Mastercard' },
] as const;

/**
 * The "accepted methods" row inside the Online Payment card: G Pay, PhonePe,
 * Paytm and the Visa + Mastercard lockup. Four marks and nothing else — no
 * overflow affordance, because the list is the complete set this store accepts.
 */
export function PaymentMethodsRow() {
  return (
    <span
      className="inline-flex items-center justify-center"
      style={{ gap: `${MARK_GAP}px` }}
      role="img"
      aria-label="Google Pay, PhonePe, Paytm, Visa and Mastercard accepted"
    >
      {MARKS.map((m) => (
        <img
          key={m.src}
          src={m.src}
          alt=""
          aria-hidden
          decoding="async"
          // height: auto width => MARK_H of visible ink, ratio preserved, so
          // the mark can never be squashed or stretched.
          style={{ height: `${MARK_H}px`, width: 'auto' } as CSSProperties}
          width={m.w}
          height={m.h}
          className="shrink-0 object-contain"
        />
      ))}
    </span>
  );
}
