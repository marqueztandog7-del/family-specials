-- Profiles: an optional name, seen only by the person themselves (the family sees nicknames, not names).
-- Changes go through update_my_profile(), which can also change the person's nickname in their family.

create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  name text check (name is null or char_length(name) between 1 and 60),
  updated_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
create policy "people see only their own profile" on public.profiles
  for select to authenticated using (user_id = (select auth.uid()));

create function public.my_profile() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('name', (select p.name from public.profiles p where p.user_id = auth.uid()))
$$;

-- p_nickname null leaves the nickname alone; an empty name clears the name.
create function public.update_my_profile(p_name text, p_nickname text default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  n text := nullif(btrim(coalesce(p_name, '')), '');
  nick text := btrim(coalesce(p_nickname, ''));
begin
  if uid is null then raise exception 'not-signed-in'; end if;
  if n is not null and char_length(n) > 60 then raise exception 'name-length'; end if;
  insert into public.profiles (user_id, name, updated_at) values (uid, n, now())
    on conflict (user_id) do update set name = excluded.name, updated_at = now();
  if p_nickname is not null then
    if char_length(nick) not between 1 and 30 then raise exception 'nickname-length'; end if;
    update public.family_members set nickname = nick where user_id = uid;
  end if;
  return public.my_profile();
end $$;

revoke all on function public.my_profile(), public.update_my_profile(text, text) from public, anon;
grant execute on function public.my_profile(), public.update_my_profile(text, text) to authenticated;
