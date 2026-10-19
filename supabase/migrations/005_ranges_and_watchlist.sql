-- Every store's full product range (for search), and each family's private watchlist.
--
-- store_products: one row per product at each store with its current shelf price and special, written once a week
-- by the Mac's refresh (with the secret key, which bypasses row-level security). Store data only: nothing about
-- any family. Signed-in people can read and search it; nobody can change it from the app.
--
-- family_watchlist: the family's watchlist as the app shows it (items, Core / Regulars groups, matched products and
-- signals), built on the Mac from our private files. Only that family's members can read it.

create extension if not exists pg_trgm with schema extensions;

create table public.store_products (
  chain text not null check (chain in ('woolworths', 'coles', 'aldi', 'costco', 'chemistwarehouse')),
  product_id text not null,
  name text not null,
  brand text,
  size_text text,
  category text,
  url text,
  image text,
  price_cents int,
  price_per text not null default 'each' check (price_per in ('each', 'kg')),
  unit_cents numeric,
  unit_per text,
  store_unit_text text,
  was_cents int,
  rrp_cents int,
  special boolean not null default false,
  special_type text,
  promo text,
  multibuy jsonb,
  valid_from timestamptz,
  valid_to timestamptz,
  valid_to_assumed boolean not null default false,
  basis text,
  in_stock boolean,
  seen_at timestamptz not null,
  -- Words to search: name, brand, size and the store's name ("aldi milk" works).
  search tsvector generated always as (to_tsvector('simple',
    coalesce(name, '') || ' ' || coalesce(brand, '') || ' ' || coalesce(size_text, '') || ' ' ||
    case chain when 'woolworths' then 'woolworths woolies' when 'chemistwarehouse' then 'chemist warehouse'
               else chain end)) stored,
  primary key (chain, product_id)
);
create index store_products_search on public.store_products using gin (search);
create index store_products_name_trgm on public.store_products using gin (lower(name) extensions.gin_trgm_ops);
create index store_products_seen on public.store_products (chain, seen_at);

alter table public.store_products enable row level security;
create policy "signed-in people read store products" on public.store_products for select to authenticated using (true);
revoke insert, update, delete, truncate on public.store_products from anon, authenticated;
revoke select on public.store_products from anon;

-- Search every store's range. Each word must start a word in the product (name, brand, size or store), best
-- matches first, specials before normal prices. If nothing matches that way, close spellings are tried.
create function public.search_products(p_query text, p_chains text[] default null, p_limit int default 40)
returns setof public.store_products
language plpgsql stable security invoker set search_path = '' as $$
declare
  words text[];
  q tsquery;
  lim int := least(greatest(coalesce(p_limit, 40), 1), 100);
  found int := 0;
begin
  select array_agg(w) into words
    from unnest(regexp_split_to_array(lower(coalesce(p_query, '')), '[^[:alnum:]]+')) w where w <> '';
  if words is null then
    return;
  end if;
  q := to_tsquery('simple', array_to_string(array(select w || ':*' from unnest(words) w), ' & '));
  return query
    select p.* from public.store_products p
    where p.search @@ q and (p_chains is null or p.chain = any (p_chains))
    order by ts_rank_cd(p.search, q) desc, p.special desc, p.price_cents nulls last
    limit lim;
  get diagnostics found = row_count;
  if found = 0 then
    return query
      select p.* from public.store_products p
      where lower(p_query) operator(extensions.<%) lower(p.name)
        and (p_chains is null or p.chain = any (p_chains))
      order by extensions.word_similarity(lower(p_query), lower(p.name)) desc, p.special desc
      limit lim;
  end if;
end $$;
revoke all on function public.search_products(text, text[], int) from public;
grant execute on function public.search_products(text, text[], int) to authenticated;

-- A few products by id ('woolworths:123'), for prices of products the family added to its watchlist.
create function public.products_by_id(p_ids text[])
returns setof public.store_products
language sql stable security invoker set search_path = '' as $$
  select p.* from public.store_products p
  where p.chain || ':' || p.product_id = any (p_ids[1:200])
$$;
revoke all on function public.products_by_id(text[]) from public;
grant execute on function public.products_by_id(text[]) to authenticated;

create table public.family_watchlist (
  family_id uuid primary key references public.families (id) on delete cascade,
  data jsonb not null,
  generated_at timestamptz not null
);
alter table public.family_watchlist enable row level security;
create policy "members read their family's watchlist" on public.family_watchlist
  for select to authenticated using (family_id = (select private.my_family_id()));
revoke insert, update, delete, truncate on public.family_watchlist from anon, authenticated;
revoke select on public.family_watchlist from anon;

-- The person's family watchlist: null when they're not in a family or it hasn't been built yet. If the app's copy
-- is already the latest (p_since), only the date comes back, to save downloading it again.
create function public.my_watchlist(p_since timestamptz default null) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select case when p_since is not null and w.generated_at <= p_since
              then jsonb_build_object('generated_at', w.generated_at, 'unchanged', true)
              else jsonb_build_object('generated_at', w.generated_at, 'data', w.data) end
  from public.family_watchlist w where w.family_id = (select private.my_family_id())
$$;
revoke all on function public.my_watchlist(timestamptz) from public;
grant execute on function public.my_watchlist(timestamptz) to authenticated;
