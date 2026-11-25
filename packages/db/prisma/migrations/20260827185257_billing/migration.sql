-- CreateTable
CREATE TABLE "location_subscriptions" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "plan" TEXT,
    "status" TEXT NOT NULL DEFAULT 'none',
    "stripeCustomerId" TEXT,
    "stripeSubscriptionId" TEXT,
    "currentPeriodEnd" TIMESTAMP(3),
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "location_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "location_subscriptions_locationId_key" ON "location_subscriptions"("locationId");

-- CreateIndex
CREATE UNIQUE INDEX "location_subscriptions_stripeSubscriptionId_key" ON "location_subscriptions"("stripeSubscriptionId");

-- CreateIndex
CREATE INDEX "location_subscriptions_tenantId_idx" ON "location_subscriptions"("tenantId");

-- CreateIndex
CREATE INDEX "location_subscriptions_stripeCustomerId_idx" ON "location_subscriptions"("stripeCustomerId");

-- AddForeignKey
ALTER TABLE "location_subscriptions" ADD CONSTRAINT "location_subscriptions_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
