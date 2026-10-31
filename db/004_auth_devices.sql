-- =============================================================================
--  Migration 004: Anmeldung, Geräte-Zertifikate, Lizenzzustand
--
--  Vor dem Login gibt es noch keinen Mandantenkontext. Alle Schritte des Logins
--  laufen deshalb über eng begrenzte SECURITY-DEFINER-Funktionen im Schema auth;
--  die App-Rolle hat keinen direkten Zugriff auf fremde Zeilen.
-- =============================================================================
BEGIN;

-- -----------------------------------------------------------------------------
-- Installation (genau eine Zeile je Kundenserver)
-- -----------------------------------------------------------------------------
CREATE TABLE app.installation (
  singleton        boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  installation_id  uuid NOT NULL,                -- vom Lizenzserver vergeben
  tenant_id        uuid NOT NULL REFERENCES app.tenants(id),   -- der Kunde auf diesem Server
  license_token    text,                         -- letzte signierte Lizenzbestätigung
  license_saved_at timestamptz
);
ALTER TABLE app.installation OWNER TO app_owner;
REVOKE ALL ON app.installation FROM app_user;   -- nur über Funktionen

-- -----------------------------------------------------------------------------
-- Geräte: id = Geräte-ID aus dem Zertifikat; Filiale wird vom Inhaber zugewiesen
-- -----------------------------------------------------------------------------
ALTER TABLE app.devices ALTER COLUMN store_id DROP NOT NULL;
ALTER TABLE app.devices DROP CONSTRAINT IF EXISTS devices_kind_check;
ALTER TABLE app.devices ADD CONSTRAINT devices_kind_check
  CHECK (kind IN ('pos', 'scanner', 'tablet', 'phone', 'pc', 'hub', 'printer'));
ALTER TABLE app.devices
  ADD COLUMN certificate   text,
  ADD COLUMN first_seen_at timestamptz,
  ADD COLUMN last_user_id  uuid;

-- Inhaber sehen auch Geräte ohne Filiale; sonst wie bisher filialgebunden
DROP POLICY tenant_store_isolation ON app.devices;
CREATE POLICY devices_isolation ON app.devices
  USING (tenant_id = app.current_tenant_id()
         AND (app.has_store_access(store_id) OR (store_id IS NULL AND app.current_role() = 'owner')))
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.current_role() IN ('owner', 'manager'));

-- -----------------------------------------------------------------------------
-- Fehlversuche / Sperre
-- -----------------------------------------------------------------------------
ALTER TABLE app.users
  ADD COLUMN failed_logins int NOT NULL DEFAULT 0,
  ADD COLUMN locked_until  timestamptz;

-- =============================================================================
--  FUNKTIONEN (alle SECURITY DEFINER, Suchpfad fest, Rückgabe minimal)
-- =============================================================================

-- Installation einrichten (einmalig bei der Inbetriebnahme, als Owner ausgeführt)
CREATE FUNCTION auth.setup_installation(p_installation_id uuid, p_tenant_id uuid) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = app, pg_temp AS
$$
  INSERT INTO app.installation (installation_id, tenant_id) VALUES (p_installation_id, p_tenant_id)
  ON CONFLICT (singleton) DO UPDATE SET installation_id = EXCLUDED.installation_id, tenant_id = EXCLUDED.tenant_id
$$;

