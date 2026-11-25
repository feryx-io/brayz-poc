import type { Metadata } from 'next';
import Link from 'next/link';
import { ContactLine, LegalPage } from '@/components/LegalPage';
import { BRAND_NAME } from '@/lib/legal';

export const metadata: Metadata = { title: `Privacy Policy — ${BRAND_NAME}` };

export default function PrivacyPolicyPage() {
  return (
    <LegalPage title="Privacy Policy">
      <p>
        This Privacy Policy explains what information {BRAND_NAME} collects, how we use it, and the choices you
        have. {BRAND_NAME} provides an AI phone assistant that answers calls for restaurants, takes orders and
        messages, sends restaurants text alerts about them, and, when a caller asks, texts the caller when their order
        is ready.
      </p>

      <h2>Information we collect</h2>
      <ul>
        <li>
          <strong>Restaurant account information:</strong> names, email addresses and roles of the people who sign in,
          the restaurant&apos;s name, address, phone numbers, hours, menu, and settings.
        </li>
        <li>
          <strong>Mobile numbers and SMS opt-in records:</strong> the mobile number a restaurant enters for text
          alerts, the number of a caller who agrees on a call to a text about their order, and a record of each
          opt-in, confirmation, and opt-out: when it happened, how (dashboard, phone call, or text reply), the wording
          agreed to, and the account and browser that submitted it or the call and order it was given on.
        </li>
        <li>
          <strong>Calls to restaurants:</strong> the caller&apos;s phone number, call times, transcripts, call
          summaries and, where the restaurant enables it, call recordings.
        </li>
        <li>
          <strong>Orders and messages:</strong> items ordered, prices, pickup or delivery details including a delivery
          address when given, names callers provide, and messages callers leave.
        </li>
        <li>
          <strong>Guest preferences</strong> a restaurant keeps for returning callers (for example a name, saved
          address, or loyalty points), which callers and restaurants can ask to have deleted.
        </li>
        <li>
          <strong>Billing information</strong> handled by our payment processor; we do not store card numbers.
        </li>
        <li>
          <strong>Technical data:</strong> logs, IP addresses and device information needed to run and secure the
          service.
        </li>
      </ul>

      <h2>How we use information</h2>
      <ul>
        <li>To answer calls, take orders and messages, and pass them to the restaurant.</li>
        <li>
          To send texts only to mobile numbers that opted in, and only the texts they agreed to, and to keep records
          proving that consent and honoring opt-outs.
        </li>
        <li>To show restaurants their calls, orders, guests and insights in the dashboard.</li>
        <li>To bill for the service, provide support, and keep the service secure and working.</li>
      </ul>

      <h2>SMS opt-in data</h2>
      <p>
        <strong>
          We do not sell or share your SMS opt-in data or personal information with third parties for marketing
          purposes.
        </strong>{' '}
        Mobile numbers and opt-in records are used only to deliver the texts you asked for and to show that you agreed
        to them. Text messaging originator opt-in data and consent will not be shared with any third parties,
        except the messaging providers that deliver the texts on our behalf.
      </p>

      <h2>Who we share information with</h2>
      <p>
        We share information only with service providers that run parts of {BRAND_NAME} for us, under agreements that
        limit their use of it: cloud hosting, telephony and text messaging, speech recognition and voice, AI language
        processing, payments, and a restaurant&apos;s own point-of-sale system when the restaurant connects one. We
        may also disclose information when required by law. We do not sell personal information.
      </p>

      <h2>Retention</h2>
      <p>
        We keep information for as long as a restaurant uses {BRAND_NAME} and as needed to provide the service.
        Restaurants control how long call recordings are kept. SMS consent records are kept as evidence of consent for
        as long as texts may be sent and for a reasonable period afterward.
      </p>

      <h2>Your choices</h2>
      <ul>
        <li>
          Reply <strong>STOP</strong> to any {BRAND_NAME} text to stop texts from that restaurant. Restaurants can also
          turn alerts off in the dashboard.
        </li>
        <li>Restaurants can edit or delete guest information from the dashboard.</li>
        <li>You can ask us to access or delete information about you.</li>
      </ul>

      <h2>Security</h2>
      <p>
        We use access controls, encryption in transit, and audit logging of access to sensitive records to protect
        information.
      </p>

      <h2>Contact</h2>
      <p>
        For questions about this policy or your information, <ContactLine />. See also our{' '}
        <Link href="/terms" className="text-brayz underline">
          Terms &amp; Conditions
        </Link>
        .
      </p>
    </LegalPage>
  );
}
