/**
 * Ref-counted body scroll lock shared by every overlay (cart drawer, nav menu,
 * search, login modal). Using a counter means overlapping overlays lock/unlock
 * safely instead of clobbering each other's state.
 *
 * Locks BOTH <html> and <body>: `overflow: hidden` on body alone does not stop
 * the background from scrolling on iOS Safari, and `overscroll-behavior: none`
 * kills scroll chaining from an overlay's own scrollable area back to the page.
 */

let count = 0;
let saved: {
  htmlOverflow: string;
  bodyOverflow: string;
  bodyPaddingRight: string;
  bodyOverscroll: string;
} | null = null;

export function lockScroll() {
  if (count === 0) {
    const body = document.body;
    const html = document.documentElement;
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    saved = {
      htmlOverflow: html.style.overflow,
      bodyOverflow: body.style.overflow,
      bodyPaddingRight: body.style.paddingRight,
      bodyOverscroll: body.style.overscrollBehavior,
    };
    html.style.overflow = 'hidden';
    body.style.overflow = 'hidden';
    if (scrollbarWidth > 0) body.style.paddingRight = `${scrollbarWidth}px`;
    body.style.overscrollBehavior = 'none';
  }
  count += 1;
}

export function unlockScroll() {
  if (count === 0) return;
  count -= 1;
  if (count === 0 && saved) {
    const body = document.body;
    const html = document.documentElement;
    html.style.overflow = saved.htmlOverflow;
    body.style.overflow = saved.bodyOverflow;
    body.style.paddingRight = saved.bodyPaddingRight;
    body.style.overscrollBehavior = saved.bodyOverscroll;
    saved = null;
  }
}