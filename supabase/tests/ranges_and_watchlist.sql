-- Self-test for the product ranges (search) and each family's private watchlist.
-- Runs inside one transaction with pretend people and pretend products, and is ROLLED BACK: nothing is saved.
-- Run: uv run specials backend test
--   A = in family X, C = in family Y, anon = not signed in.
begin;
create temp table r (n serial, name text, ok boolean, detail text);
grant insert, select on r to authenticated, anon;
grant usage on sequence r_n_seq to authenticated, anon;

insert into auth.users (id, aud, role, email) values
  ('00000000-0000-4000-8000-00000000000a', 'authenticated', 'authenticated', 'a@test.invalid'),
  ('00000000-0000-4000-8000-00000000000c', 'authenticated', 'authenticated', 'c@test.invalid');

create function pg_temp.as_user(u text) returns void language plpgsql as $f$
begin
  reset role;
  if u = 'anon' then
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
    set local role anon;
  else
    perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-00000000000' || u,
                                                               'role', 'authenticated')::text, true);
    set local role authenticated;
  end if;
end $f$;
grant execute on function pg_temp.as_user(text) to authenticated, anon;

create function pg_temp.ok(name text, ok boolean, detail text default null) returns void language sql as $f$
  insert into r (name, ok, detail) values (name, coalesce(ok, false), detail)
$f$;
grant execute on function pg_temp.ok(text, boolean, text) to authenticated, anon;

-- Pretend products (ids starting test-) and two pretend families.
insert into public.store_products (chain, product_id, name, brand, size_text, price_cents, special, seen_at) values
  ('woolworths', 'test-1', 'Zqxwool Full Cream Milk 2L', 'Zqxwool', '2L', 350, false, now()),
  ('aldi', 'test-2', 'Zqxfarm Full Cream Milk 2L', 'Zqxfarm', '2L', 299, true, now()),
  ('costco', 'test-3', 'Zqxkirk Paper Towel 12 pack', 'Zqxkirk', '12 pack', 2999, false, now()),
  ('chemistwarehouse', 'test-4', 'Zqxvita Vitamin C 500mg 100 tablets', null, null, 1299, false, now());

do $$
declare
  j jsonb; c int; x uuid; y uuid; names text;
  a uuid := '00000000-0000-4000-8000-00000000000a';
  cc uuid := '00000000-0000-4000-8000-00000000000c';
