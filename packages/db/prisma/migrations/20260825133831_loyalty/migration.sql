-- CreateTable
CREATE TABLE "location_loyalty_settings" (
    "id" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "pointsPerDollar" INTEGER NOT NULL DEFAULT 10,
    "rewardPoints" INTEGER NOT NULL DEFAULT 500,
    "rewardCents" INTEGER NOT NULL DEFAULT 500,

    CONSTRAINT "location_loyalty_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loyalty_accounts" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "guestId" UUID NOT NULL,
    "pointsBalance" INTEGER NOT NULL DEFAULT 0,
    "lifetimePoints" INTEGER NOT NULL DEFAULT 0,
    "lifetimeSpendCents" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "loyalty_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loyalty_events" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "orderId" UUID,
    "note" TEXT,
    "dedupeKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "loyalty_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "location_loyalty_settings_locationId_key" ON "location_loyalty_settings"("locationId");

-- CreateIndex
CREATE UNIQUE INDEX "loyalty_accounts_guestId_key" ON "loyalty_accounts"("guestId");

-- CreateIndex
CREATE INDEX "loyalty_accounts_tenantId_idx" ON "loyalty_accounts"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "loyalty_events_dedupeKey_key" ON "loyalty_events"("dedupeKey");

-- CreateIndex
CREATE INDEX "loyalty_events_accountId_createdAt_idx" ON "loyalty_events"("accountId", "createdAt");

-- AddForeignKey
ALTER TABLE "location_loyalty_settings" ADD CONSTRAINT "location_loyalty_settings_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_accounts" ADD CONSTRAINT "loyalty_accounts_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "guests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_events" ADD CONSTRAINT "loyalty_events_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "loyalty_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
