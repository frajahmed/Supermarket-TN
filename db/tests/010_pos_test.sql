-- =============================================================================
--  Test: Kasse (Migration 010) – Bonnummern, Preise/TVA, Rabattfreigabe, Zahlung, Storno
-- =============================================================================
\set QUIET on
BEGIN;
INSERT INTO app.tenants (id, slug, name, settings) VALUES
  ('da000000-0000-0000-0000-000000000001', 'pos-a', 'Supérette', '{"cashier_max_discount_bp": 500}'),
  ('ea000000-0000-0000-0000-000000000001', 'pos-b', 'Autre', '{}');
INSERT INTO app.stores (id, tenant_id, code, name) VALUES
  ('da000000-0000-0000-0000-0000000005a1', 'da000000-0000-0000-0000-000000000001', 'M1', 'Magasin');
INSERT INTO app.users (id, tenant_id, email, display_name, role) VALUES
  ('da000000-0000-0000-0000-0000000000b1', 'da000000-0000-0000-0000-000000000001', 'gerant@pos.tn', 'Gérant', 'manager'),
  ('da000000-0000-0000-0000-0000000000c1', 'da000000-0000-0000-0000-000000000001', 'caisse@pos.tn', 'Caisse', 'cashier'),
  ('da000000-0000-0000-0000-0000000000c2', 'da000000-0000-0000-0000-000000000001', 'caisse2@pos.tn', 'Caisse 2', 'cashier'),
  ('ea000000-0000-0000-0000-0000000000a1', 'ea000000-0000-0000-0000-000000000001', 'b@pos.tn', 'B', 'owner');
INSERT INTO app.user_store_access (tenant_id, user_id, store_id) VALUES
  ('da000000-0000-0000-0000-000000000001', 'da000000-0000-0000-0000-0000000000b1', 'da000000-0000-0000-0000-0000000005a1'),
  ('da000000-0000-0000-0000-000000000001', 'da000000-0000-0000-0000-0000000000c1', 'da000000-0000-0000-0000-0000000005a1');
INSERT INTO app.devices (id, tenant_id, name, kind) VALUES
  ('da000000-0000-0000-0000-0000000000f1', 'da000000-0000-0000-0000-000000000001', 'Caisse 1', 'pos'),
  ('da000000-0000-0000-0000-0000000000f2', 'da000000-0000-0000-0000-000000000001', 'Caisse 2', 'pos');
INSERT INTO app.products (id, tenant_id, sku, name, sale_price, tax_rate_bp) VALUES
  ('da000000-0000-0000-0000-0000000000e1', 'da000000-0000-0000-0000-000000000001', 'EAU', '{"fr":"Eau 1,5 L"}', 750, 1900),
  ('da000000-0000-0000-0000-0000000000e2', 'da000000-0000-0000-0000-000000000001', 'PAIN', '{"fr":"Pain"}', 200, 0);
-- Filialpreis überschreibt den Standardpreis
INSERT INTO app.store_products (tenant_id, store_id, product_id, sale_price) VALUES
  ('da000000-0000-0000-0000-000000000001', 'da000000-0000-0000-0000-0000000005a1', 'da000000-0000-0000-0000-0000000000e2', 230);

SET LOCAL ROLE app_user;
CREATE FUNCTION pg_temp.as_user(u uuid, r text) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('app.tenant_id', 'da000000-0000-0000-0000-000000000001', true),
         set_config('app.user_id', u::text, true), set_config('app.role', r, true),
         set_config('app.store_ids', 'da000000-0000-0000-0000-0000000005a1', true);
$$;
CREATE FUNCTION pg_temp.sell(lines jsonb, pays jsonb, approver uuid, op uuid, device uuid DEFAULT 'da000000-0000-0000-0000-0000000000f1')
  RETURNS uuid LANGUAGE sql AS $$
  SELECT app.complete_sale('da000000-0000-0000-0000-0000000005a1', device, lines, pays, approver, op, now())
$$;
SELECT pg_temp.as_user('da000000-0000-0000-0000-0000000000c1', 'cashier') \gset

