-- AlterTable
ALTER TABLE "guests" ADD COLUMN     "birthdayDay" INTEGER,
ADD COLUMN     "birthdayMonth" INTEGER;

-- AlterTable
ALTER TABLE "location_loyalty_settings" ADD COLUMN     "birthdayBonusPoints" INTEGER NOT NULL DEFAULT 200,
ADD COLUMN     "birthdayEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "vipEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "vipPointsMultiplier" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN     "vipSpendCents" INTEGER NOT NULL DEFAULT 50000,
ADD COLUMN     "winbackBonusPoints" INTEGER NOT NULL DEFAULT 200,
ADD COLUMN     "winbackDays" INTEGER NOT NULL DEFAULT 60,
ADD COLUMN     "winbackEnabled" BOOLEAN NOT NULL DEFAULT false;
