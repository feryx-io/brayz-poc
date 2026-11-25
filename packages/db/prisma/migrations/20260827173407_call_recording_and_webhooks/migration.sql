-- AlterTable
ALTER TABLE "calls" ADD COLUMN     "recordingId" TEXT,
ADD COLUMN     "recordingStatus" TEXT;

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "webhook_deliveries_receivedAt_idx" ON "webhook_deliveries"("receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_deliveries_source_eventId_key" ON "webhook_deliveries"("source", "eventId");
