-- AlterTable
ALTER TABLE "guests" ADD COLUMN     "deliveryAddress" JSONB,
ADD COLUMN     "deliveryAddressUpdatedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "locations" ADD COLUMN     "deliveryEtaMinutes" INTEGER NOT NULL DEFAULT 45,
ADD COLUMN     "deliveryFeeCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "deliveryMinimumCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "deliveryRadiusMiles" DOUBLE PRECISION,
ADD COLUMN     "deliveryZipCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "latitude" DOUBLE PRECISION,
ADD COLUMN     "longitude" DOUBLE PRECISION,
ADD COLUMN     "pickupEtaMinutes" INTEGER NOT NULL DEFAULT 20;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "deliveryAddress" JSONB,
ADD COLUMN     "deliveryAreaCheck" TEXT,
ADD COLUMN     "deliveryFeeCents" INTEGER NOT NULL DEFAULT 0;
