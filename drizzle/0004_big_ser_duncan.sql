-- Relax the UNIQUE constraint on catalog_item.item_id. Olander's P21
-- catalog has duplicate item_ids across different inv_mast_uids — typically
-- a multi-company P21 install where each company mints SKU numbers
-- independently and they collide. Backfill hit "597906" duplicated at
-- ~53K rows on 2026-05-12. inv_mast_uid stays the PK; the lookups that
-- used to rely on item_id uniqueness in queries are not load-bearing here.
ALTER TABLE "catalog_item" DROP CONSTRAINT "catalog_item_item_id_unique";
