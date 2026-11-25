-- Per-location SMS destination for order-confirmation texts; falls back to mainPhone.
ALTER TABLE "locations" ADD COLUMN "notificationPhone" TEXT;
