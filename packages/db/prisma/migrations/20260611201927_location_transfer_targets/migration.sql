-- CreateTable
CREATE TABLE "location_transfer_targets" (
    "id" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "destination" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "location_transfer_targets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "location_transfer_targets_locationId_idx" ON "location_transfer_targets"("locationId");

-- CreateIndex
CREATE UNIQUE INDEX "location_transfer_targets_locationId_key_key" ON "location_transfer_targets"("locationId", "key");

-- AddForeignKey
ALTER TABLE "location_transfer_targets" ADD CONSTRAINT "location_transfer_targets_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
