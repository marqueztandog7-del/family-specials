-- Self-test for families, invites, joining and the shared list, savings and watchlist.
-- Runs inside one transaction with pretend people and is ROLLED BACK: nothing is saved.
-- Run: uv run specials backend test
--   A = owner of "Test Family", B = joins it, C = owner of another family, D = for expiry and leaving.
begin;
create temp table r (n serial, name text, ok boolean, detail text);
grant insert, select on r to authenticated, anon;
grant usage on sequence r_n_seq to authenticated, anon;
create temp table v (k text primary key, val text);
grant insert, select, update on v to authenticated, anon;

insert into auth.users (id, aud, role, email) values
  ('00000000-0000-4000-8000-00000000000a', 'authenticated', 'authenticated', 'a@test.invalid'),
  ('00000000-0000-4000-8000-00000000000b', 'authenticated', 'authenticated', 'b@test.invalid'),
  ('00000000-0000-4000-8000-00000000000c', 'authenticated', 'authenticated', 'c@test.invalid'),
  ('00000000-0000-4000-8000-00000000000d', 'authenticated', 'authenticated', 'd@test.invalid');

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

do $$
declare
  j jsonb; p jsonb; tok text; code text; tok2 text; code2 text; c int; fid uuid; cfid uuid;
  wrong text;
  a uuid := '00000000-0000-4000-8000-00000000000a';
  b uuid := '00000000-0000-4000-8000-00000000000b';
  d uuid := '00000000-0000-4000-8000-00000000000d';
