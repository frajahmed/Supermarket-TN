-- =============================================================================
--  Test: B2B-Verkaufsablauf (Migration 008)
--  Auftrag -> Kreditprüfung bei Bestätigung -> Teillieferung + Lager ->
--  Rechnung nur über gelieferte Menge -> Gutschrift -> Rollen und Mandanten
-- =============================================================================
\set QUIET on
BEGIN;

INSERT INTO app.tenants (id, slug, name, legal_name, tax_id, settings) VALUES
  ('d8000000-0000-0000-0000-000000000001', 'flow-a', 'Grossiste Flow', 'Grossiste Flow SARL', '1111111A/M/000', '{"stamp_duty_minor": 1000}'),
  ('e8000000-0000-0000-0000-000000000001', 'flow-b', 'Autre', NULL, NULL, '{}');
INSERT INTO app.stores (id, tenant_id, code, name) VALUES
  ('d8000000-0000-0000-0000-0000000005a1', 'd8000000-0000-0000-0000-000000000001', 'D1', 'Dépôt');
INSERT INTO app.users (id, tenant_id, email, display_name, role) VALUES
  ('d8000000-0000-0000-0000-0000000000a1', 'd8000000-0000-0000-0000-000000000001', 'chef@f.tn', 'Chef', 'owner'),
  ('d8000000-0000-0000-0000-0000000000b1', 'd8000000-0000-0000-0000-000000000001', 'gerant@f.tn', 'Gérant', 'manager'),
  ('d8000000-0000-0000-0000-0000000000c1', 'd8000000-0000-0000-0000-000000000001', 'caisse@f.tn', 'Caisse', 'cashier'),
  ('e8000000-0000-0000-0000-0000000000a1', 'e8000000-0000-0000-0000-000000000001', 'b@b.tn', 'B', 'owner');
INSERT INTO app.user_store_access (tenant_id, user_id, store_id) VALUES
  ('d8000000-0000-0000-0000-000000000001', 'd8000000-0000-0000-0000-0000000000b1', 'd8000000-0000-0000-0000-0000000005a1'),
  ('d8000000-0000-0000-0000-000000000001', 'd8000000-0000-0000-0000-0000000000c1', 'd8000000-0000-0000-0000-0000000005a1');
INSERT INTO app.products (id, tenant_id, sku, name, sale_price, tax_rate_bp) VALUES
  ('d8000000-0000-0000-0000-0000000000e1', 'd8000000-0000-0000-0000-000000000001', 'HUILE', '{"fr":"Huile 1 L","ar":"زيت 1 لتر"}', 5000, 1900),
  ('d8000000-0000-0000-0000-0000000000e2', 'd8000000-0000-0000-0000-000000000001', 'PATES', '{"fr":"Pâtes 500 g"}', 1200, 700);
INSERT INTO app.price_lists (id, tenant_id, name) VALUES
  ('d8000000-0000-0000-0000-0000000000f1', 'd8000000-0000-0000-0000-000000000001', 'Revendeurs');
INSERT INTO app.price_list_items (tenant_id, price_list_id, product_id, min_qty, unit_price) VALUES
  ('d8000000-0000-0000-0000-000000000001', 'd8000000-0000-0000-0000-0000000000f1', 'd8000000-0000-0000-0000-0000000000e1', 1, 4500),
  ('d8000000-0000-0000-0000-000000000001', 'd8000000-0000-0000-0000-0000000000f1', 'd8000000-0000-0000-0000-0000000000e1', 100, 4200);
INSERT INTO app.customers (id, tenant_id, number, name, tax_id, price_list_id, payment_terms_days, credit_limit, preferred_locale) VALUES
  ('d8000000-0000-0000-0000-0000000000d1', 'd8000000-0000-0000-0000-000000000001', 'K-1', 'Épicerie El Amel', '2222222B/A/000',
   'd8000000-0000-0000-0000-0000000000f1', 30, 300000, 'ar-TN');   -- Limit 300,000 TND
-- Anfangsbestand 200 Flaschen Öl
INSERT INTO app.stock_movements (tenant_id, store_id, product_id, type, quantity_delta, client_op_id, user_id, occurred_at)
VALUES ('d8000000-0000-0000-0000-000000000001', 'd8000000-0000-0000-0000-0000000005a1', 'd8000000-0000-0000-0000-0000000000e1',
        'purchase_receipt', 200, gen_random_uuid(), 'd8000000-0000-0000-0000-0000000000a1', now());

SET LOCAL ROLE app_user;
CREATE FUNCTION pg_temp.as_user(u uuid, r text) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('app.tenant_id', 'd8000000-0000-0000-0000-000000000001', true),
         set_config('app.user_id', u::text, true), set_config('app.role', r, true),
         set_config('app.store_ids', 'd8000000-0000-0000-0000-0000000005a1', true);
