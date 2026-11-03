-- =============================================================================
--  Migration 008: B2B-Verkaufsablauf (T-105)
--  Auftrag (draft) -> Bestätigung mit Kreditprüfung -> Lieferung(en) mit
--  Lieferschein und Lagerbuchung -> Rechnung je Lieferung -> Gutschrift.
--
--  Alle Funktionen laufen als aufrufende Rolle (SECURITY INVOKER): RLS und die
--  Rollen-Policies aus 003 gelten unverändert. Fehlercodes:
--    SN402  Kreditlimit überschritten (Inhaber kann mit Begründung übersteuern)
--    SN422  fachlich ungültig (Status, Mengen, leere Positionen …)
-- =============================================================================
BEGIN;

-- -----------------------------------------------------------------------------
-- Lieferungen (Lieferschein = eine Lieferung)
-- -----------------------------------------------------------------------------
CREATE TABLE app.sales_deliveries (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  store_id       uuid NOT NULL,
  sales_order_id uuid NOT NULL,
  number         text NOT NULL,                  -- BL-2026-000001 (bon de livraison)
  invoice_id     uuid,                           -- gesetzt, sobald fakturiert
  client_op_id   uuid NOT NULL,                  -- Idempotenz (Gerät kann erneut senden)
  delivered_at   timestamptz NOT NULL DEFAULT now(),
  created_by     uuid NOT NULL,
  UNIQUE (tenant_id, number),
  UNIQUE (tenant_id, client_op_id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, store_id)       REFERENCES app.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, sales_order_id) REFERENCES app.sales_orders(tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_id)     REFERENCES app.sales_invoices(tenant_id, id)
);

CREATE TABLE app.sales_delivery_lines (
  tenant_id     uuid NOT NULL,
  delivery_id   uuid NOT NULL,
  order_line_id uuid NOT NULL REFERENCES app.sales_order_lines(id),
  product_id    uuid NOT NULL,
  quantity      numeric(14,3) NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (delivery_id, order_line_id),
  FOREIGN KEY (tenant_id, delivery_id) REFERENCES app.sales_deliveries(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, product_id)  REFERENCES app.products(tenant_id, id)
);

-- Übersteuerung des Kreditlimits durch den Inhaber (gilt für den ganzen Auftrag)
ALTER TABLE app.sales_orders
  ADD COLUMN credit_override_by     uuid,
  ADD COLUMN credit_override_reason text,
  ADD COLUMN confirmed_at           timestamptz;

ALTER TABLE app.sales_deliveries     ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.sales_deliveries     FORCE  ROW LEVEL SECURITY;
ALTER TABLE app.sales_delivery_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.sales_delivery_lines FORCE  ROW LEVEL SECURITY;
CREATE POLICY deliveries_read ON app.sales_deliveries FOR SELECT
  USING (tenant_id = app.current_tenant_id() AND app.has_store_access(store_id));
CREATE POLICY deliveries_write ON app.sales_deliveries FOR ALL
  USING      (tenant_id = app.current_tenant_id() AND app.has_store_access(store_id) AND app.current_role() <> 'cashier')
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.has_store_access(store_id) AND app.current_role() <> 'cashier');
CREATE POLICY tenant_isolation ON app.sales_delivery_lines
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());

ALTER TABLE app.sales_deliveries     OWNER TO app_owner;
ALTER TABLE app.sales_delivery_lines OWNER TO app_owner;
GRANT SELECT, INSERT, UPDATE ON app.sales_deliveries, app.sales_delivery_lines TO app_user;

-- -----------------------------------------------------------------------------
-- Hilfsfunktionen
-- -----------------------------------------------------------------------------
-- Fortlaufende Belegnummer je Serie und Jahr (SO Auftrag, BL Lieferschein), lückenlos
CREATE FUNCTION app.next_document_number(p_series text) RETURNS text
  LANGUAGE plpgsql AS
