-- CreateTable
CREATE TABLE "location_holiday_hours" (
    "id" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "closed" BOOLEAN NOT NULL DEFAULT true,
    "opensAt" INTEGER,
    "closesAt" INTEGER,
    "label" TEXT,

    CONSTRAINT "location_holiday_hours_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "location_ai_settings" (
    "id" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "transferEnabled" BOOLEAN NOT NULL DEFAULT true,
    "transferWhenOpen" BOOLEAN NOT NULL DEFAULT true,
    "offerMessageWhenClosed" BOOLEAN NOT NULL DEFAULT true,
    "maxCallSeconds" INTEGER NOT NULL DEFAULT 600,
    "voicePersona" TEXT,

    CONSTRAINT "location_ai_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "location_holiday_hours_locationId_date_key" ON "location_holiday_hours"("locationId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "location_ai_settings_locationId_key" ON "location_ai_settings"("locationId");

-- AddForeignKey
ALTER TABLE "location_holiday_hours" ADD CONSTRAINT "location_holiday_hours_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "location_ai_settings" ADD CONSTRAINT "location_ai_settings_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
