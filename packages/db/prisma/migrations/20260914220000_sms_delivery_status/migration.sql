-- What became of a text after the provider accepted it (add-only).
ALTER TABLE "notifications" ADD COLUMN "providerMessageId" TEXT;
ALTER TABLE "notifications" ADD COLUMN "deliveryStatus" TEXT;
ALTER TABLE "notifications" ADD COLUMN "deliveryErrorCode" TEXT;
ALTER TABLE "notifications" ADD COLUMN "deliveryUpdatedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "notifications_providerMessageId_key" ON "notifications"("providerMessageId");
CREATE INDEX "notifications_locationId_createdAt_idx" ON "notifications"("locationId", "createdAt");
