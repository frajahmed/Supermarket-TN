-- =============================================================================
--  Migration 003: Großhandel (B2B)
--  Geschäftskunden, Kundengruppen, Preislisten mit Mengenstaffeln, Gebinde,
--  Verkaufsaufträge, Ausgangsrechnungen (lückenlos nummeriert, nach Ausstellung
--  unveränderlich, vorbereitet für TTN/El Fatoora), Zahlungen, Kreditlimit.
--
--  Tunesien-Bezug (vor Go-live fachlich prüfen lassen):
--  * Rechnungen tragen die Matricule fiscal von Verkäufer und Käufer.
--  * Droit de timbre je Rechnung: Betrag in tenants.settings->'stamp_duty_minor'
--    (Minor Units). Standard 1000 = 1,000 TND – bewusst konfigurierbar.
-- =============================================================================
BEGIN;

CREATE TYPE app.customer_type   AS ENUM ('business', 'individual');
CREATE TYPE app.order_status    AS ENUM ('draft', 'confirmed', 'delivered', 'invoiced', 'cancelled');
CREATE TYPE app.invoice_status  AS ENUM ('draft', 'issued', 'sent', 'accepted', 'rejected', 'cancelled');
CREATE TYPE app.ttn_status      AS ENUM ('not_sent', 'pending', 'accepted', 'rejected');

-- -----------------------------------------------------------------------------
-- Gebinde: Stück -> Karton -> Palette (factor = Menge in Basiseinheit)
-- -----------------------------------------------------------------------------
CREATE TABLE app.product_packagings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  product_id  uuid NOT NULL,
  code        text NOT NULL,                     -- 'piece' | 'carton' | 'pallet' | frei
  name        jsonb NOT NULL,                    -- i18n: {"fr": "Carton de 12", "ar": "كرتونة 12"}
  factor      numeric(14,3) NOT NULL CHECK (factor > 0),
  gtin        text,                              -- eigener Barcode des Gebindes (ITF-14 o. ä.)
  is_default_sale boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, product_id, code),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES app.products(tenant_id, id) ON DELETE CASCADE
);

-- -----------------------------------------------------------------------------
-- Preislisten mit Mengenstaffeln; Kundengruppen verweisen auf eine Preisliste
-- -----------------------------------------------------------------------------
CREATE TABLE app.price_lists (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  currency    char(3) NOT NULL DEFAULT 'TND' REFERENCES app.currencies(code),
  prices_include_tax boolean NOT NULL DEFAULT false,  -- Großhandel üblich: HT (netto)
  valid_from  date,
  valid_to    date,
  is_active   boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, name),
  UNIQUE (tenant_id, id),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)
);

CREATE TABLE app.price_list_items (
  tenant_id     uuid NOT NULL,
  price_list_id uuid NOT NULL,
  product_id    uuid NOT NULL,
  min_qty       numeric(14,3) NOT NULL DEFAULT 1 CHECK (min_qty > 0),  -- Staffel ab Menge (Basiseinheit)
  unit_price    bigint NOT NULL CHECK (unit_price >= 0),                -- Minor Units je Basiseinheit
  PRIMARY KEY (price_list_id, product_id, min_qty),
  FOREIGN KEY (tenant_id, price_list_id) REFERENCES app.price_lists(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, product_id)    REFERENCES app.products(tenant_id, id)    ON DELETE CASCADE
);

CREATE TABLE app.customer_groups (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  name          jsonb NOT NULL,                  -- i18n: Épiceries, Restaurants, Revendeurs …
  price_list_id uuid,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, price_list_id) REFERENCES app.price_lists(tenant_id, id)
);

