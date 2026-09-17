/**
 * Cashfree Web Checkout (hosted drop-in) loader.
 *
 * Loads the official Cashfree JS SDK (v3) from their CDN on demand, initializes
 * it with the correct mode (sandbox/production, derived server-side and passed
 * back from cashfree-order), and opens the hosted checkout for a given
 * payment_session_id. No credentials are ever touched in the browser.
 */

declare global {
  interface Window {
    Cashfree?: (opts: { mode: 'sandbox' | 'production' }) => {
      checkout: (opts: {
        paymentSessionId: string;
        redirectTarget?: string;
      }) => Promise<{ error?: { message?: string }; redirect?: boolean }>;
    };
  }
}

import { getPaymentConfig } from './payment';

const SDK_URL = 'https://sdk.cashfree.com/js/v3/cashfree.js';

function toCashfreeMode(environment: 'TEST' | 'PROD'): 'sandbox' | 'production' {
  return environment === 'PROD' ? 'production' : 'sandbox';
}

let sdkPromise: Promise<void> | null = null;

const SDK_LOAD_TIMEOUT_MS = 15000;
const CHECKOUT_TIMEOUT_MS = 20000;

function loadSdk(): Promise<void> {
  if (sdkPromise) return sdkPromise;
  if (window.Cashfree) return Promise.resolve();
  sdkPromise = new Promise<void>((resolve, reject) => {
    if (typeof window === 'undefined') {
      reject(new Error('Cashfree SDK is only supported in the browser.'));
      return;
    }
    const script = document.createElement('script');
    script.src = SDK_URL;
    script.async = true;

    let settled = false;
    const finish = (err: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        sdkPromise = null;
        reject(err);
      } else {
        resolve();
      }
    };

    script.onload = () => finish(null);
    script.onerror = () => finish(new Error('Could not load the payment gateway. Please try again.'));

    const timer = window.setTimeout(
      () => finish(new Error('Could not load the payment gateway. Please try again.')),
      SDK_LOAD_TIMEOUT_MS
    );

    document.head.appendChild(script);
  });
  return sdkPromise;
}

/**
 * Warm the SDK cache in the background so that when the customer clicks Pay
 * the redirect to Cashfree happens with zero additional download wait. Safe to
 * call early (e.g. when the checkout page renders); failures are swallowed
 * here and re-surfaced on the actual openCashfreeCheckout() call.
 */
export function preloadCashfreeSdk(): void {
  if (typeof window === 'undefined') return;
  void loadSdk().catch(() => {});
}

/**
 * Opens the Cashfree hosted checkout. Resolves when Cashfree responds (either
 * a redirect is being started, or an error occurred). Does NOT navigate the app
 * before opening checkout.
 */
export async function openCashfreeCheckout(opts: {
  paymentSessionId: string;
  environment: 'TEST' | 'PROD';
  redirectTarget?: string;
}): Promise<void> {
  await loadSdk();
  if (!window.Cashfree) {
    throw new Error('Could not open the payment gateway. Please try again.');
  }
  const cashfree = window.Cashfree({ mode: toCashfreeMode(opts.environment) });

  // The SDK's checkout() promise must not be able to hang the checkout page
  // forever (e.g. the hosted page stalls before it can start a redirect). The
  // SDK may open the hosted checkout in a hidden form/iframe where its promise
  // only settles once the payment page posts a result — if that post never
  // arrives (CDN/network stall, popup blocked, gateway hiccup), the await
  // below would never resume. Race it so a clean timeout always wins.
  let timer: number | undefined;
  let settled: { error?: { message?: string }; redirect?: boolean } | undefined;
  let checkoutError: unknown;
  try {
    const checkoutPromise = cashfree.checkout({
      paymentSessionId: opts.paymentSessionId,
      redirectTarget: opts.redirectTarget ?? '_self',
    });
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = window.setTimeout(() => {
        reject(new Error('The payment window timed out.'));
      }, CHECKOUT_TIMEOUT_MS);
    });
    settled = await Promise.race([checkoutPromise, timeoutPromise]);
  } catch (err) {
    checkoutError = err;
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }

  if (settled?.redirect) {
    // The hosted checkout is redirecting the customer; the SPA will verify the
    // payment server-side when they land back on the return URL.
    return;
  }
  if (settled?.error?.message) {
    // NEVER surface the raw gateway message to the customer — it can contain
    // technical/configuration detail. Log it for debugging, throw a clean message.
    // eslint-disable-next-line no-console
    console.error('[checkout] Payment gateway error:', settled.error.message);
    throw new Error('The payment window could not be opened. Your order has not been charged.');
  }
  if (checkoutError) {
    // eslint-disable-next-line no-console
    console.error('[checkout] Payment gateway threw:', checkoutError);
    throw new Error('The payment window could not be opened. Your order has not been charged.');
  }
}