import {
  PolicyPageShell,
  PolicySection,
  PolicyP,
  PolicyOl,
  PolicyNote,
  POLICY_BUSINESS,
} from '@/lib/policies';

export function RefundCancellationPage() {
  return (
    <PolicyPageShell
      eyebrow="Legal"
      title="Refund & Cancellation Policy"
      intro={
        <>
          This policy explains how cancellations, refunds and claims for damaged, defective or
          not-as-described products are handled by <span className="text-bone">{POLICY_BUSINESS}</span>.
          It forms part of our Terms & Conditions.
        </>
      }
    >
      <PolicySection num={1} title="Order Cancellation">
        <PolicyP>
          If you have an account with us, you can request cancellation of an order from the{' '}
          <span className="text-bone">My Orders</span> section of your account. A cancellation can
          only be requested while the order is eligible — that is, before it has been dispatched or
          handed to the courier, and while it is not already in a final state such as cancelled or
          refunded.
        </PolicyP>
        <PolicyP>
          <span className="text-bone">Submitting a request does not cancel your order.</span> Your
          request is reviewed by our team, and an administrator will approve or reject it. Until a
          request is approved, your order stays exactly as it is, and any stock held for it remains
          reserved.
        </PolicyP>
        <PolicyOl
          items={[
            'If the request is approved, and the order is still eligible at that time, the order is cancelled and any reserved inventory is restored where applicable.',
            'If the request is rejected, your order and its payment state are left unchanged and it continues to be processed as normal.',
            'You can follow the status of your request and its decision, along with any refund tracking, in My Orders.',
            'Orders that have already been shipped, or that are in an incompatible shipping state, cannot be cancelled through this feature. In that case, please contact DSLANG support and we will help you with the available options — for example a return under our Return Policy once the order is received.',
            'Cancellation requests are not available for guest orders in this release. If you checked out without an account and need help, please contact DSLANG support.',
          ]}
        />
        <PolicyP>
          If you prefer, or if you cannot use My Orders, you can reach us on WhatsApp, by email at
          hello.dslang@gmail.com, or through our Contact page, quoting your order number.
        </PolicyP>
      </PolicySection>

      <PolicySection num={2} title="Damaged or Defective Products">
        <PolicyOl
          items={[
            'Report any product received damaged, defective or with a dispatch-error within 7 days of receiving the product.',
            'Please provide your order number, clear photos of the issue, and a short description.',
            'Once verified, we will arrange a replacement or a refund, as appropriate.',
          ]}
        />
      </PolicySection>

      <PolicySection num={3} title="Product Not As Described">
        <PolicyOl
          items={[
            'Complaints where a product does not match its description must be reported within 7 days of delivery.',
            'Provide your order number and a description (with photos where helpful) of how the product differs from what was shown.',
            'We will verify the claim and, if confirmed, offer a replacement or a refund.',
          ]}
        />
      </PolicySection>

      <PolicySection num={4} title="Refund Processing">
        <PolicyP>
          <span className="text-bone">
            Approving a cancellation does not mean a refund has been completed.
          </span>{' '}
          It confirms that the order has been cancelled. Any refund that is due is then processed
          separately, and it is shown as pending until the money has actually been refunded and the
          refund has been confirmed.
        </PolicyP>
        <PolicyOl
          items={[
            'Refunds are issued to the original payment method used for the order. The time taken for the amount to reflect may depend on the payment provider or your bank, and we cannot guarantee a fixed timeline for when it will appear in your account.',
            'For an order paid online, any approved cancellation where money was collected is recorded as a refund pending. It stays pending until the refund has been made and confirmed; only then is it shown as completed.',
            'For a cash-on-delivery order where no amount was collected in advance, no refund is due, because no money was taken.',
            'For a cash-on-delivery order where an advance amount was collected, that refund is recorded as pending and is processed and confirmed in the same way.',
            'Shipping charges are non-refundable where applicable.',
          ]}
        />
        <PolicyP>
          Refunds are handled manually by our team; they are not automatic. We will keep the refund
          status on the order up to date so you can see whether a refund is pending or has been
          completed.
        </PolicyP>
      </PolicySection>

      <PolicySection num={5} title="WhatsApp Confirmation">
        <PolicyP>
          Every order is personally reviewed by the {POLICY_BUSINESS} team, and order-related updates
          — including where a cancellation or refund is confirmed — are communicated on WhatsApp where
          a valid number was provided.
        </PolicyP>
      </PolicySection>

      <PolicyNote>
        Need to return an eligible item? See our Return Policy for the 7-day return window and the
        conditions for returned products.
      </PolicyNote>
    </PolicyPageShell>
  );
}