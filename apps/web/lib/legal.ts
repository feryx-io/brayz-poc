import { SMS_SUPPORT_EMAIL } from '@brayz/shared';

/**
 * Facts the public legal pages must state the same way everywhere. The brand
 * name is the one registered for A2P 10DLC texting (Twilio brand BN17ee…,
 * sole proprietor): carriers check that the privacy policy and terms name it.
 */
export const BRAND_NAME = 'Brayz';
export const LEGAL_UPDATED = 'September 15, 2026';
/**
 * Where people reach us about privacy, terms and texts — the same address the
 * HELP reply gives, so it is defined once in @brayz/shared.
 */
export const CONTACT_EMAIL = SMS_SUPPORT_EMAIL;
