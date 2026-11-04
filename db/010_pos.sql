-- =============================================================================
--  010 – Kasse / Abholverkauf (T-115)
--
--  * Bonnummer lückenlos je Kasse (Gerät): Zählerzeile wird in derselben Transaktion wie
--    der Verkauf hochgezählt. Die Zeilensperre serialisiert gleichzeitige Verkäufe derselben
--    Kasse, ein Rollback nimmt auch die Nummer zurück -> keine Lücken, keine Doppelten.
--  * Preise aus store_products.sale_price bzw. products.sale_price (brutto/TTC).
--  * Rabatt je Position bis tenants.settings->>'cashier_max_discount_bp' (Standard 500 = 5 %);
--    darüber nur mit Freigabe eines Inhabers/Filialleiters (Passwort/PIN prüft die API).
--  * Abgeschlossene Bons sind unveränderlich. Storno = Gegenbon (neue Nummer, negative
--    Beträge, Begründung) mit Rückbuchung ins Lager; nur mit Recht sale.void.
--  Fehlercodes: SN403 Rabattfreigabe fehlt, SN409 bereits storniert, SN422 fachlich ungültig.
-- =============================================================================
BEGIN;

CREATE TABLE app.register_counters (
  tenant_id   uuid NOT NULL,
  device_id   uuid PRIMARY KEY,
  last_number bigint NOT NULL,
  FOREIGN KEY (tenant_id, device_id) REFERENCES app.devices (tenant_id, id)
);
ALTER TABLE app.register_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.register_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.register_counters
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
GRANT SELECT, INSERT, UPDATE ON app.register_counters TO app_user;

ALTER TABLE app.sales ADD COLUMN void_reason text;
ALTER TABLE app.sales ADD CONSTRAINT sales_one_void UNIQUE (tenant_id, voids_sale_id);
ALTER TABLE app.sales ADD CONSTRAINT sales_void_reason CHECK (voids_sale_id IS NULL OR length(trim(void_reason)) >= 3);

-- Abgeschlossene Bons (und ihre Positionen/Zahlungen) sind unveränderlich
CREATE FUNCTION app.guard_completed_sale() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE v_status app.sale_status;
BEGIN
  IF TG_TABLE_NAME = 'sales' THEN
    v_status := OLD.status;
  ELSE
    SELECT status INTO v_status FROM app.sales WHERE id = coalesce(OLD.sale_id, NEW.sale_id);
  END IF;
  IF v_status = 'completed' THEN
    RAISE EXCEPTION 'Abgeschlossener Bon ist unveränderlich – Storno als Gegenbon' USING ERRCODE = 'SN409';
  END IF;
  RETURN coalesce(NEW, OLD);
END
$$;
CREATE TRIGGER sales_guard BEFORE UPDATE OR DELETE ON app.sales
  FOR EACH ROW EXECUTE FUNCTION app.guard_completed_sale();
CREATE TRIGGER sale_lines_guard BEFORE UPDATE OR DELETE ON app.sale_lines
  FOR EACH ROW EXECUTE FUNCTION app.guard_completed_sale();
CREATE TRIGGER sale_payments_guard BEFORE UPDATE OR DELETE ON app.payments
  FOR EACH ROW EXECUTE FUNCTION app.guard_completed_sale();

-- Nächste Bonnummer der Kasse (sperrt die Zählerzeile bis Transaktionsende)
CREATE FUNCTION app.next_receipt_number(p_device_id uuid) RETURNS bigint LANGUAGE sql AS
$$
  INSERT INTO app.register_counters AS rc (tenant_id, device_id, last_number)
  VALUES (app.current_tenant_id(), p_device_id, 1)
  ON CONFLICT (device_id) DO UPDATE SET last_number = rc.last_number + 1
  RETURNING last_number
$$;

