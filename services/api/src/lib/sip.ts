/**
 * A transfer destination as SiphonAI can REFER to it: SiphonAI's `transfer`
 * takes a SIP or SIPS URI only, so an E.164 number or extension is wrapped in
 * the carrier's domain (`BRAYZ_TRANSFER_SIP_DOMAIN`). Null when it cannot be —
 * a bare number with no domain configured has nowhere to go.
 */
export function toSipUri(destination: string, domain?: string): string | null {
  if (/^sips?:/i.test(destination)) return destination;
  if (!domain) return null;
  return `sip:${destination}@${domain}`;
}
