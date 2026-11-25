import { describe, expect, it } from 'vitest';
import { AnthropicLlmProvider } from '../src/anthropic.js';
import type { LlmStreamEvent } from '../src/providers.js';

/**
 * What the adapter sends about deliberation.
 *
 * On a phone call this is a latency setting first: measured on a real 111-item
 * menu, Sonnet 5 takes 3.2-4.0 s to its first token with thinking on and ~1.0 s
 * with it off, once per model round trip. Left unset it must send nothing at
 * all — the model is itself a config value, and a `thinking` shape one model
 * accepts another rejects with a 400.
 */
function fakeClient(): { client: any; sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = [];
  const client = {
    messages: {
      stream(body: Record<string, unknown>) {
        sent.push(body);
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } };
          },
        };
      },
    },
  };
  return { client, sent };
}

async function run(opts: { thinking?: 'adaptive' | 'disabled'; effort?: 'low' | 'high' }) {
  const { client, sent } = fakeClient();
  const llm = new AnthropicLlmProvider({ apiKey: 'k', model: 'claude-sonnet-5', client, ...opts });
  const events: LlmStreamEvent[] = [];
  await llm.stream({ messages: [{ role: 'user', content: 'hi' }], onEvent: (e) => events.push(e) });
  return { body: sent[0]!, events };
}

describe('AnthropicLlmProvider — deliberation settings', () => {
  it('sends nothing when neither is configured, so the model keeps its own default', async () => {
    const { body } = await run({});
    expect(body).not.toHaveProperty('thinking');
    expect(body).not.toHaveProperty('output_config');
  });

  it('turns thinking off when asked — the setting the caller hears', async () => {
    const { body } = await run({ thinking: 'disabled' });
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body).not.toHaveProperty('output_config');
  });

  it('carries effort inside output_config, not at the top level', async () => {
    const { body } = await run({ thinking: 'adaptive', effort: 'low' });
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(body.output_config).toEqual({ effort: 'low' });
    expect(body).not.toHaveProperty('effort');
  });

  it('still streams the reply either way', async () => {
    const { events } = await run({ thinking: 'disabled' });
    expect(events.some((e) => e.type === 'text' && e.textDelta === 'ok')).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'done' });
  });
});

describe('AnthropicLlmProvider — what a slow turn needs to be diagnosed', () => {
  it('reports cache usage and the request id, and says when the answer starts', async () => {
    // On 2026-09-14 turns ran 2-4 s to first output and nothing recorded
    // whether the cached prompt had been read or the provider was slow.
    const client = {
      messages: {
        stream() {
          return {
            request_id: 'req_123',
            async *[Symbol.asyncIterator]() {
              yield {
                type: 'message_start',
                message: { usage: { input_tokens: 40, cache_read_input_tokens: 6000, cache_creation_input_tokens: 0 } },
              };
              yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'x' } };
              yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } };
              yield { type: 'content_block_stop', index: 0 };
            },
          };
        },
      },
    };
    const llm = new AnthropicLlmProvider({ apiKey: 'k', model: 'claude-sonnet-5', client: client as any });
    const events: LlmStreamEvent[] = [];
    await llm.stream({ messages: [{ role: 'user', content: 'hi' }], onEvent: (e) => events.push(e) });
    expect(events.map((e) => e.type)).toEqual(['usage', 'start', 'tool_call', 'done']);
    expect(events[0]!.usage).toEqual({ inputTokens: 40, cacheReadTokens: 6000, cacheWriteTokens: 0, requestId: 'req_123' });
  });
});
