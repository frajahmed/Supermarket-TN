-- =============================================================================
--  Warenwirtschaft & Kasse – PostgreSQL-Schema (PostgreSQL 15+)
--  Migration 001: Grundschema, Rollen, Mandantentrennung per Row-Level-Security
--
--  Grundprinzipien
--  * Jede fachliche Tabelle trägt tenant_id. RLS erzwingt: eine DB-Session sieht
--    ausschließlich Zeilen des Mandanten aus `app.tenant_id`.
--  * Filialbezogene Tabellen prüfen zusätzlich `app.store_ids` (vom API-Guard
--    pro Request aus der DB geladen, nicht blind aus dem JWT übernommen).
--  * Die Anwendung verbindet sich als `app_user` (kein Owner, kein BYPASSRLS).
--    Tabellen gehören `app_owner`, der nur für Migrationen benutzt wird.
--  * Bestand ändert sich NUR über das unveränderliche Journal stock_movements.
--  * Geldbeträge: BIGINT in Minor Units + ISO-4217-Code. Achtung: TND hat 3 Nachkommastellen
--    (1 TND = 1000 Millimes), EUR 2. Die Stellenzahl steht in app.currencies.
--  * Bereitstellung: ein lokaler Server je Kunde (eigene DB). tenant_id + RLS bleiben
--    trotzdem aktiv: gleiche Codebasis, mehrere Filialen, späterer Cloud-Betrieb möglich.
-- =============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;     -- case-insensitive E-Mail
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- unscharfe Produktsuche (Beleg-Abgleich)

-- -----------------------------------------------------------------------------
-- Datenbank-Rollen
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_owner') THEN
    -- Owner der Tabellen, nur für Migrationen und SECURITY-DEFINER-Funktionen (auth.*).
    -- BYPASSRLS nötig, da FORCE ROW LEVEL SECURITY sonst auch den Owner filtert.
    CREATE ROLE app_owner NOLOGIN BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    -- Passwort wird im Deployment gesetzt: ALTER ROLE app_user LOGIN PASSWORD '...';
    CREATE ROLE app_user NOLOGIN NOBYPASSRLS;
  END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS app AUTHORIZATION app_owner;   -- fachliche Tabellen
CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION app_owner;  -- Login-Hilfsfunktionen

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------
-- Genau 4 Rollen laut Anforderung.
CREATE TYPE app.user_role AS ENUM ('owner', 'manager', 'stock_clerk', 'cashier');

CREATE TYPE app.movement_type AS ENUM (
  'purchase_receipt',   -- Wareneingang (Lieferant)
  'sale',               -- Verkauf an der Kasse
  'customer_return',    -- Rücknahme vom Kunden
  'supplier_return',    -- Rücksendung an Lieferant
  'adjustment',         -- Bestandskorrektur (+/-)
  'loss',               -- Verlust: Bruch, Diebstahl, MHD abgelaufen
  'transfer_out',       -- Umlagerung an andere Filiale
  'transfer_in',        -- Umlagerung von anderer Filiale
  'inventory_count'     -- Differenzbuchung aus Inventur
);

CREATE TYPE app.document_kind   AS ENUM ('invoice', 'delivery_note', 'credit_note');
CREATE TYPE app.document_source AS ENUM ('teif', 'qr', 'ocr', 'manual');  -- teif = XML-Format der TTN-Plattform El Fatoora
CREATE TYPE app.document_status AS ENUM ('uploaded', 'processing', 'review', 'booked', 'rejected', 'failed');
CREATE TYPE app.po_status       AS ENUM ('draft', 'sent', 'partially_received', 'received', 'cancelled');
CREATE TYPE app.sale_status     AS ENUM ('open', 'completed', 'voided');
CREATE TYPE app.payment_method  AS ENUM ('cash', 'card', 'voucher', 'other');

-- -----------------------------------------------------------------------------
-- Kontext-Funktionen (lesen die per SET LOCAL gesetzten Session-Variablen)
-- Fehlt der Kontext, liefern sie NULL -> RLS-Vergleiche sind nie wahr -> 0 Zeilen.
-- -----------------------------------------------------------------------------
CREATE FUNCTION app.current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE FUNCTION app.current_user_id() RETURNS uuid
  LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

CREATE FUNCTION app.current_role() RETURNS app.user_role
  LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.role', true), '')::app.user_role $$;

-- Inhaber sehen alle Filialen ihres Mandanten, alle anderen nur zugewiesene.
CREATE FUNCTION app.has_store_access(p_store_id uuid) RETURNS boolean
  LANGUAGE sql STABLE AS
$$
  SELECT app.current_role() = 'owner'
      OR p_store_id = ANY (
           string_to_array(nullif(current_setting('app.store_ids', true), ''), ',')::uuid[]
         )
