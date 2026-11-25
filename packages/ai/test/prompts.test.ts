import { describe, expect, it } from 'vitest';
import { RECEPTIONIST_TOOLS, buildReceptionistSystemPrompt } from '../src/prompts.js';

describe('receptionist tools + prompt', () => {
  const names = RECEPTIONIST_TOOLS.map((t) => t.name);

  it('exposes the guest-memory tools', () => {
    expect(names).toContain('recall_guest');
    expect(names).toContain('save_guest_memory');
  });

  it('exposes the order tools', () => {
    for (const n of ['add_item', 'remove_item', 'review_order', 'place_order']) {
      expect(names).toContain(n);
    }
  });

  it('exposes the loyalty tool and the redeem flag on place_order', () => {
    expect(names).toContain('check_loyalty');
    const placeOrder = RECEPTIONIST_TOOLS.find((t) => t.name === 'place_order');
    const props = (placeOrder?.parameters as { properties: Record<string, unknown> }).properties;
    expect(props).toHaveProperty('redeem_reward');
  });

  it('system prompt covers loyalty without inventing balances', () => {
    const p = buildReceptionistSystemPrompt('Test Pizza');
    expect(p).not.toContain('greeting you opened');
    expect(p).toContain('check_loyalty');
    expect(p).toContain('never invent point balances');
  });

  it('save_guest_memory accepts a birthday; prompt covers VIP + bonuses', () => {
    const save = RECEPTIONIST_TOOLS.find((t) => t.name === 'save_guest_memory');
    const props = (save?.parameters as { properties: Record<string, unknown> }).properties;
    expect(props).toHaveProperty('birthday_month');
    expect(props).toHaveProperty('birthday_day');
    const p = buildReceptionistSystemPrompt('Test Pizza');
    expect(p).toContain('VIP');
    expect(p).toContain('applied automatically');
  });

  it('tells the model a cheese pizza is not an Extra Cheese topping', () => {
    // A live call (2026-08-31) turned "a large cheese pizza" into a Large Pizza
    // (18") plus the $3.00 Extra Cheese option — read back as "with extra
    // cheese", agreed to, and charged. The menu has no plain cheese pizza item
    // at that location: the create-your-own large IS the cheese pizza, so the
    // only thing standing between the caller and a topping they never asked for
    // is this rule.
    const p = buildReceptionistSystemPrompt('Test Pizza');
    expect(p).toContain('only what the caller asks to add');
    expect(p).toContain('"A cheese pizza"');
    expect(p).toContain('Never add a paid option the caller did not ask for');
  });

  it('tells the model to ask for a required choice rather than pick one', () => {
    // A live call (2026-08-31): the caller asked for boneless wings and the bot
    // answered "added boneless wings with medium buffalo sauce" — a sauce
    // nobody had chosen, on a group the menu marks required.
    const p = buildReceptionistSystemPrompt('Test Pizza');
    expect(p).toContain('required choice');
    expect(p).toContain('Never pick one for them');
  });

  it('exposes update_item so a later request lands on the item, not a staff note', () => {
    expect(names).toContain('update_item');
    const update = RECEPTIONIST_TOOLS.find((t) => t.name === 'update_item');
    const props = (update?.parameters as { properties: Record<string, unknown> }).properties;
    expect(props).toHaveProperty('special_instructions');
    expect(props).toHaveProperty('modifiers');
    const note = RECEPTIONIST_TOOLS.find((t) => t.name === 'take_message');
    expect(note?.description).toContain('Never for order details');
  });

  it('tells the bot when to take a message and not to make the caller read their own number', () => {
    // Collapsed: the prompt wraps lines, and a phrase may straddle one.
    const p = buildReceptionistSystemPrompt('Test Pizza').replace(/\s+/g, ' ');
    expect(p).toContain('Taking a message:');
    expect(p).toContain('a person you cannot transfer to');
    expect(p).toContain('do not ask them to read out the number they are calling from');
    const tool = RECEPTIONIST_TOOLS.find((t) => t.name === 'take_message');
    const props = (tool?.parameters as { properties: Record<string, unknown>; required: string[] });
    expect(Object.keys(props.properties).sort()).toEqual(['callback_number', 'caller_name', 'message']);
    expect(props.required).toEqual(['message']);
  });

  it('system prompt covers returning guests and the identity caution', () => {
    const p = buildReceptionistSystemPrompt('Test Pizza');
    expect(p).toContain('Test Pizza');
    expect(p.toLowerCase()).toContain('returning guest');
    expect(p).toContain('confirm identity first');
  });

  it("carries the owner's greeting so a persona name in it becomes the bot's name", () => {
    const p = buildReceptionistSystemPrompt('Test Pizza', {
      greeting: 'Thank you for calling Test Pizza. This is Sam, your ordering assistant.',
    });
    expect(p).toContain('This is Sam');
    expect(p).toContain('that is your name on this call');
  });

  it('answers under the name the owner gave the voice', () => {
    expect(buildReceptionistSystemPrompt('Test Pizza', { assistantName: 'Sam' })).toContain(
      'You are Sam, answering calls for Test Pizza.',
    );
    expect(buildReceptionistSystemPrompt('Test Pizza')).toContain('You are Brayz, answering calls for Test Pizza.');
  });

  it('never claims to be human, and can hand the call to a listed persona', () => {
    const p = buildReceptionistSystemPrompt('Test Pizza', { assistantName: 'Sarah' });
    expect(p).toContain('never claim to be human');
    expect(RECEPTIONIST_TOOLS.map((t) => t.name)).toContain('switch_persona');
  });
});
