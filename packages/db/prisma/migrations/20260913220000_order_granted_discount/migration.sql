-- Add-only. The discount granted when an order was placed, which a change to
-- the order keeps. Existing orders get what their totals imply.
ALTER TABLE "orders" ADD COLUMN "discountCents" INTEGER NOT NULL DEFAULT 0;

UPDATE "orders"
SET "discountCents" = GREATEST(0, "subtotalCents" + "deliveryFeeCents" - "totalCents")
WHERE "subtotalCents" + "deliveryFeeCents" > "totalCents";
