ALTER TABLE "location_subscriptions" ADD COLUMN "stripeEventCreatedAt" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;