begin
  insert into public.families (name, owner_id) values ('Test X', a) returning id into x;
  insert into public.families (name, owner_id) values ('Test Y', cc) returning id into y;
  insert into public.family_members (user_id, family_id, nickname, role) values (a, x, 'A', 'owner'), (cc, y, 'C', 'owner');
  insert into public.family_watchlist values (x, '{"items":[{"key":"x-item","tier":"core"}]}', now() - interval '1 hour');
  insert into public.family_watchlist values (y, '{"items":[{"key":"y-item","tier":"core"}]}', now());

  -- 1. Search: every word must start a word, across stores.
  perform pg_temp.as_user('a');
  select count(*), string_agg(product_id, ',' order by product_id) into c, names
    from public.search_products('zqx full cream mil', null, 40) where product_id like 'test-%';
  perform pg_temp.ok('search finds both milks, from two stores', c = 2, names);
  select string_agg(product_id, ',') into names from public.search_products('zqx full cream milk', null, 40)
    where product_id like 'test-%';
  perform pg_temp.ok('a special comes before a normal price when equally good', names = 'test-2,test-1', names);
  select count(*) into c from public.search_products('aldi zqx milk', null, 40) where product_id like 'test-%';
  perform pg_temp.ok('the store name can be searched', c = 1);
  select count(*) into c from public.search_products('zqx milk', array['woolworths'], 40) where product_id like 'test-%';
  perform pg_temp.ok('search can be limited to some stores', c = 1);
  select count(*) into c from public.search_products('zqxkirk papr towel', null, 40) where product_id like 'test-%';
  perform pg_temp.ok('a close spelling still finds it', c = 1);
  select count(*) into c from public.search_products('zqxkirk papr towl', null, 40) where product_id like 'test-%';
  perform pg_temp.ok('a rougher spelling still finds it', c = 1);
  select string_agg(product_id, ',') into names from public.search_products('zqxkirk qqemulgel', null, 40)
    where product_id like 'test-%';
  perform pg_temp.ok('with no product having every word, most of the words still find it', names = 'test-3', names);
  select count(*) into c from public.search_products('  ', null, 40);
  perform pg_temp.ok('an empty search finds nothing', c = 0);
  select count(*) into c from public.search_products('zqx milk'' & !', null, 40) where product_id like 'test-%';
  perform pg_temp.ok('punctuation in a search is harmless', c = 2);
  select count(*) into c from public.products_by_id(array['costco:test-3', 'aldi:test-2', 'aldi:nope']);
  perform pg_temp.ok('products by id', c = 2);

  -- 2. Nobody can change store products from the app, and people who aren't signed in can't read them.
  begin
    insert into public.store_products (chain, product_id, name, seen_at) values ('aldi', 'test-x', 'x', now());
    perform pg_temp.ok('signed-in people can''t add store products', false);
  exception when others then perform pg_temp.ok('signed-in people can''t add store products', true); end;
  begin
    update public.store_products set price_cents = 1 where product_id = 'test-1';
    get diagnostics c = row_count;
    perform pg_temp.ok('signed-in people can''t change store prices', c = 0);
  exception when others then perform pg_temp.ok('signed-in people can''t change store prices', true); end;
  perform pg_temp.as_user('anon');
  begin
    select count(*) into c from public.store_products;
    perform pg_temp.ok('people not signed in can''t read the ranges', false, c::text);
  exception when others then perform pg_temp.ok('people not signed in can''t read the ranges', true); end;
  begin
    perform public.search_products('milk', null, 40);
    perform pg_temp.ok('people not signed in can''t search', false);
  exception when others then perform pg_temp.ok('people not signed in can''t search', true); end;

  -- 3. A family's watchlist is only for its members.
  perform pg_temp.as_user('a');
  j := public.my_watchlist(null);
  perform pg_temp.ok('a member gets their family''s watchlist', j->'data'->'items'->0->>'key' = 'x-item', j::text);
  select count(*) into c from public.family_watchlist;
  perform pg_temp.ok('a member never sees another family''s watchlist', c = 1);
  j := public.my_watchlist(now());
  perform pg_temp.ok('an up-to-date copy isn''t sent again', (j->>'unchanged')::bool and j->'data' is null, j::text);
  begin
    insert into public.family_watchlist values (y, '{}', now());
    perform pg_temp.ok('nobody can write a watchlist from the app', false);
  exception when others then perform pg_temp.ok('nobody can write a watchlist from the app', true); end;
  begin
    update public.family_watchlist set data = '{}' where family_id = x;
    get diagnostics c = row_count;
    perform pg_temp.ok('nobody can change their watchlist from the app', c = 0);
  exception when others then perform pg_temp.ok('nobody can change their watchlist from the app', true); end;
  perform pg_temp.as_user('c');
  j := public.my_watchlist(null);
  perform pg_temp.ok('the other family gets only its own', j->'data'->'items'->0->>'key' = 'y-item');
  perform pg_temp.as_user('anon');
  begin
    j := public.my_watchlist(null);
    perform pg_temp.ok('people not signed in get no watchlist', j is null);
  exception when others then perform pg_temp.ok('people not signed in get no watchlist', true); end;
  reset role;
  delete from public.family_members where user_id = a;
  perform pg_temp.as_user('a');
  perform pg_temp.ok('someone who left gets no watchlist', public.my_watchlist(null) is null);
  reset role;
end $$;

select name, ok, detail from r order by n;
rollback;
