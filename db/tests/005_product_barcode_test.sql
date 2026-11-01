-- =============================================================================
--  Test: Produkt-Barcodes – Eindeutigkeit über Einzelbarcodes und Gebinde-GTINs
-- =============================================================================
\set QUIET on
BEGIN;

INSERT INTO app.tenants (id, slug, name) VALUES
  ('55555555-5555-5555-5555-555555555555', 'produkte-a', 'Produkte A'),
  ('66666666-6666-6666-6666-666666666666', 'produkte-b', 'Produkte B');
INSERT INTO app.users (id, tenant_id, email, display_name, role) VALUES
  ('c5000000-0000-0000-0000-000000000001', '55555555-5555-5555-5555-555555555555', 'owner@produkte-a.tn', 'A', 'owner'),
  ('c6000000-0000-0000-0000-000000000001', '66666666-6666-6666-6666-666666666666', 'owner@produkte-b.tn', 'B', 'owner');
INSERT INTO app.products (id, tenant_id, sku, name) VALUES
  ('e5000000-0000-0000-0000-000000000001', '55555555-5555-5555-5555-555555555555', 'A-001', '{"fr":"Produit A","en":"Product A"}'),
  ('e5000000-0000-0000-0000-000000000002', '55555555-5555-5555-5555-555555555555', 'A-002', '{"fr":"Produit A2"}'),
  ('e6000000-0000-0000-0000-000000000001', '66666666-6666-6666-6666-666666666666', 'B-001', '{"fr":"Produit B"}');

INSERT INTO app.product_barcodes (tenant_id, product_id, code, pack_qty)
VALUES ('55555555-5555-5555-5555-555555555555', 'e5000000-0000-0000-0000-000000000001', 'A-UPC-001', 1);
INSERT INTO app.product_packagings (tenant_id, product_id, code, name, factor, gtin)
VALUES ('55555555-5555-5555-5555-555555555555', 'e5000000-0000-0000-0000-000000000001',
        'carton', '{"fr":"Carton de 12"}', 12, 'A-GTIN-012');

DO $$ BEGIN
  BEGIN
    INSERT INTO app.product_barcodes (tenant_id, product_id, code)
    VALUES ('55555555-5555-5555-5555-555555555555', 'e5000000-0000-0000-0000-000000000002', 'A-UPC-001');
    RAISE EXCEPTION 'P1 FAIL: doppelter Produkt-Barcode akzeptiert';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'P1 ok: doppelter Produkt-Barcode abgewiesen';
  END;

  BEGIN
    INSERT INTO app.product_packagings (tenant_id, product_id, code, name, factor, gtin)
    VALUES ('55555555-5555-5555-5555-555555555555', 'e5000000-0000-0000-0000-000000000002',
            'carton', '{"fr":"Carton"}', 12, 'A-UPC-001');
    RAISE EXCEPTION 'P2 FAIL: Barcode/Gtin-Kollision akzeptiert';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'P2 ok: Barcode/Gtin-Kollision abgewiesen';
  END;
END $$;

SET LOCAL ROLE app_user;
SELECT set_config('app.tenant_id', '55555555-5555-5555-5555-555555555555', true),
       set_config('app.user_id', 'c5000000-0000-0000-0000-000000000001', true),
       set_config('app.role', 'owner', true),
       set_config('app.store_ids', '', true) \gset

DO $$ BEGIN
  IF (SELECT count(*) FROM app.product_barcodes WHERE code = 'A-UPC-001') <> 1
     OR (SELECT count(*) FROM app.product_packagings WHERE gtin = 'A-GTIN-012') <> 1 THEN
    RAISE EXCEPTION 'P3 FAIL: eigener Mandant sieht seine Barcodes nicht';
  END IF;
  RAISE NOTICE 'P3 ok: eigener Mandant sieht Produkt-Barcode und Gebinde-GTIN';
END $$;

SELECT set_config('app.tenant_id', '66666666-6666-6666-6666-666666666666', true),
       set_config('app.user_id', 'c6000000-0000-0000-0000-000000000001', true),
       set_config('app.role', 'owner', true) \gset

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM app.product_barcodes WHERE code = 'A-UPC-001')
     OR EXISTS (SELECT 1 FROM app.product_packagings WHERE gtin = 'A-GTIN-012') THEN
    RAISE EXCEPTION 'P4 FAIL: fremder Mandant sieht A-Barcodes';
  END IF;
  RAISE NOTICE 'P4 ok: Mandant B sieht A-Barcodes nicht';
END $$;

ROLLBACK;
\echo 'ALLE PRODUKT-BARCODE-TESTS BESTANDEN'
