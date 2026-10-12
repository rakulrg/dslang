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
 *
 * ---------------------------------------------------------------------
 * variant="button" — the same marks, on the buttons that START a payment.
 *
 * The card row above is a quiet "we accept" signal on a WHITE surface, so
 * unboxed full-colour artwork is both correct and legible there. A button is
 * the opposite case: Buy Now / Cart / Pay Now all sit on `--color-bone`
 * (#1a1a1a) or `--color-crimson` (#d20a2e), and measured against those fills
 * the unboxed marks collapse:
 *
 *     mark            vs #1a1a1a     vs #d20a2e
 *     Google Pay        7.05:1         2.05:1
 *     PhonePe            1.85:1         1.87:1
 *     Paytm              1.39:1         2.49:1
 *
 * Paytm's navy is 1.39:1 on the black button — effectively invisible — and
 * PhonePe sits under 3:1 (the WCAG AA threshold for non-text content) on
 * both. So on a dark fill each mark sits in its own small WHITE CIRCLE. That
 * is the standard treatment for brand marks on dark surfaces, and the only one
 * that works without touching the artwork: the circle is a container, not a
 * redraw, so the marks keep their true brand colour and the trust signal above
 * is preserved rather than traded away.
 *
 * THE CIRCLE. `border-radius: 50%` over a square white box, sized 15px on
 * mobile and 16px from `sm` — inside the 14–16px band the design calls for.
 * The mark is centred in it at 11px/12px, which holds a constant 2px inset on
 * every side at both breakpoints, so the white ring around each mark is even
 * and the three circles read as one set rather than three differently padded
 * ones. `object-fit: contain` does the fitting: G Pay is 1.17:1 and PhonePe
 * and Paytm are square, so a fixed WIDTH would squash the wide one and a fixed
 * HEIGHT would crop it. `contain` letterboxes each mark inside its square box
 * instead, which is what makes distortion structurally impossible here.
 *
 * Only the three APP marks appear in a button. The Visa + Mastercard lockup
 * is 3:1 — a card-network pair, not an app you tap — and a wide fourth mark
 * would crowd the label on a button sized for three.
 *
 * The circles are deliberately confined to this variant. The card row keeps its
 * unboxed treatment and its crimson SAVE badge stays uncontested.
 */

import type { CSSProperties } from 'react';

/** Shared VISIBLE mark height, in px. Widths follow from each file's ratio. */
const MARK_H = 26;

/** One even gap for the whole band, in px. */
const MARK_GAP = 11;

/**
 * Button-variant gap, in px. Tighter than the card row's 11px because these
 * sit inside a single control next to its own label, and the group has to read
 * as a compact inset rather than a second element competing with the label.
 */
const BUTTON_MARK_GAP = 3;

/**
 * Intrinsic pixel size of each file AFTER cropping to its opaque bounding box.
 * Used only for the width/height attributes, which reserve the box before the
 * image loads (no layout shift) and let the browser keep the ratio.
 */
const ONLINE_MARKS = [
  { src: '/logos/gpay.png', w: 96, h: 82, name: 'Google Pay' },
  { src: '/logos/phonepe.png', w: 256, h: 256, name: 'PhonePe' },
  { src: '/logos/paytm.png', w: 254, h: 256, name: 'Paytm' },
] as const;

/** The wide card-network lockup — accepted, but not an app, so never on a button. */
const CARD_LOCKUP = { src: '/logos/visa-mastercard.png', w: 750, h: 250, name: 'Visa and Mastercard' } as const;

const MARKS = [...ONLINE_MARKS, CARD_LOCKUP] as const;

/**
 * The "accepted methods" row inside the Online Payment card: G Pay, PhonePe,
 * Paytm and the Visa + Mastercard lockup. Four marks and nothing else — no
 * overflow affordance, because the list is the complete set this store accepts.
 *
 * `variant="button"` swaps in the compact, circled three-mark group documented
 * at the top of this file, for the buttons that start a payment.
 * The default is unchanged, so the card call site needs no edit.
 */
export function PaymentMethodsRow({ variant = 'card' }: { variant?: 'card' | 'button' } = {}) {
  if (variant === 'button') {
    return (
      <span
        className="inline-flex shrink-0 items-center"
        style={{ gap: `${BUTTON_MARK_GAP}px` }}
        role="img"
        aria-label="Google Pay, PhonePe and Paytm accepted"
      >
        {ONLINE_MARKS.map((m) => (
          // A square white box closed into a true circle by `border-radius: 50%`.
          // The circle is the >=3:1 surface each mark needs on a dark button; the
          // mark is centred in it at 11px/12px, a constant 2px inset from the
          // rim at both breakpoints, and `object-contain` fits the artwork into
          // that square without ever distorting it.
          <span
            key={m.src}
            className="inline-flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-[50%] bg-white sm:h-[16px] sm:w-[16px]"
          >
            <img
              src={m.src}
              alt=""
              aria-hidden
              decoding="async"
              className="h-[11px] w-[11px] shrink-0 object-contain sm:h-[12px] sm:w-[12px]"
              width={m.w}
              height={m.h}
            />
          </span>
        ))}
      </span>
    );
  }

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