-- ---------- K1: Preise, TVA, Bonnummer, idempotent, Lager ----------
DO $$
DECLARE v1 uuid; v2 uuid; s app.sales;
BEGIN
  v1 := pg_temp.sell('[{"productId":"da000000-0000-0000-0000-0000000000e1","quantity":"2"},{"productId":"da000000-0000-0000-0000-0000000000e2","quantity":"3"}]',
                     '[{"method":"cash","amount":5000}]', NULL, 'da000000-0000-0000-0000-00000000a001');
  v2 := pg_temp.sell('[{"productId":"da000000-0000-0000-0000-0000000000e1","quantity":"99"}]', '[{"method":"cash","amount":1}]', NULL,
                     'da000000-0000-0000-0000-00000000a001');
  IF v1 <> v2 THEN RAISE EXCEPTION 'K1 FAIL: nicht idempotent'; END IF;
  SELECT * INTO s FROM app.sales WHERE id = v1;
  -- 2 x 0,750 + 3 x 0,230 (Filialpreis) = 2,190; TVA in 1,500 bei 19 % = 0,239 (round(1500*1900/11900))
  IF s.gross_total <> 2190 OR s.tax_total <> 239 OR s.net_total <> 1951 OR s.receipt_number <> 1 OR s.status <> 'completed' THEN
    RAISE EXCEPTION 'K1 FAIL: Summen % / % / % Nr %', s.gross_total, s.tax_total, s.net_total, s.receipt_number;
  END IF;
  IF (SELECT sum(amount) FROM app.payments WHERE sale_id = v1 AND method = 'cash') <> 2190 THEN
    RAISE EXCEPTION 'K1 FAIL: Barzahlung nicht auf Bonbetrag gekürzt (Rückgeld)'; END IF;
  IF (SELECT sum(quantity_delta) FROM app.stock_movements WHERE ref_id = v1) <> -5 THEN RAISE EXCEPTION 'K1 FAIL: Lager'; END IF;
  PERFORM set_config('test.sale1', v1::text, false);
  RAISE NOTICE 'K1 ok: Bon Nr. 1 = 2,190 TTC (Filialpreis), TVA 0,239, Rückgeld nicht gespeichert, Lager -5, doppelt = einmal';
END $$;

-- ---------- K2: Bonnummern lückenlos – auch nach abgelehntem Verkauf; je Kasse eigene Folge ----------
DO $$
DECLARE n bigint; ok boolean := false;
BEGIN
  BEGIN
    PERFORM pg_temp.sell('[{"productId":"da000000-0000-0000-0000-0000000000e1","quantity":"1"}]', '[{"method":"cash","amount":100}]', NULL, gen_random_uuid());
  EXCEPTION WHEN sqlstate 'SN422' THEN ok := true; END;
  IF NOT ok THEN RAISE EXCEPTION 'K2 FAIL: Unterzahlung akzeptiert'; END IF;
  SELECT receipt_number INTO n FROM app.sales WHERE id = pg_temp.sell('[{"productId":"da000000-0000-0000-0000-0000000000e2","quantity":"1"}]',
         '[{"method":"cash","amount":230}]', NULL, gen_random_uuid());
  IF n <> 2 THEN RAISE EXCEPTION 'K2 FAIL: Nummer % statt 2 (Lücke durch abgelehnten Verkauf)', n; END IF;
  SELECT receipt_number INTO n FROM app.sales WHERE id = pg_temp.sell('[{"productId":"da000000-0000-0000-0000-0000000000e2","quantity":"1"}]',
         '[{"method":"cash","amount":230}]', NULL, gen_random_uuid(), 'da000000-0000-0000-0000-0000000000f2');
  IF n <> 1 THEN RAISE EXCEPTION 'K2 FAIL: Kasse 2 beginnt bei %', n; END IF;
  RAISE NOTICE 'K2 ok: abgelehnter Verkauf hinterlässt keine Lücke (1, 2), Kasse 2 zählt eigenständig ab 1';
END $$;

