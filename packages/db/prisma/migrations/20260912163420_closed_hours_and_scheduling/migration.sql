-- AlterTable
ALTER TABLE "location_ai_settings" ADD COLUMN     "closedBehavior" TEXT NOT NULL DEFAULT 'take_orders',
ADD COLUMN     "scheduleMaxDaysAhead" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "scheduleOrdersEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "scheduledFor" TIMESTAMP(3);
