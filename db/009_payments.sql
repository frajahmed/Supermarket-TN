-- =============================================================================
--  009 – Kundenzahlungen und Kontoauszug (T-114)
--
--  * Zahlungen bleiben unveränderlich (Trigger + REVOKE aus 003). Ein Storno ist eine
--    Gegenbuchung mit negativem Betrag, Pflicht-Begründung und Verweis auf das Original;
--    jede Zahlung kann höchstens einmal storniert werden.
--  * Idempotenz über client_op_id (Gerät darf nach Netzabbruch erneut senden).
--  * Erfassen nur Inhaber und Filialleiter (restriktive Policy zusätzlich zum API-Recht).
--  * Kontoauszug: Rechnungen, Gutschriften, Zahlungen, Stornos mit laufendem Saldo;
--    der Schlusssaldo entspricht app.customer_open_balance.
--  Fehlercodes: SN409 bereits storniert / Storno eines Stornos, SN422 fachlich ungültig.
-- =============================================================================
BEGIN;

ALTER TABLE app.customer_payments ADD CONSTRAINT customer_payments_tenant_id_id_key UNIQUE (tenant_id, id);
ALTER TABLE app.customer_payments
  ADD COLUMN reverses_payment_id uuid,
  ADD COLUMN reason text,
  ADD COLUMN client_op_id uuid,
  ADD CONSTRAINT customer_payments_reverses_fk FOREIGN KEY (tenant_id, reverses_payment_id)
      REFERENCES app.customer_payments (tenant_id, id),
  ADD CONSTRAINT customer_payments_one_reversal UNIQUE (tenant_id, reverses_payment_id),
  ADD CONSTRAINT customer_payments_client_op UNIQUE (tenant_id, client_op_id);
ALTER TABLE app.customer_payments DROP CONSTRAINT customer_payments_amount_check;
ALTER TABLE app.customer_payments ADD CONSTRAINT customer_payments_amount_sign CHECK (
  (reverses_payment_id IS NULL AND amount > 0) OR
  (reverses_payment_id IS NOT NULL AND amount < 0 AND reason IS NOT NULL AND length(trim(reason)) >= 3));

-- Nur Inhaber und Filialleiter erfassen Zahlungen (wirkt zusätzlich zu tenant_isolation)
CREATE POLICY payments_insert_roles ON app.customer_payments AS RESTRICTIVE FOR INSERT
  WITH CHECK (app.current_role() IN ('owner', 'manager'));

-- -----------------------------------------------------------------------------
-- Zahlung erfassen
-- -----------------------------------------------------------------------------
CREATE FUNCTION app.record_payment(p_customer_id uuid, p_amount bigint, p_method text, p_reference text,
                                   p_received_at date, p_invoice_id uuid, p_client_op_id uuid) RETURNS uuid
  LANGUAGE plpgsql AS
$$
DECLARE v_id uuid; inv app.sales_invoices;
BEGIN
  IF p_client_op_id IS NOT NULL THEN
    SELECT id INTO v_id FROM app.customer_payments WHERE client_op_id = p_client_op_id;
    IF FOUND THEN RETURN v_id; END IF;
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'Betrag muss größer als 0 sein' USING ERRCODE = 'SN422'; END IF;
  IF NOT EXISTS (SELECT 1 FROM app.customers WHERE id = p_customer_id) THEN
    RAISE EXCEPTION 'Kunde nicht gefunden' USING ERRCODE = 'SN422';
  END IF;
  IF p_received_at IS NOT NULL AND p_received_at > current_date THEN
    RAISE EXCEPTION 'Zahlungsdatum liegt in der Zukunft' USING ERRCODE = 'SN422';
  END IF;
  IF p_invoice_id IS NOT NULL THEN
    SELECT * INTO inv FROM app.sales_invoices WHERE id = p_invoice_id;
    IF NOT FOUND OR inv.customer_id <> p_customer_id OR inv.is_credit_note
       OR inv.status IN ('draft', 'cancelled', 'rejected') THEN
      RAISE EXCEPTION 'Rechnung gehört nicht zu diesem Kunden oder ist nicht ausgestellt' USING ERRCODE = 'SN422';
    END IF;
  END IF;
  INSERT INTO app.customer_payments (tenant_id, customer_id, invoice_id, amount, method, reference, received_at,
                                     recorded_by, client_op_id)
  VALUES (app.current_tenant_id(), p_customer_id, p_invoice_id, p_amount, p_method, nullif(trim(p_reference), ''),
          coalesce(p_received_at, current_date), app.current_user_id(), p_client_op_id)
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;