-- -----------------------------------------------------------------------------
-- Geschäftskunden
-- -----------------------------------------------------------------------------
CREATE TABLE app.customers (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  number             text NOT NULL,              -- Kundennummer
  type               app.customer_type NOT NULL DEFAULT 'business',
  name               text NOT NULL,
  legal_name         text,
  tax_id             text,                       -- Matricule fiscal (Pflicht für business, s. CHECK)
  vat_exempt         boolean NOT NULL DEFAULT false,  -- z. B. Exportkunde / Suspension de TVA
  group_id           uuid,
  price_list_id      uuid,                       -- überschreibt die Preisliste der Gruppe
  currency           char(3) NOT NULL DEFAULT 'TND' REFERENCES app.currencies(code),
  payment_terms_days int NOT NULL DEFAULT 0 CHECK (payment_terms_days BETWEEN 0 AND 365),
  credit_limit       bigint CHECK (credit_limit >= 0),   -- NULL = kein Limit
  phone              text,
  email              citext,
  billing_address    jsonb NOT NULL DEFAULT '{}',
  delivery_addresses jsonb NOT NULL DEFAULT '[]',
  preferred_locale   text NOT NULL DEFAULT 'fr-TN',     -- Sprache für Rechnung/Lieferschein
  is_active          boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, group_id)      REFERENCES app.customer_groups(tenant_id, id),
  FOREIGN KEY (tenant_id, price_list_id) REFERENCES app.price_lists(tenant_id, id),
  CHECK (type = 'individual' OR tax_id IS NOT NULL)
);
CREATE INDEX customers_name_trgm ON app.customers USING gin (name gin_trgm_ops);
CREATE INDEX ON app.customers (tenant_id, tax_id);

-- -----------------------------------------------------------------------------
-- Verkaufsaufträge (Bestellung des Kunden -> Kommissionierung -> Lieferung)
-- -----------------------------------------------------------------------------
CREATE TABLE app.sales_orders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  store_id      uuid NOT NULL,                   -- ausliefernde Filiale / Lager
  customer_id   uuid NOT NULL,
  number        text NOT NULL,
  status        app.order_status NOT NULL DEFAULT 'draft',
  currency      char(3) NOT NULL DEFAULT 'TND' REFERENCES app.currencies(code),
  delivery_address jsonb,
  requested_date date,
  note          text,
  client_op_id  uuid,                            -- Aufträge können offline (Außendienst) entstehen
  created_by    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number),
  UNIQUE (tenant_id, client_op_id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, store_id)    REFERENCES app.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES app.customers(tenant_id, id)
);

CREATE TABLE app.sales_order_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  sales_order_id uuid NOT NULL,
  line_no        int NOT NULL,
  product_id     uuid NOT NULL,
  packaging_id   uuid,                           -- bestellt in Karton/Palette
  quantity       numeric(14,3) NOT NULL CHECK (quantity > 0),   -- in Basiseinheit
  quantity_delivered numeric(14,3) NOT NULL DEFAULT 0,
  unit_price     bigint NOT NULL CHECK (unit_price >= 0),       -- netto je Basiseinheit
  discount_bp    int NOT NULL DEFAULT 0 CHECK (discount_bp BETWEEN 0 AND 10000),
  tax_rate_bp    int NOT NULL,
  UNIQUE (sales_order_id, line_no),
  FOREIGN KEY (tenant_id, sales_order_id) REFERENCES app.sales_orders(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, product_id)     REFERENCES app.products(tenant_id, id),
  FOREIGN KEY (tenant_id, packaging_id)   REFERENCES app.product_packagings(tenant_id, id)
);

-- -----------------------------------------------------------------------------
-- Lückenlose Rechnungsnummern je Serie und Jahr
-- Die Nummer wird in derselben Transaktion vergeben wie die Ausstellung:
-- bricht die Transaktion ab, wird auch die Nummer nicht verbraucht.
-- -----------------------------------------------------------------------------
CREATE TABLE app.invoice_sequences (
  tenant_id   uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  series      text NOT NULL,                     -- 'FA' Rechnung, 'AV' Gutschrift (avoir)
  year        int  NOT NULL,
  next_number int  NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, series, year)
);

