-- CreateTable
CREATE TABLE "call_messages" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "callId" UUID,
    "callerName" TEXT,
    "callbackNumber" TEXT,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'new',
    "notifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "doneAt" TIMESTAMP(3),
    "doneById" UUID,

    CONSTRAINT "call_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "call_messages_tenantId_locationId_status_createdAt_idx" ON "call_messages"("tenantId", "locationId", "status", "createdAt");

-- AddForeignKey
ALTER TABLE "call_messages" ADD CONSTRAINT "call_messages_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_messages" ADD CONSTRAINT "call_messages_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_messages" ADD CONSTRAINT "call_messages_callId_fkey" FOREIGN KEY ("callId") REFERENCES "calls"("id") ON DELETE SET NULL ON UPDATE CASCADE;