-- -----------------------------------------------------------------------------
-- Storno = Gegenbuchung (Original bleibt unverändert sichtbar)
-- -----------------------------------------------------------------------------
CREATE FUNCTION app.reverse_payment(p_payment_id uuid, p_reason text, p_client_op_id uuid) RETURNS uuid
  LANGUAGE plpgsql AS
$$
DECLARE p app.customer_payments; v_id uuid;
BEGIN
  IF p_client_op_id IS NOT NULL THEN
    SELECT id INTO v_id FROM app.customer_payments WHERE client_op_id = p_client_op_id;
    IF FOUND THEN RETURN v_id; END IF;
  END IF;
  SELECT * INTO p FROM app.customer_payments WHERE id = p_payment_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Zahlung nicht gefunden' USING ERRCODE = 'P0002'; END IF;
  IF p.reverses_payment_id IS NOT NULL THEN RAISE EXCEPTION 'Ein Storno kann nicht storniert werden' USING ERRCODE = 'SN409'; END IF;
  IF EXISTS (SELECT 1 FROM app.customer_payments WHERE reverses_payment_id = p.id) THEN
    RAISE EXCEPTION 'Zahlung ist bereits storniert' USING ERRCODE = 'SN409';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) < 3 THEN
    RAISE EXCEPTION 'Begründung für das Storno fehlt' USING ERRCODE = 'SN422';
  END IF;
  INSERT INTO app.customer_payments (tenant_id, customer_id, invoice_id, amount, currency, method, reference, received_at,
                                     recorded_by, reverses_payment_id, reason, client_op_id)
  VALUES (p.tenant_id, p.customer_id, p.invoice_id, -p.amount, p.currency, p.method, p.reference, current_date,
          app.current_user_id(), p.id, trim(p_reason), p_client_op_id)
  RETURNING id INTO v_id;
  INSERT INTO app.audit_log (tenant_id, user_id, action, entity_type, entity_id, before, after)
  VALUES (p.tenant_id, app.current_user_id(), 'payment.reverse', 'customer_payment', p.id,
          jsonb_build_object('amount', p.amount, 'method', p.method, 'reference', p.reference),
          jsonb_build_object('reversal', v_id, 'reason', trim(p_reason)));
  RETURN v_id;
END
$$;

-- -----------------------------------------------------------------------------
-- Kontoauszug: alle saldowirksamen Buchungen eines Kunden
--   amount > 0 erhöht die Forderung (Rechnung, Zahlungsstorno), < 0 senkt sie
-- -----------------------------------------------------------------------------
CREATE FUNCTION app.customer_ledger(p_customer_id uuid)
  RETURNS TABLE (entry_date date, kind text, document_id uuid, number text, reference text, amount bigint,
                 created_at timestamptz)
  LANGUAGE sql STABLE AS
$$
  SELECT i.issue_date, CASE WHEN i.is_credit_note THEN 'credit_note' ELSE 'invoice' END, i.id, i.number,
         NULL::text, CASE WHEN i.is_credit_note THEN -i.gross_total ELSE i.gross_total END, i.created_at
    FROM app.sales_invoices i
   WHERE i.customer_id = p_customer_id AND i.status NOT IN ('draft', 'cancelled', 'rejected')
  UNION ALL
  SELECT p.received_at, CASE WHEN p.reverses_payment_id IS NULL THEN 'payment' ELSE 'payment_reversal' END, p.id,
         p.method, coalesce(p.reference, p.reason), -p.amount, p.created_at
    FROM app.customer_payments p
   WHERE p.customer_id = p_customer_id
$$;

GRANT EXECUTE ON FUNCTION app.record_payment(uuid, bigint, text, text, date, uuid, uuid),
                          app.reverse_payment(uuid, text, uuid), app.customer_ledger(uuid) TO app_user;

COMMIT;
