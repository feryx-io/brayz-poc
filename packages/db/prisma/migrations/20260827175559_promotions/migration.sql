-- CreateTable
CREATE TABLE "promotions" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "code" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'amount_off',
    "percentOff" INTEGER,
    "amountOffCents" INTEGER,
    "minSubtotalCents" INTEGER NOT NULL DEFAULT 0,
    "audience" TEXT NOT NULL DEFAULT 'all',
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "maxRedemptions" INTEGER,
    "maxPerGuest" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "promotions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promotion_redemptions" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "promotionId" UUID NOT NULL,
    "guestId" UUID,
    "orderId" UUID,
    "discountCents" INTEGER NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "promotion_redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "promotions_tenantId_locationId_active_idx" ON "promotions"("tenantId", "locationId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "promotions_locationId_code_key" ON "promotions"("locationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "promotion_redemptions_dedupeKey_key" ON "promotion_redemptions"("dedupeKey");

-- CreateIndex
CREATE INDEX "promotion_redemptions_promotionId_createdAt_idx" ON "promotion_redemptions"("promotionId", "createdAt");

-- CreateIndex
CREATE INDEX "promotion_redemptions_guestId_idx" ON "promotion_redemptions"("guestId");

-- AddForeignKey
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_redemptions" ADD CONSTRAINT "promotion_redemptions_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "promotions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