-- -----------------------------------------------------------------------------
-- Ausgangsrechnungen
-- -----------------------------------------------------------------------------
CREATE TABLE app.sales_invoices (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  store_id         uuid NOT NULL,
  customer_id      uuid NOT NULL,
  sales_order_id   uuid,
  series           text NOT NULL DEFAULT 'FA',
  number           text,                         -- erst bei Ausstellung vergeben, z. B. FA-2026-000123
  status           app.invoice_status NOT NULL DEFAULT 'draft',
  is_credit_note   boolean NOT NULL DEFAULT false,
  credit_note_for  uuid,                         -- Gutschrift verweist auf Original
  currency         char(3) NOT NULL DEFAULT 'TND' REFERENCES app.currencies(code),
  issue_date       date,
  due_date         date,
  net_total        bigint NOT NULL DEFAULT 0,
  tax_total        bigint NOT NULL DEFAULT 0,
  stamp_duty       bigint NOT NULL DEFAULT 0,
  gross_total      bigint NOT NULL DEFAULT 0,
  tax_breakdown    jsonb NOT NULL DEFAULT '[]',  -- [{rate_bp, net, tax}] je Steuersatz
  seller_snapshot  jsonb,                        -- Name, Matricule fiscal, Adresse zum Ausstellungszeitpunkt
  customer_snapshot jsonb,
  -- TTN / El Fatoora
  ttn_status       app.ttn_status NOT NULL DEFAULT 'not_sent',
  ttn_reference    text,                         -- eindeutige Kennung von TTN
  teif_file_key    text,                         -- signiertes TEIF-XML im Dateispeicher
  ttn_error        text,
  issued_by        uuid,
  issued_at        timestamptz,
  created_by       uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, store_id)        REFERENCES app.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id)     REFERENCES app.customers(tenant_id, id),
  FOREIGN KEY (tenant_id, sales_order_id)  REFERENCES app.sales_orders(tenant_id, id),
  FOREIGN KEY (tenant_id, credit_note_for) REFERENCES app.sales_invoices(tenant_id, id),
  CHECK (status = 'draft' OR number IS NOT NULL),
  CHECK (is_credit_note = (credit_note_for IS NOT NULL))
);
CREATE INDEX ON app.sales_invoices (tenant_id, customer_id, status);

CREATE TABLE app.sales_invoice_lines (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  invoice_id  uuid NOT NULL,
  line_no     int NOT NULL,
  product_id  uuid,
  description text NOT NULL,                     -- Snapshot (Sprache des Kunden)
  quantity    numeric(14,3) NOT NULL CHECK (quantity > 0),
  unit_price  bigint NOT NULL CHECK (unit_price >= 0),   -- netto (HT) je Einheit
  discount_bp int NOT NULL DEFAULT 0 CHECK (discount_bp BETWEEN 0 AND 10000),
  tax_rate_bp int NOT NULL,
  line_net    bigint,                            -- bei Ausstellung berechnet
  line_tax    bigint,
  UNIQUE (invoice_id, line_no),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES app.sales_invoices(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, product_id) REFERENCES app.products(tenant_id, id)
);

CREATE TABLE app.customer_payments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  customer_id  uuid NOT NULL,
  invoice_id   uuid,                             -- NULL = Akonto-Zahlung
  amount       bigint NOT NULL CHECK (amount > 0),
  currency     char(3) NOT NULL DEFAULT 'TND' REFERENCES app.currencies(code),
  method       text NOT NULL CHECK (method IN ('cash', 'cheque', 'transfer', 'traite', 'card', 'other')),
  reference    text,                             -- Schecknummer, Überweisungsreferenz …
  received_at  date NOT NULL DEFAULT current_date,
  recorded_by  uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES app.customers(tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_id)  REFERENCES app.sales_invoices(tenant_id, id)
);
CREATE INDEX ON app.customer_payments (tenant_id, customer_id);

-- =============================================================================
--  FUNKTIONEN
-- =============================================================================

-- Gültiger Preis: Kundenpreisliste vor Gruppenpreisliste, höchste erreichte Staffel
CREATE FUNCTION app.price_for(p_customer_id uuid, p_product_id uuid, p_qty numeric, p_on date DEFAULT current_date)
  RETURNS bigint LANGUAGE sql STABLE AS
$$
  WITH lists AS (
    SELECT c.price_list_id AS id, 1 AS prio FROM app.customers c WHERE c.id = p_customer_id AND c.price_list_id IS NOT NULL
    UNION ALL
    SELECT g.price_list_id, 2 FROM app.customers c JOIN app.customer_groups g ON g.id = c.group_id
     WHERE c.id = p_customer_id AND g.price_list_id IS NOT NULL
  )
  SELECT coalesce(
    (SELECT i.unit_price
       FROM lists l
       JOIN app.price_lists pl ON pl.id = l.id AND pl.is_active
            AND (pl.valid_from IS NULL OR pl.valid_from <= p_on)
            AND (pl.valid_to   IS NULL OR pl.valid_to   >= p_on)
       JOIN app.price_list_items i ON i.price_list_id = l.id AND i.product_id = p_product_id AND i.min_qty <= p_qty
      ORDER BY l.prio, i.min_qty DESC
      LIMIT 1),
    (SELECT p.sale_price FROM app.products p WHERE p.id = p_product_id)   -- Fallback: Standardpreis
  )
$$;

-- Offener Saldo eines Kunden (ausgestellte Rechnungen minus Gutschriften minus Zahlungen)
CREATE FUNCTION app.customer_open_balance(p_customer_id uuid)
  RETURNS bigint LANGUAGE sql STABLE AS