$$
DECLARE v_year int := extract(year FROM current_date)::int; v_no int;
BEGIN
  INSERT INTO app.invoice_sequences (tenant_id, series, year) VALUES (app.current_tenant_id(), p_series, v_year)
  ON CONFLICT DO NOTHING;
  UPDATE app.invoice_sequences SET next_number = next_number + 1
   WHERE tenant_id = app.current_tenant_id() AND series = p_series AND year = v_year
  RETURNING next_number - 1 INTO v_no;
  RETURN format('%s-%s-%s', p_series, v_year, lpad(v_no::text, 6, '0'));
END
$$;

-- Produktname in der Sprache des Kunden ('ar-TN' -> ar), sonst fr/ar/en
CREATE FUNCTION app.product_label(p_name jsonb, p_locale text) RETURNS text
  LANGUAGE sql IMMUTABLE AS
$$ SELECT coalesce(p_name->>left(coalesce(p_locale, 'fr'), 2), p_name->>'fr', p_name->>'ar', p_name->>'en', '?') $$;

-- Voraussichtlicher Bruttobetrag eines Auftrags (gleiche Rundung wie issue_invoice)
CREATE FUNCTION app.sales_order_gross(p_order_id uuid) RETURNS bigint
  LANGUAGE sql STABLE AS
$$
  WITH l AS (
    SELECT round(ol.quantity * ol.unit_price * (10000 - ol.discount_bp) / 10000.0)::bigint AS net,
           CASE WHEN c.vat_exempt THEN 0 ELSE ol.tax_rate_bp END AS rate
      FROM app.sales_order_lines ol
      JOIN app.sales_orders o ON o.id = ol.sales_order_id
      JOIN app.customers c    ON c.id = o.customer_id
     WHERE ol.sales_order_id = p_order_id)
  SELECT coalesce(sum(net + round(net * rate / 10000.0)::bigint), 0)
       + coalesce((SELECT (t.settings->>'stamp_duty_minor')::bigint FROM app.tenants t
                    WHERE t.id = app.current_tenant_id()), 1000)
    FROM l
$$;

-- -----------------------------------------------------------------------------
-- 1. Auftrag anlegen (Preise über app.price_for), idempotent über client_op_id
--    p_lines: [{"productId": uuid, "quantity": "12.000", "packagingId": uuid?}]
-- -----------------------------------------------------------------------------
CREATE FUNCTION app.create_sales_order(p_store_id uuid, p_customer_id uuid, p_lines jsonb,
                                       p_requested_date date, p_note text, p_client_op_id uuid)
  RETURNS uuid LANGUAGE plpgsql AS
$$
DECLARE
  v_id uuid; v_line jsonb; v_no int := 0; v_qty numeric; v_product app.products;
BEGIN
  IF p_client_op_id IS NOT NULL THEN
    SELECT id INTO v_id FROM app.sales_orders WHERE client_op_id = p_client_op_id;
    IF FOUND THEN RETURN v_id; END IF;
  END IF;
  IF jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'Auftrag ohne Positionen' USING ERRCODE = 'SN422';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.customers WHERE id = p_customer_id AND is_active) THEN
    RAISE EXCEPTION 'Kunde nicht gefunden oder inaktiv' USING ERRCODE = 'SN422';
  END IF;

  INSERT INTO app.sales_orders (tenant_id, store_id, customer_id, number, requested_date, note, client_op_id, created_by)
  VALUES (app.current_tenant_id(), p_store_id, p_customer_id, app.next_document_number('SO'),
          p_requested_date, p_note, p_client_op_id, app.current_user_id())
  RETURNING id INTO v_id;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_no := v_no + 1;
    v_qty := (v_line->>'quantity')::numeric;
    SELECT * INTO v_product FROM app.products WHERE id = (v_line->>'productId')::uuid AND is_active;
    IF NOT FOUND THEN RAISE EXCEPTION 'Position %: Produkt nicht gefunden', v_no USING ERRCODE = 'SN422'; END IF;
    IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Position %: Menge muss > 0 sein', v_no USING ERRCODE = 'SN422'; END IF;
    INSERT INTO app.sales_order_lines (tenant_id, sales_order_id, line_no, product_id, packaging_id, quantity, unit_price, tax_rate_bp)
    VALUES (app.current_tenant_id(), v_id, v_no, v_product.id, (v_line->>'packagingId')::uuid, v_qty,
            coalesce(app.price_for(p_customer_id, v_product.id, v_qty), 0), v_product.tax_rate_bp);
  END LOOP;
  RETURN v_id;
