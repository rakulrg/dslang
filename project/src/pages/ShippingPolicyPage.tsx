import {
  PolicyPageShell,
  PolicySection,
  PolicyP,
  PolicyOl,
  PolicyNote,
  POLICY_BUSINESS,
} from '@/lib/policies';

export function ShippingPolicyPage() {
  return (
    <PolicyPageShell
      eyebrow="Legal"
      title="Shipping Policy"
      intro={
        <>
          This Shipping Policy explains how orders from{' '}
          <span className="text-bone">{POLICY_BUSINESS}</span> are shipped and delivered. It forms
          part of our Terms & Conditions.
        </>
      }
    >
      <PolicySection num={1} title="Shipping Method">
        <PolicyOl
          items={[
            'Orders are shipped through domestic courier services and/or Speed Post.',
            'The courier or postal partner and any tracking reference for your order will be shared with you once the order is dispatched.',
          ]}
        />
      </PolicySection>

      <PolicySection num={2} title="Dispatch Time">
        <PolicyOl
          items={[
            'Orders are shipped within 5 days from the date of order or payment, unless a different delivery date is communicated to you.',
            'In many cases dispatch happens sooner, but the 5-day window is the confirmed maximum for standard orders.',
          ]}
        />
      </PolicySection>

      <PolicySection num={3} title="Delivery Address">
        <PolicyP>
          Delivery is made to the address provided by you at checkout. Please ensure your name,
          phone number and address are correct, since we rely on these details to deliver your order.
          We are not responsible for non-delivery caused by incorrect or incomplete address details.
        </PolicyP>
      </PolicySection>

      <PolicySection num={4} title="Delivery Timeline & Courier Delays">
        <PolicyOl
          items={[
            'Estimated delivery times depend on your location and on the courier or postal network.',
            "Courier, postal or weather-related delays are outside DSLANG's direct control. Where such a delay occurs, we will keep you informed and make best efforts to see your order delivered, but we are not liable for delays caused by the courier or postal service.",
          ]}
        />
      </PolicySection>

      <PolicySection num={5} title="Shipping Charges">
        <PolicyP>
          Shipping charges, where applicable, are shown at checkout before you place your order.
          Shipping charges are non-refundable where applicable. Orders above a specified merchandise
          value may qualify for free shipping, as reflected at checkout.
        </PolicyP>
      </PolicySection>

      <PolicySection num={6} title="Not Able to Deliver">
        <PolicyP>
          If a delivery attempt is unsuccessful or an order is returned to us as undeliverable, we
          will contact you to arrange redelivery or a refund of the product value in line with our
          Refund & Cancellation Policy.
        </PolicyP>
      </PolicySection>

      <PolicyNote>Questions about shipping? Contact us on WhatsApp or via email for assistance.</PolicyNote>
    </PolicyPageShell>
  );
}