$$;

-- Generischer updated_at-Trigger
CREATE FUNCTION app.touch_updated_at() RETURNS trigger
  LANGUAGE plpgsql AS
$$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

-- =============================================================================
--  WÄHRUNGEN & STEUERSÄTZE (global, nicht mandantenbezogen)
-- =============================================================================
CREATE TABLE app.currencies (
  code        char(3) PRIMARY KEY,               -- ISO 4217
  minor_unit  smallint NOT NULL CHECK (minor_unit BETWEEN 0 AND 4),  -- TND 3, EUR 2
  symbol      text NOT NULL
);

CREATE TABLE app.tax_rates (
  country_code char(2) NOT NULL,
  rate_bp      int NOT NULL,                     -- Basispunkte: 1900 = 19 %
  label        jsonb NOT NULL,                   -- i18n-Bezeichnung
  PRIMARY KEY (country_code, rate_bp)
);

-- =============================================================================
--  MANDANTEN, FILIALEN, BENUTZER
-- =============================================================================
CREATE TABLE app.tenants (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug             text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{3,40}$'),
  name             text NOT NULL,
  legal_name       text,
  tax_id           text,                         -- Matricule fiscal (TN) bzw. USt-IdNr.
  country_code     char(2) NOT NULL DEFAULT 'TN',
  default_currency char(3) NOT NULL DEFAULT 'TND' REFERENCES app.currencies(code),
  default_locale   text    NOT NULL DEFAULT 'fr-TN',  -- 'ar-TN' | 'fr-TN' | 'en'
  ttn_account_id   text,                         -- Konto bei El Fatoora (E-Rechnung)
  settings         jsonb   NOT NULL DEFAULT '{}',  -- z. B. Rabattlimits, Warnschwellen
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.stores (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  code         text NOT NULL,                    -- Filialnummer
  name         text NOT NULL,
  address      jsonb NOT NULL DEFAULT '{}',
  timezone     text NOT NULL DEFAULT 'Africa/Tunis',
  currency     char(3) NOT NULL DEFAULT 'TND',
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id)                         -- Ziel für zusammengesetzte FKs
);

CREATE TABLE app.users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  email           citext NOT NULL,
  display_name    text NOT NULL,
  role            app.user_role NOT NULL,
  password_hash   text,                          -- Argon2id; NULL = nur PIN-Login (Kasse)
  pin_hash        text,                          -- Argon2id der Kassen-PIN
  totp_secret_enc bytea,                         -- verschlüsselt (App-Key), Pflicht für owner/manager
  locale          text,
  is_active       boolean NOT NULL DEFAULT true,
  last_login_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email),
  UNIQUE (tenant_id, id)
);

-- Zuordnung Benutzer <-> Filialen (für owner nicht nötig)
CREATE TABLE app.user_store_access (
  tenant_id uuid NOT NULL,
  user_id   uuid NOT NULL,
  store_id  uuid NOT NULL,
  PRIMARY KEY (user_id, store_id),
  FOREIGN KEY (tenant_id, user_id)  REFERENCES app.users(tenant_id, id)  ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, store_id) REFERENCES app.stores(tenant_id, id) ON DELETE CASCADE
);

-- Feingranulare Rechte, fest den 4 Rollen zugeordnet (global, nicht mandantenbezogen)
CREATE TABLE app.permissions (
  code        text PRIMARY KEY,                  -- z. B. 'stock.adjust'
  description text NOT NULL
);

CREATE TABLE app.role_permissions (
  role            app.user_role NOT NULL,
  permission_code text NOT NULL REFERENCES app.permissions(code) ON DELETE CASCADE,
  store_scoped    boolean NOT NULL DEFAULT true,  -- true = nur in zugewiesenen Filialen
  PRIMARY KEY (role, permission_code)
);

-- Gekoppelte Geräte (Kasse, Scanner, Tablet, Filial-Hub)
CREATE TABLE app.devices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  store_id        uuid NOT NULL,
  name            text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('pos', 'scanner', 'tablet', 'hub', 'printer')),
  public_key      text,                          -- Geräte-Schlüssel aus der QR-Kopplung
  fiscal_device_id text,                         -- Kassen-ID beim Fiskal-Modul (falls Pflicht)
  last_seen_at    timestamptz,
  sync_cursor     bigint NOT NULL DEFAULT 0,
  revoked_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, store_id) REFERENCES app.stores(tenant_id, id) ON DELETE CASCADE
);