$$;
SELECT pg_temp.as_user('d8000000-0000-0000-0000-0000000000b1', 'manager') \gset

-- ---------- S1: Auftrag mit Preisstaffel, idempotent ----------
DO $$
DECLARE v_id uuid; v_again uuid; v_price bigint; v_no text;
BEGIN
  v_id := app.create_sales_order('d8000000-0000-0000-0000-0000000005a1', 'd8000000-0000-0000-0000-0000000000d1',
    '[{"productId":"d8000000-0000-0000-0000-0000000000e1","quantity":"120"},{"productId":"d8000000-0000-0000-0000-0000000000e2","quantity":"50"}]',
    NULL, 'Test', 'd8000000-0000-0000-0000-00000000aaa1');
  v_again := app.create_sales_order('d8000000-0000-0000-0000-0000000005a1', 'd8000000-0000-0000-0000-0000000000d1',
    '[{"productId":"d8000000-0000-0000-0000-0000000000e1","quantity":"1"}]', NULL, NULL, 'd8000000-0000-0000-0000-00000000aaa1');
  IF v_again <> v_id THEN RAISE EXCEPTION 'S1 FAIL: nicht idempotent'; END IF;
  SELECT unit_price INTO v_price FROM app.sales_order_lines WHERE sales_order_id = v_id AND line_no = 1;
  IF v_price <> 4200 THEN RAISE EXCEPTION 'S1 FAIL: Staffelpreis % statt 4200', v_price; END IF;
  SELECT number INTO v_no FROM app.sales_orders WHERE id = v_id;
  IF v_no NOT LIKE 'SO-%-000001' THEN RAISE EXCEPTION 'S1 FAIL: Nummer %', v_no; END IF;
  PERFORM set_config('test.order', v_id::text, false);
  RAISE NOTICE 'S1 ok: Auftrag % mit Staffelpreis 4,200 (ab 100), doppelt gesendet = einmal angelegt', v_no;
END $$;

-- ---------- S2: Kreditlimit blockiert die BESTÄTIGUNG (Kriterium 1) ----------
-- Auftrag brutto: 120×4,200 = 504,000 + 19 % = 599,760; 50×1,121 (netto aus 1,200 TTC) = 56,050 + 7 % = 59,974;
-- + Timbre 1,000 = 660,734 > 300,000
DO $$
DECLARE v_order uuid := current_setting('test.order')::uuid; v_status app.order_status;
BEGIN
  IF app.sales_order_gross(v_order) <> 660734 THEN RAISE EXCEPTION 'S2 FAIL: Brutto %', app.sales_order_gross(v_order); END IF;
  BEGIN
    PERFORM app.confirm_sales_order(v_order, 'Stammkunde');      -- Filialleiter darf NICHT übersteuern
    RAISE EXCEPTION 'S2 FAIL: Filialleiter bestätigt trotz Limit';
  EXCEPTION WHEN SQLSTATE 'SN402' THEN NULL; END;
  SELECT status INTO v_status FROM app.sales_orders WHERE id = v_order;
  IF v_status <> 'draft' THEN RAISE EXCEPTION 'S2 FAIL: Status %', v_status; END IF;
  RAISE NOTICE 'S2 ok: Bestätigung über Kreditlimit (660,734 > 300,000) blockiert, auch mit Begründung durch Filialleiter';
END $$;

-- ---------- S3: Inhaber übersteuert mit Begründung -> Audit ----------
SELECT pg_temp.as_user('d8000000-0000-0000-0000-0000000000a1', 'owner') \gset
DO $$
DECLARE v_order uuid := current_setting('test.order')::uuid;
BEGIN
  BEGIN
    PERFORM app.confirm_sales_order(v_order, '  ');
    RAISE EXCEPTION 'S3 FAIL: Übersteuerung ohne Begründung';
  EXCEPTION WHEN SQLSTATE 'SN402' THEN NULL; END;
  PERFORM app.confirm_sales_order(v_order, 'Zahlung per Scheck zugesagt');
  IF (SELECT status FROM app.sales_orders WHERE id = v_order) <> 'confirmed' THEN RAISE EXCEPTION 'S3 FAIL: nicht bestätigt'; END IF;
  IF NOT EXISTS (SELECT 1 FROM app.audit_log WHERE action = 'credit.override' AND entity_id = v_order
                  AND after->>'reason' = 'Zahlung per Scheck zugesagt') THEN RAISE EXCEPTION 'S3 FAIL: kein Audit'; END IF;
  RAISE NOTICE 'S3 ok: Inhaber übersteuert nur mit Begründung, Audit-Eintrag vorhanden';