-- ---------- K3: Rabatt über Limit nur mit Freigabe ----------
DO $$
DECLARE ok boolean := false; v uuid;
BEGIN
  BEGIN
    PERFORM pg_temp.sell('[{"productId":"da000000-0000-0000-0000-0000000000e1","quantity":"10","discountBp":1000}]', '[{"method":"cash","amount":10000}]', NULL, gen_random_uuid());
  EXCEPTION WHEN sqlstate 'SN403' THEN ok := true; END;
  IF NOT ok THEN RAISE EXCEPTION 'K3 FAIL: 10 %% Rabatt ohne Freigabe'; END IF;
  ok := false;
  BEGIN   -- Freigabe durch einen Kassierer zählt nicht
    PERFORM pg_temp.sell('[{"productId":"da000000-0000-0000-0000-0000000000e1","quantity":"10","discountBp":1000}]', '[{"method":"cash","amount":10000}]',
                         'da000000-0000-0000-0000-0000000000c2', gen_random_uuid());
  EXCEPTION WHEN sqlstate 'SN403' THEN ok := true; END;
  IF NOT ok THEN RAISE EXCEPTION 'K3 FAIL: Kassierer als Freigeber akzeptiert'; END IF;
  -- 5 % ist erlaubt
  PERFORM pg_temp.sell('[{"productId":"da000000-0000-0000-0000-0000000000e1","quantity":"1","discountBp":500}]', '[{"method":"cash","amount":750}]', NULL, gen_random_uuid());
  v := pg_temp.sell('[{"productId":"da000000-0000-0000-0000-0000000000e1","quantity":"10","discountBp":1000}]', '[{"method":"card","amount":6750,"terminalRef":"T-1"}]',
                    'da000000-0000-0000-0000-0000000000b1', gen_random_uuid());
  IF (SELECT discount_total FROM app.sales WHERE id = v) <> 750 OR (SELECT gross_total FROM app.sales WHERE id = v) <> 6750
     OR (SELECT discount_approved_by FROM app.sales WHERE id = v) <> 'da000000-0000-0000-0000-0000000000b1' THEN
    RAISE EXCEPTION 'K3 FAIL: Rabatt/Freigabe nicht gespeichert'; END IF;
  IF NOT EXISTS (SELECT 1 FROM app.audit_log WHERE action = 'discount.approve' AND entity_id = v) THEN RAISE EXCEPTION 'K3 FAIL: Audit'; END IF;
  RAISE NOTICE 'K3 ok: 10 %% Rabatt ohne bzw. mit Kassierer-Freigabe abgelehnt, 5 %% frei, mit Filialleiter gebucht + Audit';
END $$;

-- ---------- K4: Zahlung: Karte nie über Bonbetrag; abgeschlossener Bon unveränderlich ----------
DO $$
DECLARE ok boolean := false;
BEGIN
  BEGIN
    PERFORM pg_temp.sell('[{"productId":"da000000-0000-0000-0000-0000000000e2","quantity":"1"}]', '[{"method":"card","amount":500}]', NULL, gen_random_uuid());
  EXCEPTION WHEN sqlstate 'SN422' THEN ok := true; END;
  IF NOT ok THEN RAISE EXCEPTION 'K4 FAIL: Rückgeld auf Karte'; END IF;
  ok := false;
  BEGIN UPDATE app.sales SET gross_total = 1 WHERE id = current_setting('test.sale1')::uuid;
  EXCEPTION WHEN sqlstate 'SN409' THEN ok := true; END;
  IF NOT ok THEN RAISE EXCEPTION 'K4 FAIL: Bon änderbar'; END IF;
  ok := false;
  BEGIN DELETE FROM app.sale_lines WHERE sale_id = current_setting('test.sale1')::uuid;
  EXCEPTION WHEN sqlstate 'SN409' THEN ok := true; END;
  IF NOT ok THEN RAISE EXCEPTION 'K4 FAIL: Position löschbar'; END IF;
  RAISE NOTICE 'K4 ok: Karte über Bonbetrag abgelehnt, abgeschlossener Bon und Positionen unveränderlich';
END $$;

