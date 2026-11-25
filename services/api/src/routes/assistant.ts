import type { FastifyInstance } from 'fastify';
import { AnthropicLlmProvider, type LlmProvider } from '@brayz/ai';
import { loadConfig } from '@brayz/config';
import { forTenant, writeAudit } from '@brayz/db';
import { AssistantChatInput } from '@brayz/shared';
import { HttpError, notFound, parse } from '../lib/http.js';
import { runAssistant } from '../lib/assistant.js';
import { requireTenant, requireTenantRole } from '../plugins/auth.js';

export interface AssistantRouteOptions {
  /** Overrides the configured model (tests). `null` means none configured. */
  llm?: LlmProvider | null;
}

/**
 * One turn of the per-account assistant. Manager and up: it reads transcripts
 * and proposes menu edits, neither of which is a staff-level thing. Every
 * turn is audited with what it read and what it proposed, so "the assistant
 * suggested it" is on the record beside "the owner applied it".
 */
export async function assistantRoutes(app: FastifyInstance, opts: AssistantRouteOptions = {}): Promise<void> {
  const cfg = loadConfig();
  const llm =
    opts.llm !== undefined
      ? opts.llm
      : cfg.ANTHROPIC_API_KEY
        ? new AnthropicLlmProvider({
            apiKey: cfg.ANTHROPIC_API_KEY,
            model: cfg.ANTHROPIC_MODEL,
            // Longer than a spoken reply: a proposal carries a whole group.
            maxTokens: 2048,
            thinking: cfg.ANTHROPIC_THINKING,
            effort: cfg.ANTHROPIC_EFFORT,
          })
        : null;

  app.post('/v1/locations/:locationId/assistant/chat', async (request) => {
    const tenantId = requireTenant(request);
    await requireTenantRole(request, tenantId, 'manager');
    const { locationId } = request.params as { locationId: string };
    const input = parse(AssistantChatInput, request.body);
    const location = await forTenant(tenantId).location.findFirst({
      where: { id: locationId },
      select: { id: true, name: true, timezone: true },
    });
    if (!location) throw notFound('Location');
    if (!llm) {
      throw new HttpError(503, 'The assistant is not configured (ANTHROPIC_API_KEY missing)', 'assistant_not_configured');
    }
    if (input.messages[input.messages.length - 1]?.role !== 'user') {
      throw new HttpError(400, 'The last message must be from the user', 'bad_thread');
    }

    const result = await runAssistant({
      llm,
      tenantId,
      locationId,
      location,
      days: input.days ?? 30,
      messages: input.messages,
      log: request.log,
    });

    await writeAudit({
      tenantId,
      locationId,
      actorId: request.auth?.userId ?? null,
      action: 'assistant.chat',
      targetType: 'location',
      targetId: locationId,
      metadata: {
        tools: result.toolsUsed,
        proposals: result.proposals.map((p) => ({ id: p.id, kind: p.fix.kind, summary: p.summary })),
      },
    });
    return result;
  });
}
