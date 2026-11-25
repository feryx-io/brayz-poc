import { describe, expect, it } from 'vitest';
import { drainSentences, toSpeakable } from '../src/conversation.js';

describe('toSpeakable (strip markdown before TTS)', () => {
  it('removes bold so the voice does not say "star star"', () => {
    expect(toSpeakable('A Large Pepperoni Pizza is **$16.99**.')).toBe('A Large Pepperoni Pizza is $16.99.');
  });

  it('strips italics, inline code, headings, bullets, and links', () => {
    expect(toSpeakable('*Hi* `there`')).toBe('Hi there');
    expect(toSpeakable('## Menu')).toBe('Menu');
    expect(toSpeakable('- Wings\n- Pizza')).toBe('Wings\nPizza');
    expect(toSpeakable('See [our menu](https://x.example).')).toBe('See our menu.');
  });

  it('drops stray emphasis characters', () => {
    expect(toSpeakable('Price: **16.99')).toBe('Price: 16.99'); // unmatched **
    expect(toSpeakable('~tilde~ and `tick`')).toBe('tilde and tick');
  });

  it('leaves plain spoken text untouched', () => {
    expect(toSpeakable('We are open until 9 tonight.')).toBe('We are open until 9 tonight.');
  });
});

describe('drainSentences (per-sentence TTS chunking)', () => {
  it('splits on sentence enders and keeps the partial as rest', () => {
    expect(drainSentences('We are open. Anything else? ')).toEqual({
      sentences: ['We are open. ', 'Anything else? '],
      rest: '',
    });
  });

  it('does not split decimals like $16.99', () => {
    expect(drainSentences('A Large Pepperoni is $16.99. Thanks ')).toEqual({
      sentences: ['A Large Pepperoni is $16.99. '],
      rest: 'Thanks ',
    });
  });

  it('holds an incomplete sentence until it ends', () => {
    expect(drainSentences('Let me check')).toEqual({ sentences: [], rest: 'Let me check' });
  });
});
