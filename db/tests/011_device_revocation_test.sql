-- =============================================================================
--  Test: auth.device_is_revoked (Migration 011)
-- =============================================================================
\set QUIET on
BEGIN;
INSERT INTO app.tenants (id, slug, name) VALUES
  ('db000000-0000-0000-0000-000000000001', 'dev-a', 'A'), ('eb000000-0000-0000-0000-000000000001', 'dev-b', 'B');
INSERT INTO app.devices (id, tenant_id, name, kind, revoked_at) VALUES
  ('db000000-0000-0000-0000-0000000000f1', 'db000000-0000-0000-0000-000000000001', 'Kasse', 'pos', NULL),
  ('db000000-0000-0000-0000-0000000000f2', 'db000000-0000-0000-0000-000000000001', 'Handy', 'phone', now());
SET LOCAL ROLE app_user;
DO $$
BEGIN
  IF auth.device_is_revoked('db000000-0000-0000-0000-000000000001', 'db000000-0000-0000-0000-0000000000f1') THEN
    RAISE EXCEPTION 'G1 FAIL: aktives Gerät als gesperrt gemeldet'; END IF;
  IF NOT auth.device_is_revoked('db000000-0000-0000-0000-000000000001', 'db000000-0000-0000-0000-0000000000f2') THEN
    RAISE EXCEPTION 'G1 FAIL: gesperrtes Gerät nicht erkannt'; END IF;
  RAISE NOTICE 'G1 ok: gesperrtes Gerät wird ohne Mandantenkontext erkannt';
  IF auth.device_is_revoked('eb000000-0000-0000-0000-000000000001', 'db000000-0000-0000-0000-0000000000f2') THEN
    RAISE EXCEPTION 'G2 FAIL: Gerät eines anderen Mandanten'; END IF;
  RAISE NOTICE 'G2 ok: Abfrage mit fremdem Mandanten verrät nichts';
  IF EXISTS (SELECT 1 FROM app.devices) THEN RAISE EXCEPTION 'G3 FAIL: Geräte ohne Kontext lesbar'; END IF;
  RAISE NOTICE 'G3 ok: Tabelle selbst bleibt ohne Mandantenkontext unsichtbar';
END $$;
ROLLBACK;
\echo 'ALLE GERÄTE-TESTS BESTANDEN'
