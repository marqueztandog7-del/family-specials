-- Search that forgives more: when no product has every word, try close spellings ("dsh clth" -> dish cloth),
-- then products with most of the words ("voltaren emulgel" -> Chemist Warehouse's "Voltaren Pain Relief Gel").

create or replace function public.search_products(p_query text, p_chains text[] default null, p_limit int default 40)
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
  -- 1. Every word starts a word in the product.
  q := to_tsquery('simple', array_to_string(array(select w || ':*' from unnest(words) w), ' & '));
  return query
    select p.* from public.store_products p
    where p.search @@ q and (p_chains is null or p.chain = any (p_chains))
    order by ts_rank_cd(p.search, q) desc, p.special desc, p.price_cents nulls last
    limit lim;
  get diagnostics found = row_count;
  if found > 0 then
    return;
  end if;
  -- 2. Close spellings (a word similarity of 0.45 or more).
  return query
    select p.* from public.store_products p
    where extensions.word_similarity(lower(p_query), lower(p.name)) >= 0.45
      and (p_chains is null or p.chain = any (p_chains))
    order by extensions.word_similarity(lower(p_query), lower(p.name)) desc, p.special desc
    limit lim;
  get diagnostics found = row_count;
  if found > 0 or array_length(words, 1) < 2 then
    return;
  end if;
  -- 3. Most of the words, the products with the most matching words first.
  q := to_tsquery('simple', array_to_string(array(select w || ':*' from unnest(words) w), ' | '));
  return query
    select p.* from public.store_products p
    where p.search @@ q and (p_chains is null or p.chain = any (p_chains))
    order by ts_rank_cd(p.search, q) desc, p.special desc, p.price_cents nulls last
    limit lim;
end $$;
revoke all on function public.search_products(text, text[], int) from public;
grant execute on function public.search_products(text, text[], int) to authenticated;
