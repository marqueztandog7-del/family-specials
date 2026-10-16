-- A tiny daily check-in from GitHub Actions, so the free project isn't paused for inactivity (Supabase pauses
-- free projects that get no database use for about a week). It touches a table but returns nothing about it.
create function public.ping() returns text
language plpgsql stable security definer set search_path = '' as $$
begin
  perform 1 from public.families limit 1;
  return 'ok';
end $$;
revoke all on function public.ping() from public;
grant execute on function public.ping() to anon, authenticated;
