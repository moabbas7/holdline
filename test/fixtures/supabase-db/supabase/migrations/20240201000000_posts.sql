create table public.posts (
  id bigint generated always as identity primary key,
  author_id uuid not null references public.profiles (id),
  title text not null,
  body text,
  published boolean default false
);

alter table public.posts add constraint posts_title_author_key unique (author_id, title);
create index posts_published_idx on public.posts (published) where published;

alter table public.posts enable row level security;
create policy "Published posts are public" on public.posts for select using (published);

create view public.published_posts as select id, title from public.posts where published;
