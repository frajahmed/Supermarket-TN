-- Test: TOTP-Lookup, atomarer Replay-Schutz und Mandantengrenze
\set QUIET on
BEGIN;

INSERT INTO app.tenants (id, slug, name) VALUES
  ('66666666-6666-6666-6666-666666666666', 'totp-a', 'TOTP A'),
  ('77777777-7777-7777-7777-777777777777', 'totp-b', 'TOTP B');
INSERT INTO app.users (id, tenant_id, email, display_name, role, password_hash, totp_secret_enc)
VALUES
  ('e0000000-0000-0000-0000-000000000001', '66666666-6666-6666-6666-666666666666',
   'owner@totp-a.tn', 'Owner A', 'owner', 'scrypt$x', '\x01'),
  ('f0000000-0000-0000-0000-000000000001', '77777777-7777-7777-7777-777777777777',
   'owner@totp-b.tn', 'Owner B', 'owner', 'scrypt$y', '\x02');
SELECT auth.setup_installation('88888888-0000-0000-0000-000000000001', '66666666-6666-6666-6666-666666666666');

SET LOCAL ROLE app_user;

DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM auth.login_candidate_with_totp('OWNER@TOTP-A.TN');
  IF r.user_id <> 'e0000000-0000-0000-0000-000000000001' OR r.totp_secret_enc <> '\x01'::bytea
  THEN RAISE EXCEPTION 'U2FA-1 FAIL: TOTP-Lookup'; END IF;
  IF EXISTS (SELECT 1 FROM auth.login_candidate_with_totp('owner@totp-b.tn'))
  THEN RAISE EXCEPTION 'U2FA-1 FAIL: fremder Mandant sichtbar'; END IF;
  RAISE NOTICE 'U2FA-1 ok: Lookup bleibt auf den Installationsmandanten begrenzt';
END $$;

DO $$
BEGIN
  IF NOT auth.consume_totp_step('e0000000-0000-0000-0000-000000000001', 100) THEN
    RAISE EXCEPTION 'U2FA-2 FAIL: erster Schritt abgelehnt';
  END IF;
  IF auth.consume_totp_step('e0000000-0000-0000-0000-000000000001', 100) THEN
    RAISE EXCEPTION 'U2FA-2 FAIL: Replay akzeptiert';
  END IF;
  IF auth.consume_totp_step('e0000000-0000-0000-0000-000000000001', 99) THEN
    RAISE EXCEPTION 'U2FA-2 FAIL: alter Schritt akzeptiert';
  END IF;
  IF auth.consume_totp_step('f0000000-0000-0000-0000-000000000001', 101) THEN
    RAISE EXCEPTION 'U2FA-2 FAIL: fremder Mandant akzeptiert';
  END IF;
  IF NOT auth.consume_totp_step('e0000000-0000-0000-0000-000000000001', 101) THEN
    RAISE EXCEPTION 'U2FA-2 FAIL: nächster Schritt abgelehnt';
  END IF;
  RAISE NOTICE 'U2FA-2 ok: TOTP-Schritt ist atomar und idempotent';
END $$;

ROLLBACK;
\echo 'ALLE BENUTZERVERWALTUNGS-TESTS BESTANDEN'
