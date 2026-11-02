-- =============================================================================
--  Migration 007: Sicherheit Anmeldung und Benutzerverwaltung (T-108)
--
--  1. 2FA-Einrichtung durch den Nutzer selbst: das vom Server erzeugte Geheimnis
--     liegt verschlüsselt als "ausstehend", bis der Nutzer es mit einem gültigen
--     Code bestätigt. Erst dann wird es nach totp_secret_enc übernommen.
--  2. Der letzte aktive Inhaber eines Mandanten kann weder deaktiviert noch
--     herabgestuft noch gelöscht werden – geprüft in der Datenbank, damit auch
--     zwei gleichzeitige Änderungen den Mandanten nicht ohne Inhaber lassen.
-- =============================================================================
BEGIN;

ALTER TABLE app.users
  ADD COLUMN totp_pending_enc bytea,
  ADD COLUMN totp_pending_at  timestamptz;

-- -----------------------------------------------------------------------------
-- Letzter Inhaber
-- -----------------------------------------------------------------------------
CREATE FUNCTION app.guard_last_owner() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp AS
$$
DECLARE
  v_remaining int;
BEGIN
  -- Nur relevant, wenn ein aktiver Inhaber diesen Status verliert
  IF NOT (OLD.role = 'owner' AND OLD.is_active) THEN
    RETURN coalesce(NEW, OLD);
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.role = 'owner' AND NEW.is_active AND NEW.tenant_id = OLD.tenant_id THEN
    RETURN NEW;
  END IF;

  -- Serialisiert gleichzeitige Änderungen an Inhabern desselben Mandanten.
  -- Die folgende Abfrage sieht danach den bereits festgeschriebenen Stand der anderen Transaktion.
  PERFORM pg_advisory_xact_lock(hashtextextended('stn-last-owner:' || OLD.tenant_id::text, 0));

  SELECT count(*) INTO v_remaining
    FROM app.users
   WHERE tenant_id = OLD.tenant_id AND role = 'owner' AND is_active AND id <> OLD.id;

  IF v_remaining = 0 THEN
    RAISE EXCEPTION 'Der letzte aktive Inhaber kann nicht deaktiviert, herabgestuft oder gelöscht werden'
      USING ERRCODE = 'SN409',
            HINT = 'Zuerst einen weiteren Inhaber anlegen.';
  END IF;
  RETURN coalesce(NEW, OLD);
END
$$;
ALTER FUNCTION app.guard_last_owner() OWNER TO app_owner;

CREATE TRIGGER users_guard_last_owner
  BEFORE UPDATE OF role, is_active, tenant_id OR DELETE ON app.users
  FOR EACH ROW EXECUTE FUNCTION app.guard_last_owner();

-- -----------------------------------------------------------------------------
-- Gemischte Filialen: Filialleiter sehen Zuordnungen zu fremden Filialen wegen RLS
-- nicht. Diese Funktion beantwortet nur die Ja/Nein-Frage, ob es solche gibt –
-- ohne die fremden Filialen preiszugeben.
-- -----------------------------------------------------------------------------
CREATE FUNCTION app.user_has_foreign_stores(p_user_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp AS
$$
  SELECT EXISTS (
    SELECT 1 FROM app.user_store_access
     WHERE user_id = p_user_id
       AND tenant_id = app.current_tenant_id()
       AND NOT app.has_store_access(store_id))
$$;
ALTER FUNCTION app.user_has_foreign_stores(uuid) OWNER TO app_owner;
REVOKE ALL ON FUNCTION app.user_has_foreign_stores(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.user_has_foreign_stores(uuid) TO app_user;

COMMIT;