-- -----------------------------------------------------------------------------
-- Verkauf abschließen
--   p_lines    [{productId, quantity, discountBp?}]
--   p_payments [{method: cash|card|voucher|other, amount, terminalRef?}]  – Summe >= Brutto;
--              Bar-Überzahlung ist Rückgeld (gespeichert wird der verbleibende Barbetrag)
-- -----------------------------------------------------------------------------
CREATE FUNCTION app.complete_sale(p_store_id uuid, p_device_id uuid, p_lines jsonb, p_payments jsonb,
                                  p_approved_by uuid, p_client_op_id uuid, p_started_at timestamptz) RETURNS uuid
  LANGUAGE plpgsql AS
$$
DECLARE
  v_id uuid; v_no int := 0; v_line jsonb; v_pay jsonb; p app.products; v_price bigint; v_qty numeric;
  v_bp int; v_gross_line bigint; v_disc bigint; v_total bigint; v_tax bigint;
  v_sum_gross bigint := 0; v_sum_tax bigint := 0; v_sum_disc bigint := 0;
  v_limit int; v_needs_approval boolean := false; v_paid bigint := 0; v_noncash bigint := 0; v_cash bigint := 0;
BEGIN
  SELECT id INTO v_id FROM app.sales WHERE client_op_id = p_client_op_id;
  IF FOUND THEN RETURN v_id; END IF;

  IF NOT app.has_store_access(p_store_id) THEN
    RAISE EXCEPTION 'Keine Berechtigung für diese Filiale' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'Bon ohne Positionen' USING ERRCODE = 'SN422';
  END IF;
  SELECT coalesce((settings->>'cashier_max_discount_bp')::int, 500) INTO v_limit
    FROM app.tenants WHERE id = app.current_tenant_id();

  INSERT INTO app.sales (tenant_id, store_id, device_id, receipt_number, status, cashier_id, client_op_id, started_at)
  VALUES (app.current_tenant_id(), p_store_id, p_device_id, app.next_receipt_number(p_device_id), 'open',
          app.current_user_id(), p_client_op_id, coalesce(p_started_at, now()))
  RETURNING id INTO v_id;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_no := v_no + 1;
    v_qty := (v_line->>'quantity')::numeric;
    v_bp := coalesce((v_line->>'discountBp')::int, 0);
    SELECT * INTO p FROM app.products WHERE id = (v_line->>'productId')::uuid AND is_active;
    IF NOT FOUND THEN RAISE EXCEPTION 'Position %: Produkt nicht gefunden', v_no USING ERRCODE = 'SN422'; END IF;
    IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Position %: Menge muss > 0 sein', v_no USING ERRCODE = 'SN422'; END IF;
    IF v_bp < 0 OR v_bp > 10000 THEN RAISE EXCEPTION 'Position %: Rabatt ungültig', v_no USING ERRCODE = 'SN422'; END IF;
    IF v_bp > v_limit THEN v_needs_approval := true; END IF;
    SELECT coalesce(sp.sale_price, p.sale_price) INTO v_price
      FROM app.products pp LEFT JOIN app.store_products sp ON sp.store_id = p_store_id AND sp.product_id = pp.id
     WHERE pp.id = p.id;
    IF v_price IS NULL THEN RAISE EXCEPTION 'Position %: % hat keinen Verkaufspreis', v_no, p.sku USING ERRCODE = 'SN422'; END IF;
    v_gross_line := round(v_qty * v_price);
    v_disc := round(v_gross_line * v_bp / 10000.0);
    v_total := v_gross_line - v_disc;
    v_tax := round(v_total * p.tax_rate_bp / (10000.0 + p.tax_rate_bp));   -- im Bruttopreis enthaltene TVA
    INSERT INTO app.sale_lines (tenant_id, sale_id, line_no, product_id, product_name, quantity, unit_price, discount,
                                tax_rate_bp, line_total)
    VALUES (app.current_tenant_id(), v_id, v_no, p.id,
            coalesce(p.name->>'fr', p.name->>'ar', p.name->>'en', p.sku), v_qty, v_price, v_disc, p.tax_rate_bp, v_total);
    INSERT INTO app.stock_movements (tenant_id, store_id, product_id, type, quantity_delta, ref_type, ref_id,
                                     client_op_id, device_id, user_id, occurred_at)
    VALUES (app.current_tenant_id(), p_store_id, p.id, 'sale', -v_qty, 'sale', v_id, gen_random_uuid(), p_device_id,
            app.current_user_id(), coalesce(p_started_at, now()));
    v_sum_gross := v_sum_gross + v_total; v_sum_tax := v_sum_tax + v_tax; v_sum_disc := v_sum_disc + v_disc;
  END LOOP;

  -- Rabattfreigabe: Inhaber/Filialleiter selbst, oder bestätigte Freigabe einer solchen Person
  IF v_needs_approval AND app.current_role() NOT IN ('owner', 'manager') THEN
    IF p_approved_by IS NULL OR NOT EXISTS (
         SELECT 1 FROM app.users u WHERE u.id = p_approved_by AND u.is_active AND u.role IN ('owner', 'manager')) THEN
      RAISE EXCEPTION 'Rabatt über % %% braucht Freigabe durch Filialleitung', v_limit / 100.0 USING ERRCODE = 'SN403';
    END IF;
  END IF;

  IF jsonb_typeof(p_payments) <> 'array' OR jsonb_array_length(p_payments) = 0 THEN
    RAISE EXCEPTION 'Zahlung fehlt' USING ERRCODE = 'SN422';
  END IF;
  FOR v_pay IN SELECT * FROM jsonb_array_elements(p_payments) LOOP
    IF (v_pay->>'amount')::bigint IS NULL OR (v_pay->>'amount')::bigint <= 0 THEN
      RAISE EXCEPTION 'Zahlbetrag muss > 0 sein' USING ERRCODE = 'SN422';
    END IF;
    v_paid := v_paid + (v_pay->>'amount')::bigint;
    IF v_pay->>'method' = 'cash' THEN v_cash := v_cash + (v_pay->>'amount')::bigint;
    ELSE v_noncash := v_noncash + (v_pay->>'amount')::bigint; END IF;
  END LOOP;
  IF v_paid < v_sum_gross THEN
    RAISE EXCEPTION 'Zahlung % reicht nicht für Bon %', v_paid, v_sum_gross USING ERRCODE = 'SN422';
  END IF;
  IF v_noncash > v_sum_gross THEN
    RAISE EXCEPTION 'Karte/Gutschein höher als der Bon – Rückgeld nur bar' USING ERRCODE = 'SN422';
  END IF;
  FOR v_pay IN SELECT * FROM jsonb_array_elements(p_payments) WHERE value->>'method' <> 'cash' LOOP
    INSERT INTO app.payments (tenant_id, sale_id, method, amount, terminal_ref)
    VALUES (app.current_tenant_id(), v_id, (v_pay->>'method')::app.payment_method, (v_pay->>'amount')::bigint,
            nullif(v_pay->>'terminalRef', ''));
  END LOOP;
  IF v_sum_gross - v_noncash > 0 THEN    -- bar kassiert = Rest nach Karte (Rückgeld nicht gespeichert)
    INSERT INTO app.payments (tenant_id, sale_id, method, amount)
    VALUES (app.current_tenant_id(), v_id, 'cash', v_sum_gross - v_noncash);
  END IF;

  UPDATE app.sales SET status = 'completed', completed_at = now(), gross_total = v_sum_gross, tax_total = v_sum_tax,
         net_total = v_sum_gross - v_sum_tax, discount_total = v_sum_disc,
         discount_approved_by = CASE WHEN v_needs_approval THEN coalesce(p_approved_by, app.current_user_id()) END
   WHERE id = v_id;
  IF v_needs_approval THEN
    INSERT INTO app.audit_log (tenant_id, user_id, action, entity_type, entity_id, after)
    VALUES (app.current_tenant_id(), app.current_user_id(), 'discount.approve', 'sale', v_id,
            jsonb_build_object('approvedBy', coalesce(p_approved_by, app.current_user_id()), 'discount', v_sum_disc));
  END IF;
  RETURN v_id;
