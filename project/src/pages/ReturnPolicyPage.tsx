import {
  PolicyPageShell,
  PolicySection,
  PolicyP,
  PolicyOl,
  PolicyNote,
  POLICY_BUSINESS,
} from '@/lib/policies';

export function ReturnPolicyPage() {
  return (
    <PolicyPageShell
      eyebrow="Legal"
      title="Return Policy"
      intro={
        <>
          This Return Policy sets out how returns and exchanges are handled by{' '}
          <span className="text-bone">{POLICY_BUSINESS}</span>. It forms part of our Terms &
          Conditions and should be read alongside our Refund & Cancellation Policy.
        </>
      }
    >
      <PolicySection num={1} title="Return & Exchange Window">
        <PolicyOl
          items={[
            'Returns and exchanges are accepted within 7 days of the delivery date.',
            'To start a return or exchange, contact us on WhatsApp, by email at hello.dslang@gmail.com, or through our Contact page, quoting your order number.',
            'Items being exchanged are subject to size and stock availability. Where an exchange is not possible, a refund may be offered instead.',
          ]}
        />
      </PolicySection>

      <PolicySection num={2} title="Condition of Returned Items">
        <PolicyOl
          items={[
            'Products must be unused, unworn and in the same condition as they were received.',
            'Original packaging and tags must be retained and returned with the product.',
            'Items must be returned with all included accessories or materials that accompanied them.',
          ]}
        />
      </PolicySection>

      <PolicySection num={3} title="Sale & Final-Sale Items">
        <PolicyP>
          Sale or clearance items may be excluded from return or exchange where applicable. Clearance
          lots and items labelled as final sale are non-returnable and non-exchangeable.
        </PolicyP>
      </PolicySection>

      <PolicySection num={4} title="Defective or Damaged Items">
        <PolicyP>
          Defective or damaged items can be replaced after inspection. Report the issue within 7 days
          of receiving the product, with clear photos and your order number. Following verification,
          we will arrange a replacement or, where a replacement is not available, a refund under our
          Refund & Cancellation Policy.
        </PolicyP>
      </PolicySection>

      <PolicySection num={5} title="How Return Shipping Is Handled">
        <PolicyP>
          Return shipping arrangements are coordinated with you when your return is approved. The
          manner and any cost of returning an item depend on the reason for the return, as we explain
          on a case-by-case basis.
        </PolicyP>
      </PolicySection>

      <PolicyNote>
        Summaries on product pages or in order confirmations are for convenience only — the terms on
        this page are the binding Return Policy.
      </PolicyNote>
    </PolicyPageShell>
  );
}