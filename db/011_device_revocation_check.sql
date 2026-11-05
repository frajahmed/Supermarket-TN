-- =============================================================================
--  011 – Lokal gesperrte Geräte sofort abweisen (T-116)
--  Der Guard prüft je Anfrage ohne Mandantenkontext; deshalb SECURITY DEFINER wie die übrigen auth.*.
-- =============================================================================
BEGIN;

CREATE FUNCTION auth.device_is_revoked(p_tenant_id uuid, p_device_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp AS
$$
  SELECT coalesce((SELECT revoked_at IS NOT NULL FROM app.devices WHERE id = p_device_id AND tenant_id = p_tenant_id), false)
$$;
ALTER FUNCTION auth.device_is_revoked(uuid, uuid) OWNER TO app_owner;
GRANT EXECUTE ON FUNCTION auth.device_is_revoked(uuid, uuid) TO app_user;

COMMIT;