END
$$;

-- -----------------------------------------------------------------------------
-- Storno: Gegenbon mit neuer Nummer an derselben Kasse, Lager-Rückbuchung
-- -----------------------------------------------------------------------------
CREATE FUNCTION app.void_sale(p_sale_id uuid, p_device_id uuid, p_reason text, p_client_op_id uuid) RETURNS uuid
  LANGUAGE plpgsql AS
$$
DECLARE s app.sales; v_id uuid; l app.sale_lines;
BEGIN
  SELECT id INTO v_id FROM app.sales WHERE client_op_id = p_client_op_id;
  IF FOUND THEN RETURN v_id; END IF;
  IF app.current_role() NOT IN ('owner', 'manager') THEN
    RAISE EXCEPTION 'Storno nur durch Filialleitung' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO s FROM app.sales WHERE id = p_sale_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bon nicht gefunden' USING ERRCODE = 'P0002'; END IF;
  IF s.voids_sale_id IS NOT NULL THEN RAISE EXCEPTION 'Ein Storno kann nicht storniert werden' USING ERRCODE = 'SN409'; END IF;
  IF s.status <> 'completed' THEN RAISE EXCEPTION 'Nur abgeschlossene Bons können storniert werden' USING ERRCODE = 'SN422'; END IF;
  IF EXISTS (SELECT 1 FROM app.sales WHERE voids_sale_id = s.id) THEN
    RAISE EXCEPTION 'Bon ist bereits storniert' USING ERRCODE = 'SN409';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) < 3 THEN RAISE EXCEPTION 'Begründung fehlt' USING ERRCODE = 'SN422'; END IF;

  INSERT INTO app.sales (tenant_id, store_id, device_id, receipt_number, status, cashier_id, client_op_id, started_at,
                         voids_sale_id, void_reason)
  VALUES (s.tenant_id, s.store_id, p_device_id, app.next_receipt_number(p_device_id), 'open', app.current_user_id(),
          p_client_op_id, now(), s.id, trim(p_reason))
  RETURNING id INTO v_id;
  FOR l IN SELECT * FROM app.sale_lines WHERE sale_id = s.id ORDER BY line_no LOOP
    INSERT INTO app.sale_lines (tenant_id, sale_id, line_no, product_id, product_name, quantity, unit_price, discount,
                                tax_rate_bp, line_total)
    VALUES (l.tenant_id, v_id, l.line_no, l.product_id, l.product_name, -l.quantity, l.unit_price, -l.discount,
            l.tax_rate_bp, -l.line_total);
    INSERT INTO app.stock_movements (tenant_id, store_id, product_id, type, quantity_delta, ref_type, ref_id,
                                     client_op_id, device_id, user_id, occurred_at)
    VALUES (l.tenant_id, s.store_id, l.product_id, 'customer_return', l.quantity, 'sale', v_id, gen_random_uuid(),
            p_device_id, app.current_user_id(), now());
  END LOOP;
  INSERT INTO app.payments (tenant_id, sale_id, method, amount, terminal_ref)
  SELECT tenant_id, v_id, method, -amount, terminal_ref FROM app.payments WHERE sale_id = s.id;
  UPDATE app.sales SET status = 'completed', completed_at = now(), gross_total = -s.gross_total, tax_total = -s.tax_total,
         net_total = -s.net_total, discount_total = -s.discount_total
   WHERE id = v_id;
  INSERT INTO app.audit_log (tenant_id, user_id, action, entity_type, entity_id, before, after)
  VALUES (s.tenant_id, app.current_user_id(), 'sale.void', 'sale', s.id,
          jsonb_build_object('receipt', s.receipt_number, 'gross', s.gross_total),
          jsonb_build_object('voidSale', v_id, 'reason', trim(p_reason)));
  RETURN v_id;
END
$$;

GRANT EXECUTE ON FUNCTION app.next_receipt_number(uuid), app.complete_sale(uuid, uuid, jsonb, jsonb, uuid, uuid, timestamptz),
                          app.void_sale(uuid, uuid, text, uuid) TO app_user;
COMMIT;