begin
  -- 1. A starts a family and gets a link token and a code.
  perform pg_temp.as_user('a');
  j := public.create_family('Test Family', 'Owner A');
  tok := j->'new_invite'->>'token';
  code := j->'new_invite'->>'code';
  fid := (j->>'id')::uuid;
  perform pg_temp.ok('start: owner, family name', (j->>'is_owner')::bool and j->>'name' = 'Test Family');
  perform pg_temp.ok('code: 6 allowed characters', code ~ '^[2-9A-HJKMNP-Z]{6}$', code);
  perform pg_temp.ok('link token: long, random, URL-safe', tok ~ '^[A-Za-z0-9_-]{24}$', tok);
  perform pg_temp.ok('link token never contains the code', position(code in tok) = 0);
  perform pg_temp.ok('code expires in 7 days',
    abs(extract(epoch from ((j->'new_invite'->>'expires_at')::timestamptz - (now() + interval '7 days')))) < 60);
  perform pg_temp.ok('my_family shows the link but never the code',
    public.my_family()->'invite'->>'token' = tok and public.my_family()::text !~ code);
  reset role;
  perform pg_temp.ok('code stored only as a bcrypt hash',
    (select code_hash like '$2%' and code_hash !~ code from public.family_invites where invite_token = tok));
  perform pg_temp.ok('no invite column holds the code',
    (select count(*) = 0 from public.family_invites i where to_jsonb(i)::text ~ code));

  -- 2. The link's page (signed out) shows only the family name and who invited you.
  perform pg_temp.as_user('anon');
  p := public.get_invite_preview(tok);
  perform pg_temp.ok('preview: name and inviter only', p = jsonb_build_object('status', 'ok', 'family_name', 'Test Family',
    'inviter', 'Owner A'), p::text);
  perform pg_temp.ok('preview: unknown link shows nothing', public.get_invite_preview('not-a-real-token') is null);
  begin
    perform public.join_family(tok, code, 'Sneaky');
    perform pg_temp.ok('signed out: cannot join', false, 'allowed');
  exception when others then perform pg_temp.ok('signed out: cannot join', true, sqlstate); end;

  -- 3. B joins: the link alone never works, wrong codes are counted, and 5 wrong ones lock for 15 minutes.
  perform pg_temp.as_user('b');
  j := public.join_family(tok, '', 'B');
  perform pg_temp.ok('link alone (no code) cannot join', j->>'status' = 'wrong-code', j::text);
  wrong := case when code = 'ABCDEF' then 'ABCDEG' else 'ABCDEF' end;
  j := public.join_family(tok, wrong, 'B');
  perform pg_temp.ok('wrong code: says who to check with', j->>'status' = 'wrong-code' and j->>'inviter' = 'Owner A'
    and j->>'family_name' = 'Test Family', j::text);
  perform public.join_family(tok, wrong, 'B');
  perform public.join_family(tok, wrong, 'B');
  j := public.join_family(tok, wrong, 'B');
  perform pg_temp.ok('5 wrong codes (empty one counted too)', j->>'status' = 'too-many' or j->>'status' = 'wrong-code', j::text);
  j := public.join_family(tok, code, 'B');
  perform pg_temp.ok('6th try is refused, even with the right code', j->>'status' = 'too-many', j::text);
  reset role;
  select count(*) into c from public.family_members where family_id = fid;
  perform pg_temp.ok('not joined while locked', c = 1, c::text);
  update public.join_attempts set attempted_at = now() - interval '16 minutes' where user_id = b;
  perform pg_temp.as_user('b');
  j := public.join_family(tok, lower(substr(code, 1, 3)) || ' ' || lower(substr(code, 4)), '  Mum  ');
  perform pg_temp.ok('after 15 minutes: right code (lowercase, with a space) joins', j->>'status' = 'ok', j::text);
  perform pg_temp.ok('joined with the nickname, as a member', public.my_family()->'me' @> '{"nickname": "Mum", "role": "member"}');
  perform pg_temp.ok('the family shows both members', jsonb_array_length(public.my_family()->'members') = 2);
  perform pg_temp.ok('members never see the invite', public.my_family()->'invite' = 'null'::jsonb
    or public.my_family()->'invite' is null);
  j := public.join_family(tok, code, 'Again');
  perform pg_temp.ok('already in a family: says which', j->>'status' = 'already-in-family' and j->>'family_name' = 'Test Family', j::text);
  select count(*) into c from public.join_attempts;
  perform pg_temp.ok('attempt records are private', c = 0, c::text);
  select count(*) into c from public.family_invites;
  perform pg_temp.ok('invites are private', c = 0, c::text);

  -- 4. Only the owner manages the family.
  begin perform public.new_invite(); perform pg_temp.ok('member cannot make codes', false);
  exception when others then perform pg_temp.ok('member cannot make codes', sqlerrm = 'not-owner', sqlerrm); end;
  begin perform public.rename_family('Hijacked'); perform pg_temp.ok('member cannot rename', false);
  exception when others then perform pg_temp.ok('member cannot rename', sqlerrm = 'not-owner', sqlerrm); end;
  begin perform public.remove_member(a); perform pg_temp.ok('member cannot remove people', false);
  exception when others then perform pg_temp.ok('member cannot remove people', sqlerrm = 'not-owner', sqlerrm); end;
  begin update public.families set name = 'Hijacked'; get diagnostics c = row_count;
    perform pg_temp.ok('no direct changes to the family', c = 0, c::text);
  exception when others then perform pg_temp.ok('no direct changes to the family', true, sqlstate); end;
  perform pg_temp.as_user('a');
  j := public.rename_family('  Renamed Family ');
  perform pg_temp.ok('owner renames the family', j->>'name' = 'Renamed Family');

  -- 5. A new code: the old link and code stop working straight away; expired invites are refused.
  j := public.new_invite();
  tok2 := j->>'token';
  code2 := j->>'code';
  perform pg_temp.as_user('anon');
  perform pg_temp.ok('old link shows as expired', public.get_invite_preview(tok)->>'status' = 'expired');
  perform pg_temp.as_user('d');
  j := public.join_family(tok, code, 'D');
  perform pg_temp.ok('old link and code are refused', j->>'status' = 'expired' and j->>'inviter' = 'Owner A', j::text);
  reset role;
  update public.family_invites set expires_at = now() - interval '1 minute' where invite_token = tok2;
  perform pg_temp.as_user('d');
  j := public.join_family(tok2, code2, 'D');
  perform pg_temp.ok('expired invite is refused', j->>'status' = 'expired', j::text);
  reset role;
  update public.family_invites set expires_at = now() + interval '1 day' where invite_token = tok2;

  -- 6. The shared list: who added it is set by the server, changes merge field by field, nothing is lost.
  perform pg_temp.as_user('b');
  insert into public.family_list_items (family_id, item_key, data, qty, qty_changed, ticked, ticked_changed,
                                        deleted, deleted_changed, added_by)
    values (fid, 'woolworths:1', '{"name": "Test item"}', 1, now(), false, now(), false, now(), a);
  perform pg_temp.as_user('a');
  perform pg_temp.ok('owner sees what the member added', exists (select 1 from public.family_list_items where item_key = 'woolworths:1'));
  perform pg_temp.ok('"added by" is the member, not what the phone claimed',
    (select added_by from public.family_list_items where item_key = 'woolworths:1') = b);
  -- A ticks it (newer); B changes the quantity at the same time with an older timestamp for the tick.
  insert into public.family_list_items as t (family_id, item_key, qty, qty_changed, ticked, ticked_at, ticked_changed, deleted, deleted_changed)
    values (fid, 'woolworths:1', 1, now(), true, now(), now() + interval '2 seconds', false, now())
    on conflict (family_id, item_key) do update set qty = excluded.qty, qty_changed = excluded.qty_changed,
      ticked = excluded.ticked, ticked_at = excluded.ticked_at, ticked_changed = excluded.ticked_changed,
      deleted = excluded.deleted, deleted_changed = excluded.deleted_changed;
  perform pg_temp.as_user('b');
  insert into public.family_list_items (family_id, item_key, qty, qty_changed, ticked, ticked_changed, deleted, deleted_changed)
    values (fid, 'woolworths:1', 3, now() + interval '3 seconds', false, now() + interval '1 second', false, now())
    on conflict (family_id, item_key) do update set qty = excluded.qty, qty_changed = excluded.qty_changed,
      ticked = excluded.ticked, ticked_changed = excluded.ticked_changed,
      deleted = excluded.deleted, deleted_changed = excluded.deleted_changed;
  perform pg_temp.ok('both changes kept: the tick and the new quantity',
    (select ticked and qty = 3 from public.family_list_items where item_key = 'woolworths:1'));
  -- B removes it, but A changed the quantity after that: it comes back.
  update public.family_list_items set deleted = true, deleted_changed = now() + interval '4 seconds' where item_key = 'woolworths:1';
  perform pg_temp.ok('removed', (select deleted from public.family_list_items where item_key = 'woolworths:1'));
  perform pg_temp.as_user('a');
  update public.family_list_items set qty = 4, qty_changed = now() + interval '5 seconds' where item_key = 'woolworths:1';
  perform pg_temp.ok('a later change brings a removed item back',
    (select not deleted and qty = 4 from public.family_list_items where item_key = 'woolworths:1'));
  update public.family_list_items set qty = 9, qty_changed = now() + interval '1 day' where item_key = 'woolworths:1';
  perform pg_temp.ok('a phone with a wrong clock cannot lock a field',
    (select qty_changed <= now() + interval '5 minutes' from public.family_list_items where item_key = 'woolworths:1'));
  begin delete from public.family_list_items where item_key = 'woolworths:1'; get diagnostics c = row_count;
    perform pg_temp.ok('rows are never deleted outright', c = 0, c::text);
  exception when others then perform pg_temp.ok('rows are never deleted outright', true, sqlstate); end;

  -- Savings and the watchlist work the same way.
  insert into public.family_savings (family_id, entry_id, data, saving_cents, saved_at, deleted_changed)
    values (fid, 'woolworths:1|t', '{"name": "Test item"}', 170, now(), now());
  insert into public.family_watch_items (family_id, watch_key, watching, watching_changed)
    values (fid, 'test-item', false, now());
  perform pg_temp.as_user('b');
  perform pg_temp.ok('member sees the saving', (select saving_cents = 170 from public.family_savings where entry_id = 'woolworths:1|t'));
  perform pg_temp.ok('member sees the watchlist change', (select not watching from public.family_watch_items where watch_key = 'test-item'));

  -- 7. Another family (C) can't see or change any of it.
  perform pg_temp.as_user('c');
  j := public.create_family('Other Family', 'C');
  cfid := (j->>'id')::uuid;
  select count(*) into c from public.family_list_items;   perform pg_temp.ok('other family: no list items', c = 0, c::text);
  select count(*) into c from public.family_savings;      perform pg_temp.ok('other family: no savings', c = 0, c::text);
  select count(*) into c from public.family_watch_items;  perform pg_temp.ok('other family: no watchlist', c = 0, c::text);
  select count(*) into c from public.family_members;      perform pg_temp.ok('other family: sees only itself', c = 1, c::text);
  select count(*) into c from public.families;            perform pg_temp.ok('other family: one family visible', c = 1, c::text);
  update public.family_list_items set qty = 99 where family_id = fid; get diagnostics c = row_count;
  perform pg_temp.ok('other family: cannot change the list', c = 0, c::text);
  begin
    insert into public.family_list_items (family_id, item_key, qty_changed, ticked_changed, deleted_changed)
      values (fid, 'intruder', now(), now(), now());
    perform pg_temp.ok('other family: cannot add to the list', false, 'allowed');
  exception when others then perform pg_temp.ok('other family: cannot add to the list', true, sqlstate); end;
  perform pg_temp.as_user('anon');
  begin select count(*) into c from public.family_list_items;
    perform pg_temp.ok('signed out: no list', c = 0, c::text);
  exception when others then perform pg_temp.ok('signed out: no list', true, sqlstate); end;

  -- 8. Leaving and removing.
  perform pg_temp.as_user('d');
  j := public.join_family(tok2, code2, 'D');
  perform pg_temp.ok('D joins with the new code', j->>'status' = 'ok', j::text);
  perform public.leave_family();
  perform pg_temp.ok('member leaves', public.my_family() is null);
  perform pg_temp.as_user('a');
  j := public.remove_member(b);
  perform pg_temp.ok('owner removes a member', jsonb_array_length(j->'members') = 1);
  perform pg_temp.as_user('b');
  select count(*) into c from public.family_list_items;
  perform pg_temp.ok('removed member loses access to the list', c = 0 and public.my_family() is null, c::text);
  reset role;
  insert into public.family_members (user_id, family_id, nickname, role) values (b, fid, 'Mum', 'member');
  perform pg_temp.as_user('a');
  begin perform public.leave_family(); perform pg_temp.ok('owner must pick a new owner first', false);
  exception when others then perform pg_temp.ok('owner must pick a new owner first', sqlerrm = 'choose-new-owner', sqlerrm); end;
  perform public.leave_family(b);
  perform pg_temp.as_user('b');
  perform pg_temp.ok('the new owner takes over', (public.my_family()->>'is_owner')::bool);
  perform public.leave_family();
  reset role;
  select count(*) into c from public.families where id = fid;
  perform pg_temp.ok('last one out takes the family and its data', c = 0
    and not exists (select 1 from public.family_list_items where family_id = fid), c::text);

  -- 9. Live updates are switched on for the shared tables.
  perform pg_temp.ok('live updates on for the shared tables', (select count(*) = 5 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public'
      and tablename in ('family_list_items', 'family_savings', 'family_watch_items', 'family_members', 'families')));
end $$;

select name, ok, detail from r order by n;
rollback;