$$
  SELECT coalesce((SELECT sum(CASE WHEN is_credit_note THEN -gross_total ELSE gross_total END)
                     FROM app.sales_invoices
                    WHERE customer_id = p_customer_id AND status NOT IN ('draft', 'cancelled', 'rejected')), 0)
       - coalesce((SELECT sum(amount) FROM app.customer_payments WHERE customer_id = p_customer_id), 0)
$$;

-- Rechnung ausstellen: Summen berechnen, Nummer vergeben, Snapshots einfrieren, Kreditlimit prüfen
CREATE FUNCTION app.issue_invoice(p_invoice_id uuid) RETURNS app.sales_invoices
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

  -- Positionen: netto je Zeile kaufmännisch gerundet, Steuer je Zeile
  UPDATE app.sales_invoice_lines l
     SET line_net = round(l.quantity * l.unit_price * (10000 - l.discount_bp) / 10000.0)::bigint,
         tax_rate_bp = CASE WHEN cust.vat_exempt THEN 0 ELSE l.tax_rate_bp END
   WHERE l.invoice_id = inv.id;
  UPDATE app.sales_invoice_lines l
     SET line_tax = round(l.line_net * l.tax_rate_bp / 10000.0)::bigint
   WHERE l.invoice_id = inv.id;

  v_stamp := CASE WHEN inv.is_credit_note THEN 0
                  ELSE coalesce((ten.settings->>'stamp_duty_minor')::bigint, 1000) END;

  -- Aufschlüsselung je Steuersatz (Pflichtangabe auf der Rechnung) und Gesamtsummen
  SELECT jsonb_agg(jsonb_build_object('rate_bp', rate_bp, 'net', net, 'tax', tax) ORDER BY rate_bp DESC),
         sum(net), sum(tax)
    INTO inv.tax_breakdown, inv.net_total, inv.tax_total
    FROM (SELECT tax_rate_bp AS rate_bp, sum(line_net) AS net, sum(line_tax) AS tax
            FROM app.sales_invoice_lines WHERE invoice_id = inv.id
           GROUP BY tax_rate_bp) t;
  inv.stamp_duty  := v_stamp;
  inv.gross_total := inv.net_total + inv.tax_total + v_stamp;

  -- Kreditlimit (nur für Rechnungen, Inhaber darf überschreiben über Einstellung im API)
  IF NOT inv.is_credit_note AND cust.credit_limit IS NOT NULL THEN
    v_open := app.customer_open_balance(cust.id);
    IF v_open + inv.gross_total > cust.credit_limit AND app.current_role() <> 'owner' THEN
      RAISE EXCEPTION 'Kreditlimit überschritten (offen %, Rechnung %, Limit %)',
        v_open, inv.gross_total, cust.credit_limit USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Lückenlose Nummer (Zeilensperre auf der Sequenz serialisiert parallele Ausstellungen)
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

-- Ausgestellte Rechnungen sind unveränderlich; nur Status- und TTN-Felder dürfen sich ändern.
CREATE FUNCTION app.guard_issued_invoice() RETURNS trigger
  LANGUAGE plpgsql AS
$$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'Ausgestellte Rechnung % kann nicht gelöscht werden – Gutschrift erstellen', OLD.number
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'draft' AND (
       NEW.number, NEW.customer_id, NEW.issue_date, NEW.net_total, NEW.tax_total, NEW.stamp_duty,
       NEW.gross_total, NEW.tax_breakdown, NEW.customer_snapshot, NEW.seller_snapshot, NEW.currency
     ) IS DISTINCT FROM (
       OLD.number, OLD.customer_id, OLD.issue_date, OLD.net_total, OLD.tax_total, OLD.stamp_duty,
       OLD.gross_total, OLD.tax_breakdown, OLD.customer_snapshot, OLD.seller_snapshot, OLD.currency
     ) THEN
    RAISE EXCEPTION 'Ausgestellte Rechnung % ist unveränderlich', OLD.number USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION app.guard_issued_invoice_lines() RETURNS trigger
  LANGUAGE plpgsql AS
$$
DECLARE v_status app.invoice_status;
BEGIN
  SELECT status INTO v_status FROM app.sales_invoices
   WHERE id = coalesce(NEW.invoice_id, OLD.invoice_id);
  -- Während issue_invoice() ist die Rechnung noch 'draft' -> Berechnung erlaubt
  IF v_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'Positionen einer ausgestellten Rechnung sind unveränderlich' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN coalesce(NEW, OLD);
