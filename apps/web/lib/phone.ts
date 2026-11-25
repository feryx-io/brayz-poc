/**
 * Phone numbers the way owners type them — "(518) 555-1234", "518-555-1234",
 * "5185551234" — normalized to the E.164 the API insists on ("+15185551234").
 * Anything that is not recognizably a North American number is returned
 * trimmed, so the API's validation message names the problem instead of a
 * silently mangled value being saved.
 */
export function normalizePhone(input: string): string {
  const raw = input.trim();
  if (raw === '') return raw;
  const digits = raw.replace(/\D/g, '');
  if (raw.startsWith('+')) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return raw;
}
