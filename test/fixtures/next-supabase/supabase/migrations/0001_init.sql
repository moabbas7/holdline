-- users and their posts
create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  name text not null
);

create table posts (
  id uuid primary key default gen_random_uuid(),
  author_id uuid references public.users (id),
  title text not null
);
