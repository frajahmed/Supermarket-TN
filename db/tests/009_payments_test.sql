-- =============================================================================
--  Test: Zahlungen, Storno als Gegenbuchung, Kontoauszug (Migration 009)
-- =============================================================================
\set QUIET on
BEGIN;
INSERT INTO app.tenants (id, slug, name) VALUES
  ('d9000000-0000-0000-0000-000000000001', 'pay-a', 'Grossiste Pay'),
  ('e9000000-0000-0000-0000-000000000001', 'pay-b', 'Autre');
INSERT INTO app.stores (id, tenant_id, code, name) VALUES
  ('d9000000-0000-0000-0000-0000000005a1', 'd9000000-0000-0000-0000-000000000001', 'D1', 'Dépôt');
INSERT INTO app.users (id, tenant_id, email, display_name, role) VALUES
  ('d9000000-0000-0000-0000-0000000000a1', 'd9000000-0000-0000-0000-000000000001', 'chef@p.tn', 'Chef', 'owner'),
  ('d9000000-0000-0000-0000-0000000000b1', 'd9000000-0000-0000-0000-000000000001', 'gerant@p.tn', 'Gérant', 'manager'),
  ('d9000000-0000-0000-0000-0000000000c1', 'd9000000-0000-0000-0000-000000000001', 'mag@p.tn', 'Mag', 'stock_clerk'),
  ('e9000000-0000-0000-0000-0000000000a1', 'e9000000-0000-0000-0000-000000000001', 'b@p.tn', 'B', 'owner');
INSERT INTO app.customers (id, tenant_id, number, name, tax_id) VALUES
  ('d9000000-0000-0000-0000-0000000000d1', 'd9000000-0000-0000-0000-000000000001', 'K1', 'Épicerie', '1234567A'),
  ('d9000000-0000-0000-0000-0000000000d2', 'd9000000-0000-0000-0000-000000000001', 'K2', 'Autre client', '7654321B');
-- Ausgestellte Rechnung 100,000 und Gutschrift 10,000 (direkt, ohne Ablauf – getestet in 008)
INSERT INTO app.sales_invoices (id, tenant_id, store_id, customer_id, number, status, issue_date, gross_total, is_credit_note, created_by, credit_note_for, series) VALUES
  ('d9000000-0000-0000-0000-0000000001f1', 'd9000000-0000-0000-0000-000000000001', 'd9000000-0000-0000-0000-0000000005a1',
   'd9000000-0000-0000-0000-0000000000d1', 'FA-T-1', 'issued', current_date - 10, 100000, false, 'd9000000-0000-0000-0000-0000000000a1', NULL, 'FA'),
  ('d9000000-0000-0000-0000-0000000001f2', 'd9000000-0000-0000-0000-000000000001', 'd9000000-0000-0000-0000-0000000005a1',
   'd9000000-0000-0000-0000-0000000000d1', 'AV-T-1', 'issued', current_date - 5, 10000, true, 'd9000000-0000-0000-0000-0000000000a1', 'd9000000-0000-0000-0000-0000000001f1', 'AV'),
  ('d9000000-0000-0000-0000-0000000001f3', 'd9000000-0000-0000-0000-000000000001', 'd9000000-0000-0000-0000-0000000005a1',
   'd9000000-0000-0000-0000-0000000000d2', 'FA-T-2', 'issued', current_date - 3, 5000, false, 'd9000000-0000-0000-0000-0000000000a1', NULL, 'FA');

SET LOCAL ROLE app_user;
CREATE FUNCTION pg_temp.as_user(u uuid, r text) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('app.tenant_id', 'd9000000-0000-0000-0000-000000000001', true),
         set_config('app.user_id', u::text, true), set_config('app.role', r, true),
         set_config('app.store_ids', 'd9000000-0000-0000-0000-0000000005a1', true);
$$;
SELECT pg_temp.as_user('d9000000-0000-0000-0000-0000000000b1', 'manager') \gset

