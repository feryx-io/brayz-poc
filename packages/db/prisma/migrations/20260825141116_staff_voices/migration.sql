-- AlterTable
ALTER TABLE "location_ai_settings" ADD COLUMN     "fixedVoiceProfileId" UUID,
ADD COLUMN     "voiceMode" TEXT NOT NULL DEFAULT 'default';

-- CreateTable
CREATE TABLE "staff_profiles" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "staff_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_voice_profiles" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "staffProfileId" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "provider" TEXT,
    "providerVoiceId" TEXT,
    "enabledForRotation" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "staff_voice_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voice_consent_records" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "staffProfileId" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "notes" TEXT,
    "recordedByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "voice_consent_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "staff_profiles_tenantId_locationId_idx" ON "staff_profiles"("tenantId", "locationId");

-- CreateIndex
CREATE INDEX "staff_voice_profiles_staffProfileId_idx" ON "staff_voice_profiles"("staffProfileId");

-- CreateIndex
CREATE INDEX "voice_consent_records_staffProfileId_createdAt_idx" ON "voice_consent_records"("staffProfileId", "createdAt");

-- AddForeignKey
ALTER TABLE "staff_profiles" ADD CONSTRAINT "staff_profiles_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_voice_profiles" ADD CONSTRAINT "staff_voice_profiles_staffProfileId_fkey" FOREIGN KEY ("staffProfileId") REFERENCES "staff_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_consent_records" ADD CONSTRAINT "voice_consent_records_staffProfileId_fkey" FOREIGN KEY ("staffProfileId") REFERENCES "staff_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
