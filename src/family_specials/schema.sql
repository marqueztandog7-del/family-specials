-- Family Specials Finder database schema.
-- Prices are stored in integer cents; store-reported unit prices are dollars (REAL).
-- Timestamps are UTC ISO-8601 strings ("2026-10-05T03:15:00Z").

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL
);

-- One row for now (our household). Watchlists and preferences will hang off this.
CREATE TABLE IF NOT EXISTS households (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  postcode TEXT,
  created_at TEXT NOT NULL
);

-- A specific store whose prices we record (or a chain's online/national price list).
CREATE TABLE IF NOT EXISTS stores (
  id INTEGER PRIMARY KEY,
  chain TEXT NOT NULL,              -- woolworths | coles | aldi | costco | chemistwarehouse | tongli
  store_ref TEXT NOT NULL,          -- the retailer's own store id, e.g. '0883', 'G449', 'online'
  name TEXT NOT NULL,
  suburb TEXT,
  postcode TEXT,
  price_scope TEXT NOT NULL,        -- store | default_online_store | online_national | manual
  notes TEXT,
  UNIQUE (chain, store_ref)
);

-- One row per retailer SKU, keyed on the retailer's own product id (never the name).
CREATE TABLE IF NOT EXISTS retailer_products (
  id INTEGER PRIMARY KEY,
  chain TEXT NOT NULL,
  retailer_product_id TEXT NOT NULL,
  name TEXT NOT NULL,               -- raw name exactly as the store writes it
  display_name TEXT,
  brand TEXT,
  size_text TEXT,                   -- the store's own size text
  url TEXT,
  image_url TEXT,
  category_path TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE (chain, retailer_product_id)
);

-- Barcodes. A product can have several; normalised to 14 digits, check digit validated.
CREATE TABLE IF NOT EXISTS retailer_product_gtins (
  retailer_product_id INTEGER NOT NULL REFERENCES retailer_products(id),
  gtin14 TEXT NOT NULL,
  gtin_raw TEXT NOT NULL,
  is_global INTEGER NOT NULL,       -- 0 = in-store / variable-weight code: never match across stores
  source TEXT NOT NULL,             -- listing | product_page | supplier_content | manual
  first_seen_at TEXT NOT NULL,
  PRIMARY KEY (retailer_product_id, gtin14)
);
CREATE INDEX IF NOT EXISTS idx_gtins_gtin14 ON retailer_product_gtins(gtin14);

-- Other names for a product (e.g. receipt abbreviations). Names are never unique.
CREATE TABLE IF NOT EXISTS product_aliases (
  id INTEGER PRIMARY KEY,
  retailer_product_id INTEGER NOT NULL REFERENCES retailer_products(id),
  alias TEXT NOT NULL,
  source TEXT NOT NULL,             -- receipt | purchase_history | manual
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_aliases_product ON product_aliases(retailer_product_id);

-- The store's raw product data (descriptive fields), saved only when it changes,
-- so products can be re-parsed later without re-fetching.
CREATE TABLE IF NOT EXISTS raw_snapshots (
  id INTEGER PRIMARY KEY,
  retailer_product_id INTEGER NOT NULL REFERENCES retailer_products(id),
  content_hash TEXT NOT NULL,
  payload BLOB NOT NULL,            -- zlib-compressed JSON
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE (retailer_product_id, content_hash)
);

-- What our parser understood from the name/size. Re-parsed when the parser version changes.
CREATE TABLE IF NOT EXISTS product_attributes (
  retailer_product_id INTEGER PRIMARY KEY REFERENCES retailer_products(id),
  parser_version INTEGER NOT NULL,
  brand TEXT,
  own_brand INTEGER,                -- 1 own brand, 0 not, NULL unknown
  size_quantity REAL,               -- quantity of one unit, e.g. 600 (mL)
  size_unit TEXT,                   -- g | ml | each
  pack_count INTEGER,               -- e.g. 24 for "24 x 600mL"
  total_quantity REAL,              -- in base units: g, ml or each
  base_unit TEXT,                   -- g | ml | each
  count_noun TEXT,                  -- for "each" units: pack, roll, sheet, tablet, egg ...
  comparable INTEGER NOT NULL,      -- 1 if the size was read reliably
  not_comparable_reason TEXT,
  item_type TEXT,                   -- Phase 2
  variant TEXT,                     -- Phase 2
  active_ingredient TEXT,           -- Phase 2 (medicines)
  strength TEXT,                    -- Phase 2 (medicines)
  parsed_at TEXT NOT NULL
);

-- Every collector run, per chain.
CREATE TABLE IF NOT EXISTS collection_runs (
  id INTEGER PRIMARY KEY,
  chain TEXT NOT NULL,
  kind TEXT NOT NULL,               -- specials | category | manual
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,             -- running | ok | partial | blocked | error
  requests_made INTEGER NOT NULL DEFAULT 0,
  items_seen INTEGER NOT NULL DEFAULT 0,
  observations_added INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  run_where TEXT,                   -- github | mac (where the run happened)
  published INTEGER NOT NULL DEFAULT 0  -- 1 once written to the repo's history files (or imported from them)
);
CREATE INDEX IF NOT EXISTS idx_runs_chain ON collection_runs(chain, kind, started_at);

-- Which store pages each run actually read, so "not seen" is never mistaken for "not on special".
CREATE TABLE IF NOT EXISTS run_coverage (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES collection_runs(id),
  scope_type TEXT NOT NULL,         -- specials_group | category | promotion_date | manual_import
  scope_ref TEXT NOT NULL,
  scope_name TEXT,
  pages_read INTEGER NOT NULL,
  pages_total INTEGER,
  items_seen INTEGER NOT NULL,
  items_total INTEGER,
  complete INTEGER NOT NULL
);

-- Append-only price history. Never updated or deleted.
CREATE TABLE IF NOT EXISTS price_observations (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES collection_runs(id),
  retailer_product_id INTEGER NOT NULL REFERENCES retailer_products(id),
  store_id INTEGER NOT NULL REFERENCES stores(id),
  observed_at TEXT NOT NULL,
  source TEXT NOT NULL,             -- specials | category | manual | watch_refresh
  price_basis TEXT NOT NULL,        -- in_store | online | online_incl_delivery
  price_per TEXT NOT NULL,          -- each | kg
  price_cents INTEGER,              -- NULL when the store shows no price
  was_cents INTEGER,
  rrp_cents INTEGER,
  is_special INTEGER NOT NULL,
  special_type TEXT,                -- half_price | price_drop | multibuy | catalogue | special_buy | clearance | ...
  promo_text TEXT,
  multibuy_qty INTEGER,
  multibuy_cents INTEGER,           -- total price for multibuy_qty items
  member_only INTEGER NOT NULL DEFAULT 0,
  member_price_cents INTEGER,
  unit_price REAL,                  -- as the store reports it (dollars)
  unit_measure TEXT,                -- as the store reports it, e.g. '100G', '1L', '1EA'
  unit_price_text TEXT,
  valid_from TEXT,
  valid_to TEXT,
  valid_to_source TEXT,             -- store | catalogue | weekly_cycle_assumed | manual
  in_stock INTEGER,                 -- NULL when the store doesn't say
  raw_price_z BLOB                  -- the store's raw price/promo fields, zlib-compressed JSON
);
CREATE INDEX IF NOT EXISTS idx_obs_product ON price_observations(retailer_product_id, store_id, observed_at);
CREATE INDEX IF NOT EXISTS idx_obs_run ON price_observations(run_id);
CREATE INDEX IF NOT EXISTS idx_obs_special ON price_observations(is_special, observed_at);

-- Store category trees, discovered from each store, used to choose tracked categories.
CREATE TABLE IF NOT EXISTS store_categories (
  chain TEXT NOT NULL,
  category_ref TEXT NOT NULL,
  name TEXT NOT NULL,
  path TEXT,
  url_path TEXT,
  product_count INTEGER,
  discovered_at TEXT NOT NULL,
  PRIMARY KEY (chain, category_ref)
);

-- Full-text search over product names and brands.
CREATE VIRTUAL TABLE IF NOT EXISTS product_search USING fts5(
  name, brand, size_text,
  content='retailer_products', content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS retailer_products_ai AFTER INSERT ON retailer_products BEGIN
  INSERT INTO product_search(rowid, name, brand, size_text) VALUES (new.id, new.name, new.brand, new.size_text);
END;
CREATE TRIGGER IF NOT EXISTS retailer_products_ad AFTER DELETE ON retailer_products BEGIN
  INSERT INTO product_search(product_search, rowid, name, brand, size_text) VALUES ('delete', old.id, old.name, old.brand, old.size_text);
END;
CREATE TRIGGER IF NOT EXISTS retailer_products_au AFTER UPDATE OF name, brand, size_text ON retailer_products BEGIN
  INSERT INTO product_search(product_search, rowid, name, brand, size_text) VALUES ('delete', old.id, old.name, old.brand, old.size_text);
  INSERT INTO product_search(rowid, name, brand, size_text) VALUES (new.id, new.name, new.brand, new.size_text);
END;