END
$$;

-- -----------------------------------------------------------------------------
-- 2. Bestätigen – Kreditlimit wird HIER geprüft (Abnahmekriterium 1)
-- -----------------------------------------------------------------------------
CREATE FUNCTION app.confirm_sales_order(p_order_id uuid, p_override_reason text) RETURNS void
  LANGUAGE plpgsql AS
$$
DECLARE o app.sales_orders; c app.customers; v_open bigint; v_gross bigint;
BEGIN
  SELECT * INTO o FROM app.sales_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Auftrag nicht gefunden' USING ERRCODE = 'no_data_found'; END IF;
  IF o.status <> 'draft' THEN RAISE EXCEPTION 'Auftrag ist bereits %', o.status USING ERRCODE = 'SN422'; END IF;
  SELECT * INTO c FROM app.customers WHERE id = o.customer_id;

  IF c.credit_limit IS NOT NULL THEN
    v_open  := app.customer_open_balance(c.id)
             + coalesce((SELECT sum(app.sales_order_gross(x.id)) FROM app.sales_orders x   -- bestätigt, noch nicht fakturiert
                          WHERE x.customer_id = c.id AND x.status IN ('confirmed', 'delivered') AND x.id <> o.id), 0);
    v_gross := app.sales_order_gross(o.id);
    IF v_open + v_gross > c.credit_limit THEN
      IF app.current_role() = 'owner' AND nullif(trim(p_override_reason), '') IS NOT NULL THEN
        UPDATE app.sales_orders SET credit_override_by = app.current_user_id(), credit_override_reason = trim(p_override_reason)
         WHERE id = o.id;
        INSERT INTO app.audit_log (tenant_id, user_id, action, entity_type, entity_id, after)
        VALUES (o.tenant_id, app.current_user_id(), 'credit.override', 'sales_order', o.id,
                jsonb_build_object('reason', trim(p_override_reason), 'open', v_open, 'order', v_gross, 'limit', c.credit_limit));
      ELSE
        RAISE EXCEPTION 'Kreditlimit überschritten: offen %, Auftrag %, Limit %', v_open, v_gross, c.credit_limit
          USING ERRCODE = 'SN402',
                HINT = 'Der Inhaber kann mit Begründung übersteuern.';
      END IF;
    END IF;
  END IF;

  UPDATE app.sales_orders SET status = 'confirmed', confirmed_at = now() WHERE id = o.id;
  INSERT INTO app.audit_log (tenant_id, user_id, action, entity_type, entity_id)
  VALUES (o.tenant_id, app.current_user_id(), 'sales_order.confirm', 'sales_order', o.id);
END
$$;

-- -----------------------------------------------------------------------------
-- 3. Liefern (auch Teillieferung) – Lieferschein + Lagerbuchung je Position
--    p_lines: [{"orderLineId": uuid, "quantity": "5.000"}]
-- -----------------------------------------------------------------------------
CREATE FUNCTION app.deliver_sales_order(p_order_id uuid, p_lines jsonb, p_client_op_id uuid) RETURNS uuid
  LANGUAGE plpgsql AS