-- ---------- Z1: Zahlung senkt Saldo, idempotent ----------
DO $$
DECLARE v1 uuid; v2 uuid;
BEGIN
  IF app.customer_open_balance('d9000000-0000-0000-0000-0000000000d1') <> 90000 THEN RAISE EXCEPTION 'Z1 FAIL: Startsaldo'; END IF;
  v1 := app.record_payment('d9000000-0000-0000-0000-0000000000d1', 30000, 'cheque', ' CHQ 4711 ', current_date - 1,
                           'd9000000-0000-0000-0000-0000000001f1', 'd9000000-0000-0000-0000-00000000aa01');
  v2 := app.record_payment('d9000000-0000-0000-0000-0000000000d1', 30000, 'cheque', 'CHQ 4711', NULL, NULL,
                           'd9000000-0000-0000-0000-00000000aa01');
  IF v1 <> v2 THEN RAISE EXCEPTION 'Z1 FAIL: nicht idempotent'; END IF;
  IF app.customer_open_balance('d9000000-0000-0000-0000-0000000000d1') <> 60000 THEN RAISE EXCEPTION 'Z1 FAIL: Saldo nach Zahlung'; END IF;
  IF (SELECT reference FROM app.customer_payments WHERE id = v1) <> 'CHQ 4711' THEN RAISE EXCEPTION 'Z1 FAIL: Referenz'; END IF;
  PERFORM set_config('test.pay', v1::text, false);
  RAISE NOTICE 'Z1 ok: Zahlung 30,000 senkt Saldo 90,000 -> 60,000, doppelt gesendet = einmal';
END $$;

-- ---------- Z2: Ungültige Zahlungen ----------
DO $$
BEGIN
  BEGIN PERFORM app.record_payment('d9000000-0000-0000-0000-0000000000d1', 0, 'cash', NULL, NULL, NULL, NULL);
    RAISE EXCEPTION 'Z2 FAIL: Betrag 0'; EXCEPTION WHEN sqlstate 'SN422' THEN NULL; END;
  BEGIN PERFORM app.record_payment('d9000000-0000-0000-0000-0000000000d1', 100, 'cash', NULL, NULL,
                                   'd9000000-0000-0000-0000-0000000001f3', NULL);   -- Rechnung eines anderen Kunden
    RAISE EXCEPTION 'Z2 FAIL: fremde Rechnung'; EXCEPTION WHEN sqlstate 'SN422' THEN NULL; END;
  BEGIN PERFORM app.record_payment('d9000000-0000-0000-0000-0000000000d1', 100, 'cash', NULL, current_date + 1, NULL, NULL);
    RAISE EXCEPTION 'Z2 FAIL: Zukunftsdatum'; EXCEPTION WHEN sqlstate 'SN422' THEN NULL; END;
  BEGIN PERFORM app.record_payment('d9000000-0000-0000-0000-0000000000d1', 100, 'bitcoin', NULL, NULL, NULL, NULL);
    RAISE EXCEPTION 'Z2 FAIL: Zahlart'; EXCEPTION WHEN check_violation THEN NULL; END;
  RAISE NOTICE 'Z2 ok: Betrag 0, fremde Rechnung, Zukunftsdatum, unbekannte Zahlart abgewiesen';
END $$;

