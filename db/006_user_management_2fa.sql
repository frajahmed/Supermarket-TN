-- =============================================================================
-- Migration 006: Benutzerverwaltung und TOTP-Replay-Schutz
-- =============================================================================
BEGIN;

ALTER TABLE app.users
  ADD COLUMN IF NOT EXISTS totp_last_used_step bigint;

-- Login-Funktion mit dem verschlüsselten TOTP-Geheimnis. Die bestehende
-- Funktion aus 004 bleibt für alte Clients unverändert erhalten.
CREATE FUNCTION auth.login_candidate_with_totp(p_email text)
  RETURNS TABLE (user_id uuid, tenant_id uuid, role app.user_role, password_hash text,
                 pin_hash text, totp_secret_enc bytea, is_active boolean,
                 locked_until timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp AS
$$
  SELECT u.id, u.tenant_id, u.role, u.password_hash, u.pin_hash,
         u.totp_secret_enc, u.is_active, u.locked_until
    FROM app.users u
    JOIN app.installation i ON i.tenant_id = u.tenant_id
   WHERE lower(u.email::text) = lower(p_email)
$$;

-- Atomare Schritt-Reservierung: derselbe gültige Code kann im Zeitfenster
-- höchstens einmal verwendet werden. Die Installation begrenzt den Zugriff
-- zusätzlich auf den Mandanten dieses Kundenservers.
CREATE FUNCTION auth.consume_totp_step(p_user_id uuid, p_step bigint)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp AS
$$
BEGIN
  IF p_step < 0 THEN RETURN false; END IF;
  UPDATE app.users
     SET totp_last_used_step = p_step
   WHERE id = p_user_id
     AND tenant_id = (SELECT tenant_id FROM app.installation WHERE singleton)
     AND (totp_last_used_step IS NULL OR totp_last_used_step < p_step);
  RETURN FOUND;
END
$$;

-- Nur diese beiden neuen Funktionen werden vor dem Login freigegeben.
ALTER FUNCTION auth.login_candidate_with_totp(text) OWNER TO app_owner;
ALTER FUNCTION auth.consume_totp_step(uuid, bigint) OWNER TO app_owner;
REVOKE ALL ON FUNCTION auth.login_candidate_with_totp(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.consume_totp_step(uuid, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.login_candidate_with_totp(text) TO app_user;
GRANT EXECUTE ON FUNCTION auth.consume_totp_step(uuid, bigint) TO app_user;

-- Separates Recht für die vollständige Benutzerverwaltung. Filialleiter
-- behalten user.manage, erhalten aber nicht user.manage.all.
INSERT INTO app.permissions (code, description)
VALUES ('user.manage.all', 'Alle Benutzer und Rollen mandantenweit verwalten')
ON CONFLICT (code) DO NOTHING;
INSERT INTO app.role_permissions (role, permission_code, store_scoped)
VALUES ('owner', 'user.manage.all', false)
ON CONFLICT (role, permission_code) DO NOTHING;

COMMIT;
