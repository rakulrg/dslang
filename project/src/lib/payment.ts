import { supabase } from '@/lib/supabase';

/**
 * Payment abstraction layer — the only place payment-provider specifics live.
 *
 * Strategy: the frontend NEVER touches payment credentials. Credentials live
 * server-side only (Vercel serverless functions under /api, e.g.
 * api/cashfree-order) and this layer calls them. When no gateway is configured
 * for the current deployment, the config flag is OFF: checkout records the
 * order as pending and surfaces an honest "payment configuration pending"
 * message instead of faking a success.
 *
 * Activation (deployment step, NOT done in this local session):
 *   VITE_PAYMENT_PROVIDER=cashfree
 *   VITE_PAYMENT_CLIENT_CONFIGURED=true
 *   server env (Vercel project Environment Variables): CASHFREE_APP_ID,
 *       CASHFREE_SECRET_KEY, CASHFREE_ENV (TEST|PRODUCTION), SUPABASE_URL,
 *       SUPABASE_SERVICE_ROLE_KEY, APP_ORIGIN.
 */

/** Base origin of the serverless API. Vercel serves the SPA and /api on the
 *  same origin, so in production a relative path resolves correctly. For local
 *  development, point VITE_API_BASE_URL at a deployed Vercel preview/prod. */
const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');
function apiUrl(path: string): string {
  return API_BASE ? `${API_BASE}${path}` : `/api${path}`;
}

export type PaymentProvider = 'none' | 'cashfree';

export interface PaymentGatewayConfig {
  provider: PaymentProvider;
  configured: boolean;
  /** Human-readable status for the checkout UI. */
  status: 'off' | 'pending' | 'ready';
}

export interface PaymentSessionRequest {
  orderRef: string;
  orderId: string;
  amount: number; // total amount in INR (decimal number, not paise)
  customer: { name: string; phone: string; email?: string };
}

export interface PaymentSession {
  provider: PaymentProvider;
  orderRef: string;
  /** Provider payment/reference id when a session is created. */
  paymentId: string | null;
  /** Final authoritative state from the gateway. */
  status: 'pending' | 'success' | 'failed' | 'unavailable';
  redirectUrl?: string;
  /** Cashfree payment_session_id used to open the hosted Web Checkout. */
  paymentSessionId?: string;
  /** Cashfree SDK environment: 'TEST' (sandbox) or 'PROD' (production). */
  environment?: 'TEST' | 'PROD';
  /** URL the hosted checkout returns the customer to. */
  returnUrl?: string;
}

export interface PaymentVerification {
  verified: boolean;
  status: 'success' | 'failed' | 'pending' | 'unavailable';
  order: Record<string, unknown> | null;
}

const PROVIDER = (import.meta.env.VITE_PAYMENT_PROVIDER ?? 'none') as PaymentProvider;

/**
 * Whether the gateway is wired up for the CURRENT deployment. The provider key
 * presence is intentionally never inspected in the browser bundle — only a
 * boolean "configured" flag is derived from build-time config.
 */
export function getPaymentConfig(): PaymentGatewayConfig {
  const configured =
    PROVIDER === 'cashfree' && Boolean(import.meta.env.VITE_PAYMENT_CLIENT_CONFIGURED);
  if (PROVIDER === 'none') return { provider: 'none', configured: false, status: 'off' };
  if (!configured) return { provider: PROVIDER, configured: false, status: 'pending' };
  return { provider: PROVIDER, configured: true, status: 'ready' };
}

/**
 * Creates a Cashfree payment session for an order. Provider-agnostic: the retail
 * order is first logged server-side (awaiting payment), then this initiates
 * payment through the server-held-credentials endpoint (cashfree-order).
 *
 * Until the gateway + server env is configured this returns an honest
 * "unavailable / pending configuration" session and does NOT fake payment.
 */
export async function createPaymentSession(req: PaymentSessionRequest): Promise<PaymentSession> {
  const cfg = getPaymentConfig();
  if (PROVIDER === 'none' || !cfg.configured) {
    return {
      provider: PROVIDER,
      orderRef: req.orderRef,
      paymentId: null,
      status: 'unavailable',
    };
  }

  const response = await fetch(apiUrl('/cashfree-order'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId: req.orderId, orderRef: req.orderRef }),
  });
  let data: any;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok || !data?.success || !data.paymentSessionId) {
    // Log the technical detail server/debug side; surface only a clean message.
    // eslint-disable-next-line no-console
    console.error('[checkout] Payment session init failed:', response.status, data ?? response.statusText);
    throw new Error('The online payment could not be started. Your order has not been charged.');
  }
  return {
    provider: 'cashfree',
    orderRef: req.orderRef,
    paymentId: data.orderId ?? null,
    status: 'pending',
    paymentSessionId: data.paymentSessionId as string,
    environment: (data.environment === 'PROD' ? 'PROD' : 'TEST') as PaymentSession['environment'],
    returnUrl: data.returnUrl as string,
  };
}

/**
 * Asks the secure backend for the authoritative, verified payment state of an
 * order (used right after returning from the gateway — never trusting a
 * browser success page or URL parameter).
 */
export async function verifyPayment(orderRef: string): Promise<PaymentVerification> {
  const cfg = getPaymentConfig();
  if (!cfg.configured || PROVIDER !== 'cashfree') {
    return { verified: false, status: 'unavailable', order: null };
  }
  const { data, error } = await supabase.functions.invoke('cashfree-status', {
    body: { orderRef },
  });
  if (error || !data) {
    // eslint-disable-next-line no-console
    console.error('[checkout] Payment verification failed:', error ?? data);
    return { verified: false, status: 'unavailable', order: null };
  }
  return {
    verified: Boolean(data.verified),
    status: data.status as PaymentVerification['status'],
    order: data.order ?? null,
  };
}

/** Plain-text note used in checkout to explain the payment state. */
export function paymentStatusMessage(): string {
  const cfg = getPaymentConfig();
  if (cfg.status === 'ready') return 'Payment is processed securely by ' + cfg.provider.toUpperCase() + '.';
  if (cfg.status === 'pending') {
    return 'Online payment is being set up. Your order is recorded and a confirmation SMS is sent.';
  }
  return 'Online payment is not configured. Your order is recorded and a confirmation SMS is sent.';
}