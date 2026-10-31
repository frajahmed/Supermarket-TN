-- =============================================================================
--  Test: Login-Funktionen, Fehlversuch-Sperre, Geräte, Refresh-Rotation
--  Voraussetzung: 001–004 angewendet. Läuft in einer Transaktion.
-- =============================================================================
\set QUIET on
BEGIN;

INSERT INTO app.tenants (id, slug, name) VALUES
  ('11111111-1111-1111-1111-111111111111', 'grossiste-sfax', 'Grossiste Sfax'),
  ('22222222-2222-2222-2222-222222222222', 'autre', 'Autre');
INSERT INTO app.users (id, tenant_id, email, display_name, role, password_hash) VALUES
  ('c0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'chef@g.tn', 'Chef', 'owner', 'scrypt$x'),
  ('d0000000-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', 'chef@autre.tn', 'B', 'owner', 'scrypt$y');
SELECT auth.setup_installation('99999999-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111');

SET LOCAL ROLE app_user;

-- ---------- A1: Installation nur über Funktionen ----------
DO $$ BEGIN
  BEGIN PERFORM * FROM app.installation; RAISE EXCEPTION 'A1 FAIL: Tabelle direkt lesbar';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM auth.setup_installation(gen_random_uuid(), '22222222-2222-2222-2222-222222222222');
        RAISE EXCEPTION 'A1 FAIL: App darf Installation umbiegen';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  IF (SELECT tenant_id FROM auth.installation_info()) <> '11111111-1111-1111-1111-111111111111' THEN RAISE EXCEPTION 'A1 FAIL info'; END IF;
  RAISE NOTICE 'A1 ok: Installation nur lesbar über Funktion, App kann sie nicht umstellen';
END $$;

-- ---------- A2: Login findet nur Benutzer des Kunden dieses Servers ----------
DO $$ BEGIN
  IF (SELECT count(*) FROM auth.login_candidate('CHEF@g.tn')) <> 1 THEN RAISE EXCEPTION 'A2 FAIL eigener Benutzer'; END IF;
  IF (SELECT count(*) FROM auth.login_candidate('chef@autre.tn')) <> 0 THEN RAISE EXCEPTION 'A2 FAIL fremder Benutzer'; END IF;
  RAISE NOTICE 'A2 ok: nur Benutzer des eigenen Kunden können sich an diesem Server anmelden';
END $$;

-- ---------- A3: Sperre nach 5 Fehlversuchen, Zurücksetzen bei Erfolg ----------
DO $$
DECLARE i int; v_locked timestamptz;
BEGIN
  FOR i IN 1..4 LOOP PERFORM auth.record_login_attempt('c0000000-0000-0000-0000-000000000001', false, NULL); END LOOP;
  SELECT locked_until INTO v_locked FROM auth.login_candidate('chef@g.tn');
  IF v_locked IS NOT NULL THEN RAISE EXCEPTION 'A3 FAIL: nach 4 Versuchen schon gesperrt'; END IF;
  PERFORM auth.record_login_attempt('c0000000-0000-0000-0000-000000000001', false, NULL);
  SELECT locked_until INTO v_locked FROM auth.login_candidate('chef@g.tn');
  IF v_locked IS NULL OR v_locked < now() + interval '14 minutes' THEN RAISE EXCEPTION 'A3 FAIL: keine 15-Minuten-Sperre'; END IF;
  PERFORM auth.record_login_attempt('c0000000-0000-0000-0000-000000000001', false, NULL);
  SELECT locked_until INTO v_locked FROM auth.login_candidate('chef@g.tn');
  IF v_locked < now() + interval '29 minutes' THEN RAISE EXCEPTION 'A3 FAIL: Sperre verdoppelt sich nicht'; END IF;
  PERFORM auth.record_login_attempt('c0000000-0000-0000-0000-000000000001', true, NULL);
  SELECT locked_until INTO v_locked FROM auth.login_candidate('chef@g.tn');
  IF v_locked IS NOT NULL THEN RAISE EXCEPTION 'A3 FAIL: Erfolg setzt nicht zurück'; END IF;
  RAISE NOTICE 'A3 ok: Sperre ab 5. Fehlversuch (15 min, dann 30 min …), Erfolg setzt zurück';
END $$;

-- ---------- A4: Gerät registrieren, lokal sperren ----------
DO $$ BEGIN
  IF NOT auth.register_device('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001',
       'Kasse 1', 'pos', 'PUBKEY', 'CERT', 'c0000000-0000-0000-0000-000000000001')
  THEN RAISE EXCEPTION 'A4 FAIL: neues Gerät abgelehnt'; END IF;
  BEGIN
    PERFORM auth.register_device('22222222-2222-2222-2222-222222222222', 'aaaaaaaa-0000-0000-0000-000000000001',
       'Klon', 'pos', 'X', 'Y', 'd0000000-0000-0000-0000-000000000001');
    RAISE EXCEPTION 'A4 FAIL: Geräte-ID von fremdem Mandanten übernommen';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  RAISE NOTICE 'A4 ok: Gerät beim ersten Login registriert, fremder Mandant kann es nicht übernehmen';
END $$;

-- Inhaber sperrt das Gerät im Backoffice
SELECT set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true),
       set_config('app.user_id', 'c0000000-0000-0000-0000-000000000001', true),
       set_config('app.role', 'owner', true), set_config('app.store_ids', '', true) \gset
