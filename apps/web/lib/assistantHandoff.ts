import type { MenuHealthFinding } from '@/lib/queries';

/**
 * Hand a question to the assistant page from elsewhere in the portal.
 *
 * The Menu health card can say what is wrong; the assistant can talk it
 * through and propose the edit once the owner supplies the missing facts
 * (the bread list, the price). Rather than make the owner copy a finding
 * into the chat box, a card button parks the question here and navigates;
 * the assistant page sends it as the next message on arrival.
 *
 * sessionStorage, keyed by location: the finding text can be long and has no
 * business in the URL or the browser history, and it should vanish with the
 * tab. Keyed by location so a switch after the click does not send one
 * location's finding into another's thread.
 */
export const pendingKey = (locationId: string) => `brayz.assistant.pending.${locationId}`;

export function stashAssistantQuestion(locationId: string, text: string): void {
  try {
    sessionStorage.setItem(pendingKey(locationId), text);
  } catch {
    /* the page still works — the owner can type it */
  }
}

/** Read and clear the parked question, so a reload does not send it twice. */
export function takeAssistantQuestion(locationId: string): string | null {
  try {
    const key = pendingKey(locationId);
    const text = sessionStorage.getItem(key);
    if (text) sessionStorage.removeItem(key);
    return text || null;
  } catch {
    return null;
  }
}

/**
 * The question a finding turns into. It carries the same facts the card
 * shows (title, detail, evidence), so the assistant starts from the finding
 * rather than re-discovering it, and ends by asking what to do — the
 * assistant then asks for whatever the fix still needs, or proposes it.
 */
export function findingToQuestion(f: MenuHealthFinding): string {
  const lines = [`Menu health flagged this: ${f.title}`, f.detail];
  const samples = f.evidence.samples?.filter(Boolean) ?? [];
  if (samples.length) {
    lines.push(`What callers said: ${samples.map((s) => `"${s}"`).join(', ')}`);
  }
  lines.push('What should I change on the menu to fix it? Propose the edit if you have enough to go on.');
  return lines.join('\n');
}
