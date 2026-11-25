import { redirect } from 'next/navigation';

/** The SMS terms moved into the Terms & Conditions page (a carrier requirement); the old link still works. */
export default function SmsTermsRedirect() {
  redirect('/terms#sms');
}