$$
DECLARE o app.sales_orders; v_id uuid; v_line jsonb; ol app.sales_order_lines; v_qty numeric;
BEGIN
  SELECT id INTO v_id FROM app.sales_deliveries WHERE client_op_id = p_client_op_id;
  IF FOUND THEN RETURN v_id; END IF;                       -- erneut gesendet: nichts doppelt buchen

  SELECT * INTO o FROM app.sales_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Auftrag nicht gefunden' USING ERRCODE = 'no_data_found'; END IF;
  IF o.status <> 'confirmed' THEN
    RAISE EXCEPTION 'Nur bestätigte, noch nicht vollständig gelieferte Aufträge können geliefert werden (Status: %)', o.status
      USING ERRCODE = 'SN422';
  END IF;
  IF jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'Lieferung ohne Positionen' USING ERRCODE = 'SN422';
  END IF;

  INSERT INTO app.sales_deliveries (tenant_id, store_id, sales_order_id, number, client_op_id, created_by)
  VALUES (o.tenant_id, o.store_id, o.id, app.next_document_number('BL'), p_client_op_id, app.current_user_id())
  RETURNING id INTO v_id;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_qty := (v_line->>'quantity')::numeric;
    SELECT * INTO ol FROM app.sales_order_lines
     WHERE id = (v_line->>'orderLineId')::uuid AND sales_order_id = o.id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Position gehört nicht zum Auftrag' USING ERRCODE = 'SN422'; END IF;
    IF v_qty IS NULL OR v_qty <= 0 OR v_qty > ol.quantity - ol.quantity_delivered THEN
      RAISE EXCEPTION 'Position %: Liefermenge % überschreitet offene Menge %', ol.line_no, v_qty, ol.quantity - ol.quantity_delivered
        USING ERRCODE = 'SN422';
    END IF;
    INSERT INTO app.sales_delivery_lines (tenant_id, delivery_id, order_line_id, product_id, quantity)
    VALUES (o.tenant_id, v_id, ol.id, ol.product_id, v_qty);
    UPDATE app.sales_order_lines SET quantity_delivered = quantity_delivered + v_qty WHERE id = ol.id;
    INSERT INTO app.stock_movements (tenant_id, store_id, product_id, type, quantity_delta, ref_type, ref_id,
                                     client_op_id, user_id, occurred_at)
    VALUES (o.tenant_id, o.store_id, ol.product_id, 'sale', -v_qty, 'sales_order', o.id,
            gen_random_uuid(), app.current_user_id(), now());
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM app.sales_order_lines WHERE sales_order_id = o.id AND quantity_delivered < quantity) THEN
    UPDATE app.sales_orders SET status = 'delivered' WHERE id = o.id;
  END IF;
  RETURN v_id;
END
$$;

-- -----------------------------------------------------------------------------
-- 4. Rechnung aus einer Lieferung – nur gelieferte Mengen (Abnahmekriterium 2)
-- -----------------------------------------------------------------------------
CREATE FUNCTION app.invoice_delivery(p_delivery_id uuid) RETURNS uuid
  LANGUAGE plpgsql AS
$$
DECLARE d app.sales_deliveries; o app.sales_orders; c app.customers; v_inv uuid;
BEGIN
  SELECT * INTO d FROM app.sales_deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Lieferung nicht gefunden' USING ERRCODE = 'no_data_found'; END IF;
  IF d.invoice_id IS NOT NULL THEN RETURN d.invoice_id; END IF;   -- idempotent
  SELECT * INTO o FROM app.sales_orders WHERE id = d.sales_order_id;
  SELECT * INTO c FROM app.customers WHERE id = o.customer_id;

  INSERT INTO app.sales_invoices (tenant_id, store_id, customer_id, sales_order_id, currency, created_by)
  VALUES (d.tenant_id, d.store_id, o.customer_id, o.id, o.currency, app.current_user_id())
  RETURNING id INTO v_inv;

  INSERT INTO app.sales_invoice_lines (tenant_id, invoice_id, line_no, product_id, description, quantity, unit_price, discount_bp, tax_rate_bp)
  SELECT d.tenant_id, v_inv, row_number() OVER (ORDER BY ol.line_no), ol.product_id,
         app.product_label(p.name, c.preferred_locale), dl.quantity, ol.unit_price, ol.discount_bp, ol.tax_rate_bp
    FROM app.sales_delivery_lines dl
    JOIN app.sales_order_lines ol ON ol.id = dl.order_line_id
    JOIN app.products p ON p.id = ol.product_id
   WHERE dl.delivery_id = d.id;

  PERFORM app.issue_invoice(v_inv);
  UPDATE app.sales_deliveries SET invoice_id = v_inv WHERE id = d.id;

  IF o.status = 'delivered' AND NOT EXISTS (
       SELECT 1 FROM app.sales_deliveries WHERE sales_order_id = o.id AND invoice_id IS NULL) THEN
    UPDATE app.sales_orders SET status = 'invoiced' WHERE id = o.id;
  END IF;
  RETURN v_inv;
