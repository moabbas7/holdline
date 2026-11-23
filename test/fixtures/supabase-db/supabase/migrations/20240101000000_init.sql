-- Initial schema
create extension if not exists "pgcrypto";

create type public.member_role as enum ('owner', 'member');

create table public.orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.profiles (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.orgs (id) on delete cascade,
  email varchar(255) not null unique,
  display_name text,
  role public.member_role not null default 'member',
  created_at timestamp with time zone default now()
);

create index profiles_org_id_idx on public.profiles (org_id);

alter table public.profiles enable row level security;

create policy "Profiles are visible to their owner" on public.profiles
  for select to authenticated using (auth.uid() = id);

create policy "Owners update their profile" on public.profiles
  for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);

-- Things holdline must ignore: functions, triggers, DO blocks, grants, data.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email);
  return new;
end;
$$;

do $$ begin
  raise notice 'create table fake_table (id int);';
end $$;

grant select on public.profiles to anon;
insert into public.orgs (name) values ('Acme');
