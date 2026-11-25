-- CreateTable
CREATE TABLE "pos_integrations" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'manual',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "externalLocationId" TEXT,
    "environment" TEXT NOT NULL DEFAULT 'sandbox',
    "accessToken" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pos_integrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pos_order_syncs" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "externalOrderId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3),

    CONSTRAINT "pos_order_syncs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pos_integrations_locationId_key" ON "pos_integrations"("locationId");

-- CreateIndex
CREATE INDEX "pos_integrations_tenantId_idx" ON "pos_integrations"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "pos_order_syncs_orderId_key" ON "pos_order_syncs"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "pos_order_syncs_dedupeKey_key" ON "pos_order_syncs"("dedupeKey");

-- CreateIndex
CREATE INDEX "pos_order_syncs_tenantId_locationId_createdAt_idx" ON "pos_order_syncs"("tenantId", "locationId", "createdAt");

-- AddForeignKey
ALTER TABLE "pos_integrations" ADD CONSTRAINT "pos_integrations_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_order_syncs" ADD CONSTRAINT "pos_order_syncs_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
