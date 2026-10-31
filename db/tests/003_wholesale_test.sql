-- =============================================================================
--  Test: Großhandel – Preisstaffeln, Rechnungsausstellung, Nummernkreis,
--  Unveränderlichkeit, Kreditlimit, Rollen, Mandantentrennung
--  Voraussetzung: 001, 002, 003 angewendet. Läuft in einer Transaktion.
-- =============================================================================
\set QUIET on
BEGIN;

INSERT INTO app.tenants (id, slug, name, legal_name, tax_id, settings) VALUES
  ('11111111-1111-1111-1111-111111111111', 'grossiste-sfax', 'Grossiste Sfax', 'Grossiste Sfax SARL', '1234567A/M/000',
   '{"stamp_duty_minor": 1000}'),
  ('22222222-2222-2222-2222-222222222222', 'autre', 'Autre', NULL, NULL, '{}');
INSERT INTO app.stores (id, tenant_id, code, name) VALUES
  ('a1111111-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'D1', 'Dépôt Sfax');
INSERT INTO app.users (id, tenant_id, email, display_name, role) VALUES
  ('c0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'gerant@g.tn', 'Gérant', 'manager'),
  ('c0000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'caisse@g.tn', 'Caisse', 'cashier'),
  ('d0000000-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', 'o@b.tn', 'B', 'owner');
INSERT INTO app.user_store_access (tenant_id, user_id, store_id) VALUES
  ('11111111-1111-1111-1111-111111111111', 'c0000000-0000-0000-0000-000000000001', 'a1111111-0000-0000-0000-000000000001'),
  ('11111111-1111-1111-1111-111111111111', 'c0000000-0000-0000-0000-000000000003', 'a1111111-0000-0000-0000-000000000001');
INSERT INTO app.products (id, tenant_id, sku, name, sale_price, tax_rate_bp) VALUES
  ('e0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'HUILE-1L', '{"fr":"Huile 1 L"}', 5000, 1900),
  ('e0000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'PATES-500', '{"fr":"Pâtes 500 g"}', 1200, 700);
INSERT INTO app.price_lists (id, tenant_id, name) VALUES
  ('f1000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Revendeurs');
INSERT INTO app.price_list_items (tenant_id, price_list_id, product_id, min_qty, unit_price) VALUES
  ('11111111-1111-1111-1111-111111111111', 'f1000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001', 1,   4500),
  ('11111111-1111-1111-1111-111111111111', 'f1000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001', 120, 4200);
INSERT INTO app.customer_groups (id, tenant_id, name, price_list_id) VALUES
  ('f2000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', '{"fr":"Épiceries"}', 'f1000000-0000-0000-0000-000000000001');
INSERT INTO app.customers (id, tenant_id, number, name, tax_id, group_id, payment_terms_days, credit_limit) VALUES
  ('b1000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'K-001', 'Épicerie El Amel', '7654321B/A/000',
   'f2000000-0000-0000-0000-000000000001', 30, 700000);   -- Limit 700,000 TND

-- Matricule fiscal ist Pflicht für Geschäftskunden
DO $$ BEGIN
  INSERT INTO app.customers (tenant_id, number, name) VALUES ('11111111-1111-1111-1111-111111111111', 'K-X', 'Sans MF');
  RAISE EXCEPTION 'W0 FAIL: Geschäftskunde ohne Matricule fiscal akzeptiert';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'W0 ok: Geschäftskunde braucht Matricule fiscal';
END $$;

SET LOCAL ROLE app_user;
SELECT set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true),
       set_config('app.user_id', 'c0000000-0000-0000-0000-000000000001', true),
       set_config('app.role', 'manager', true),
       set_config('app.store_ids', 'a1111111-0000-0000-0000-000000000001', true) \gset

-- ---------- W1: Preisfindung mit Staffel und Fallback ----------
DO $$ BEGIN
  IF app.price_for('b1000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001', 10)  <> 4500 THEN RAISE EXCEPTION 'W1 FAIL Staffel 1'; END IF;
  IF app.price_for('b1000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001', 120) <> 4200 THEN RAISE EXCEPTION 'W1 FAIL Staffel 120'; END IF;
  IF app.price_for('b1000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000002', 10)  <> 1200 THEN RAISE EXCEPTION 'W1 FAIL Fallback'; END IF;
  RAISE NOTICE 'W1 ok: Gruppenpreis 4,500 / ab 120 Stück 4,200 / sonst Standardpreis';
END $$;

-- ---------- W2: Rechnung ausstellen: Summen, TVA je Satz, Timbre, Nummer ----------
INSERT INTO app.sales_invoices (id, tenant_id, store_id, customer_id, created_by) VALUES
  ('a9000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'a1111111-0000-0000-0000-000000000001',
   'b1000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001');
INSERT INTO app.sales_invoice_lines (tenant_id, invoice_id, line_no, product_id, description, quantity, unit_price, discount_bp, tax_rate_bp) VALUES
  ('11111111-1111-1111-1111-111111111111', 'a9000000-0000-0000-0000-000000000001', 1, 'e0000000-0000-0000-0000-000000000001', 'Huile 1 L', 120, 4200, 0,   1900),
  ('11111111-1111-1111-1111-111111111111', 'a9000000-0000-0000-0000-000000000001', 2, 'e0000000-0000-0000-0000-000000000002', 'Pâtes 500 g', 50, 1200, 500, 700);

DO $$
DECLARE inv app.sales_invoices;
BEGIN
  inv := app.issue_invoice('a9000000-0000-0000-0000-000000000001');
  -- Huile: 120 × 4,200 = 504,000 HT, TVA 19 % = 95,760
  -- Pâtes: 50 × 1,200 − 5 % = 57,000 HT, TVA 7 % = 3,990
  IF inv.net_total <> 561000 OR inv.tax_total <> 99750 OR inv.stamp_duty <> 1000 OR inv.gross_total <> 661750
  THEN RAISE EXCEPTION 'W2 FAIL Summen: % % % %', inv.net_total, inv.tax_total, inv.stamp_duty, inv.gross_total; END IF;
  IF inv.number <> format('FA-%s-000001', extract(year FROM current_date)) THEN RAISE EXCEPTION 'W2 FAIL Nummer %', inv.number; END IF;
  IF jsonb_array_length(inv.tax_breakdown) <> 2 THEN RAISE EXCEPTION 'W2 FAIL Aufschlüsselung'; END IF;
  IF inv.due_date <> current_date + 30 THEN RAISE EXCEPTION 'W2 FAIL Fälligkeit'; END IF;
  IF inv.customer_snapshot->>'tax_id' <> '7654321B/A/000' THEN RAISE EXCEPTION 'W2 FAIL Snapshot'; END IF;
  RAISE NOTICE 'W2 ok: % – HT 561,000 + TVA 99,750 (19 %%/7 %%) + Timbre 1,000 = TTC 661,750 TND, fällig in 30 Tagen', inv.number;
END $$;

-- ---------- W3: ausgestellte Rechnung unveränderlich ----------
DO $$ BEGIN
  BEGIN
    UPDATE app.sales_invoices SET gross_total = 1 WHERE id = 'a9000000-0000-0000-0000-000000000001';
    RAISE EXCEPTION 'W3 FAIL: Betrag änderbar';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    UPDATE app.sales_invoice_lines SET quantity = 1 WHERE invoice_id = 'a9000000-0000-0000-0000-000000000001';
    RAISE EXCEPTION 'W3 FAIL: Position änderbar';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    DELETE FROM app.sales_invoices WHERE id = 'a9000000-0000-0000-0000-000000000001';
    RAISE EXCEPTION 'W3 FAIL: löschbar';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  -- TTN-Status darf sich ändern
  UPDATE app.sales_invoices SET ttn_status = 'pending', status = 'sent' WHERE id = 'a9000000-0000-0000-0000-000000000001';
  RAISE NOTICE 'W3 ok: Beträge, Positionen, Löschen gesperrt; TTN-Status änderbar';
END $$;

-- ---------- W4: Kreditlimit (offen 661,750 + neue 60,500 > Limit 700,000) ----------
INSERT INTO app.sales_invoices (id, tenant_id, store_id, customer_id, created_by) VALUES
  ('a9000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'a1111111-0000-0000-0000-000000000001',
   'b1000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001');
INSERT INTO app.sales_invoice_lines (tenant_id, invoice_id, line_no, description, quantity, unit_price, tax_rate_bp) VALUES
  ('11111111-1111-1111-1111-111111111111', 'a9000000-0000-0000-0000-000000000002', 1, 'Divers', 50, 1000, 1900);  -- 50,000 HT + 9,500 TVA + 1,000 Timbre
DO $$ BEGIN
  BEGIN
    PERFORM app.issue_invoice('a9000000-0000-0000-0000-000000000002');
    RAISE EXCEPTION 'W4 FAIL: Kreditlimit ignoriert';
  EXCEPTION WHEN check_violation THEN NULL; END;
  -- Zahlung 300,000 senkt den Saldo -> Ausstellung möglich
  INSERT INTO app.customer_payments (tenant_id, customer_id, amount, method, reference, recorded_by)
  VALUES ('11111111-1111-1111-1111-111111111111', 'b1000000-0000-0000-0000-000000000001', 300000, 'cheque', 'CHQ-0042',
          'c0000000-0000-0000-0000-000000000001');
  IF (app.issue_invoice('a9000000-0000-0000-0000-000000000002')).number NOT LIKE '%-000002' THEN RAISE EXCEPTION 'W4 FAIL Nummer'; END IF;
  RAISE NOTICE 'W4 ok: Limit blockiert, nach Scheckzahlung 300,000 TND Ausstellung mit lückenloser Nummer 000002';
END $$;

-- ---------- W5: abgebrochene Ausstellung verbraucht keine Nummer ----------
INSERT INTO app.sales_invoices (id, tenant_id, store_id, customer_id, created_by) VALUES
  ('a9000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'a1111111-0000-0000-0000-000000000001',
   'b1000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001');
DO $$ BEGIN
  BEGIN PERFORM app.issue_invoice('a9000000-0000-0000-0000-000000000003');   -- ohne Positionen -> Fehler
  EXCEPTION WHEN check_violation THEN NULL; END;
  INSERT INTO app.sales_invoice_lines (tenant_id, invoice_id, line_no, description, quantity, unit_price, tax_rate_bp) VALUES
    ('11111111-1111-1111-1111-111111111111', 'a9000000-0000-0000-0000-000000000003', 1, 'Divers', 1, 1000, 1900);
  IF (app.issue_invoice('a9000000-0000-0000-0000-000000000003')).number NOT LIKE '%-000003' THEN RAISE EXCEPTION 'W5 FAIL Lücke'; END IF;
  RAISE NOTICE 'W5 ok: fehlgeschlagene Ausstellung erzeugt keine Nummernlücke (nächste: 000003)';
END $$;

-- ---------- W6: Kassierer darf Rechnungen lesen, aber nicht ausstellen ----------
SELECT set_config('app.user_id', 'c0000000-0000-0000-0000-000000000003', true), set_config('app.role', 'cashier', true) \gset
DO $$ BEGIN
  IF (SELECT count(*) FROM app.sales_invoices) <> 3 THEN RAISE EXCEPTION 'W6 FAIL: Kassierer sieht Rechnungen nicht'; END IF;
  BEGIN
    INSERT INTO app.sales_invoices (tenant_id, store_id, customer_id, created_by) VALUES
      ('11111111-1111-1111-1111-111111111111', 'a1111111-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000001',
       'c0000000-0000-0000-0000-000000000003');
    RAISE EXCEPTION 'W6 FAIL: Kassierer legt Rechnung an';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  RAISE NOTICE 'W6 ok: Kassierer liest/druckt Rechnungen, kann keine anlegen';
END $$;

-- ---------- W7: anderer Mandant sieht weder Kunden noch Rechnungen ----------
SELECT set_config('app.tenant_id', '22222222-2222-2222-2222-222222222222', true),
       set_config('app.user_id', 'd0000000-0000-0000-0000-000000000001', true),
       set_config('app.role', 'owner', true) \gset
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM app.customers) OR EXISTS (SELECT 1 FROM app.sales_invoices)
     OR EXISTS (SELECT 1 FROM app.price_list_items) OR EXISTS (SELECT 1 FROM app.v_customer_balance)
  THEN RAISE EXCEPTION 'W7 FAIL: fremde B2B-Daten sichtbar'; END IF;
  RAISE NOTICE 'W7 ok: anderer Mandant sieht keine Kunden, Preise, Rechnungen';
END $$;

ROLLBACK;
\echo 'ALLE GROSSHANDELS-TESTS BESTANDEN'
