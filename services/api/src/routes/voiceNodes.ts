import type { FastifyInstance } from 'fastify';
import { HeartbeatInput, RegisterNodeInput } from '@brayz/shared';
import { prisma } from '@brayz/db';
import { notFound, parse } from '../lib/http.js';
import { requireNode } from '../auth/node.js';

/**
 * Voice-node lifecycle (implementation plan §6.3). Siphon-AI nodes register on
 * boot, heartbeat with live load, and are drained for graceful shutdown. These
 * are platform-infra rows (not tenant-scoped); callers authenticate with the
 * node shared secret.
 */
export async function voiceNodeRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/voice-nodes/register', async (request, reply) => {
    requireNode(request);
    const input = parse(RegisterNodeInput, request.body);
    const node = await prisma.voiceNode.upsert({
      where: { nodeId: input.nodeId },
      update: {
        region: input.region,
        environment: input.environment,
        publicIp: input.publicIp,
        maxCalls: input.maxCalls,
        status: 'ready',
        lastSeenAt: new Date(),
      },
      create: {
        nodeId: input.nodeId,
        region: input.region,
        environment: input.environment,
        publicIp: input.publicIp,
        maxCalls: input.maxCalls,
        status: 'ready',
      },
    });
    return reply.status(201).send(node);
  });

  app.post('/v1/voice-nodes/:nodeId/heartbeat', async (request) => {
    requireNode(request);
    const { nodeId } = request.params as { nodeId: string };
    const input = parse(HeartbeatInput, request.body);
    const existing = await prisma.voiceNode.findUnique({ where: { nodeId } });
    if (!existing) throw notFound('Voice node');
    // A draining node stays draining even if it heartbeats as ready.
    const status = existing.status === 'draining' ? 'draining' : (input.status ?? existing.status);
    await prisma.voiceNode.update({
      where: { nodeId },
      data: {
        activeCalls: input.activeCalls,
        publicIp: input.publicIp ?? existing.publicIp,
        status,
        lastSeenAt: new Date(),
        // The latest self-report replaces the last; the staff portal judges it
        // (lib/nodeHealth.ts). A beat without one leaves the previous in place.
        ...(input.health ? { health: input.health } : {}),
      },
    });
    return { ok: true, status };
  });

  app.post('/v1/voice-nodes/:nodeId/drain', async (request) => {
    requireNode(request);
    const { nodeId } = request.params as { nodeId: string };
    const node = await setStatus(nodeId, 'draining');
    return { ok: true, status: node.status, activeCalls: node.activeCalls };
  });

  app.post('/v1/voice-nodes/:nodeId/undrain', async (request) => {
    requireNode(request);
    const { nodeId } = request.params as { nodeId: string };
    const node = await setStatus(nodeId, 'ready');
    return { ok: true, status: node.status };
  });

  // Operator view (user-authed would be added when an admin UI needs it).
  app.get('/v1/voice-nodes', async (request) => {
    requireNode(request);
    return prisma.voiceNode.findMany({ orderBy: { nodeId: 'asc' } });
  });
}

async function setStatus(nodeId: string, status: string) {
  const existing = await prisma.voiceNode.findUnique({ where: { nodeId } });
  if (!existing) throw notFound('Voice node');
  return prisma.voiceNode.update({ where: { nodeId }, data: { status } });
}
