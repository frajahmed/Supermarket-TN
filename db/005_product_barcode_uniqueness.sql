-- =============================================================================
--  Migration 005: Produkt-API – Barcode-Eindeutigkeit und GTIN-Suche
--
--  product_barcodes und product_packagings sind bereits Teil des Großhandels-
--  schemas. Ein Barcode darf aber auch zwischen beiden Tabellen je Mandant nur
--  einmal vorkommen. Der transaktionale Advisory-Lock verhindert dabei Race
--  Conditions zwischen zwei gleichzeitigen Schreibvorgängen.
-- =============================================================================
BEGIN;

CREATE INDEX product_packagings_gtin_lookup
  ON app.product_packagings (tenant_id, gtin)
  WHERE gtin IS NOT NULL;

CREATE UNIQUE INDEX product_packagings_gtin_unique
  ON app.product_packagings (tenant_id, gtin)
  WHERE gtin IS NOT NULL;

CREATE INDEX products_sku_trgm
  ON app.products USING gin (sku gin_trgm_ops);

CREATE OR REPLACE FUNCTION app.ensure_product_barcode_unique()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  barcode text;
BEGIN
  barcode := CASE
    WHEN TG_TABLE_NAME = 'product_barcodes' THEN to_jsonb(NEW)->>'code'
    ELSE to_jsonb(NEW)->>'gtin'
  END;

  IF barcode IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended(
        NEW.tenant_id::text || ':' || barcode,
        0
      )
    );

    IF TG_TABLE_NAME = 'product_barcodes'
       AND EXISTS (
         SELECT 1 FROM app.product_packagings
          WHERE tenant_id = NEW.tenant_id AND gtin = barcode
       ) THEN
      RAISE EXCEPTION 'Barcode ist im Mandanten bereits vergeben'
        USING ERRCODE = 'unique_violation';
    ELSIF TG_TABLE_NAME = 'product_packagings'
       AND EXISTS (
         SELECT 1 FROM app.product_barcodes
          WHERE tenant_id = NEW.tenant_id AND code = barcode
       ) THEN
      RAISE EXCEPTION 'Barcode ist im Mandanten bereits vergeben'
        USING ERRCODE = 'unique_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

ALTER FUNCTION app.ensure_product_barcode_unique() OWNER TO app_owner;

CREATE TRIGGER product_barcodes_unique_trigger
  BEFORE INSERT OR UPDATE OF code, tenant_id ON app.product_barcodes
  FOR EACH ROW EXECUTE FUNCTION app.ensure_product_barcode_unique();

CREATE TRIGGER product_packagings_unique_trigger
  BEFORE INSERT OR UPDATE OF gtin, tenant_id ON app.product_packagings
  FOR EACH ROW EXECUTE FUNCTION app.ensure_product_barcode_unique();

COMMIT;
