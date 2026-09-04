import {
  PolicyPageShell,
  PolicySection,
  PolicyP,
  PolicyUl,
  PolicySubheading,
  POLICY_BUSINESS,
  POLICY_SITE,
  POLICY_ADDRESS,
} from '@/lib/policies';

export function PrivacyPolicyPage() {
  return (
    <PolicyPageShell
      eyebrow="Legal"
      title="Privacy Policy"
      intro={
        <>
          <span className="text-bone">{POLICY_BUSINESS}</span> respects your privacy. This Privacy
          Policy explains what information we collect through{' '}
          <span className="text-bone">{POLICY_SITE}</span>, how we use it, and the choices you have
          over your personal data.
        </>
      }
    >
      <PolicySection num={1} title="Information We Collect">
        <PolicyUl
          items={[
            'Identification and contact details you provide when ordering or signing in — such as your name, delivery address, phone number and (if provided) email address.',
            'The contents of your communication with us for order-related queries and customer support.',
            'Technical information collected automatically when you use the website, such as device type, browser and pages visited.',
          ]}
        />
      </PolicySection>

      <PolicySection num={2} title="Account & Customer Information">
        <PolicyP>
          If you create an account, we store the information you provide so that we can recognise you
          and, where applicable, maintain preferences you make known to us. An account is not required
          to place an order. You may delete your account or request that we delete your personal
          information as described in the "Account Deletion & Your Rights" section below.
        </PolicyP>
      </PolicySection>

      <PolicySection num={3} title="Transaction Information">
        <PolicyP>
          When you place an order, we record the products ordered, the amount, the delivery details
          and the payment outcome. Payment card or other payment details are not stored by us — they
          are processed by our payment gateway provider. We record only the payment reference needed
          to reconcile your order.
        </PolicyP>
      </PolicySection>

      <PolicySection num={4} title="How We Use Personal Data">
        <PolicyUl
          items={[
            'Order fulfilment — processing, packing and delivering your order.',
            'Customer support — answering your questions and resolving issues about an order.',
            'Order-related communication — notifying you about dispatch, delivery and payment status.',
            'Fraud prevention and security — detecting and preventing fraudulent or unlawful activity.',
          ]}
        />
      </PolicySection>

      <PolicySection num={5} title="Order Fulfilment & Customer Support">
        <PolicyP>
          We use your personal data primarily to complete and support your orders. This includes
          passing the minimum necessary delivery details to our courier or postal partners so that
          your order can be delivered, and contacting you for order-related matters.
        </PolicyP>
      </PolicySection>

      <PolicySection num={6} title="Fraud & Security">
        <PolicyP>
          We may process information to safeguard the website and our customers, including verifying
          that orders are genuine and that stock and payments are handled correctly. We do not misuse
          personal data for unrelated purposes.
        </PolicyP>
      </PolicySection>

      <PolicySection num={7} title="Third-Party Service Providers">
        <PolicySubheading title="Logistics & Payment Providers" />
        <PolicyP>We share personal data only with the service providers needed to run the store:</PolicyP>
        <PolicyUl
          items={[
            'Payment gateway providers who process payments on our behalf (they receive only the information required to complete the payment).',
            'Courier and postal partners who deliver your order (they receive your name and delivery address).',
            'Where applicable, platform providers that host or operate the website.',
          ]}
        />
        <PolicyP>
          We do not sell or rent your personal data, and we do not share it with third parties for
          their own marketing purposes.
        </PolicyP>
      </PolicySection>

      <PolicySection num={8} title="Data Retention">
        <PolicyP>
          We retain transaction and order records for as long as necessary to operate the store,
          respond to queries, and comply with financial and legal obligations, after which they are
          deleted or anonymised. You may request deletion of your personal information at any time,
          as described below.
        </PolicyP>
      </PolicySection>

      <PolicySection num={9} title="Account Deletion & Your Rights">
        <PolicyUl
          items={[
            'You may request access to, correction of, or deletion of the personal information we hold about you.',
            'You may ask us to stop processing your personal data for non-essential purposes.',
            'To exercise any of these rights, contact us through our Contact page, on WhatsApp, or by email at hello.dslang@gmail.com. We will respond within a reasonable time.',
          ]}
        />
        <PolicyP>
          Please note that certain records may need to be retained where required by law or to fulfil
          an outstanding order.
        </PolicyP>
      </PolicySection>

      <PolicySection num={10} title="Consent">
        <PolicyP>
          By browsing the website and, in particular, by providing your personal data to place an
          order, you consent to the collection and use of your information as described in this
          Privacy Policy. Where required, we will obtain your specific consent before collecting
          additional information.
        </PolicyP>
      </PolicySection>

      <PolicySection num={11} title="Changes to This Policy">
        <PolicyP>
          We may update this Privacy Policy from time to time. Any changes will be posted on this page
          with a revised effective date. Your continued use of the website and placement of orders
          after such changes constitutes your acceptance of the updated Policy.
        </PolicyP>
      </PolicySection>

      <PolicySection num={12} title="Contact & Grievance">
        <PolicyP>
          For any questions or grievances regarding this Privacy Policy or the handling of your
          personal data, you may contact us on WhatsApp or by email at hello.dslang@gmail.com, or
          through our <a href="#/contact" className="text-crimson underline hover:text-crimson-dark">Contact page</a>.
        </PolicyP>
        <p className="text-sm text-grey leading-relaxed">
          {POLICY_ADDRESS}
        </p>
      </PolicySection>
    </PolicyPageShell>
  );
}