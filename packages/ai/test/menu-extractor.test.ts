import { describe, expect, it } from 'vitest';
import { AnthropicMenuExtractor, type MenuExtractorClient } from '../src/menu-extractor.js';

function fakeClient(input: unknown): { client: MenuExtractorClient; calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  const client: MenuExtractorClient = {
    messages: {
      create: async (body) => {
        calls.push(body);
        return { content: [{ type: 'tool_use', name: 'submit_menu', input }] };
      },
    },
  };
  return { client, calls };
}

describe('AnthropicMenuExtractor', () => {
  it('forces the submit_menu tool and returns the parsed menu', async () => {
    const { client, calls } = fakeClient({
      categories: [{ name: 'Pizza', items: [{ name: 'Margherita', priceCents: 1399 }] }],
    });
    const extractor = new AnthropicMenuExtractor({ model: 'claude-opus-4-8', client });
    const menu = await extractor.extract({ text: 'Margherita $13.99' });

    expect(calls[0]).toMatchObject({
      model: 'claude-opus-4-8',
      tool_choice: { type: 'tool', name: 'submit_menu' },
    });
    expect(menu.categories[0].items[0]).toEqual({ name: 'Margherita', priceCents: 1399 });
  });

  it('builds image + pdf content blocks', async () => {
    const { client, calls } = fakeClient({ categories: [] });
    const extractor = new AnthropicMenuExtractor({ model: 'm', client });
    await extractor.extract({ images: [{ base64: 'AAAA', mediaType: 'image/png' }], pdfBase64: 'BBBB' });

    const content = (calls[0].messages as Array<{ content: Array<{ type: string }> }>)[0].content;
    const types = content.map((b) => b.type);
    expect(types).toContain('image');
    expect(types).toContain('document');
  });

  it('normalizes bad output (drops nameless items, floors negative prices)', async () => {
    const { client } = fakeClient({
      categories: [
        { name: 'X', items: [{ name: 'Good', priceCents: -5 }, { priceCents: 100 }] },
        { items: [] }, // nameless category dropped
      ],
    });
    const extractor = new AnthropicMenuExtractor({ model: 'm', client });
    const menu = await extractor.extract({ text: 'x' });
    expect(menu.categories).toHaveLength(1);
    expect(menu.categories[0].items).toEqual([{ name: 'Good', priceCents: 0 }]);
  });
});