-- Rotierende Refresh-Tokens (nur Hash gespeichert); family_id erkennt Token-Diebstahl
CREATE TABLE app.refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  user_id     uuid NOT NULL,
  device_id   uuid,
  family_id   uuid NOT NULL,
  token_hash  bytea NOT NULL UNIQUE,             -- SHA-256
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, user_id) REFERENCES app.users(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX ON app.refresh_tokens (family_id);
CREATE INDEX users_email_lower ON app.users (lower(email::text));

-- =============================================================================
--  STAMMDATEN: Kategorien, Lieferanten, Produkte
-- =============================================================================
CREATE TABLE app.categories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  parent_id  uuid REFERENCES app.categories(id) ON DELETE SET NULL,
  name       jsonb NOT NULL,                     -- i18n: {"ar": "ألبان", "fr": "Produits laitiers", "en": "Dairy"}
  sort_order int NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id)
);

CREATE TABLE app.suppliers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  name          text NOT NULL,
  tax_id        text,                            -- Matricule fiscal des Lieferanten
  iban          text,                            -- für Belegabgleich (GiroCode)
  email         citext,
  phone         text,
  address       jsonb NOT NULL DEFAULT '{}',
  currency      char(3) NOT NULL DEFAULT 'TND',
  lead_time_days int,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE INDEX ON app.suppliers (tenant_id, tax_id);

CREATE TABLE app.products (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  sku                text NOT NULL,              -- interne Artikelnummer
  name               jsonb NOT NULL,             -- i18n
  description        jsonb,
  category_id        uuid,
  default_supplier_id uuid,
  unit               text NOT NULL DEFAULT 'piece' CHECK (unit IN ('piece', 'kg', 'g', 'l', 'ml', 'pack')),
  currency           char(3) NOT NULL DEFAULT 'TND',
  purchase_price     bigint CHECK (purchase_price >= 0),   -- Minor Units, netto
  sale_price         bigint CHECK (sale_price >= 0),       -- Minor Units, brutto (TTC)
  tax_rate_bp        int NOT NULL DEFAULT 1900, -- Basispunkte; TN: 1900 / 1300 / 700 / 0
  min_stock          numeric(14,3) NOT NULL DEFAULT 0,     -- Mindestbestand je Filiale (Default)
  shelf_life_days    int,                        -- für MHD-Vorschlag beim Wareneingang
  track_expiry       boolean NOT NULL DEFAULT true,
  nutrition          jsonb,                      -- je 100 g/ml: energy_kj, fat, sugar, protein, salt …
  allergens          text[] NOT NULL DEFAULT '{}',  -- LMIV-Codes: 'gluten','milk','nuts' …
  image_key          text,                       -- Object-Storage-Schlüssel
  source             text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'barcode', 'ai', 'import', 'document')),
  is_active          boolean NOT NULL DEFAULT true,
  created_by         uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, sku),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, category_id)         REFERENCES app.categories(tenant_id, id),
  FOREIGN KEY (tenant_id, default_supplier_id) REFERENCES app.suppliers(tenant_id, id)
);
CREATE INDEX products_name_fr_trgm ON app.products USING gin ((name->>'fr') gin_trgm_ops);
CREATE INDEX products_name_ar_trgm ON app.products USING gin ((name->>'ar') gin_trgm_ops);

-- Mehrere Barcodes je Produkt (EAN-13, EAN-8, UPC, GS1-QR, interne Waagen-Codes)
CREATE TABLE app.product_barcodes (
  tenant_id  uuid NOT NULL,
  product_id uuid NOT NULL,
  code       text NOT NULL,
  symbology  text NOT NULL DEFAULT 'ean13',
  pack_qty   numeric(14,3) NOT NULL DEFAULT 1,   -- Kiste à 12 Stück -> 12
  PRIMARY KEY (tenant_id, code),                 -- ein Code ist im Mandanten eindeutig
  FOREIGN KEY (tenant_id, product_id) REFERENCES app.products(tenant_id, id) ON DELETE CASCADE
);

-- Lieferanten-Artikelnummern (für den Rechnungsabgleich)
CREATE TABLE app.supplier_products (
  tenant_id         uuid NOT NULL,
  supplier_id       uuid NOT NULL,
  product_id        uuid NOT NULL,
  supplier_sku      text NOT NULL,
  purchase_price    bigint,
  pack_qty          numeric(14,3) NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, supplier_id, supplier_sku),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES app.suppliers(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, product_id)  REFERENCES app.products(tenant_id, id)  ON DELETE CASCADE
);

-- Filialspezifische Abweichungen (Preis, Mindestbestand)
CREATE TABLE app.store_products (
  tenant_id   uuid NOT NULL,
  store_id    uuid NOT NULL,
  product_id  uuid NOT NULL,
  sale_price  bigint,
  min_stock   numeric(14,3),
  shelf_location text,
  PRIMARY KEY (store_id, product_id),
  FOREIGN KEY (tenant_id, store_id)   REFERENCES app.stores(tenant_id, id)   ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, product_id) REFERENCES app.products(tenant_id, id) ON DELETE CASCADE
);

