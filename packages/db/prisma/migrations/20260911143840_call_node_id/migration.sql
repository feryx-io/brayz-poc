-- AlterTable
ALTER TABLE "calls" ADD COLUMN     "nodeId" TEXT;

-- CreateIndex
CREATE INDEX "calls_startedAt_idx" ON "calls"("startedAt");
