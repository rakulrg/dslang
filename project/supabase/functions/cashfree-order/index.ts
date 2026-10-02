// ============================================================================
// DECOMMISSIONED — do not use. This function is intentionally inert.
//
// WHY IT EXISTS AS A FILE: it used to be a SECOND, full copy of the Cashfree
// "create payment order" logic. The storefront never called it (src/lib/payment.ts
// only ever calls the Vercel route `/api/cashfree-order`, optionally rebased onto
// VITE_API_BASE_URL), so it was a dormant second copy of the money path that
// could silently drift from the live one — it still defaulted CASHFREE_ENV to
// TEST, hardcoded a production APP_ORIGIN fallback, performed NO caller
// authorization, and overwrote payment_id unconditionally.
//
// IT NOW ANSWERS 410 GONE so a stale client or a mistaken direct call fails
// loudly instead of quietly creating payment sessions through an unauthorized
// path. The live payment-start implementation is:
//
//     api/cashfree-order.ts          (Vercel serverless function — authoritative)
//
// NOT AFFECTED by this decommission (all still live and required):
//     supabase/functions/cashfree-status     — authoritative payment verification
//     supabase/functions/cashfree-webhook    — Cashfree payment callbacks
//     supabase/functions/expire-stale-orders — abandoned-order sweep
//     supabase/functions/auto-ship-orders    — post-grace shipment sweep
//
// TO FULLY REMOVE: after confirming no client hits this endpoint, delete the
// `supabase/functions/cashfree-order` directory and run
//     supabase functions delete cashfree-order
// This is intentionally NOT done here: deleting a deployed function is an
// irreversible, remote change.
// ============================================================================

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

Deno.serve((req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  return new Response(
    JSON.stringify({
      success: false,
      code: 'PAYMENT_START_MOVED',
      error: 'This payment endpoint has been decommissioned.',
    }),
    { status: 410, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
  );
});
