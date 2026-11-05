-- =============================================================================
--  Test: Großhandelspreis ohne Preisliste = Nettopreis aus Bruttopreis (Migration 012)
-- =============================================================================
\set QUIET on
BEGIN;
INSERT INTO app.tenants (id, slug, name) VALUES ('dc000000-0000-0000-0000-000000000001', 'net-a', 'A');
INSERT INTO app.customers (id, tenant_id, number, name, tax_id) VALUES
  ('dc000000-0000-0000-0000-0000000000d1', 'dc000000-0000-0000-0000-000000000001', 'K1', 'Sans tarif', '1234567A'),
  ('dc000000-0000-0000-0000-0000000000d2', 'dc000000-0000-0000-0000-000000000001', 'K2', 'Avec tarif', '7654321B');
INSERT INTO app.products (id, tenant_id, sku, name, sale_price, tax_rate_bp) VALUES
  ('dc000000-0000-0000-0000-0000000000e1', 'dc000000-0000-0000-0000-000000000001', 'LAIT', '{"fr":"Lait"}', 1350, 1900),
  ('dc000000-0000-0000-0000-0000000000e2', 'dc000000-0000-0000-0000-000000000001', 'PAIN', '{"fr":"Pain"}', 230, 0);
INSERT INTO app.price_lists (id, tenant_id, name) VALUES ('dc000000-0000-0000-0000-0000000000f1', 'dc000000-0000-0000-0000-000000000001', 'Gros');
INSERT INTO app.price_list_items (tenant_id, price_list_id, product_id, unit_price) VALUES
  ('dc000000-0000-0000-0000-000000000001', 'dc000000-0000-0000-0000-0000000000f1', 'dc000000-0000-0000-0000-0000000000e1', 1000);
UPDATE app.customers SET price_list_id = 'dc000000-0000-0000-0000-0000000000f1' WHERE id = 'dc000000-0000-0000-0000-0000000000d2';
SET LOCAL ROLE app_user;
SELECT set_config('app.tenant_id', 'dc000000-0000-0000-0000-000000000001', true) \gset
DO $$ BEGIN
  -- 1,350 TTC bei 19 % -> 1,134 HT; mit TVA wieder 1,349 (Rundung) statt doppelt 1,607
  IF app.price_for('dc000000-0000-0000-0000-0000000000d1', 'dc000000-0000-0000-0000-0000000000e1', 1) <> 1134 THEN
    RAISE EXCEPTION 'N1 FAIL: %', app.price_for('dc000000-0000-0000-0000-0000000000d1', 'dc000000-0000-0000-0000-0000000000e1', 1); END IF;
  RAISE NOTICE 'N1 ok: ohne Preisliste 1,350 TTC -> 1,134 HT (keine doppelte TVA)';
  IF app.price_for('dc000000-0000-0000-0000-0000000000d1', 'dc000000-0000-0000-0000-0000000000e2', 1) <> 230 THEN RAISE EXCEPTION 'N2 FAIL'; END IF;
  RAISE NOTICE 'N2 ok: 0 %% TVA – Preis unverändert';
  IF app.price_for('dc000000-0000-0000-0000-0000000000d2', 'dc000000-0000-0000-0000-0000000000e1', 1) <> 1000 THEN RAISE EXCEPTION 'N3 FAIL'; END IF;
  RAISE NOTICE 'N3 ok: Preisliste (netto) bleibt unverändert';
END $$;
ROLLBACK;
\echo 'ALLE NETTOPREIS-TESTS BESTANDEN'
