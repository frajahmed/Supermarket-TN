-- =============================================================================
--  Test: Mandantentrennung, Filialrechte, Bestandsjournal
--  Ausführen gegen eine frische DB nach 001_schema.sql:
--    psql -v ON_ERROR_STOP=1 -f tests/001_rls_test.sql
--  Jede Prüfung bricht mit EXCEPTION ab, wenn sie fehlschlägt.
-- =============================================================================
\set QUIET on
BEGIN;

-- ---------- Testdaten (als Owner, RLS umgangen) ----------
INSERT INTO app.tenants (id, slug, name) VALUES
  ('11111111-1111-1111-1111-111111111111', 'epicerie-sfax', 'Épicerie Sfax'),
  ('22222222-2222-2222-2222-222222222222', 'grossiste-tunis', 'Grossiste Tunis');

INSERT INTO app.stores (id, tenant_id, code, name) VALUES
  ('a1111111-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'S1', 'Sfax Centre'),
  ('a1111111-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'S2', 'Sfax Nord'),
  ('b2222222-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', 'T1', 'Tunis Entrepôt');

INSERT INTO app.users (id, tenant_id, email, display_name, role) VALUES
  ('c0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'owner@sfax.tn',   'Inhaber Sfax', 'owner'),
  ('c0000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'lager@sfax.tn',   'Lagerist S1',  'stock_clerk'),
  ('c0000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'kasse@sfax.tn',   'Kassierer S1', 'cashier'),
  ('d0000000-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', 'owner@tunis.tn',  'Inhaber Tunis','owner');

INSERT INTO app.user_store_access (tenant_id, user_id, store_id) VALUES
  ('11111111-1111-1111-1111-111111111111', 'c0000000-0000-0000-0000-000000000002', 'a1111111-0000-0000-0000-000000000001'),
  ('11111111-1111-1111-1111-111111111111', 'c0000000-0000-0000-0000-000000000003', 'a1111111-0000-0000-0000-000000000001');

INSERT INTO app.products (id, tenant_id, sku, name, sale_price, min_stock) VALUES
  ('e0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'LAIT-1L',
   '{"fr": "Lait demi-écrémé 1 L", "ar": "حليب نصف دسم 1 لتر"}', 1350, 10),   -- 1,350 TND
  ('f0000000-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', 'SEMOULE-5KG',
   '{"fr": "Semoule 5 kg"}', 9500, 5);

-- Hilfsfunktion: Kontext setzen wie der API-Guard
CREATE FUNCTION pg_temp.ctx(t uuid, u uuid, r text, stores text) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('app.tenant_id', t::text, true),
         set_config('app.user_id',   u::text, true),
         set_config('app.role',      r,       true),
         set_config('app.store_ids', stores,  true);
$$;
GRANT EXECUTE ON FUNCTION pg_temp.ctx(uuid, uuid, text, text) TO app_user;

SET LOCAL ROLE app_user;

-- ---------- T1: ohne Kontext sieht man nichts ----------
DO $$ BEGIN
  IF (SELECT count(*) FROM app.products) <> 0 THEN RAISE EXCEPTION 'T1 FAIL: Daten ohne Kontext sichtbar'; END IF;
  RAISE NOTICE 'T1 ok: ohne Mandantenkontext 0 Zeilen';
END $$;

-- ---------- T2: Mandant A sieht nur eigene Produkte ----------
SELECT pg_temp.ctx('11111111-1111-1111-1111-111111111111', 'c0000000-0000-0000-0000-000000000001', 'owner', '');
DO $$ BEGIN
  IF (SELECT count(*) FROM app.products) <> 1 OR
     EXISTS (SELECT 1 FROM app.products WHERE tenant_id <> '11111111-1111-1111-1111-111111111111')
  THEN RAISE EXCEPTION 'T2 FAIL: fremde Produkte sichtbar'; END IF;
  IF (SELECT count(*) FROM app.tenants) <> 1 THEN RAISE EXCEPTION 'T2 FAIL: fremder Mandant sichtbar'; END IF;
  RAISE NOTICE 'T2 ok: Mandant A sieht nur eigene Daten';
END $$;

-- ---------- T3: Schreiben in fremden Mandanten wird abgewiesen ----------
DO $$ BEGIN
  BEGIN
    INSERT INTO app.products (tenant_id, sku, name) VALUES ('22222222-2222-2222-2222-222222222222', 'HACK', '{"fr":"x"}');
    RAISE EXCEPTION 'T3 FAIL: Insert in fremden Mandanten möglich';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'T3 ok: Insert in fremden Mandanten abgewiesen';
  END;
END $$;

-- ---------- T4: Wareneingang bucht Bestand + Outbox ----------
SELECT pg_temp.ctx('11111111-1111-1111-1111-111111111111', 'c0000000-0000-0000-0000-000000000002', 'stock_clerk',
                   'a1111111-0000-0000-0000-000000000001');
INSERT INTO app.stock_movements (tenant_id, store_id, product_id, type, quantity_delta, client_op_id, user_id, occurred_at)
VALUES ('11111111-1111-1111-1111-111111111111', 'a1111111-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001',
        'purchase_receipt', 24, gen_random_uuid(), 'c0000000-0000-0000-0000-000000000002', now());
DO $$ BEGIN
  IF (SELECT quantity FROM app.store_stock WHERE product_id = 'e0000000-0000-0000-0000-000000000001') <> 24
  THEN RAISE EXCEPTION 'T4 FAIL: Bestand nicht 24'; END IF;
  IF (SELECT count(*) FROM app.outbox_events WHERE topic = 'stock.changed') <> 1
  THEN RAISE EXCEPTION 'T4 FAIL: kein Outbox-Event'; END IF;
  RAISE NOTICE 'T4 ok: Wareneingang +24 gebucht, Echtzeit-Event erzeugt';
END $$;

-- ---------- T5a: Verlust braucht Begründung / T5b: Idempotenz ----------
DO $$
DECLARE op uuid := gen_random_uuid();
BEGIN
  INSERT INTO app.stock_movements (tenant_id, store_id, product_id, type, quantity_delta, client_op_id, user_id, occurred_at)
  VALUES ('11111111-1111-1111-1111-111111111111', 'a1111111-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001',
          'loss', -2, op, 'c0000000-0000-0000-0000-000000000002', now())
  ON CONFLICT (tenant_id, client_op_id) DO NOTHING;   -- bewusst ohne 'reason'
  RAISE EXCEPTION 'T5 FAIL: Verlust ohne Begründung akzeptiert';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'T5a ok: Verlust ohne Begründung abgewiesen';
END $$;

DO $$
DECLARE op uuid := gen_random_uuid();
BEGIN
  FOR i IN 1..2 LOOP
    INSERT INTO app.stock_movements (tenant_id, store_id, product_id, type, quantity_delta, reason, client_op_id, user_id, occurred_at)
    VALUES ('11111111-1111-1111-1111-111111111111', 'a1111111-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001',
            'loss', -2, 'Bruch', op, 'c0000000-0000-0000-0000-000000000002', now())
    ON CONFLICT (tenant_id, client_op_id) DO NOTHING;
  END LOOP;
  IF (SELECT quantity FROM app.store_stock WHERE product_id = 'e0000000-0000-0000-0000-000000000001') <> 22
  THEN RAISE EXCEPTION 'T5 FAIL: doppelte Buchung'; END IF;
  RAISE NOTICE 'T5b ok: doppelt gesendete Offline-Buchung nur einmal gezählt (Bestand 22)';
END $$;

-- ---------- T6: Journal unveränderlich ----------
DO $$ BEGIN
  BEGIN
    UPDATE app.stock_movements SET quantity_delta = 999;
    RAISE EXCEPTION 'T6 FAIL: Journal änderbar';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'T6 ok: Journal nicht änderbar';
  END;
END $$;

-- ---------- T7: Lagerist ohne Zugriff auf Filiale S2 ----------
DO $$ BEGIN
  BEGIN
    INSERT INTO app.stock_movements (tenant_id, store_id, product_id, type, quantity_delta, client_op_id, user_id, occurred_at)
    VALUES ('11111111-1111-1111-1111-111111111111', 'a1111111-0000-0000-0000-000000000002', 'e0000000-0000-0000-0000-000000000001',
            'purchase_receipt', 5, gen_random_uuid(), 'c0000000-0000-0000-0000-000000000002', now());
    RAISE EXCEPTION 'T7 FAIL: Buchung in fremder Filiale möglich';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'T7 ok: Buchung in nicht zugewiesener Filiale abgewiesen';
  END;
END $$;

-- ---------- T8: Kassierer darf keinen Wareneingang buchen ----------
SELECT pg_temp.ctx('11111111-1111-1111-1111-111111111111', 'c0000000-0000-0000-0000-000000000003', 'cashier',
                   'a1111111-0000-0000-0000-000000000001');
DO $$ BEGIN
  BEGIN
    INSERT INTO app.stock_movements (tenant_id, store_id, product_id, type, quantity_delta, client_op_id, user_id, occurred_at)
    VALUES ('11111111-1111-1111-1111-111111111111', 'a1111111-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001',
            'purchase_receipt', 100, gen_random_uuid(), 'c0000000-0000-0000-0000-000000000003', now());
    RAISE EXCEPTION 'T8 FAIL: Kassierer bucht Wareneingang';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'T8 ok: Kassierer kann keinen Wareneingang buchen';
  END;
END $$;

-- ---------- T9: Mandant B sieht nichts von A (inkl. View) ----------
SELECT pg_temp.ctx('22222222-2222-2222-2222-222222222222', 'd0000000-0000-0000-0000-000000000001', 'owner', '');
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM app.store_stock) OR EXISTS (SELECT 1 FROM app.stock_movements)
     OR EXISTS (SELECT 1 FROM app.v_low_stock WHERE tenant_id = '11111111-1111-1111-1111-111111111111')
  THEN RAISE EXCEPTION 'T9 FAIL: Mandant B sieht Bestand von A'; END IF;
  RAISE NOTICE 'T9 ok: Mandant B sieht keinen Bestand, kein Journal von A';
END $$;

-- ---------- T10: Login-/Guard-Funktionen arbeiten ohne Mandantenkontext ----------
SELECT set_config('app.tenant_id', '', true), set_config('app.role', '', true);
DO $$ BEGIN
  IF (SELECT count(*) FROM auth.find_login_user('epicerie-sfax', 'LAGER@sfax.tn')) <> 1
  THEN RAISE EXCEPTION 'T10 FAIL: Login-Lookup findet Nutzer nicht'; END IF;
  IF (SELECT count(*) FROM auth.find_login_user('grossiste-tunis', 'lager@sfax.tn')) <> 0
  THEN RAISE EXCEPTION 'T10 FAIL: Login über fremden Mandanten möglich'; END IF;
  IF auth.user_store_ids('11111111-1111-1111-1111-111111111111', 'c0000000-0000-0000-0000-000000000002')
     <> ARRAY['a1111111-0000-0000-0000-000000000001']::uuid[]
  THEN RAISE EXCEPTION 'T10 FAIL: Filialzuordnung falsch'; END IF;
  RAISE NOTICE 'T10 ok: Login-Lookup und Filialzuordnung funktionieren, mandantengetrennt';
END $$;

-- ---------- T11: Outbox-Abholung für den Echtzeit-Worker ----------
DO $$ BEGIN
  IF (SELECT count(*) FROM auth.claim_outbox_events(100)) < 1 THEN RAISE EXCEPTION 'T11 FAIL: keine Events'; END IF;
  IF (SELECT count(*) FROM auth.claim_outbox_events(100)) <> 0 THEN RAISE EXCEPTION 'T11 FAIL: Doppelversand'; END IF;
  RAISE NOTICE 'T11 ok: Outbox-Events werden genau einmal abgeholt';
END $$;

ROLLBACK;
\echo 'ALLE TESTS BESTANDEN'
