import type { Metadata } from 'next';
import Link from 'next/link';
import {
  guestOrderReadySms,
  guestOrderTextsConfirmationSms,
  guestOrderTextsOffer,
  restaurantAlertsConfirmationSms,
  restaurantAlertsDisclosure,
  SMS_HELP_REPLY,
  SMS_OPT_IN_REPLY,
  SMS_OPT_OUT_REPLY,
} from '@brayz/shared';
import { LegalPage } from '@/components/LegalPage';
import { BRAND_NAME } from '@/lib/legal';

export const metadata: Metadata = { title: `Text message opt-in — ${BRAND_NAME}` };

const EXAMPLE_RESTAURANT = "Jimmy's Pizza - Saratoga";
const EXAMPLE_PHONE = '(518) 555-1234';
const EXAMPLE_ORDER = '3AC27';

/**
 * Public proof of how people opt in to Brayz texts, for carrier review. There
 * are two ways in, and both are shown in full: restaurant staff on a form inside
 * the signed-in dashboard (components/TextAlertsCard.tsx), and a caller saying
 * yes on the phone after ordering. Every word — the disclosure, the spoken
 * offer, each text — is imported from @brayz/shared, so it cannot drift from
 * what people actually see and hear. The keyword replies must match the Twilio
 * Messaging Service (docs/operations/sms-consent.md).
 */
