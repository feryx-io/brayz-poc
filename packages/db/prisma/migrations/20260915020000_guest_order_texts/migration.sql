-- Guest order-update texts, consented to on the call (add-only).
ALTER TABLE "location_ai_settings" ADD COLUMN "guestOrderTextsEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "sms_consent_records" ADD COLUMN "callId" UUID;
ALTER TABLE "notifications" ADD COLUMN "audience" TEXT NOT NULL DEFAULT 'restaurant';