DO $$ BEGIN
  IF (SELECT count(*) FROM app.devices) <> 1 THEN RAISE EXCEPTION 'A4b FAIL: Inhaber sieht Gerät ohne Filiale nicht'; END IF;
  PERFORM app.revoke_device('aaaaaaaa-0000-0000-0000-000000000001');
  IF auth.register_device('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001',
       'Kasse 1', 'pos', 'PUBKEY', 'CERT', 'c0000000-0000-0000-0000-000000000001')
  THEN RAISE EXCEPTION 'A4b FAIL: gesperrtes Gerät darf sich anmelden'; END IF;
  RAISE NOTICE 'A4b ok: vom Inhaber gesperrtes Gerät wird beim nächsten Login abgewiesen';
END $$;

-- ---------- A5: Refresh-Rotation und Diebstahlerkennung ----------
DO $$
DECLARE r record; fam uuid := gen_random_uuid();
BEGIN
  PERFORM auth.register_device('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000002',
     'Handy', 'phone', 'PK2', 'C2', 'c0000000-0000-0000-0000-000000000001');
  PERFORM auth.issue_refresh_token('11111111-1111-1111-1111-111111111111', 'c0000000-0000-0000-0000-000000000001',
     'aaaaaaaa-0000-0000-0000-000000000002', fam, '\x01'::bytea, 3600);

  SELECT * INTO r FROM auth.rotate_refresh_token('\x01', '\x02', 3600);
  IF r.status <> 'ok' OR r.role <> 'owner' THEN RAISE EXCEPTION 'A5 FAIL Rotation: %', r.status; END IF;

  -- Dieb spielt das alte Token erneut ein -> ganze Familie gesperrt
  SELECT * INTO r FROM auth.rotate_refresh_token('\x01', '\x03', 3600);
  IF r.status <> 'reuse' THEN RAISE EXCEPTION 'A5 FAIL: Wiederverwendung nicht erkannt'; END IF;
  -- auch das rechtmäßige neue Token ist jetzt ungültig
  SELECT * INTO r FROM auth.rotate_refresh_token('\x02', '\x04', 3600);
  IF r.status <> 'reuse' THEN RAISE EXCEPTION 'A5 FAIL: Familie nicht gesperrt (%)', r.status; END IF;
  RAISE NOTICE 'A5 ok: Rotation funktioniert; wiederverwendetes Token sperrt die ganze Sitzungskette';
END $$;

-- ---------- A6: gesperrtes Gerät kann Sitzung nicht verlängern ----------
DO $$
DECLARE r record;
BEGIN
  PERFORM auth.issue_refresh_token('11111111-1111-1111-1111-111111111111', 'c0000000-0000-0000-0000-000000000001',
     'aaaaaaaa-0000-0000-0000-000000000001', gen_random_uuid(), '\x10'::bytea, 3600);
  SELECT * INTO r FROM auth.rotate_refresh_token('\x10', '\x11', 3600);
  IF r.status <> 'invalid' THEN RAISE EXCEPTION 'A6 FAIL: gesperrtes Gerät verlängert Sitzung'; END IF;
  RAISE NOTICE 'A6 ok: Sitzungen eines gesperrten Geräts enden beim nächsten Verlängern';
END $$;

ROLLBACK;
\echo 'ALLE LOGIN-TESTS BESTANDEN'
