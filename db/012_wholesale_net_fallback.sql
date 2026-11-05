-- =============================================================================
--  012 – Großhandelspreis ohne Preisliste (T-118, Entscheidung Ahmed: Variante a)
--  products.sale_price ist brutto (TTC); Aufträge rechnen netto (HT). Ohne Preisliste wird
--  der Nettopreis aus dem Bruttopreis zurückgerechnet, sonst käme die TVA doppelt hinzu.
-- =============================================================================
BEGIN;

CREATE OR REPLACE FUNCTION app.price_for(p_customer_id uuid, p_product_id uuid, p_qty numeric, p_on date DEFAULT current_date)
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
    (SELECT round(p.sale_price * 10000.0 / (10000 + p.tax_rate_bp))::bigint FROM app.products p WHERE p.id = p_product_id)
  )
$$;

COMMIT;