-- ---------- K5: Storno nur Filialleitung, als Gegenbon, einmal ----------
DO $$
DECLARE ok boolean := false;
BEGIN
  BEGIN PERFORM app.void_sale(current_setting('test.sale1')::uuid, 'da000000-0000-0000-0000-0000000000f1', 'Kunde verzichtet', gen_random_uuid());
  EXCEPTION WHEN insufficient_privilege THEN ok := true; END;
  IF NOT ok THEN RAISE EXCEPTION 'K5 FAIL: Kassierer storniert'; END IF;
  RAISE NOTICE 'K5a ok: Kassierer darf nicht stornieren';
END $$;
SELECT pg_temp.as_user('da000000-0000-0000-0000-0000000000b1', 'manager') \gset
DO $$
DECLARE v uuid; v2 uuid; s app.sales; ok boolean := false; stock_before numeric; stock_after numeric;
BEGIN
  SELECT quantity INTO stock_before FROM app.store_stock WHERE product_id = 'da000000-0000-0000-0000-0000000000e1';
  v := app.void_sale(current_setting('test.sale1')::uuid, 'da000000-0000-0000-0000-0000000000f1', 'Falsch gescannt', 'da000000-0000-0000-0000-00000000a0ff');
  v2 := app.void_sale(current_setting('test.sale1')::uuid, 'da000000-0000-0000-0000-0000000000f1', 'Falsch gescannt', 'da000000-0000-0000-0000-00000000a0ff');
  IF v <> v2 THEN RAISE EXCEPTION 'K5 FAIL: Storno nicht idempotent'; END IF;
  SELECT * INTO s FROM app.sales WHERE id = v;
  IF s.gross_total <> -2190 OR s.voids_sale_id <> current_setting('test.sale1')::uuid OR s.receipt_number <> 5 THEN
    RAISE EXCEPTION 'K5 FAIL: Gegenbon % Nr %', s.gross_total, s.receipt_number; END IF;
  IF (SELECT sum(amount) FROM app.payments WHERE sale_id = v) <> -2190 THEN RAISE EXCEPTION 'K5 FAIL: Zahlung'; END IF;
  SELECT quantity INTO stock_after FROM app.store_stock WHERE product_id = 'da000000-0000-0000-0000-0000000000e1';
  IF stock_after - stock_before <> 2 THEN RAISE EXCEPTION 'K5 FAIL: Lager nicht zurückgebucht'; END IF;
  IF (SELECT status FROM app.sales WHERE id = current_setting('test.sale1')::uuid) <> 'completed' THEN RAISE EXCEPTION 'K5 FAIL: Original verändert'; END IF;
  BEGIN PERFORM app.void_sale(current_setting('test.sale1')::uuid, 'da000000-0000-0000-0000-0000000000f1', 'nochmal', gen_random_uuid());
  EXCEPTION WHEN sqlstate 'SN409' THEN ok := true; END;
  IF NOT ok THEN RAISE EXCEPTION 'K5 FAIL: doppelt storniert'; END IF;
  RAISE NOTICE 'K5 ok: Gegenbon Nr. 5 (lückenlos nach 4) (−2,190), Zahlung und Lager zurück, Original unverändert, nur einmal';
END $$;

-- ---------- K6: anderer Mandant sieht nichts ----------
SELECT set_config('app.tenant_id', 'ea000000-0000-0000-0000-000000000001', true),
       set_config('app.user_id', 'ea000000-0000-0000-0000-0000000000a1', true),
       set_config('app.role', 'owner', true) \gset
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM app.sales) OR EXISTS (SELECT 1 FROM app.sale_lines) OR EXISTS (SELECT 1 FROM app.payments)
     OR EXISTS (SELECT 1 FROM app.register_counters) THEN RAISE EXCEPTION 'K6 FAIL: fremde Kassendaten sichtbar'; END IF;
  RAISE NOTICE 'K6 ok: anderer Mandant sieht keine Bons, Zahlungen oder Zähler';
END $$;

ROLLBACK;
\echo 'ALLE KASSEN-TESTS BESTANDEN'
