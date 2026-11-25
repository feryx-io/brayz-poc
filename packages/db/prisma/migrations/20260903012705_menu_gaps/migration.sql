-- CreateTable
CREATE TABLE "menu_gaps" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "callId" UUID,
    "kind" TEXT NOT NULL,
    "term" TEXT NOT NULL,
    "rawTerm" TEXT NOT NULL,
    "onItem" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "menu_gaps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "menu_gaps_tenantId_locationId_createdAt_idx" ON "menu_gaps"("tenantId", "locationId", "createdAt");

-- CreateIndex
CREATE INDEX "menu_gaps_locationId_term_idx" ON "menu_gaps"("locationId", "term");

-- AddForeignKey
ALTER TABLE "menu_gaps" ADD CONSTRAINT "menu_gaps_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_gaps" ADD CONSTRAINT "menu_gaps_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_gaps" ADD CONSTRAINT "menu_gaps_callId_fkey" FOREIGN KEY ("callId") REFERENCES "calls"("id") ON DELETE SET NULL ON UPDATE CASCADE;
