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

function loadSdk(): Promise<void> {
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise<void>((resolve, reject) => {
    if (typeof window === 'undefined') {
      reject(new Error('Cashfree SDK is only supported in the browser.'));
      return;
    }
    if (window.Cashfree) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = SDK_URL;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      sdkPromise = null;
      reject(new Error('Could not load the payment gateway. Please try again.'));
    };
    document.head.appendChild(script);
  });
  return sdkPromise;
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
  // eslint-disable-next-line no-console
  console.log('[checkout] cashfree checkout diag', {
    provider: getPaymentConfig().provider,
    configured: getPaymentConfig().configured,
    paymentSessionId: opts.paymentSessionId,
    environment: opts.environment,
    sdkMode: toCashfreeMode(opts.environment),
  });
  const result = await cashfree.checkout({
    paymentSessionId: opts.paymentSessionId,
    redirectTarget: opts.redirectTarget ?? '_self',
  });
  if (result?.redirect) {
    // The hosted checkout is redirecting the customer; the SPA will verify the
    // payment server-side when they land back on the return URL.
    return;
  }
  if (result?.error?.message) {
    // NEVER surface the raw gateway message to the customer — it can contain
    // technical/configuration detail. Log it for debugging, throw a clean message.
    // eslint-disable-next-line no-console
    console.error('[checkout] Payment gateway error:', result.error.message);
    throw new Error('The payment window could not be opened. Your order has not been charged.');
  }
}