END
$$;

-- -----------------------------------------------------------------------------
-- 5. Gutschrift (Serie AV) über eine ausgestellte Rechnung, vollständig
-- -----------------------------------------------------------------------------
CREATE FUNCTION app.create_credit_note(p_invoice_id uuid, p_reason text) RETURNS uuid
  LANGUAGE plpgsql AS
$$
DECLARE inv app.sales_invoices; v_cn uuid;
BEGIN
  IF nullif(trim(p_reason), '') IS NULL THEN RAISE EXCEPTION 'Begründung fehlt' USING ERRCODE = 'SN422'; END IF;
  SELECT * INTO inv FROM app.sales_invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Rechnung nicht gefunden' USING ERRCODE = 'no_data_found'; END IF;
  IF inv.is_credit_note OR inv.status IN ('draft', 'cancelled', 'rejected') THEN
    RAISE EXCEPTION 'Gutschrift nur zu einer ausgestellten Rechnung' USING ERRCODE = 'SN422';
  END IF;
  IF EXISTS (SELECT 1 FROM app.sales_invoices WHERE credit_note_for = inv.id AND status <> 'draft') THEN
    RAISE EXCEPTION 'Zu Rechnung % gibt es bereits eine Gutschrift', inv.number USING ERRCODE = 'SN422';
  END IF;

  INSERT INTO app.sales_invoices (tenant_id, store_id, customer_id, sales_order_id, series, is_credit_note,
                                  credit_note_for, currency, created_by)
  VALUES (inv.tenant_id, inv.store_id, inv.customer_id, inv.sales_order_id, 'AV', true, inv.id, inv.currency,
          app.current_user_id())
  RETURNING id INTO v_cn;
  INSERT INTO app.sales_invoice_lines (tenant_id, invoice_id, line_no, product_id, description, quantity, unit_price, discount_bp, tax_rate_bp)
  SELECT tenant_id, v_cn, line_no, product_id, description, quantity, unit_price, discount_bp, tax_rate_bp
    FROM app.sales_invoice_lines WHERE invoice_id = inv.id;

  PERFORM app.issue_invoice(v_cn);
  INSERT INTO app.audit_log (tenant_id, user_id, action, entity_type, entity_id, after)
  VALUES (inv.tenant_id, app.current_user_id(), 'invoice.credit_note', 'sales_invoice', v_cn,
          jsonb_build_object('creditNoteFor', inv.number, 'reason', trim(p_reason)));
  RETURN v_cn;
END
$$;

-- -----------------------------------------------------------------------------
-- issue_invoice aus 003 erweitert: hat der Inhaber das Kreditlimit beim Auftrag
-- übersteuert, gilt das auch für die Rechnungen dieses Auftrags. Sonst unverändert.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.issue_invoice(p_invoice_id uuid) RETURNS app.sales_invoices
  LANGUAGE plpgsql AS
$$
DECLARE
  inv     app.sales_invoices;
  cust    app.customers;
  ten     app.tenants;
  v_year  int := extract(year FROM current_date)::int;
  v_no    int;
  v_stamp bigint;
  v_open  bigint;
  v_overridden boolean;
