-- BirdballSavant: development plans and weekly feedback (Supabase)
--
-- Run this once in your Supabase project: Dashboard -> SQL Editor -> New query -> paste -> Run.
-- It is safe to run again (it only adds what's missing and refreshes the rules).
--
-- Who can do what (enforced by the database, not the website):
--   * Coaches (members.role = 'coach'): upload, see and delete every plan; add player emails.
--   * Players (members.role = 'player'): see only the plans for their own player_key; mark them read.
--   * Anyone else, signed in or not: sees nothing.

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
create table if not exists public.members (
  email       text primary key check (email = lower(email)),
  role        text not null check (role in ('coach', 'player')),
  player_key  text,                 -- players: the key in the site's player URLs, e.g. bc-toomey-jack
  coach_id    text,                 -- coaches: creegan, antonelli, housinger, jaksa, burdi, wilder
  name        text,
  created_at  timestamptz not null default now(),
  check (role <> 'player' or player_key is not null)
);

create table if not exists public.plans (
  id          uuid primary key default gen_random_uuid(),
  player_key  text not null,
  kind        text not null check (kind in ('plan', 'feedback')),
  title       text not null,
  week        date,
  file_path   text not null,        -- path inside the private "plans" storage bucket
  coach_name  text,
  created_by  text not null default lower(coalesce(auth.jwt() ->> 'email', '')),
  created_at  timestamptz not null default now(),
  read_at     timestamptz
);
create index if not exists plans_player_idx on public.plans (player_key, created_at desc);

-- ---------------------------------------------------------------------------
-- 2. Who is signed in (helpers used by the rules below)
-- ---------------------------------------------------------------------------
create or replace function public.is_coach() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members
                 where email = lower(auth.jwt() ->> 'email') and role = 'coach');
$$;

create or replace function public.my_player() returns text
language sql stable security definer set search_path = public as $$
  select player_key from public.members
  where email = lower(auth.jwt() ->> 'email') and role = 'player'
  limit 1;
$$;

-- A player marks his own plan as read (the only change a player can make)
create or replace function public.mark_read(plan_id uuid) returns void
language sql volatile security definer set search_path = public as $$
  update public.plans set read_at = coalesce(read_at, now())
  where id = plan_id and player_key = public.my_player();
$$;

revoke all on function public.is_coach() from public;
revoke all on function public.my_player() from public;
revoke all on function public.mark_read(uuid) from public;
grant execute on function public.is_coach() to authenticated;
grant execute on function public.my_player() to authenticated;
grant execute on function public.mark_read(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Row-level security
-- ---------------------------------------------------------------------------
alter table public.members enable row level security;
alter table public.plans   enable row level security;

revoke all on public.members from anon;
revoke all on public.plans   from anon;
grant select, insert, update, delete on public.members to authenticated;
grant select, insert, update, delete on public.plans   to authenticated;

drop policy if exists members_read   on public.members;
drop policy if exists members_write  on public.members;
drop policy if exists members_update on public.members;
drop policy if exists members_delete on public.members;
create policy members_read   on public.members for select to authenticated
  using (email = lower(auth.jwt() ->> 'email') or public.is_coach());
create policy members_write  on public.members for insert to authenticated with check (public.is_coach());
create policy members_update on public.members for update to authenticated using (public.is_coach()) with check (public.is_coach());
create policy members_delete on public.members for delete to authenticated using (public.is_coach());

drop policy if exists plans_read   on public.plans;
drop policy if exists plans_write  on public.plans;
drop policy if exists plans_update on public.plans;
drop policy if exists plans_delete on public.plans;
create policy plans_read   on public.plans for select to authenticated
  using (public.is_coach() or player_key = public.my_player());
create policy plans_write  on public.plans for insert to authenticated with check (public.is_coach());
create policy plans_update on public.plans for update to authenticated using (public.is_coach()) with check (public.is_coach());
create policy plans_delete on public.plans for delete to authenticated using (public.is_coach());

-- ---------------------------------------------------------------------------
-- 4. Private storage for the PDFs (files live at plans/<player_key>/<id>.pdf)
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('plans', 'plans', false, 20971520, array['application/pdf'])
on conflict (id) do update set public = false, file_size_limit = 20971520, allowed_mime_types = array['application/pdf'];

drop policy if exists plans_files_read   on storage.objects;
drop policy if exists plans_files_write  on storage.objects;
drop policy if exists plans_files_update on storage.objects;
drop policy if exists plans_files_delete on storage.objects;
create policy plans_files_read on storage.objects for select to authenticated
  using (bucket_id = 'plans' and (public.is_coach() or (storage.foldername(name))[1] = public.my_player()));
create policy plans_files_write on storage.objects for insert to authenticated
  with check (bucket_id = 'plans' and public.is_coach());
create policy plans_files_update on storage.objects for update to authenticated
  using (bucket_id = 'plans' and public.is_coach()) with check (bucket_id = 'plans' and public.is_coach());
create policy plans_files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'plans' and public.is_coach());

-- ---------------------------------------------------------------------------
-- 5. The coaching staff. Put each coach's real email in place of the placeholder,
--    then run. (Players are added from the website by any coach.)
-- ---------------------------------------------------------------------------
insert into public.members (email, role, coach_id, name) values
  (lower('REPLACE-creegan@bc.edu'),   'coach', 'creegan',   'John Creegan'),
  (lower('REPLACE-antonelli@bc.edu'), 'coach', 'antonelli', 'Matt Antonelli'),
  (lower('REPLACE-housinger@bc.edu'), 'coach', 'housinger', 'Jack Housinger'),
  (lower('REPLACE-jaksa@bc.edu'),     'coach', 'jaksa',     'Nick Jaksa'),
  (lower('REPLACE-burdi@bc.edu'),     'coach', 'burdi',     'Nick Burdi'),
  (lower('REPLACE-wilder@bc.edu'),    'coach', 'wilder',    'Holden Wilder')
on conflict (email) do update set role = 'coach', coach_id = excluded.coach_id, name = excluded.name;

-- Remove any placeholder rows that were run by mistake:
delete from public.members where email like 'replace-%';
