/**
 * Menu extraction, behind a provider-agnostic interface (CLAUDE.md rule #2).
 * Claude is the first implementation. Given a menu's text and/or images/PDF, it
 * returns a structured menu (categories → items + prices) for the owner to
 * review before import — the LLM never writes to the DB.
 */
import Anthropic from '@anthropic-ai/sdk';

export interface ExtractedMenuItem {
  name: string;
  priceCents: number;
  description?: string;
  /** Ingredients listed on the source (empty if none shown). */
  ingredients?: string[];
}
export interface ExtractedMenuCategory {
  name: string;
  items: ExtractedMenuItem[];
}
export interface ExtractedMenu {
  categories: ExtractedMenuCategory[];
}

/** A source image (base64) — media type must be a Claude-supported image type. */
export interface ExtractionImage {
  base64: string;
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
}

export interface MenuExtractionInput {
  /** Page text (from a URL or pasted/uploaded text). */
  text?: string;
  /** Photos of a printed menu. */
  images?: ExtractionImage[];
  /** A PDF menu, base64. */
  pdfBase64?: string;
}

export interface MenuExtractor {
  readonly name: string;
  extract(input: MenuExtractionInput): Promise<ExtractedMenu>;
}

/** Minimal one-shot Messages client shape — lets tests inject a fake. */
export interface MenuExtractorClient {
  messages: {
    create(body: Record<string, unknown>): Promise<{
      stop_reason?: string | null;
      content: Array<{ type: string; name?: string; input?: unknown }>;
    }>;
  };
}

// JSON Schema for the structured tool the model is forced to call.
const SUBMIT_MENU_SCHEMA = {
  type: 'object',
  properties: {
    categories: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Category/section name, e.g. "Pizzas".' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                priceCents: { type: 'integer', description: 'Price in cents, e.g. 1899 for $18.99.' },
                description: { type: 'string' },
                ingredients: {
                  type: 'array',
                  description: 'Ingredients/toppings listed for this item on the source. Empty if none are shown — do NOT guess.',
                  items: { type: 'string' },
                },
              },
              required: ['name', 'priceCents'],
            },
          },
        },
        required: ['name', 'items'],
      },
    },
  },
  required: ['categories'],
} as const;

const SYSTEM = [
  'You extract a restaurant menu into structured data. Read the provided text and/or',
  'images/PDF and return every menu item with its category and price. Convert prices to',
  'integer cents (e.g. $18.99 → 1899). Skip non-menu content (hours, addresses, marketing).',
  "If a price is missing, use 0. Don't invent items, prices, or ingredients — only what's shown.",
  "Capture each item's listed ingredients/toppings into its ingredients array; leave it empty if none are shown.",
  'Call the submit_menu tool with the result.',
].join(' ');

export class AnthropicMenuExtractor implements MenuExtractor {
  readonly name = 'anthropic';
  private readonly client: MenuExtractorClient;
  private readonly model: string;

  constructor(opts: { apiKey?: string; model: string; client?: MenuExtractorClient }) {
    // Cap a single extraction at 2 min so a slow/stuck call fails fast with a
    // clear error instead of hanging until the Cloud Run request timeout.
    this.client =
      opts.client ?? (new Anthropic({ apiKey: opts.apiKey, timeout: 120_000 }) as unknown as MenuExtractorClient);
    this.model = opts.model;
  }

  async extract(input: MenuExtractionInput): Promise<ExtractedMenu> {
    const content: Array<Record<string, unknown>> = [];
    for (const img of input.images ?? []) {
      content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } });
    }
    if (input.pdfBase64) {
      content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: input.pdfBase64 } });
    }
    content.push({
      type: 'text',
      text: input.text?.trim()
        ? `Extract the menu from the following content:\n\n${input.text.slice(0, 100_000)}`
        : 'Extract the menu from the attached image(s)/PDF.',
    });

    const res = await this.client.messages.create({
      // Large menus with per-item ingredients produce a lot of structured output;
      // too small a cap truncates the tool JSON mid-output → an empty/invalid result.
      model: this.model,
      max_tokens: 32_000,
      system: SYSTEM,
      tools: [
        {
          name: 'submit_menu',
          description: 'Return the fully extracted menu.',
          input_schema: SUBMIT_MENU_SCHEMA,
        },
      ],
      tool_choice: { type: 'tool', name: 'submit_menu' },
      messages: [{ role: 'user', content }],
    });

    const toolUse = res.content.find((b) => b.type === 'tool_use' && b.name === 'submit_menu');
    // If the model ran out of output room mid-menu, the tool JSON is truncated —
    // surface that instead of silently returning a partial/empty menu.
    if (res.stop_reason === 'max_tokens') {
      throw new Error('This menu is very large — import it a section (or page) at a time.');
    }
    const parsed = (toolUse?.input ?? { categories: [] }) as ExtractedMenu;
    return normalize(parsed);
  }
}

/** Defensively coerce the model's output into the expected shape. */
function normalize(menu: ExtractedMenu): ExtractedMenu {
  const categories = Array.isArray(menu.categories) ? menu.categories : [];
  return {
    categories: categories
      .filter((c) => c && typeof c.name === 'string')
      .map((c) => ({
        name: c.name,
        items: (Array.isArray(c.items) ? c.items : [])
          .filter((i) => i && typeof i.name === 'string')
          .map((i) => {
            const ingredients = (Array.isArray(i.ingredients) ? i.ingredients : [])
              .map((g) => String(g).trim())
              .filter(Boolean);
            return {
              name: i.name,
              priceCents: Number.isFinite(i.priceCents) ? Math.max(0, Math.round(i.priceCents)) : 0,
              ...(i.description ? { description: String(i.description) } : {}),
              ...(ingredients.length ? { ingredients } : {}),
            };
          }),
      })),
  };
}