-- =============================================================================
--  BESTAND: Journal (Wahrheit) + abgeleitete Summen
-- =============================================================================
-- Chargen mit MHD je Filiale. quantity wird ausschließlich per Trigger gepflegt.
CREATE TABLE app.stock_lots (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  store_id    uuid NOT NULL,
  product_id  uuid NOT NULL,
  lot_number  text,
  expiry_date date,                              -- MHD / Verbrauchsdatum
  quantity    numeric(14,3) NOT NULL DEFAULT 0,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, store_id)   REFERENCES app.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES app.products(tenant_id, id)
);
CREATE INDEX stock_lots_expiry ON app.stock_lots (tenant_id, store_id, expiry_date) WHERE quantity > 0;

-- Aktueller Bestand je Filiale/Produkt (Materialisierung des Journals)
CREATE TABLE app.store_stock (
  tenant_id   uuid NOT NULL,
  store_id    uuid NOT NULL,
  product_id  uuid NOT NULL,
  quantity    numeric(14,3) NOT NULL DEFAULT 0,  -- darf negativ werden (Offline-Realität) -> Warnung
  last_movement_id bigint,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, product_id),
  FOREIGN KEY (tenant_id, store_id)   REFERENCES app.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES app.products(tenant_id, id)
);
CREATE INDEX ON app.store_stock (tenant_id, store_id);

-- Unveränderliches Bewegungsjournal (revisionssicher). Korrekturen = Gegenbuchung.
-- Bei großem Volumen: monatliche Partitionierung nach occurred_at.
CREATE TABLE app.stock_movements (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,  -- dient auch als Sync-Cursor
  tenant_id      uuid NOT NULL,
  store_id       uuid NOT NULL,
  product_id     uuid NOT NULL,
  lot_id         uuid,
  type           app.movement_type NOT NULL,
  quantity_delta numeric(14,3) NOT NULL CHECK (quantity_delta <> 0),
  unit_cost      bigint,                         -- Einstandspreis in Minor Units (für Bewertung)
  reason         text,                           -- Pflicht bei loss/adjustment (siehe CHECK)
  ref_type       text,                           -- 'sale' | 'document' | 'purchase_order' | 'transfer' | 'count'
  ref_id         uuid,
  client_op_id   uuid NOT NULL,                  -- vom Gerät erzeugt (UUID v7) -> Idempotenz
  device_id      uuid,
  user_id        uuid NOT NULL,
  occurred_at    timestamptz NOT NULL,           -- Zeitpunkt auf dem Gerät (offline!)
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, client_op_id),
  FOREIGN KEY (tenant_id, store_id)   REFERENCES app.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES app.products(tenant_id, id),
  FOREIGN KEY (tenant_id, lot_id)     REFERENCES app.stock_lots(tenant_id, id),
  -- Vorzeichen passend zum Typ erzwingen
  CHECK (
    (type IN ('purchase_receipt', 'customer_return', 'transfer_in') AND quantity_delta > 0) OR
    (type IN ('sale', 'supplier_return', 'loss', 'transfer_out')    AND quantity_delta < 0) OR
    (type IN ('adjustment', 'inventory_count'))
  ),
  CHECK (type NOT IN ('loss', 'adjustment') OR reason IS NOT NULL)
);
CREATE INDEX ON app.stock_movements (tenant_id, store_id, id);
CREATE INDEX ON app.stock_movements (tenant_id, product_id, occurred_at);

-- Journal-Trigger: Bestand + Charge fortschreiben (läuft in derselben Transaktion)
CREATE FUNCTION app.apply_stock_movement() RETURNS trigger
  LANGUAGE plpgsql AS
$$
BEGIN
  INSERT INTO app.store_stock AS s (tenant_id, store_id, product_id, quantity, last_movement_id, updated_at)
  VALUES (NEW.tenant_id, NEW.store_id, NEW.product_id, NEW.quantity_delta, NEW.id, now())
  ON CONFLICT (store_id, product_id) DO UPDATE
    SET quantity         = s.quantity + EXCLUDED.quantity,
        last_movement_id = EXCLUDED.last_movement_id,
        updated_at       = now();

  IF NEW.lot_id IS NOT NULL THEN
    UPDATE app.stock_lots
       SET quantity = quantity + NEW.quantity_delta
     WHERE id = NEW.lot_id AND tenant_id = NEW.tenant_id;
  END IF;

  -- Outbox-Event für Echtzeit-Verteilung (Worker -> Redis -> WebSocket)
  INSERT INTO app.outbox_events (tenant_id, store_id, topic, payload)
  VALUES (NEW.tenant_id, NEW.store_id, 'stock.changed',
          jsonb_build_object('movementId', NEW.id, 'productId', NEW.product_id,
                             'delta', NEW.quantity_delta, 'type', NEW.type));
  RETURN NEW;