END
$$;

CREATE TRIGGER sales_invoices_guard BEFORE UPDATE OR DELETE ON app.sales_invoices
  FOR EACH ROW EXECUTE FUNCTION app.guard_issued_invoice();
CREATE TRIGGER sales_invoice_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON app.sales_invoice_lines
  FOR EACH ROW EXECUTE FUNCTION app.guard_issued_invoice_lines();
CREATE TRIGGER customer_payments_immutable BEFORE UPDATE OR DELETE ON app.customer_payments
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['customers', 'sales_orders', 'sales_invoices'] LOOP
    EXECUTE format('CREATE TRIGGER %I_touch BEFORE UPDATE ON app.%I
                    FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at()', t, t);
  END LOOP;
END $$;

-- =============================================================================
--  ROW-LEVEL-SECURITY
-- =============================================================================
DO $$
DECLARE t text;
BEGIN
  -- mandantenweit
  FOREACH t IN ARRAY ARRAY['product_packagings', 'price_lists', 'price_list_items', 'customer_groups',
                           'customers', 'invoice_sequences', 'sales_order_lines', 'sales_invoice_lines',
                           'customer_payments']
  LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON app.%I
                      USING (tenant_id = app.current_tenant_id())
                      WITH CHECK (tenant_id = app.current_tenant_id())$p$, t);
  END LOOP;

  -- filialgebunden
  FOREACH t IN ARRAY ARRAY['sales_orders', 'sales_invoices'] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_store_read ON app.%I FOR SELECT
                      USING (tenant_id = app.current_tenant_id() AND app.has_store_access(store_id))$p$, t);
  END LOOP;
END $$;

-- Aufträge: anlegen/ändern alle außer Kassierer
CREATE POLICY orders_write ON app.sales_orders FOR ALL
  USING      (tenant_id = app.current_tenant_id() AND app.has_store_access(store_id) AND app.current_role() <> 'cashier')
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.has_store_access(store_id) AND app.current_role() <> 'cashier');

-- Rechnungen: schreiben nur Inhaber und Filialleiter (Kassierer darf lesen und drucken)
CREATE POLICY invoices_write ON app.sales_invoices FOR ALL
  USING      (tenant_id = app.current_tenant_id() AND app.has_store_access(store_id) AND app.current_role() IN ('owner', 'manager'))
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.has_store_access(store_id) AND app.current_role() IN ('owner', 'manager'));

-- =============================================================================
--  RECHTE & GRANTS
-- =============================================================================
INSERT INTO app.permissions (code, description) VALUES
  ('customer.manage', 'Geschäftskunden, Kundengruppen und Preislisten pflegen'),
  ('sales.order',     'Verkaufsaufträge anlegen und bearbeiten'),
  ('invoice.issue',   'Ausgangsrechnungen und Gutschriften ausstellen, an TTN senden'),
  ('payment.record',  'Kundenzahlungen erfassen');

INSERT INTO app.role_permissions (role, permission_code, store_scoped)
SELECT 'owner', code, false FROM app.permissions
 WHERE code IN ('customer.manage', 'sales.order', 'invoice.issue', 'payment.record');

INSERT INTO app.role_permissions (role, permission_code) VALUES
  ('manager', 'customer.manage'), ('manager', 'sales.order'), ('manager', 'invoice.issue'),
  ('manager', 'payment.record'), ('stock_clerk', 'sales.order');

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'app' LOOP
    EXECUTE format('ALTER TABLE app.%I OWNER TO app_owner', r.tablename);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO app_user;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO app_user;
REVOKE UPDATE, DELETE ON app.stock_movements, app.audit_log, app.customer_payments FROM app_user;
REVOKE INSERT, UPDATE, DELETE ON app.permissions, app.role_permissions, app.currencies, app.tax_rates FROM app_user;

-- Kundensaldo für Listen und Kreditprüfung im Auftrag
CREATE VIEW app.v_customer_balance WITH (security_invoker = true) AS
SELECT c.tenant_id, c.id AS customer_id, c.number, c.name, c.credit_limit,
       app.customer_open_balance(c.id) AS open_balance,
       (c.credit_limit IS NOT NULL AND app.customer_open_balance(c.id) > c.credit_limit) AS over_limit
  FROM app.customers c;
ALTER VIEW app.v_customer_balance OWNER TO app_owner;
GRANT SELECT ON app.v_customer_balance TO app_user;

COMMIT;