CREATE FUNCTION auth.installation_info()
  RETURNS TABLE (installation_id uuid, tenant_id uuid, license_token text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp AS
$$ SELECT installation_id, tenant_id, license_token FROM app.installation $$;

CREATE FUNCTION auth.save_license(p_token text) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = app, pg_temp AS
$$ UPDATE app.installation SET license_token = p_token, license_saved_at = now() $$;

-- Benutzer dieses Servers zur E-Mail (Mandant kommt aus der Installation)
CREATE FUNCTION auth.login_candidate(p_email text)
  RETURNS TABLE (user_id uuid, tenant_id uuid, role app.user_role, password_hash text, pin_hash text,
                 is_active boolean, locked_until timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp AS
$$
  SELECT u.id, u.tenant_id, u.role, u.password_hash, u.pin_hash, u.is_active, u.locked_until
    FROM app.users u
    JOIN app.installation i ON i.tenant_id = u.tenant_id
   WHERE lower(u.email::text) = lower(p_email)
$$;

-- Fehlversuch zählen; ab 5 Fehlversuchen Sperre, die sich jedes Mal verdoppelt (15, 30, 60 … max. 24 h)
CREATE FUNCTION auth.record_login_attempt(p_user_id uuid, p_success boolean, p_device_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp AS
$$
DECLARE v_tenant uuid; v_failed int;
BEGIN
  IF p_success THEN
    UPDATE app.users SET failed_logins = 0, locked_until = NULL, last_login_at = now()
     WHERE id = p_user_id RETURNING tenant_id INTO v_tenant;
  ELSE
    UPDATE app.users SET failed_logins = failed_logins + 1,
           locked_until = CASE WHEN failed_logins + 1 >= 5
                               THEN now() + least(interval '15 minutes' * power(2, failed_logins + 1 - 5), interval '24 hours')
                               ELSE locked_until END
     WHERE id = p_user_id RETURNING tenant_id, failed_logins INTO v_tenant, v_failed;
  END IF;
  INSERT INTO app.audit_log (tenant_id, user_id, device_id, action, after)
  VALUES (v_tenant, p_user_id, p_device_id, CASE WHEN p_success THEN 'auth.login' ELSE 'auth.login_failed' END,
          CASE WHEN p_success THEN NULL ELSE jsonb_build_object('failed_logins', v_failed) END);
END
$$;

-- Gerät beim ersten Login registrieren / aktualisieren. false = lokal gesperrt.
CREATE FUNCTION auth.register_device(p_tenant_id uuid, p_device_id uuid, p_name text, p_kind text,
                                     p_public_key text, p_certificate text, p_user_id uuid) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp AS
$$
DECLARE v_revoked timestamptz;
BEGIN
  INSERT INTO app.devices (id, tenant_id, store_id, name, kind, public_key, certificate, first_seen_at, last_seen_at, last_user_id)
  VALUES (p_device_id, p_tenant_id, NULL, p_name, p_kind, p_public_key, p_certificate, now(), now(), p_user_id)
  ON CONFLICT (id) DO UPDATE
    SET last_seen_at = now(), last_user_id = EXCLUDED.last_user_id, certificate = EXCLUDED.certificate
    WHERE app.devices.tenant_id = EXCLUDED.tenant_id
  RETURNING revoked_at INTO v_revoked;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Geräte-ID gehört zu einem anderen Mandanten' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN v_revoked IS NULL;
END
$$;

CREATE FUNCTION auth.issue_refresh_token(p_tenant_id uuid, p_user_id uuid, p_device_id uuid, p_family_id uuid,
                                         p_token_hash bytea, p_ttl_seconds int) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = app, pg_temp AS
$$
  INSERT INTO app.refresh_tokens (tenant_id, user_id, device_id, family_id, token_hash, expires_at)
  VALUES (p_tenant_id, p_user_id, p_device_id, p_family_id, p_token_hash, now() + make_interval(secs => p_ttl_seconds))
$$;

-- Rotation: altes Token wird verbraucht, neues gleicher Familie ausgegeben.
-- Wird ein bereits verbrauchtes Token erneut vorgelegt -> ganze Familie sperren ('reuse').
CREATE FUNCTION auth.rotate_refresh_token(p_old_hash bytea, p_new_hash bytea, p_ttl_seconds int)
  RETURNS TABLE (status text, user_id uuid, tenant_id uuid, role app.user_role, device_id uuid)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp AS
$$
DECLARE t app.refresh_tokens; u app.users; v_dev_revoked timestamptz;
BEGIN
  SELECT * INTO t FROM app.refresh_tokens WHERE token_hash = p_old_hash FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'invalid', NULL::uuid, NULL::uuid, NULL::app.user_role, NULL::uuid; RETURN; END IF;

  IF t.used_at IS NOT NULL OR t.revoked_at IS NOT NULL THEN
    UPDATE app.refresh_tokens SET revoked_at = coalesce(revoked_at, now()) WHERE family_id = t.family_id;
    INSERT INTO app.audit_log (tenant_id, user_id, device_id, action) VALUES (t.tenant_id, t.user_id, t.device_id, 'auth.refresh_reuse');
    RETURN QUERY SELECT 'reuse', NULL::uuid, NULL::uuid, NULL::app.user_role, NULL::uuid; RETURN;
  END IF;

  SELECT * INTO u FROM app.users WHERE id = t.user_id;
  SELECT revoked_at INTO v_dev_revoked FROM app.devices WHERE id = t.device_id;
  IF t.expires_at < now() OR NOT u.is_active OR v_dev_revoked IS NOT NULL THEN
    UPDATE app.refresh_tokens SET revoked_at = now() WHERE family_id = t.family_id;
    RETURN QUERY SELECT 'invalid', NULL::uuid, NULL::uuid, NULL::app.user_role, NULL::uuid; RETURN;
  END IF;

  UPDATE app.refresh_tokens SET used_at = now() WHERE id = t.id;
  INSERT INTO app.refresh_tokens (tenant_id, user_id, device_id, family_id, token_hash, expires_at)
  VALUES (t.tenant_id, t.user_id, t.device_id, t.family_id, p_new_hash, now() + make_interval(secs => p_ttl_seconds));
  RETURN QUERY SELECT 'ok', u.id, u.tenant_id, u.role, t.device_id;
END
$$;

CREATE FUNCTION auth.revoke_refresh_family(p_token_hash bytea) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = app, pg_temp AS
$$
  UPDATE app.refresh_tokens SET revoked_at = coalesce(revoked_at, now())
   WHERE family_id = (SELECT family_id FROM app.refresh_tokens WHERE token_hash = p_token_hash)
$$;

-- Inhaber sperrt ein Gerät lokal (wirkt sofort, auch ohne Lizenzserver)
CREATE FUNCTION app.revoke_device(p_device_id uuid) RETURNS void
  LANGUAGE plpgsql AS
$$
BEGIN
  IF app.current_role() NOT IN ('owner', 'manager') THEN
    RAISE EXCEPTION 'Nur Inhaber oder Filialleiter dürfen Geräte sperren' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE app.devices SET revoked_at = now() WHERE id = p_device_id AND tenant_id = app.current_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Gerät nicht gefunden' USING ERRCODE = 'no_data_found'; END IF;
  INSERT INTO app.audit_log (tenant_id, user_id, action, entity_type, entity_id)
  VALUES (app.current_tenant_id(), app.current_user_id(), 'device.revoke', 'device', p_device_id);
END
$$;

-- -----------------------------------------------------------------------------
-- Rechte
-- -----------------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'auth.setup_installation(uuid, uuid)', 'auth.installation_info()', 'auth.save_license(text)',
    'auth.login_candidate(text)', 'auth.record_login_attempt(uuid, boolean, uuid)',
    'auth.register_device(uuid, uuid, text, text, text, text, uuid)',
    'auth.issue_refresh_token(uuid, uuid, uuid, uuid, bytea, int)',
    'auth.rotate_refresh_token(bytea, bytea, int)', 'auth.revoke_refresh_family(bytea)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO app_owner', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO app_user', f);
  END LOOP;
END $$;
-- Installation einrichten darf nur der Betreiber bei der Inbetriebnahme
REVOKE EXECUTE ON FUNCTION auth.setup_installation(uuid, uuid) FROM app_user;
GRANT EXECUTE ON FUNCTION app.revoke_device(uuid) TO app_user;

COMMIT;