END
$$;

-- Journal ist append-only
CREATE FUNCTION app.forbid_mutation() RETURNS trigger
  LANGUAGE plpgsql AS
$$
BEGIN
  RAISE EXCEPTION '% ist unveränderlich – Korrektur nur per Gegenbuchung', TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END
$$;

-- =============================================================================
--  EINKAUF: Bestellungen und eingelesene Belege
-- =============================================================================
CREATE TABLE app.purchase_orders (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  store_id     uuid NOT NULL,
  supplier_id  uuid NOT NULL,
  number       text NOT NULL,
  status       app.po_status NOT NULL DEFAULT 'draft',
  currency     char(3) NOT NULL DEFAULT 'TND',
  expected_at  date,
  created_by   uuid NOT NULL,
  approved_by  uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, store_id)    REFERENCES app.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES app.suppliers(tenant_id, id)
);

CREATE TABLE app.purchase_order_lines (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  purchase_order_id uuid NOT NULL,
  product_id        uuid NOT NULL,
  quantity_ordered  numeric(14,3) NOT NULL CHECK (quantity_ordered > 0),
  quantity_received numeric(14,3) NOT NULL DEFAULT 0,
  unit_price        bigint,
  FOREIGN KEY (tenant_id, purchase_order_id) REFERENCES app.purchase_orders(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, product_id)        REFERENCES app.products(tenant_id, id)
);

-- Eingelesene Rechnungen/Lieferscheine (Original unveränderlich im Dateispeicher)
CREATE TABLE app.documents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  store_id        uuid NOT NULL,
  kind            app.document_kind NOT NULL,
  source          app.document_source NOT NULL,
  status          app.document_status NOT NULL DEFAULT 'uploaded',
  supplier_id     uuid,
  purchase_order_id uuid,
  document_number text,
  document_date   date,
  currency        char(3) NOT NULL DEFAULT 'TND',
  net_total       bigint,
  tax_total       bigint,
  stamp_duty      bigint,                        -- Droit de timbre (TN) auf Rechnungen
  gross_total     bigint,
  file_key        text NOT NULL,                 -- Object-Storage-Schlüssel des Originals
  file_sha256     bytea NOT NULL,                -- Integritätsnachweis, Original unveränderlich
  ttn_reference   text,                          -- eindeutige Kennung der Rechnung bei TTN
  extraction      jsonb,                         -- Roh-Ergebnis Parser/KI inkl. Konfidenzen
  issues          jsonb NOT NULL DEFAULT '[]',   -- Plausibilitätswarnungen
  uploaded_by     uuid NOT NULL,
  reviewed_by     uuid,
  booked_at       timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, store_id)          REFERENCES app.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id)       REFERENCES app.suppliers(tenant_id, id),
  FOREIGN KEY (tenant_id, purchase_order_id) REFERENCES app.purchase_orders(tenant_id, id)
);
-- Dublettenschutz: dieselbe Rechnungsnummer eines Lieferanten nur einmal buchen
CREATE UNIQUE INDEX documents_no_duplicates
  ON app.documents (tenant_id, supplier_id, kind, document_number)
  WHERE status <> 'rejected' AND document_number IS NOT NULL;

CREATE TABLE app.document_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  document_id    uuid NOT NULL,
  line_no        int NOT NULL,
  raw_text       text,
  gtin           text,
  supplier_sku   text,
  product_id     uuid,                           -- NULL = noch nicht zugeordnet
  match_method   text CHECK (match_method IN ('gtin', 'supplier_sku', 'fuzzy', 'manual')),
  match_confidence real,
  quantity       numeric(14,3),
  unit_price     bigint,
  tax_rate_bp    int,
  line_total     bigint,
  expiry_date    date,
  UNIQUE (document_id, line_no),
  FOREIGN KEY (tenant_id, document_id) REFERENCES app.documents(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, product_id)  REFERENCES app.products(tenant_id, id)
);

