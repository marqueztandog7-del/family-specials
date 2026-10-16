-- Family sharing, complete: invites with a link token and a separately sent code, joining with limits on wrong
-- codes, owner and member controls, and the family's shared watchlist, shopping list and savings (live updates).
--
-- Rules:
--   - The invite LINK carries only a random token. It shows who invited you, never the code.
--   - The 6-character CODE is sent separately, typed in by hand, and stored only as a bcrypt hash.
--   - Joining happens only through join_family(token, code, nickname): signed in, not already in a family,
--     invite live, code right, at most 5 wrong codes per person per 15 minutes (and 20 per invite per hour).
--   - People only ever read or change their own family's rows (row-level security on every table).
--   - Shared rows are never deleted: removals are kept as "removed" so changes from several phones merge,
--     field by field, latest change wins, and nothing is lost.

-- ------------------------------------------------------------------ invites (replaces the first version)

-- The first version kept codes in plain text and put them in the link: those invites are gone.
drop table if exists public.family_invites cascade;

create table public.family_invites (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families (id) on delete cascade,
  invite_token text not null unique,
  code_hash text not null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked boolean not null default false
);
create index family_invites_live on public.family_invites (family_id) where not revoked;
alter table public.family_invites enable row level security;     -- no policies: only the functions below

create table public.join_attempts (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  invite_id uuid references public.family_invites (id) on delete cascade,
  attempted_at timestamptz not null default now(),
  success boolean not null
);
create index join_attempts_by_person on public.join_attempts (user_id, attempted_at);
create index join_attempts_by_invite on public.join_attempts (invite_id, attempted_at);
alter table public.join_attempts enable row level security;      -- no policies: only join_family()

-- Codes: 6 characters from 2-9 and A-Z without O, I and L, each equally likely (bytes 248+ are skipped).
create or replace function private.new_invite_code() returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  alphabet constant text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  b int;
  c text := '';
begin
  while char_length(c) < 6 loop
    b := get_byte(extensions.gen_random_bytes(1), 0);
    if b < 248 then
      c := c || substr(alphabet, 1 + b % 31, 1);
    end if;
  end loop;
  return c;
end $$;

-- Link tokens: 18 random bytes (144 bits), URL-safe.
create function private.new_invite_token() returns text
language sql volatile security definer set search_path = '' as $$
  select translate(encode(extensions.gen_random_bytes(18), 'base64'), '+/', '-_')
$$;

-- A new invite for a family: earlier ones stop working at once. The code is returned this once only.
create function private.make_invite(fid uuid, uid uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  c text := private.new_invite_code();
  t text := private.new_invite_token();
  exp timestamptz := now() + interval '7 days';
begin
  update public.family_invites set revoked = true where family_id = fid and not revoked;
  insert into public.family_invites (family_id, invite_token, code_hash, created_by, expires_at)
    values (fid, t, extensions.crypt(c, extensions.gen_salt('bf', 8)), uid, exp);
  return jsonb_build_object('token', t, 'code', c, 'expires_at', exp);
end $$;

-- Who an invite is from: the person who made it (if still a member), else the family's owner.
create function private.inviter_nickname(inv public.family_invites) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select m.nickname from public.family_members m where m.user_id = inv.created_by and m.family_id = inv.family_id),
    (select m.nickname from public.family_members m where m.family_id = inv.family_id and m.role = 'owner'))
$$;

revoke all on function private.new_invite_code(), private.new_invite_token(), private.make_invite(uuid, uuid),
  private.inviter_nickname(public.family_invites) from public;

-- ------------------------------------------------------------------ members: who's who, for the family

-- my_family() now includes each member's account id (an opaque number, needed for "added by" and removing a
-- member) and, for the owner, the live invite's link token and expiry. Never the code, never emails.
create or replace function public.my_family() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', f.id,
    'name', f.name,
    'is_owner', f.owner_id = auth.uid(),
    'me', jsonb_build_object('user_id', m.user_id, 'nickname', m.nickname, 'role', m.role),
    'members', (select jsonb_agg(jsonb_build_object('user_id', x.user_id, 'nickname', x.nickname, 'role', x.role,
                                                    'is_me', x.user_id = auth.uid(), 'joined_at', x.joined_at)
                                 order by x.role desc, x.joined_at)
                from public.family_members x where x.family_id = f.id),
    'invite', case when f.owner_id = auth.uid() then
                (select jsonb_build_object('token', i.invite_token, 'expires_at', i.expires_at)
                 from public.family_invites i
                 where i.family_id = f.id and not i.revoked and i.expires_at > now()
                 order by i.created_at desc limit 1) end)
  from public.family_members m join public.families f on f.id = m.family_id
  where m.user_id = auth.uid()
