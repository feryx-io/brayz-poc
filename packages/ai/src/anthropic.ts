/**
 * Anthropic (Claude) implementation of LlmProvider (CLAUDE.md rule #2).
 *
 * Streaming Messages API with tool use. The model is configurable; the default
 * (claude-sonnet-5) is set in @brayz/config, where the reasoning it buys on a
 * real restaurant menu is explained. Core code talks to LlmProvider, never to
 * this class directly.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { LlmMessage, LlmProvider, LlmStreamEvent, LlmToolDefinition } from './providers.js';

/**
 * How much the model may deliberate before it answers. On a phone call this is
 * a latency setting first: measured on a real 111-item menu, Sonnet 5's
 * time-to-first-token is 3.2-4.0 s with thinking on and ~1.0 s with it off, and
 * every turn of every call pays it once per model round trip.
 */
export type LlmThinking = 'adaptive' | 'disabled';
export type LlmEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AnthropicLlmOptions {
  apiKey: string;
  model: string;
  /** Max output tokens per turn. Spoken replies are short; default keeps latency low. */
  maxTokens?: number;
  /**
   * Thinking mode. Left unset the model decides, which on Sonnet 5 means
   * adaptive thinking is on — a default nobody chose and the largest single
   * cost in the caller's wait.
   */
  thinking?: LlmThinking;
  /** Deliberation depth when thinking is on. Unset means the model's own default (high). */
  effort?: LlmEffort;
  /** Injectable for tests. */
  client?: Anthropic;
}

export class AnthropicLlmProvider implements LlmProvider {
  readonly name = 'anthropic';
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly thinking?: LlmThinking;
  private readonly effort?: LlmEffort;

  constructor(opts: AnthropicLlmOptions) {
    this.client = opts.client ?? new Anthropic({ apiKey: opts.apiKey });
    this.model = opts.model;
    this.maxTokens = opts.maxTokens ?? 1024;
    this.thinking = opts.thinking;
    this.effort = opts.effort;
  }

  async stream(opts: {
    messages: LlmMessage[];
    tools?: LlmToolDefinition[];
    temperature?: number;
    onEvent: (event: LlmStreamEvent) => void;
    signal?: AbortSignal;
  }): Promise<void> {
    const { system, messages } = toAnthropicMessages(opts.messages);
    const tools = opts.tools?.map(toAnthropicTool);

    // Note: temperature is intentionally not forwarded — it 400s on Opus 4.7+
    // and Fable 5, and the model is configurable. Steer via prompt instead.
    const stream = this.client.messages.stream(
      {
        model: this.model,
        max_tokens: this.maxTokens,
        // Only sent when configured. The model is a config value, and what one
        // model accepts another rejects with a 400 — an unset knob has to mean
        // "whatever this model does", not a value we picked for a different one.
        ...(this.thinking ? { thinking: { type: this.thinking } } : {}),
        ...(this.effort ? { output_config: { effort: this.effort } } : {}),
        ...(system ? { system } : {}),
        messages,
        ...(tools && tools.length ? { tools } : {}),
      } as Anthropic.MessageStreamParams,
      { signal: opts.signal },
    );

    // Accumulate streamed tool-call input JSON per content block index.
    const toolAccum = new Map<number, { id: string; name: string; json: string }>();
    let started = false;

    try {
      for await (const event of stream) {
        if (event.type === 'message_start') {
          // Whether the cached system prompt was read back, and the request id
          // to chase a slow turn with — neither was recorded, so a slow call
          // on 2026-09-14 could not be pinned on the provider or on us.
          const usage = event.message.usage;
          opts.onEvent({
            type: 'usage',
            usage: {
              inputTokens: usage.input_tokens,
              cacheReadTokens: usage.cache_read_input_tokens ?? 0,
              cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
              requestId: stream.request_id ?? null,
            },
          });
        } else if (event.type === 'content_block_start') {
          const block = event.content_block;
          if (!started && (block.type === 'text' || block.type === 'tool_use')) {
            started = true;
            opts.onEvent({ type: 'start' });
          }
          if (block.type === 'tool_use') {
            toolAccum.set(event.index, { id: block.id, name: block.name, json: '' });
          }
        } else if (event.type === 'content_block_delta') {
          const delta = event.delta;
          if (delta.type === 'text_delta') {
            opts.onEvent({ type: 'text', textDelta: delta.text });
          } else if (delta.type === 'input_json_delta') {
            const acc = toolAccum.get(event.index);
            if (acc) acc.json += delta.partial_json;
          }
        } else if (event.type === 'content_block_stop') {
          const acc = toolAccum.get(event.index);
          if (acc) {
            opts.onEvent({
              type: 'tool_call',
              toolCall: {
                id: acc.id,
                name: acc.name,
                arguments: acc.json ? safeParseJson(acc.json) : {},
              },
            });
            toolAccum.delete(event.index);
          }
        }
      }
    } catch (err) {
      // Barge-in aborts the stream; that's expected, not an error to propagate.
      if (opts.signal?.aborted) {
        opts.onEvent({ type: 'done' });
        return;
      }
      throw err;
    }

    opts.onEvent({ type: 'done' });
  }
}

/** Map our provider-neutral messages to the Anthropic Messages API shape. */
function toAnthropicMessages(messages: LlmMessage[]): {
  system?: Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
} {
  const systemParts: string[] = [];
  const out: Anthropic.MessageParam[] = [];

  for (const m of messages) {
    if (m.role === 'system') {
      systemParts.push(m.content);
      continue;
    }
    if (m.role === 'tool') {
      // Tool results are user-turn content blocks referencing the tool_use id.
      out.push({
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: m.toolCallId ?? '', content: m.content },
        ],
      });
      continue;
    }
    if (m.role === 'assistant') {
      const blocks: Anthropic.ContentBlockParam[] = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const call of m.toolCalls ?? []) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments });
      }
      out.push({ role: 'assistant', content: blocks.length ? blocks : m.content });
      continue;
    }
    // user
    out.push({ role: 'user', content: m.content });
  }

  // The system prompt is built once when the call opens — restaurant, transfer
  // options, the whole menu — and never changes again, so every turn after the
  // first resends the same several thousand tokens. Cached, they are read back
  // at a fraction of the price and the model starts answering sooner, which on
  // a phone call is the part the caller can hear. Requests are rendered
  // tools → system → messages, so this breakpoint covers the tool definitions
  // too. A prompt below the model's minimum cacheable length simply is not
  // cached; nothing breaks.
  const system = systemParts.join('\n\n');
  return {
    system: system
      ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
      : undefined,
    messages: out,
  };
}

function toAnthropicTool(t: LlmToolDefinition): Anthropic.Tool {
  return {
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Anthropic.Tool.InputSchema,
  };
}

function safeParseJson(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