-- =============================================================================
--  KASSE: Verkäufe, Positionen, Zahlungen, Fiskal-Modul
-- =============================================================================
CREATE TABLE app.sales (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  store_id         uuid NOT NULL,
  device_id        uuid NOT NULL,
  receipt_number   bigint NOT NULL,              -- fortlaufend je Kasse
  status           app.sale_status NOT NULL DEFAULT 'open',
  currency         char(3) NOT NULL DEFAULT 'TND',
  net_total        bigint NOT NULL DEFAULT 0,
  tax_total        bigint NOT NULL DEFAULT 0,
  gross_total      bigint NOT NULL DEFAULT 0,
  discount_total   bigint NOT NULL DEFAULT 0,
  discount_approved_by uuid,                     -- Filialleiter-Freigabe über Limit
  cashier_id       uuid NOT NULL,
  client_op_id     uuid NOT NULL,                -- Idempotenz für Offline-Sync
  voids_sale_id    uuid,                         -- Storno verweist auf Original
  -- Fiskal-Modul (länderspezifisch; TN: zertifizierte Kasse/DGI, falls für die Branche
  -- vorgeschrieben). Generisch gehalten, damit ein zertifiziertes Modul andocken kann.
  fiscal_provider  text,
  fiscal_reference text,                         -- Transaktions-/Signaturnummer des Moduls
  fiscal_payload   jsonb,                        -- vollständige Antwort des Fiskal-Moduls
  fiscal_failure   boolean NOT NULL DEFAULT false,
  started_at       timestamptz NOT NULL,
  completed_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, client_op_id),
  UNIQUE (device_id, receipt_number),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, store_id)  REFERENCES app.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES app.devices(tenant_id, id),
  FOREIGN KEY (tenant_id, voids_sale_id) REFERENCES app.sales(tenant_id, id)
);
CREATE INDEX ON app.sales (tenant_id, store_id, completed_at);

CREATE TABLE app.sale_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  sale_id        uuid NOT NULL,
  line_no        int NOT NULL,
  product_id     uuid NOT NULL,
  product_name   text NOT NULL,                  -- Snapshot zum Verkaufszeitpunkt
  quantity       numeric(14,3) NOT NULL,
  unit_price     bigint NOT NULL,                -- brutto, Minor Units
  discount       bigint NOT NULL DEFAULT 0,
  tax_rate_bp    int NOT NULL,
  line_total     bigint NOT NULL,
  UNIQUE (sale_id, line_no),
  FOREIGN KEY (tenant_id, sale_id)    REFERENCES app.sales(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, product_id) REFERENCES app.products(tenant_id, id)
);

CREATE TABLE app.payments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  sale_id     uuid NOT NULL,
  method      app.payment_method NOT NULL,
  amount      bigint NOT NULL,
  currency    char(3) NOT NULL DEFAULT 'TND',
  terminal_ref text,                             -- Referenz des Kartenterminals
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, sale_id) REFERENCES app.sales(tenant_id, id) ON DELETE CASCADE
);

-- =============================================================================
--  INFRASTRUKTUR: Outbox (Echtzeit), Audit-Log
-- =============================================================================
CREATE TABLE app.outbox_events (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id    uuid NOT NULL,
  store_id     uuid,
  topic        text NOT NULL,
  payload      jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX outbox_unpublished ON app.outbox_events (id) WHERE published_at IS NULL;

CREATE TABLE app.audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id   uuid NOT NULL,
  user_id     uuid,
  device_id   uuid,
  action      text NOT NULL,                     -- 'user.create', 'price.update', 'sale.void' …
  entity_type text,
  entity_id   uuid,
  before      jsonb,
  after       jsonb,
  ip          inet,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON app.audit_log (tenant_id, created_at);

-- =============================================================================
--  TRIGGER
-- =============================================================================
CREATE TRIGGER stock_movements_apply AFTER INSERT ON app.stock_movements
  FOR EACH ROW EXECUTE FUNCTION app.apply_stock_movement();
CREATE TRIGGER stock_movements_immutable BEFORE UPDATE OR DELETE ON app.stock_movements
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON app.audit_log
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenants','stores','users','suppliers','products',
                           'purchase_orders','documents']
  LOOP
    EXECUTE format('CREATE TRIGGER %I_touch BEFORE UPDATE ON app.%I
                    FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at()', t, t);
  END LOOP;
END $$;

-- =============================================================================
--  ROW-LEVEL-SECURITY
-- =============================================================================
-- 1) Mandanten-Tabellen: nur eigener Mandant
ALTER TABLE app.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.tenants FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON app.tenants
  USING (id = app.current_tenant_id())
  WITH CHECK (id = app.current_tenant_id() AND app.current_role() = 'owner');