-- ---------- Z3: unveränderlich, Storno nur als Gegenbuchung, einmal ----------
DO $$
DECLARE v_pay uuid := current_setting('test.pay')::uuid; v_rev uuid; v_again uuid;
BEGIN
  BEGIN UPDATE app.customer_payments SET amount = 1 WHERE id = v_pay;
    RAISE EXCEPTION 'Z3 FAIL: Zahlung änderbar'; EXCEPTION WHEN insufficient_privilege OR raise_exception THEN
      IF SQLERRM LIKE 'Z3 FAIL%' THEN RAISE; END IF; END;
  BEGIN DELETE FROM app.customer_payments WHERE id = v_pay;
    RAISE EXCEPTION 'Z3 FAIL: Zahlung löschbar'; EXCEPTION WHEN insufficient_privilege OR raise_exception THEN
      IF SQLERRM LIKE 'Z3 FAIL%' THEN RAISE; END IF; END;
  BEGIN PERFORM app.reverse_payment(v_pay, ' x ', NULL);
    RAISE EXCEPTION 'Z3 FAIL: Storno ohne Begründung'; EXCEPTION WHEN sqlstate 'SN422' THEN NULL; END;
  v_rev := app.reverse_payment(v_pay, 'Scheck ungedeckt', 'd9000000-0000-0000-0000-00000000aa02');
  v_again := app.reverse_payment(v_pay, 'Scheck ungedeckt', 'd9000000-0000-0000-0000-00000000aa02');
  IF v_rev <> v_again THEN RAISE EXCEPTION 'Z3 FAIL: Storno nicht idempotent'; END IF;
  IF (SELECT amount FROM app.customer_payments WHERE id = v_rev) <> -30000 THEN RAISE EXCEPTION 'Z3 FAIL: Gegenbetrag'; END IF;
  IF (SELECT amount FROM app.customer_payments WHERE id = v_pay) <> 30000 THEN RAISE EXCEPTION 'Z3 FAIL: Original verändert'; END IF;
  IF app.customer_open_balance('d9000000-0000-0000-0000-0000000000d1') <> 90000 THEN RAISE EXCEPTION 'Z3 FAIL: Saldo nach Storno'; END IF;
  BEGIN PERFORM app.reverse_payment(v_pay, 'nochmal storniert', NULL);
    RAISE EXCEPTION 'Z3 FAIL: doppelt storniert'; EXCEPTION WHEN sqlstate 'SN409' THEN NULL; END;
  BEGIN PERFORM app.reverse_payment(v_rev, 'Storno vom Storno', NULL);
    RAISE EXCEPTION 'Z3 FAIL: Storno storniert'; EXCEPTION WHEN sqlstate 'SN409' THEN NULL; END;
  IF NOT EXISTS (SELECT 1 FROM app.audit_log WHERE action = 'payment.reverse' AND entity_id = v_pay) THEN
    RAISE EXCEPTION 'Z3 FAIL: kein Audit'; END IF;
  RAISE NOTICE 'Z3 ok: Zahlung unveränderlich, Storno = Gegenbuchung (Saldo wieder 90,000), nur einmal, mit Audit';
END $$;

-- ---------- Z4: Kontoauszug-Summe = customer_open_balance ----------
DO $$
DECLARE v_sum bigint; v_n int;
BEGIN
  PERFORM app.record_payment('d9000000-0000-0000-0000-0000000000d1', 25000, 'cash', NULL, NULL, NULL, NULL);
  SELECT sum(amount), count(*) INTO v_sum, v_n FROM app.customer_ledger('d9000000-0000-0000-0000-0000000000d1');
  IF v_sum <> app.customer_open_balance('d9000000-0000-0000-0000-0000000000d1') OR v_sum <> 65000 THEN
    RAISE EXCEPTION 'Z4 FAIL: Auszug % / Saldo %', v_sum, app.customer_open_balance('d9000000-0000-0000-0000-0000000000d1');
  END IF;
  IF v_n <> 5 THEN RAISE EXCEPTION 'Z4 FAIL: % Buchungen statt 5', v_n; END IF;
  RAISE NOTICE 'Z4 ok: Kontoauszug (Rechnung, Gutschrift, Zahlung, Storno, Zahlung) = offener Saldo 65,000';
END $$;

-- ---------- Z5: Lagerist darf keine Zahlung erfassen (Policy) ----------
SELECT pg_temp.as_user('d9000000-0000-0000-0000-0000000000c1', 'stock_clerk') \gset
DO $$
BEGIN
  BEGIN PERFORM app.record_payment('d9000000-0000-0000-0000-0000000000d1', 100, 'cash', NULL, NULL, NULL, NULL);
    RAISE EXCEPTION 'Z5 FAIL: Lagerist erfasst Zahlung'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  RAISE NOTICE 'Z5 ok: Lagerist kann keine Zahlung buchen (RLS)';
END $$;

-- ---------- Z6: anderer Mandant sieht nichts ----------
SELECT set_config('app.tenant_id', 'e9000000-0000-0000-0000-000000000001', true),
       set_config('app.user_id', 'e9000000-0000-0000-0000-0000000000a1', true),
       set_config('app.role', 'owner', true) \gset
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM app.customer_payments)
     OR EXISTS (SELECT 1 FROM app.customer_ledger('d9000000-0000-0000-0000-0000000000d1')) THEN
    RAISE EXCEPTION 'Z6 FAIL: fremde Zahlungen sichtbar'; END IF;
  RAISE NOTICE 'Z6 ok: anderer Mandant sieht weder Zahlungen noch Kontoauszug';
END $$;

ROLLBACK;
\echo 'ALLE ZAHLUNGS-TESTS BESTANDEN'
