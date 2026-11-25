-- A spoken yes to order texts covers the order it was given for (add-only).
ALTER TABLE "sms_consent_records" ADD COLUMN "orderId" UUID;
