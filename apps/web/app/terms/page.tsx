import type { Metadata } from 'next';
import Link from 'next/link';
import { ContactLine, LegalPage } from '@/components/LegalPage';
import { BRAND_NAME } from '@/lib/legal';

export const metadata: Metadata = { title: `Terms & Conditions — ${BRAND_NAME}` };

export default function TermsPage() {
  return (
    <LegalPage title="Terms & Conditions">
      <p>
        These Terms &amp; Conditions govern your use of {BRAND_NAME}, an AI phone assistant service for restaurants.
        By creating an account or using {BRAND_NAME}, you agree to these terms.
      </p>

      <h2>The service</h2>
      <p>
        {BRAND_NAME} answers calls to a restaurant&apos;s phone number, answers questions, takes orders and messages,
        and passes them to the restaurant through its dashboard and, if the restaurant opts in, by text message. A
        restaurant can also have {BRAND_NAME} offer callers a text when their order is ready.
        Restaurants are responsible for the accuracy of their menu, prices, hours, and settings, and for fulfilling
        orders.
      </p>

      <h2>Accounts</h2>
      <p>
        You are responsible for the people you give access to your restaurant&apos;s account and for keeping sign-in
        details secure. You must have the right to act for the restaurant you register.
      </p>

      <h2>Acceptable use</h2>
      <p>
        Do not use {BRAND_NAME} to break the law, to send unsolicited messages, or to interfere with the service.
      </p>

      <h2 id="sms">SMS Terms</h2>
      <ul>
        <li>
          <strong>Programs:</strong> {BRAND_NAME} sends two kinds of text.{' '}
          <em>Restaurant alerts</em> go to a restaurant&apos;s owner or staff about new orders, order changes, and
          messages callers leave. <em>Order-ready texts</em> go to a caller about an order they placed by phone, sent
          on the restaurant&apos;s behalf and naming both the restaurant and {BRAND_NAME}.
        </li>
        <li>
          <strong>How to opt in:</strong> for restaurant alerts, an owner or manager enters a mobile number in the{' '}
          {BRAND_NAME} dashboard (Settings → Text alerts), checks a box agreeing to receive alerts, and replies YES to
          the confirmation text. For order-ready texts, after placing an order by phone the caller is asked whether
          they would like a text when it is ready, and says yes; a confirmation text follows. See{' '}
          <Link href="/sms-opt-in" className="text-brayz underline">
            how opt-in works
          </Link>
          . Consent is not a condition of purchase.
        </li>
        <li>
          <strong>Message frequency</strong> for restaurant alerts varies with the restaurant&apos;s orders and calls.
          Order-ready texts are two per order the caller agreed to: a confirmation and the ready notice.
        </li>
        <li>
          <strong>Message and data rates may apply.</strong>
        </li>
        <li>
          <strong>To opt out,</strong> reply <strong>STOP</strong> to any {BRAND_NAME} text. You will receive one
          confirmation and no further texts from that restaurant. Reply <strong>START</strong> to resume.
        </li>
        <li>
          <strong>For help,</strong> reply <strong>HELP</strong>, or <ContactLine />.
        </li>
        <li>Carriers are not liable for delayed or undelivered messages.</li>
        <li>
          Your mobile number and opt-in data are handled as described in our{' '}
          <Link href="/privacy" className="text-brayz underline">
            Privacy Policy
          </Link>
          ; we do not sell or share them with third parties for marketing purposes.
        </li>
      </ul>

      <h2>Billing</h2>
      <p>
        Paid plans are billed through our payment processor according to the plan you choose. A free trial, when
        offered, ends automatically; the service stops answering calls if no plan is chosen.
      </p>

      <h2>Availability and liability</h2>
      <p>
        We work to keep {BRAND_NAME} available and accurate, but AI can make mistakes and calls, texts, and
        integrations can fail. The service is provided as is, and to the extent the law allows, {BRAND_NAME} is not
        liable for indirect or consequential losses, including lost orders.
      </p>

      <h2>Changes</h2>
      <p>We may update these terms; the date above shows when they last changed.</p>

      <h2>Contact</h2>
      <p>
        Questions about these terms: <ContactLine />.
      </p>
    </LegalPage>
  );
}