END $$;

-- ---------- S4: Teillieferung bucht Lager, Überlieferung abgewiesen, idempotent ----------
SELECT pg_temp.as_user('d8000000-0000-0000-0000-0000000000b1', 'manager') \gset
DO $$
DECLARE v_order uuid := current_setting('test.order')::uuid; l1 uuid; l2 uuid; v_del uuid; v_again uuid; v_stock numeric;
BEGIN
  SELECT id INTO l1 FROM app.sales_order_lines WHERE sales_order_id = v_order AND line_no = 1;
  SELECT id INTO l2 FROM app.sales_order_lines WHERE sales_order_id = v_order AND line_no = 2;
  BEGIN
    PERFORM app.deliver_sales_order(v_order, jsonb_build_array(jsonb_build_object('orderLineId', l1, 'quantity', '121')), gen_random_uuid());
    RAISE EXCEPTION 'S4 FAIL: Überlieferung akzeptiert';
  EXCEPTION WHEN SQLSTATE 'SN422' THEN NULL; END;
  -- 1. Lieferung: 70 Öl, keine Nudeln
  v_del := app.deliver_sales_order(v_order, jsonb_build_array(jsonb_build_object('orderLineId', l1, 'quantity', '70')),
                                   'd8000000-0000-0000-0000-00000000bbb1');
  v_again := app.deliver_sales_order(v_order, jsonb_build_array(jsonb_build_object('orderLineId', l1, 'quantity', '70')),
                                     'd8000000-0000-0000-0000-00000000bbb1');
  IF v_again <> v_del THEN RAISE EXCEPTION 'S4 FAIL: Lieferung doppelt'; END IF;
  SELECT quantity INTO v_stock FROM app.store_stock WHERE product_id = 'd8000000-0000-0000-0000-0000000000e1';
  IF v_stock <> 130 THEN RAISE EXCEPTION 'S4 FAIL: Bestand % statt 130', v_stock; END IF;
  IF (SELECT status FROM app.sales_orders WHERE id = v_order) <> 'confirmed' THEN RAISE EXCEPTION 'S4 FAIL: Status nach Teillieferung'; END IF;
  IF (SELECT number FROM app.sales_deliveries WHERE id = v_del) NOT LIKE 'BL-%-000001' THEN RAISE EXCEPTION 'S4 FAIL: BL-Nummer'; END IF;
  PERFORM set_config('test.del1', v_del::text, false);
  PERFORM set_config('test.l1', l1::text, false);
  PERFORM set_config('test.l2', l2::text, false);
  RAISE NOTICE 'S4 ok: Teillieferung 70 von 120 bucht Lager (200 -> 130), Überlieferung abgewiesen, doppelt gesendet = einmal';
END $$;

-- ---------- S5: Rechnung nur über gelieferte Menge (Kriterium 2) ----------
DO $$
DECLARE inv app.sales_invoices; v_inv uuid; v_qty numeric; v_desc text;
BEGIN
  v_inv := app.invoice_delivery(current_setting('test.del1')::uuid);
  SELECT * INTO inv FROM app.sales_invoices WHERE id = v_inv;
  SELECT sum(quantity), min(description) INTO v_qty, v_desc FROM app.sales_invoice_lines WHERE invoice_id = v_inv;
  -- 70 × 4,200 = 294,000 HT, TVA 19 % = 55,860, Timbre 1,000 -> 350,860
  IF v_qty <> 70 OR inv.net_total <> 294000 OR inv.tax_total <> 55860 OR inv.gross_total <> 350860 THEN
    RAISE EXCEPTION 'S5 FAIL: Menge % / HT % / TVA % / TTC %', v_qty, inv.net_total, inv.tax_total, inv.gross_total;
  END IF;
  IF v_desc <> 'زيت 1 لتر' THEN RAISE EXCEPTION 'S5 FAIL: Bezeichnung nicht in Kundensprache (%)', v_desc; END IF;
  IF app.invoice_delivery(current_setting('test.del1')::uuid) <> v_inv THEN RAISE EXCEPTION 'S5 FAIL: doppelt fakturiert'; END IF;
  PERFORM set_config('test.inv1', v_inv::text, false);
  RAISE NOTICE 'S5 ok: Rechnung % nur über 70 gelieferte Einheiten: TTC 350,860 TND, Bezeichnung auf Arabisch, nicht doppelt', inv.number;
END $$;