$$;

-- Start a family: the person becomes its owner, and its first invite is made (code shown this once).
create or replace function public.create_family(p_name text, p_nickname text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  fid uuid;
  inv jsonb;
begin
  if uid is null then raise exception 'not-signed-in'; end if;
  if char_length(btrim(coalesce(p_name, ''))) not between 1 and 60 then raise exception 'family-name-length'; end if;
  if char_length(btrim(coalesce(p_nickname, ''))) not between 1 and 30 then raise exception 'nickname-length'; end if;
  if exists (select 1 from public.family_members where user_id = uid) then raise exception 'already-in-family'; end if;
  insert into public.families (name, owner_id) values (btrim(p_name), uid) returning id into fid;
  insert into public.family_members (user_id, family_id, nickname, role) values (uid, fid, btrim(p_nickname), 'owner');
  inv := private.make_invite(fid, uid);
  return public.my_family() || jsonb_build_object('new_invite', inv);
end $$;

-- Owner: make a new link and code (the old ones stop working straight away).
create function public.new_invite() returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  fid uuid;
begin
  if uid is null then raise exception 'not-signed-in'; end if;
  select id into fid from public.families where owner_id = uid;
  if fid is null then raise exception 'not-owner'; end if;
  return private.make_invite(fid, uid);
end $$;

-- What the invite link's page may show: the family's name and who invited you. Nothing else.
create function public.get_invite_preview(p_token text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'status', case when i.revoked or i.expires_at <= now() then 'expired' else 'ok' end,
    'family_name', f.name,
    'inviter', private.inviter_nickname(i))
  from public.family_invites i join public.families f on f.id = i.family_id
  where i.invite_token = p_token
$$;

-- Join with the link's token, the code sent separately, and a nickname. Wrong codes are recorded (so they're
-- returned as a result, not an error: an error would undo the record).
create function public.join_family(p_token text, p_code text, p_nickname text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  inv public.family_invites;
  fam_name text;
  inviter text;
  fails int;
  invite_fails int;
  code text := upper(regexp_replace(coalesce(p_code, ''), '[^0-9A-Za-z]', '', 'g'));
  nick text := btrim(coalesce(p_nickname, ''));
begin
  if uid is null then raise exception 'not-signed-in'; end if;
  select f.name into fam_name from public.family_members m join public.families f on f.id = m.family_id
    where m.user_id = uid;
  if found then return jsonb_build_object('status', 'already-in-family', 'family_name', fam_name); end if;
  select count(*) into fails from public.join_attempts
    where user_id = uid and not success and attempted_at > now() - interval '15 minutes';
  if fails >= 5 then return jsonb_build_object('status', 'too-many'); end if;
  select * into inv from public.family_invites where invite_token = p_token;
  if not found then
    insert into public.join_attempts (user_id, success) values (uid, false);
    return jsonb_build_object('status', 'not-found');
  end if;
  select name into fam_name from public.families where id = inv.family_id;
  inviter := private.inviter_nickname(inv);
  if inv.revoked or inv.expires_at <= now() then
    return jsonb_build_object('status', 'expired', 'family_name', fam_name, 'inviter', inviter);
  end if;
  select count(*) into invite_fails from public.join_attempts
    where invite_id = inv.id and not success and attempted_at > now() - interval '1 hour';
  if invite_fails >= 20 then return jsonb_build_object('status', 'too-many'); end if;
  if char_length(nick) not between 1 and 30 then return jsonb_build_object('status', 'nickname'); end if;
  if code !~ '^[2-9A-HJKMNP-Z]{6}$' or extensions.crypt(code, inv.code_hash) <> inv.code_hash then
    insert into public.join_attempts (user_id, invite_id, success) values (uid, inv.id, false);
    return jsonb_build_object('status', 'wrong-code', 'family_name', fam_name, 'inviter', inviter,
                              'attempts_left', greatest(0, 4 - fails));
  end if;
  insert into public.family_members (user_id, family_id, nickname, role) values (uid, inv.family_id, nick, 'member');
  insert into public.join_attempts (user_id, invite_id, success) values (uid, inv.id, true);
  return jsonb_build_object('status', 'ok', 'family_name', fam_name, 'inviter', inviter, 'family', public.my_family());
end $$;

-- Owner: rename the family.
create function public.rename_family(p_name text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not-signed-in'; end if;
  if char_length(btrim(coalesce(p_name, ''))) not between 1 and 60 then raise exception 'family-name-length'; end if;
  update public.families set name = btrim(p_name), updated_at = now() where owner_id = uid;
  if not found then raise exception 'not-owner'; end if;
  return public.my_family();
end $$;

-- Owner: remove another member.
create function public.remove_member(p_user_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  fid uuid;
begin
  if uid is null then raise exception 'not-signed-in'; end if;
  select id into fid from public.families where owner_id = uid;
  if fid is null then raise exception 'not-owner'; end if;
  if p_user_id = uid then raise exception 'cannot-remove-yourself'; end if;
  delete from public.family_members where user_id = p_user_id and family_id = fid;
  if not found then raise exception 'not-a-member'; end if;
  return public.my_family();
end $$;

-- Leave the family. An owner with others in the family must hand it to one of them first; the last person to
-- leave takes the family (and its list and savings) with them.
create function public.leave_family(p_new_owner uuid default null) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  me public.family_members;
  others int;
begin
  if uid is null then raise exception 'not-signed-in'; end if;
  select * into me from public.family_members where user_id = uid;
  if not found then raise exception 'not-in-family'; end if;
  if me.role = 'owner' then
    select count(*) into others from public.family_members where family_id = me.family_id and user_id <> uid;
    if others = 0 then
      delete from public.families where id = me.family_id;
      return;
    end if;
    if p_new_owner is null or p_new_owner = uid or not exists (
        select 1 from public.family_members where family_id = me.family_id and user_id = p_new_owner) then
      raise exception 'choose-new-owner';
    end if;
    update public.families set owner_id = p_new_owner, updated_at = now() where id = me.family_id;
    update public.family_members set role = 'owner' where user_id = p_new_owner;
  end if;
  delete from public.family_members where user_id = uid;
end $$;

revoke all on function public.new_invite(), public.join_family(text, text, text), public.rename_family(text),
  public.remove_member(uuid), public.leave_family(uuid) from public, anon;
grant execute on function public.new_invite(), public.join_family(text, text, text), public.rename_family(text),
  public.remove_member(uuid), public.leave_family(uuid) to authenticated;
revoke all on function public.get_invite_preview(text) from public;
grant execute on function public.get_invite_preview(text) to anon, authenticated;
revoke all on function public.create_family(text, text), public.my_family() from public, anon;
grant execute on function public.create_family(text, text), public.my_family() to authenticated;

-- ------------------------------------------------------------------ shared data

-- A change timestamp from a phone with a wrong clock can't lock a field forever: anything more than 5 minutes
-- in the future counts as now.
create function private.clamp_time(t timestamptz) returns timestamptz
language sql stable as $$ select least(t, now() + interval '5 minutes') $$;

-- The shopping list: one row per thing on the list (the same product added twice is one row, more of it).
create table public.family_list_items (
  family_id uuid not null references public.families (id) on delete cascade,
  item_key text not null check (char_length(item_key) between 1 and 200),
  data jsonb not null default '{}'::jsonb check (pg_column_size(data) < 4000),
  qty int not null default 1 check (qty between 1 and 99),
  qty_changed timestamptz not null,
  ticked boolean not null default false,
  ticked_at timestamptz,
  ticked_changed timestamptz not null,
  deleted boolean not null default false,
  deleted_changed timestamptz not null,
  added_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (family_id, item_key)
);

create function private.merge_list_item() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.qty_changed := private.clamp_time(new.qty_changed);
  new.ticked_changed := private.clamp_time(new.ticked_changed);
  new.deleted_changed := private.clamp_time(new.deleted_changed);
  if tg_op = 'INSERT' then
    new.added_by := auth.uid();                  -- who added it is set here, not by the phone
    new.created_at := now();
    new.updated_at := now();
    return new;
  end if;
  new.family_id := old.family_id;
  new.item_key := old.item_key;
  new.created_at := old.created_at;
  -- Field by field, the newest change wins.
  if new.qty_changed < old.qty_changed then
    new.qty := old.qty; new.qty_changed := old.qty_changed;
  end if;
  if new.ticked_changed < old.ticked_changed then
    new.ticked := old.ticked; new.ticked_at := old.ticked_at; new.ticked_changed := old.ticked_changed;
  end if;
  if new.deleted_changed < old.deleted_changed then
    new.deleted := old.deleted; new.deleted_changed := old.deleted_changed;
    new.data := old.data; new.added_by := old.added_by;
  elsif old.deleted and not new.deleted then
    new.added_by := auth.uid();                  -- added again: by whoever added it back, with what they added
  else
    new.data := old.data; new.added_by := old.added_by;
  end if;
  -- Never lose an item: a change made after it was removed brings it back.
  if new.deleted and greatest(new.qty_changed, new.ticked_changed) > new.deleted_changed then
    new.deleted := false;
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger merge_list_item before insert or update on public.family_list_items
  for each row execute function private.merge_list_item();

-- Savings: one entry per special ticked off as bought.
create table public.family_savings (
  family_id uuid not null references public.families (id) on delete cascade,
  entry_id text not null check (char_length(entry_id) between 1 and 300),
  data jsonb not null default '{}'::jsonb check (pg_column_size(data) < 4000),
  saving_cents int not null check (saving_cents between 0 and 100000),
  saved_at timestamptz not null,
  deleted boolean not null default false,
  deleted_changed timestamptz not null,
  recorded_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (family_id, entry_id)
);

create function private.merge_saving() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.deleted_changed := private.clamp_time(new.deleted_changed);
  if tg_op = 'INSERT' then
    new.recorded_by := auth.uid();
    new.updated_at := now();
    return new;
  end if;
  new.family_id := old.family_id;
  new.entry_id := old.entry_id;
  if new.deleted_changed < old.deleted_changed then
    new.deleted := old.deleted; new.deleted_changed := old.deleted_changed;
    new.data := old.data; new.saving_cents := old.saving_cents; new.saved_at := old.saved_at;
    new.recorded_by := old.recorded_by;
  elsif old.deleted and not new.deleted then
    new.recorded_by := auth.uid();
  else
    new.data := old.data; new.saving_cents := old.saving_cents; new.saved_at := old.saved_at;
    new.recorded_by := old.recorded_by;
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger merge_saving before insert or update on public.family_savings
  for each row execute function private.merge_saving();

-- The watchlist: changes to the shared watchlist. Every family starts watching the standard watchlist; a row
-- either stops (or restarts) watching one of its items, or adds a product ('product:<store id>').
create table public.family_watch_items (
  family_id uuid not null references public.families (id) on delete cascade,
  watch_key text not null check (char_length(watch_key) between 1 and 200),
  data jsonb not null default '{}'::jsonb check (pg_column_size(data) < 4000),
  watching boolean not null,
  watching_changed timestamptz not null,
  added_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (family_id, watch_key)
);

create function private.merge_watch_item() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.watching_changed := private.clamp_time(new.watching_changed);
  if tg_op = 'INSERT' then
    new.added_by := auth.uid();
    new.updated_at := now();
    return new;
  end if;
  new.family_id := old.family_id;
  new.watch_key := old.watch_key;
  if new.watching_changed < old.watching_changed then
    new.watching := old.watching; new.watching_changed := old.watching_changed;
    new.data := old.data; new.added_by := old.added_by;
  elsif new.watching and not old.watching then
    new.added_by := auth.uid();
  else
    new.data := old.data; new.added_by := old.added_by;
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger merge_watch_item before insert or update on public.family_watch_items
  for each row execute function private.merge_watch_item();

revoke all on function private.clamp_time(timestamptz), private.merge_list_item(), private.merge_saving(),
  private.merge_watch_item() from public;

-- Row-level security: a family reads, adds and changes only its own rows. No deletes: removals are kept as
-- "removed" so changes merge; rows go when the family does.
do $$
declare t text;
begin
  foreach t in array array['family_list_items', 'family_savings', 'family_watch_items'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy "family reads its own" on public.%I for select to authenticated
                      using (family_id = (select private.my_family_id()))', t);
    execute format('create policy "family adds its own" on public.%I for insert to authenticated
                      with check (family_id = (select private.my_family_id()))', t);
    execute format('create policy "family changes its own" on public.%I for update to authenticated
                      using (family_id = (select private.my_family_id()))
                      with check (family_id = (select private.my_family_id()))', t);
    execute format('grant select, insert, update on public.%I to authenticated', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

-- Live updates: every member's phone hears about changes within a second or two (row-level security applies).
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;
alter publication supabase_realtime add table public.family_list_items, public.family_savings,
  public.family_watch_items, public.family_members, public.families;
