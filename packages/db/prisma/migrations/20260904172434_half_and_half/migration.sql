-- AlterTable
ALTER TABLE "menu_modifier_groups" ADD COLUMN     "allowsHalves" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "halfPricing" TEXT NOT NULL DEFAULT 'full';

-- AlterTable
ALTER TABLE "order_item_modifiers" ADD COLUMN     "portion" TEXT NOT NULL DEFAULT 'whole';

-- Backfill: halves are the norm for pizza toppings, and nobody should have to
-- click through 27 toppings per size to say so. The same rule lives in
-- defaultAllowsHalves (@brayz/shared) for groups created from now on.
UPDATE "menu_modifier_groups" g
SET "allowsHalves" = true
FROM "menu_items" mi
JOIN "menu_categories" c ON c.id = mi."categoryId"
WHERE g."menuItemId" = mi.id
  AND g."selectionType" = 'multi'
  AND g.name ILIKE '%topping%'
  AND (mi.name ILIKE '%pizza%' OR c.name ILIKE '%pizza%')
  AND mi.name NOT ILIKE '%calzone%'
  AND mi.name NOT ILIKE '%stromboli%';
