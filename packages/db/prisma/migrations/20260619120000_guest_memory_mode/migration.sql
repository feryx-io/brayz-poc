-- Per-location guest-memory personalization posture: full | confirm | off.
ALTER TABLE "location_ai_settings" ADD COLUMN "guestMemoryMode" TEXT NOT NULL DEFAULT 'full';