-- ---------- S6: Restlieferung -> Auftrag geliefert -> fakturiert ----------
DO $$
DECLARE v_order uuid := current_setting('test.order')::uuid; v_del uuid;
BEGIN
  v_del := app.deliver_sales_order(v_order, jsonb_build_array(
    jsonb_build_object('orderLineId', current_setting('test.l1'), 'quantity', '50'),
    jsonb_build_object('orderLineId', current_setting('test.l2'), 'quantity', '50')), gen_random_uuid());
  IF (SELECT status FROM app.sales_orders WHERE id = v_order) <> 'delivered' THEN RAISE EXCEPTION 'S6 FAIL: nicht geliefert'; END IF;
  BEGIN
    PERFORM app.deliver_sales_order(v_order, jsonb_build_array(jsonb_build_object('orderLineId', current_setting('test.l2'), 'quantity', '1')), gen_random_uuid());
    RAISE EXCEPTION 'S6 FAIL: Lieferung nach vollständiger Lieferung';
  EXCEPTION WHEN SQLSTATE 'SN422' THEN NULL; END;
  PERFORM app.invoice_delivery(v_del);
  IF (SELECT status FROM app.sales_orders WHERE id = v_order) <> 'invoiced' THEN RAISE EXCEPTION 'S6 FAIL: nicht fakturiert'; END IF;
  RAISE NOTICE 'S6 ok: Restlieferung -> Status geliefert, zweite Rechnung -> Status fakturiert';
END $$;

-- ---------- S7: Gutschrift AV mit Bezug, einmalig ----------
DO $$
DECLARE cn app.sales_invoices; v_cn uuid; v_inv uuid := current_setting('test.inv1')::uuid;
BEGIN
  BEGIN PERFORM app.create_credit_note(v_inv, ''); RAISE EXCEPTION 'S7 FAIL: ohne Begründung';
  EXCEPTION WHEN SQLSTATE 'SN422' THEN NULL; END;
  v_cn := app.create_credit_note(v_inv, 'Ware beschädigt');
  SELECT * INTO cn FROM app.sales_invoices WHERE id = v_cn;
  IF cn.number NOT LIKE 'AV-%-000001' OR NOT cn.is_credit_note OR cn.credit_note_for <> v_inv
     OR cn.net_total <> 294000 OR cn.stamp_duty <> 0 THEN
    RAISE EXCEPTION 'S7 FAIL: Gutschrift % / % / %', cn.number, cn.net_total, cn.stamp_duty;
  END IF;
  BEGIN PERFORM app.create_credit_note(v_inv, 'nochmal'); RAISE EXCEPTION 'S7 FAIL: zweite Gutschrift';
  EXCEPTION WHEN SQLSTATE 'SN422' THEN NULL; END;
  RAISE NOTICE 'S7 ok: Gutschrift % über HT 294,000 ohne Timbre, Bezug auf Rechnung, nur einmal', cn.number;
END $$;

-- ---------- S8: Rollen – Kassierer darf weder Auftrag noch Lieferung ----------
SELECT pg_temp.as_user('d8000000-0000-0000-0000-0000000000c1', 'cashier') \gset
DO $$ BEGIN
  BEGIN
    PERFORM app.create_sales_order('d8000000-0000-0000-0000-0000000005a1', 'd8000000-0000-0000-0000-0000000000d1',
      '[{"productId":"d8000000-0000-0000-0000-0000000000e2","quantity":"1"}]', NULL, NULL, NULL);
    RAISE EXCEPTION 'S8 FAIL: Kassierer legt Auftrag an';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  IF (SELECT count(*) FROM app.sales_deliveries) <> 2 THEN RAISE EXCEPTION 'S8 FAIL: Kassierer sieht Lieferscheine nicht'; END IF;
  RAISE NOTICE 'S8 ok: Kassierer kann Lieferscheine lesen/drucken, aber keine Aufträge anlegen';
END $$;

-- ---------- S9: anderer Mandant sieht nichts ----------
SELECT set_config('app.tenant_id', 'e8000000-0000-0000-0000-000000000001', true),
       set_config('app.user_id', 'e8000000-0000-0000-0000-0000000000a1', true),
       set_config('app.role', 'owner', true) \gset
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM app.sales_orders) OR EXISTS (SELECT 1 FROM app.sales_deliveries)
     OR EXISTS (SELECT 1 FROM app.sales_delivery_lines) THEN
    RAISE EXCEPTION 'S9 FAIL: fremde Verkaufsdaten sichtbar';
  END IF;
  RAISE NOTICE 'S9 ok: anderer Mandant sieht keine Aufträge, Lieferungen, Positionen';
END $$;

ROLLBACK;
\echo 'ALLE VERKAUFSABLAUF-TESTS BESTANDEN'