export default function SmsOptInPage() {
  return (
    <LegalPage title="How people opt in to Brayz text messages">
      <p>
        {BRAND_NAME} answers phone calls for restaurants with an AI assistant. It sends two kinds of text, and only to
        people who asked for them:
      </p>
      <ul>
        <li>
          <a href="#restaurant-alerts" className="text-brayz underline">
            Restaurant alerts
          </a>{' '}
          — to a restaurant&apos;s owner or manager, about new orders, order changes and messages callers leave. They
          opt in on a web form and confirm by replying YES.
        </li>
        <li>
          <a href="#order-updates" className="text-brayz underline">
            Order-ready texts
          </a>{' '}
          — to a caller who has just placed an order by phone, when that order is ready. They opt in by saying yes
          when the assistant asks, and get a confirmation text right away.
        </li>
      </ul>
      <p>
        Consent is never a condition of purchase, and every opt-in and opt-out is recorded with the time and the exact
        wording. Replying STOP to any {BRAND_NAME} text stops every text that restaurant sends to that number.
      </p>

      <h2 id="restaurant-alerts">Restaurant alerts</h2>
      <p>
        The sign-up form is in the {BRAND_NAME} dashboard, which requires signing in, so this section shows exactly
        what owners and managers see and every message that follows.
      </p>

      <h2>Step 1 — The form (Settings → Text alerts)</h2>
      <p>The box is unchecked until they check it. The button stays disabled until they do.</p>
      <div className="rounded-xl border border-slate-300 bg-white p-6 shadow-sm" aria-label="Form preview">
        <p className="font-semibold">Text alerts</p>
        <p className="mb-4 text-slate-500">
          New orders, order changes and messages callers leave, texted to a phone at the restaurant.
        </p>
        <label className="block max-w-xs">
          <span className="font-medium">Mobile number for alerts</span>
          <input
            disabled
            value={EXAMPLE_PHONE}
            readOnly
            className="mt-1 w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2"
          />
        </label>
        <label className="mt-3 flex items-start gap-2 text-slate-700">
          <input type="checkbox" disabled className="mt-1" />
          <span>
            {restaurantAlertsDisclosure(EXAMPLE_RESTAURANT)}{' '}
            <Link href="/terms#sms" className="text-brayz underline">
              SMS Terms
            </Link>{' '}
            and{' '}
            <Link href="/privacy" className="text-brayz underline">
              Privacy Policy
            </Link>
          </span>
        </label>
        <button disabled className="mt-3 rounded-lg bg-brayz px-3 py-2 font-medium text-white opacity-50">
          Turn on text alerts
        </button>
        <p className="mt-2 text-xs text-slate-500">We’ll text that number to confirm. Reply YES to start alerts.</p>
      </div>

      <h2>Step 2 — After submitting</h2>
      <div className="rounded-xl border border-slate-300 bg-white p-6 shadow-sm">
        <p className="font-semibold">Text alerts</p>
        <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-amber-900">
          <span className="font-semibold">Waiting for a reply.</span> We texted {EXAMPLE_PHONE} — reply <b>YES</b> to
          that text to turn alerts on. Nothing else is sent until then.
        </p>
      </div>
      <p>
        {BRAND_NAME} records the opt-in — the time, the account and browser that submitted it, and the exact wording
        shown — and sends one confirmation text. No alerts are sent until the number replies YES.
      </p>

      <h2>Step 3 — The messages</h2>
      <Exchange
        messages={[
          { from: 'brayz', text: restaurantAlertsConfirmationSms(EXAMPLE_RESTAURANT) },
          { from: 'owner', text: 'YES' },
          { from: 'brayz', text: SMS_OPT_IN_REPLY },
          {
            from: 'brayz',
            text: `New pickup order #${EXAMPLE_ORDER} for James: 1x Sausage (Mozzarella; Marinara). Total $12.00. — ${EXAMPLE_RESTAURANT}`,
          },
        ]}
      />
      <p>Once confirmed, the dashboard shows:</p>
      <div className="rounded-xl border border-slate-300 bg-white p-6 shadow-sm">
        <p className="font-semibold">Text alerts</p>
        <p className="mt-3 rounded-lg bg-green-50 px-3 py-2 text-green-800">
          <span className="font-semibold">On</span> — texting {EXAMPLE_PHONE}.
        </p>
      </div>

      <h2 id="order-updates">Order-ready texts</h2>
      <p>
        When a caller places an order by phone, the {BRAND_NAME} assistant confirms the order and reads out its order
        number. Only then, and only if the restaurant has turned this on, it asks one question, in these exact words
        (the assistant never rewords it):
      </p>
      <Exchange
        messages={[
          { from: 'assistant', text: guestOrderTextsOffer(EXAMPLE_RESTAURANT) },
          { from: 'caller', text: 'Yes please.' },
          { from: 'assistant', text: "Great, you'll get a text when it's ready. Anything else I can help with?" },
        ]}
      />
      <p>
        The assistant&apos;s reply after the caller answers is in its own words; the question never is. The order is
        already placed before the question is asked, so saying no changes nothing about it. If the caller says no, or
        does not answer, no text is sent. The question is asked once per call, and only when the call shows a caller ID
        number; the texts go only to that number.
      </p>
      <p>
        A yes is recorded with the call, the time, the order, the exact question above and the caller&apos;s own words.
        {BRAND_NAME} then sends one confirmation text straight away, and one more when the restaurant marks the order
        ready. That is all: two texts, about that one order. A yes covers only the order it was given for; a later
        order is asked about again on its own call.
      </p>
      <Exchange
        messages={[
          { from: 'brayz', text: guestOrderTextsConfirmationSms(EXAMPLE_RESTAURANT, EXAMPLE_ORDER) },
          { from: 'brayz', text: guestOrderReadySms(EXAMPLE_RESTAURANT, EXAMPLE_ORDER, false) },
        ]}
      />

      <h2>Help and opting out</h2>
      <p>These replies are the same for both kinds of text.</p>
      <Exchange
        messages={[
          { from: 'person', text: 'HELP' },
          { from: 'brayz', text: SMS_HELP_REPLY },
          { from: 'person', text: 'STOP' },
          { from: 'brayz', text: SMS_OPT_OUT_REPLY },
        ]}
      />
      <p>
        STOP ends every text that restaurant sends to that number, whichever kind. Restaurant alerts can also be turned
        off at any time in the dashboard. See the{' '}
        <Link href="/terms#sms" className="text-brayz underline">
          SMS Terms
        </Link>{' '}
        and{' '}
        <Link href="/privacy" className="text-brayz underline">
          Privacy Policy
        </Link>
        .
      </p>
    </LegalPage>
  );
}

type Speaker = 'brayz' | 'owner' | 'person' | 'assistant' | 'caller';

const SPEAKER_LABEL: Record<Speaker, string> = {
  brayz: `Text from ${BRAND_NAME}`,
  owner: 'Restaurant owner',
  person: 'Reply',
  assistant: `${BRAND_NAME} assistant, on the call`,
  caller: 'Caller',
};

function Exchange({ messages }: { messages: Array<{ from: Speaker; text: string }> }) {
  return (
    <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-4">
      {messages.map((m, i) => {
        const theirs = m.from === 'owner' || m.from === 'person' || m.from === 'caller';
        return (
          <div key={i} className={theirs ? 'flex justify-end' : 'flex justify-start'}>
            <div
              className={
                'max-w-[80%] rounded-2xl px-3 py-2 ' +
                (theirs ? 'bg-brayz text-white' : 'border border-slate-200 bg-white text-slate-800')
              }
            >
              <p className="text-[11px] font-medium opacity-70">{SPEAKER_LABEL[m.from]}</p>
              <p>{m.text}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
