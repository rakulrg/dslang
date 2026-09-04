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
        <PolicyP>You may cancel an order in the following circumstances:</PolicyP>
        <PolicyOl
          items={[
            'Cancellation requests are accepted within 7 days of placing the order.',
            'Cancellation is subject to the order not already having been shipped or being out for delivery.',
            'Once an order has been dispatched, it can no longer be cancelled, but may instead be returned under our Return Policy once received.',
          ]}
        />
        <PolicyP>
          To request a cancellation, contact us on WhatsApp, by email at hello.dslang@gmail.com, or
          through our Contact page, quoting your order number.
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
        <PolicyOl
          items={[
            'Approved refunds are processed within 5 days of the refund being approved.',
            'The refund is issued to the original payment method used for the order. Actual credit timing may depend on the payment provider or bank.',
            'Shipping charges are non-refundable where applicable.',
          ]}
        />
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