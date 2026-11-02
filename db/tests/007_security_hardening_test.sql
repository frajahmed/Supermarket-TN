-- =============================================================================
--  Test: Migration 007 – letzter Inhaber geschützt, Spalten für ausstehende 2FA
--  Voraussetzung: 001–007 angewendet. Läuft in einer Transaktion.
-- =============================================================================
\set QUIET on
BEGIN;

INSERT INTO app.tenants (id, slug, name) VALUES
  ('a7000000-0000-0000-0000-000000000001', 'owner-guard-a', 'Owner Guard A'),
  ('b7000000-0000-0000-0000-000000000001', 'owner-guard-b', 'Owner Guard B');
INSERT INTO app.users (id, tenant_id, email, display_name, role) VALUES
  ('a7000000-0000-0000-0000-0000000000a1', 'a7000000-0000-0000-0000-000000000001', 'chef1@a.tn', 'Chef 1', 'owner'),
  ('a7000000-0000-0000-0000-0000000000c1', 'a7000000-0000-0000-0000-000000000001', 'kasse@a.tn', 'Kasse', 'cashier'),
  ('b7000000-0000-0000-0000-0000000000b1', 'b7000000-0000-0000-0000-000000000001', 'chef@b.tn', 'Chef B', 'owner');

SET LOCAL ROLE app_user;
SELECT set_config('app.tenant_id', 'a7000000-0000-0000-0000-000000000001', true),
       set_config('app.user_id', 'a7000000-0000-0000-0000-0000000000a1', true),
       set_config('app.role', 'owner', true),
       set_config('app.store_ids', '', true) \gset

-- ---------- O1: einziger Inhaber – deaktivieren, herabstufen, löschen verboten ----------
DO $$
DECLARE v_state text;
BEGIN
  BEGIN
    UPDATE app.users SET is_active = false WHERE id = 'a7000000-0000-0000-0000-0000000000a1';
    RAISE EXCEPTION 'O1 FAIL: letzter Inhaber deaktivierbar';
  EXCEPTION WHEN SQLSTATE 'SN409' THEN NULL; END;
  BEGIN
    UPDATE app.users SET role = 'manager' WHERE id = 'a7000000-0000-0000-0000-0000000000a1';
    RAISE EXCEPTION 'O1 FAIL: letzter Inhaber herabstufbar';
  EXCEPTION WHEN SQLSTATE 'SN409' THEN NULL; END;
  BEGIN
    DELETE FROM app.users WHERE id = 'a7000000-0000-0000-0000-0000000000a1';
    RAISE EXCEPTION 'O1 FAIL: letzter Inhaber löschbar';
  EXCEPTION WHEN SQLSTATE 'SN409' THEN NULL; END;
  RAISE NOTICE 'O1 ok: einziger Inhaber kann nicht deaktiviert, herabgestuft oder gelöscht werden';
END $$;

-- ---------- O2: andere Änderungen am Inhaber und an anderen Nutzern bleiben möglich ----------
DO $$ BEGIN
  UPDATE app.users SET display_name = 'Chef Eins', failed_logins = 3 WHERE id = 'a7000000-0000-0000-0000-0000000000a1';
  UPDATE app.users SET is_active = false WHERE id = 'a7000000-0000-0000-0000-0000000000c1';
  RAISE NOTICE 'O2 ok: Name/Zähler des Inhabers und Deaktivieren anderer Rollen funktionieren';
END $$;

-- ---------- O3: mit zweitem aktivem Inhaber ist Deaktivieren erlaubt, danach wieder geschützt ----------
INSERT INTO app.users (id, tenant_id, email, display_name, role) VALUES
  ('a7000000-0000-0000-0000-0000000000a2', 'a7000000-0000-0000-0000-000000000001', 'chef2@a.tn', 'Chef 2', 'owner');
DO $$ BEGIN
  UPDATE app.users SET is_active = false WHERE id = 'a7000000-0000-0000-0000-0000000000a1';
  BEGIN
    UPDATE app.users SET role = 'manager' WHERE id = 'a7000000-0000-0000-0000-0000000000a2';
    RAISE EXCEPTION 'O3 FAIL: jetzt letzter Inhaber herabstufbar';
  EXCEPTION WHEN SQLSTATE 'SN409' THEN NULL; END;
  -- Reaktivieren des ersten Inhabers ist immer erlaubt
  UPDATE app.users SET is_active = true WHERE id = 'a7000000-0000-0000-0000-0000000000a1';
  UPDATE app.users SET role = 'manager' WHERE id = 'a7000000-0000-0000-0000-0000000000a2';
  RAISE NOTICE 'O3 ok: mit zweitem Inhaber erlaubt, der verbleibende Inhaber bleibt geschützt';
END $$;

-- ---------- O4: Mandanten werden getrennt gezählt ----------
-- Inhaber von A zählt nicht für B: B hat nur einen Inhaber (als Owner ausgeführt, RLS umgangen)
RESET ROLE;
DO $$ BEGIN
  BEGIN
    UPDATE app.users SET is_active = false WHERE id = 'b7000000-0000-0000-0000-0000000000b1';
    RAISE EXCEPTION 'O4 FAIL: Inhaber eines anderen Mandanten zählt mit';
  EXCEPTION WHEN SQLSTATE 'SN409' THEN NULL; END;
  RAISE NOTICE 'O4 ok: Inhaber werden je Mandant gezählt';
END $$;

-- ---------- O5: Spalten für ausstehende 2FA vorhanden ----------
DO $$ BEGIN
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'app' AND table_name = 'users'
         AND column_name IN ('totp_pending_enc', 'totp_pending_at')) <> 2
  THEN RAISE EXCEPTION 'O5 FAIL: Spalten fehlen'; END IF;
  RAISE NOTICE 'O5 ok: Spalten für ausstehende 2FA-Einrichtung vorhanden';
END $$;

ROLLBACK;
\echo 'ALLE INHABER-SCHUTZ-TESTS BESTANDEN'
