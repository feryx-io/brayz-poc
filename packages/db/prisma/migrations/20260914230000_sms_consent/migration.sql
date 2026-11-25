-- Append-only ledger of consent to receive texts (add-only).
CREATE TABLE "sms_consent_records" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "phone" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "disclosureVersion" TEXT NOT NULL,
    "disclosureText" TEXT NOT NULL,
    "actorUserId" UUID,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "providerMessageId" TEXT,
    "replyText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sms_consent_records_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "sms_consent_records_tenantId_locationId_phone_purpose_creat_idx" ON "sms_consent_records"("tenantId", "locationId", "phone", "purpose", "createdAt");
CREATE INDEX "sms_consent_records_tenantId_phone_createdAt_idx" ON "sms_consent_records"("tenantId", "phone", "createdAt");
