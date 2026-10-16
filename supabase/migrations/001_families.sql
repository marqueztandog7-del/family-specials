-- Families, members and invite codes (stage a: start a family).
--
-- Every table has row-level security: people only ever see their own family, and nothing can be changed
-- directly. Changes go through the functions below, which run on the server and check who's asking.
-- No personal data beyond a nickname: emails and passwords live in Supabase Auth, not here.

create schema if not exists private;
grant usage on schema private to authenticated;

create table public.families (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 60),
  owner_id uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One family per person for now (the primary key is the person).
create table public.family_members (
  user_id uuid primary key references auth.users (id) on delete cascade,
  family_id uuid not null references public.families (id) on delete cascade,
  nickname text not null check (char_length(btrim(nickname)) between 1 and 30),
  role text not null check (role in ('owner', 'member')),
  joined_at timestamptz not null default now()
);
create index family_members_by_family on public.family_members (family_id);

-- One live invite per family. Codes use 2-9 and A-Z without O, I and L (no look-alikes).
create table public.family_invites (
  family_id uuid primary key references public.families (id) on delete cascade,
  code text not null unique check (code ~ '^[2-9A-HJKMNP-Z]{6}$'),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table public.families enable row level security;
alter table public.family_members enable row level security;
alter table public.family_invites enable row level security;

-- The family the signed-in person belongs to (null when they're not in one).
create function private.my_family_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select family_id from public.family_members where user_id = auth.uid()
$$;
revoke all on function private.my_family_id() from public;
grant execute on function private.my_family_id() to authenticated;

create policy "members see their family" on public.families
  for select to authenticated using (id = (select private.my_family_id()));
create policy "members see their family's members" on public.family_members
  for select to authenticated using (family_id = (select private.my_family_id()));
create policy "the owner sees the invite" on public.family_invites
  for select to authenticated using (
    exists (select 1 from public.families f where f.id = family_id and f.owner_id = (select auth.uid())));

-- A fresh, unused invite code. Random bytes from 248 upwards are skipped so every character is equally likely.
create function private.new_invite_code() returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  alphabet constant text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  b int;
  c text;
begin
  loop
    c := '';
    while char_length(c) < 6 loop
      b := get_byte(extensions.gen_random_bytes(1), 0);
      if b < 248 then
        c := c || substr(alphabet, 1 + b % 31, 1);
      end if;
    end loop;
    exit when not exists (select 1 from public.family_invites i where i.code = c);
  end loop;
  return c;
end $$;
revoke all on function private.new_invite_code() from public;

-- Everything the app shows about the person's family. Members' account ids and emails are never returned.
create function public.my_family() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', f.id,
    'name', f.name,
    'is_owner', f.owner_id = auth.uid(),
    'me', jsonb_build_object('nickname', m.nickname, 'role', m.role),
    'members', (select jsonb_agg(jsonb_build_object('nickname', x.nickname, 'role', x.role,
                                                    'is_me', x.user_id = auth.uid(), 'joined_at', x.joined_at)
                                 order by x.role desc, x.joined_at)
                from public.family_members x where x.family_id = f.id),
    'invite', case when f.owner_id = auth.uid() then
                (select jsonb_build_object('code', i.code, 'expires_at', i.expires_at)
                 from public.family_invites i where i.family_id = f.id) end)
  from public.family_members m join public.families f on f.id = m.family_id
  where m.user_id = auth.uid()
$$;

-- Start a family: the person becomes its owner, and its first invite code (valid 7 days) is made.
create function public.create_family(p_name text, p_nickname text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  fid uuid;
begin
  if uid is null then raise exception 'not-signed-in'; end if;
  if char_length(btrim(coalesce(p_name, ''))) not between 1 and 60 then raise exception 'family-name-length'; end if;
  if char_length(btrim(coalesce(p_nickname, ''))) not between 1 and 30 then raise exception 'nickname-length'; end if;
  if exists (select 1 from public.family_members where user_id = uid) then raise exception 'already-in-family'; end if;
  insert into public.families (name, owner_id) values (btrim(p_name), uid) returning id into fid;
  insert into public.family_members (user_id, family_id, nickname, role) values (uid, fid, btrim(p_nickname), 'owner');
  insert into public.family_invites (family_id, code, expires_at)
    values (fid, private.new_invite_code(), now() + interval '7 days');
  return public.my_family();
end $$;

-- Delete my account. An owner hands the family to the longest-standing member, or the family goes if they're
-- the only one. Deleting the account removes their membership too.
create function public.delete_my_account() returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  fam uuid;
  heir uuid;
begin
  if uid is null then raise exception 'not-signed-in'; end if;
  select id into fam from public.families where owner_id = uid;
  if fam is not null then
    select user_id into heir from public.family_members
      where family_id = fam and user_id <> uid order by joined_at limit 1;
    if heir is null then
      delete from public.families where id = fam;
    else
      update public.families set owner_id = heir, updated_at = now() where id = fam;
      update public.family_members set role = 'owner' where user_id = heir;
    end if;
  end if;
  delete from auth.users where id = uid;
end $$;

revoke all on function public.my_family(), public.create_family(text, text), public.delete_my_account() from public, anon;
grant execute on function public.my_family(), public.create_family(text, text), public.delete_my_account() to authenticated;
