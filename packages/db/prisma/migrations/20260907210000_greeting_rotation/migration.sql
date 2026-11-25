-- Greetings become a rotated list, and a regular's welcome-back line gets its own.
ALTER TABLE "locations" ADD COLUMN "aiGreetings" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "welcomeBackLines" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- The single greeting an owner already wrote becomes the first (and only) line.
UPDATE "locations" SET "aiGreetings" = ARRAY["aiGreeting"] WHERE "aiGreeting" IS NOT NULL AND btrim("aiGreeting") <> '';

ALTER TABLE "locations" DROP COLUMN "aiGreeting";
