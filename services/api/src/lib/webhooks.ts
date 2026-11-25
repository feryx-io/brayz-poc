import { prisma, type Prisma } from '@brayz/db';

export async function processWebhook(
  delivery: { source: string; eventId: string; eventType: string },
  process: (tx: Prisma.TransactionClient) => Promise<void>,
): Promise<boolean> {
  return prisma.$transaction(
    async (tx) => {
      const claimed = await tx.webhookDelivery.createMany({
        data: [delivery],
        skipDuplicates: true,
      });
      if (claimed.count === 0) return false;
      await process(tx);
      return true;
    },
    { timeout: 20_000 },
  );
}