DO $$
DECLARE t text;
BEGIN
  -- Tabellen, die mandantenweit (nicht filialgebunden) sichtbar sind
  FOREACH t IN ARRAY ARRAY['stores','users','categories','suppliers','products',
                           'product_barcodes','supplier_products','refresh_tokens',
                           'audit_log','outbox_events']
  LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON app.%I
                      USING (tenant_id = app.current_tenant_id())
                      WITH CHECK (tenant_id = app.current_tenant_id())$p$, t);
  END LOOP;

  -- Tabellen mit store_id: Mandant UND zugewiesene Filiale
  FOREACH t IN ARRAY ARRAY['user_store_access','devices','store_products','stock_lots',
                           'store_stock','purchase_orders','documents','sales']
  LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_store_isolation ON app.%I
                      USING (tenant_id = app.current_tenant_id() AND app.has_store_access(store_id))
                      WITH CHECK (tenant_id = app.current_tenant_id() AND app.has_store_access(store_id))$p$, t);
  END LOOP;

  -- Kindtabellen ohne eigene store_id: Mandant (Filialprüfung erfolgt über Elternzeile)
  FOREACH t IN ARRAY ARRAY['purchase_order_lines','document_lines','sale_lines','payments']
  LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON app.%I
                      USING (tenant_id = app.current_tenant_id())
                      WITH CHECK (tenant_id = app.current_tenant_id())$p$, t);
  END LOOP;
END $$;

-- 2) Bestandsjournal: Lesen je Filiale; Schreiben rollenabhängig (Defense in Depth)
ALTER TABLE app.stock_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.stock_movements FORCE  ROW LEVEL SECURITY;
CREATE POLICY movements_read ON app.stock_movements FOR SELECT
  USING (tenant_id = app.current_tenant_id() AND app.has_store_access(store_id));
CREATE POLICY movements_insert ON app.stock_movements FOR INSERT
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    AND app.has_store_access(store_id)
    AND user_id = app.current_user_id()
    -- Kassierer dürfen ausschließlich Verkäufe und Kundenrückgaben buchen
    AND (app.current_role() <> 'cashier' OR type IN ('sale', 'customer_return'))
  );

-- 3) Global lesbare Kataloge (keine Mandantendaten)
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['permissions','role_permissions','currencies','tax_rates'] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY read_all ON app.%I FOR SELECT USING (true)', t);
  END LOOP;
END $$;

-- =============================================================================
--  LOGIN-HILFE (vor Login ist noch kein Mandantenkontext gesetzt)
--  SECURITY DEFINER, gibt nur das Nötigste zurück; Passwortprüfung in der API.
-- =============================================================================
CREATE FUNCTION auth.find_login_user(p_tenant_slug text, p_email citext)
  RETURNS TABLE (user_id uuid, tenant_id uuid, role app.user_role,
                 password_hash text, totp_required boolean, is_active boolean)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = app, pg_temp AS
$$
  SELECT u.id, u.tenant_id, u.role, u.password_hash,
         (u.role IN ('owner', 'manager')) AS totp_required, u.is_active
    FROM app.users u
    JOIN app.tenants t ON t.id = u.tenant_id
   -- lower() statt citext-Operator: der Suchpfad enthält bewusst kein 'public'
   WHERE t.slug = p_tenant_slug AND lower(u.email::text) = lower(p_email::text)
$$;

-- Filialzuordnungen für den Guard (nach erfolgreicher Authentifizierung)
CREATE FUNCTION auth.user_store_ids(p_tenant_id uuid, p_user_id uuid)
  RETURNS uuid[]
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = app, pg_temp AS
$$
  SELECT coalesce(array_agg(store_id), '{}')
    FROM app.user_store_access
   WHERE tenant_id = p_tenant_id AND user_id = p_user_id
$$;

-- =============================================================================
--  BERECHTIGUNGEN
-- =============================================================================
ALTER TABLE app.tenants              OWNER TO app_owner;
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'app' LOOP
    EXECUTE format('ALTER TABLE app.%I OWNER TO app_owner', r.tablename);
  END LOOP;
END $$;
ALTER FUNCTION auth.find_login_user(text, citext) OWNER TO app_owner;
ALTER FUNCTION auth.user_store_ids(uuid, uuid)   OWNER TO app_owner;

GRANT USAGE ON SCHEMA app, auth TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA app TO app_user;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app, auth TO app_user;
-- Journal und Audit: nur anhängen und lesen
REVOKE UPDATE, DELETE ON app.stock_movements, app.audit_log FROM app_user;
-- Rechte-Katalog ist nur für Migrationen änderbar
REVOKE INSERT, UPDATE, DELETE ON app.permissions, app.role_permissions, app.currencies, app.tax_rates FROM app_user;

-- =============================================================================
--  KATALOGE (Seed) – Steuersätze vor Go-live mit Steuerberater abgleichen
-- =============================================================================
INSERT INTO app.currencies (code, minor_unit, symbol) VALUES
  ('TND', 3, 'د.ت'), ('EUR', 2, '€'), ('USD', 2, '$');

