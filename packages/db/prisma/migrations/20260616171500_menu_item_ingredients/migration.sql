-- Optional per-item ingredient list (bot answers ingredient questions from this only).
ALTER TABLE "menu_items" ADD COLUMN "ingredients" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
