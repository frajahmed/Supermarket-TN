-- =============================================================================
--  Migration 002: Outbox-Abholung für den Echtzeit-Worker
--  Der Worker arbeitet mandantenübergreifend (er verteilt nur Events an die
--  passenden WebSocket-Räume). Statt ihm BYPASSRLS zu geben, bekommt er genau
--  eine SECURITY-DEFINER-Funktion, die Events atomar abholt und markiert.
--  FOR UPDATE SKIP LOCKED erlaubt mehrere Worker-Instanzen ohne Doppelversand.
-- =============================================================================
BEGIN;

CREATE FUNCTION auth.claim_outbox_events(p_limit int DEFAULT 100)
  RETURNS TABLE (id bigint, tenant_id uuid, store_id uuid, topic text, payload jsonb, created_at timestamptz)
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = app, pg_temp AS
$$
  WITH next AS (
    SELECT o.id FROM app.outbox_events o
     WHERE o.published_at IS NULL
     ORDER BY o.id
     LIMIT least(greatest(p_limit, 1), 1000)
     FOR UPDATE SKIP LOCKED
  )
  UPDATE app.outbox_events o
     SET published_at = now()
    FROM next
   WHERE o.id = next.id
  RETURNING o.id, o.tenant_id, o.store_id, o.topic, o.payload, o.created_at
$$;

ALTER FUNCTION auth.claim_outbox_events(int) OWNER TO app_owner;
REVOKE ALL ON FUNCTION auth.claim_outbox_events(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.claim_outbox_events(int) TO app_user;

COMMIT;