BEGIN
  IF app.current_role() NOT IN ('owner', 'manager') THEN
    RAISE EXCEPTION 'Nur Inhaber oder Filialleiter dürfen Rechnungen ausstellen' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO inv FROM app.sales_invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Rechnung nicht gefunden' USING ERRCODE = 'no_data_found'; END IF;
  IF inv.status <> 'draft' THEN RAISE EXCEPTION 'Rechnung ist bereits ausgestellt' USING ERRCODE = 'check_violation'; END IF;
  IF NOT EXISTS (SELECT 1 FROM app.sales_invoice_lines WHERE invoice_id = inv.id) THEN
    RAISE EXCEPTION 'Rechnung ohne Positionen' USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO cust FROM app.customers WHERE id = inv.customer_id;
  SELECT * INTO ten  FROM app.tenants   WHERE id = inv.tenant_id;

  UPDATE app.sales_invoice_lines l
     SET line_net = round(l.quantity * l.unit_price * (10000 - l.discount_bp) / 10000.0)::bigint,
         tax_rate_bp = CASE WHEN cust.vat_exempt THEN 0 ELSE l.tax_rate_bp END
   WHERE l.invoice_id = inv.id;
  UPDATE app.sales_invoice_lines l
     SET line_tax = round(l.line_net * l.tax_rate_bp / 10000.0)::bigint
   WHERE l.invoice_id = inv.id;

  v_stamp := CASE WHEN inv.is_credit_note THEN 0
                  ELSE coalesce((ten.settings->>'stamp_duty_minor')::bigint, 1000) END;

  SELECT jsonb_agg(jsonb_build_object('rate_bp', rate_bp, 'net', net, 'tax', tax) ORDER BY rate_bp DESC),
         sum(net), sum(tax)
    INTO inv.tax_breakdown, inv.net_total, inv.tax_total
    FROM (SELECT tax_rate_bp AS rate_bp, sum(line_net) AS net, sum(line_tax) AS tax
            FROM app.sales_invoice_lines WHERE invoice_id = inv.id
           GROUP BY tax_rate_bp) t;
  inv.stamp_duty  := v_stamp;
  inv.gross_total := inv.net_total + inv.tax_total + v_stamp;

  v_overridden := inv.sales_order_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM app.sales_orders WHERE id = inv.sales_order_id AND credit_override_by IS NOT NULL);
  IF NOT inv.is_credit_note AND cust.credit_limit IS NOT NULL AND NOT v_overridden THEN
    v_open := app.customer_open_balance(cust.id);
    IF v_open + inv.gross_total > cust.credit_limit AND app.current_role() <> 'owner' THEN
      RAISE EXCEPTION 'Kreditlimit überschritten (offen %, Rechnung %, Limit %)',
        v_open, inv.gross_total, cust.credit_limit USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  INSERT INTO app.invoice_sequences (tenant_id, series, year) VALUES (inv.tenant_id, inv.series, v_year)
  ON CONFLICT DO NOTHING;
  UPDATE app.invoice_sequences SET next_number = next_number + 1
   WHERE tenant_id = inv.tenant_id AND series = inv.series AND year = v_year
  RETURNING next_number - 1 INTO v_no;

  UPDATE app.sales_invoices SET
    number            = format('%s-%s-%s', inv.series, v_year, lpad(v_no::text, 6, '0')),
    status            = 'issued',
    issue_date        = current_date,
    due_date          = current_date + cust.payment_terms_days,
    net_total         = inv.net_total,
    tax_total         = inv.tax_total,
    stamp_duty        = inv.stamp_duty,
    gross_total       = inv.gross_total,
    tax_breakdown     = inv.tax_breakdown,
    seller_snapshot   = jsonb_build_object('name', coalesce(ten.legal_name, ten.name), 'tax_id', ten.tax_id),
    customer_snapshot = jsonb_build_object('name', coalesce(cust.legal_name, cust.name), 'tax_id', cust.tax_id,
                                           'address', cust.billing_address),
    issued_by         = app.current_user_id(),
    issued_at         = now()
  WHERE id = inv.id
  RETURNING * INTO inv;

  INSERT INTO app.outbox_events (tenant_id, store_id, topic, payload)
  VALUES (inv.tenant_id, inv.store_id, 'invoice.issued',
          jsonb_build_object('invoiceId', inv.id, 'number', inv.number, 'gross', inv.gross_total));
  RETURN inv;
END
$$;

-- -----------------------------------------------------------------------------
-- Rechte (Funktionen laufen als Aufrufer – RLS und Rollen-Policies greifen)
-- -----------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION
  app.next_document_number(text), app.product_label(jsonb, text), app.sales_order_gross(uuid),
  app.create_sales_order(uuid, uuid, jsonb, date, text, uuid), app.confirm_sales_order(uuid, text),
  app.deliver_sales_order(uuid, jsonb, uuid), app.invoice_delivery(uuid), app.create_credit_note(uuid, text)
TO app_user;

COMMIT;