INSERT INTO app.tax_rates (country_code, rate_bp, label) VALUES
  ('TN', 1900, '{"fr": "TVA 19 %", "ar": "أداء على القيمة المضافة 19%", "en": "VAT 19%"}'),
  ('TN', 1300, '{"fr": "TVA 13 %", "ar": "أداء على القيمة المضافة 13%", "en": "VAT 13%"}'),
  ('TN',  700, '{"fr": "TVA 7 %",  "ar": "أداء على القيمة المضافة 7%",  "en": "VAT 7%"}'),
  ('TN',    0, '{"fr": "Exonéré",  "ar": "معفى",                         "en": "Exempt"}');

-- =============================================================================
--  RECHTE-KATALOG (Seed)
-- =============================================================================
INSERT INTO app.permissions (code, description) VALUES
  ('tenant.settings',     'Mandanten-, Steuer- und Fiskal-Einstellungen'),
  ('user.manage',         'Benutzer anlegen, Rollen zuweisen'),
  ('report.finance',      'Finanzberichte, Margen, Einkaufspreise'),
  ('report.stock',        'Bestandsberichte'),
  ('product.write',       'Produkte anlegen und bearbeiten'),
  ('price.update',        'Verkaufspreise ändern'),
  ('stock.receive',       'Wareneingang buchen'),
  ('stock.adjust',        'Bestandskorrektur, Verlust, Inventur'),
  ('stock.read',          'Bestände einsehen'),
  ('purchase.order',      'Lieferantenbestellungen anlegen/senden'),
  ('document.scan',       'Belege einlesen und prüfen'),
  ('sale.create',         'Verkäufe abwickeln, Bon drucken'),
  ('sale.void',           'Storno'),
  ('discount.approve',    'Rabatte über Kassierer-Limit freigeben'),
  ('export.accounting',   'CSV/Excel- und Steuer-Exporte'),
  ('device.manage',       'Geräte koppeln und sperren');

INSERT INTO app.role_permissions (role, permission_code, store_scoped)
SELECT 'owner', code, false FROM app.permissions;

INSERT INTO app.role_permissions (role, permission_code) VALUES
  ('manager', 'user.manage'), ('manager', 'report.finance'), ('manager', 'report.stock'),
  ('manager', 'product.write'), ('manager', 'price.update'), ('manager', 'stock.receive'),
  ('manager', 'stock.adjust'), ('manager', 'stock.read'), ('manager', 'purchase.order'),
  ('manager', 'document.scan'), ('manager', 'sale.create'), ('manager', 'sale.void'),
  ('manager', 'discount.approve'), ('manager', 'export.accounting'), ('manager', 'device.manage'),
  ('stock_clerk', 'product.write'), ('stock_clerk', 'stock.receive'), ('stock_clerk', 'stock.adjust'),
  ('stock_clerk', 'stock.read'), ('stock_clerk', 'document.scan'),
  ('cashier', 'sale.create'), ('cashier', 'stock.read');

-- Mandantenweite Rechte des Filialleiters (Produkte gelten für alle Filialen)
UPDATE app.role_permissions SET store_scoped = false
 WHERE role IN ('manager', 'stock_clerk') AND permission_code = 'product.write';

-- =============================================================================
--  VIEWS für das Dashboard (RLS wirkt durch, da security_invoker)
-- =============================================================================
CREATE VIEW app.v_low_stock WITH (security_invoker = true) AS
SELECT s.tenant_id, s.store_id, s.product_id, p.sku,
       coalesce(p.name->>'fr', p.name->>'ar', p.name->>'en') AS name,
       s.quantity, coalesce(sp.min_stock, p.min_stock) AS min_stock
  FROM app.store_stock s
  JOIN app.products p        ON p.id = s.product_id
  LEFT JOIN app.store_products sp ON sp.store_id = s.store_id AND sp.product_id = s.product_id
 WHERE s.quantity <= coalesce(sp.min_stock, p.min_stock);

CREATE VIEW app.v_expiring_lots WITH (security_invoker = true) AS
SELECT l.tenant_id, l.store_id, l.product_id, p.sku,
       coalesce(p.name->>'fr', p.name->>'ar', p.name->>'en') AS name,
       l.lot_number, l.expiry_date, l.quantity,
       (l.expiry_date - current_date) AS days_left
  FROM app.stock_lots l
  JOIN app.products p ON p.id = l.product_id
 WHERE l.quantity > 0 AND l.expiry_date IS NOT NULL
   AND l.expiry_date <= current_date + 7;

ALTER VIEW app.v_low_stock      OWNER TO app_owner;
ALTER VIEW app.v_expiring_lots  OWNER TO app_owner;
GRANT SELECT ON app.v_low_stock, app.v_expiring_lots TO app_user;

COMMIT;
