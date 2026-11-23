create table users (
  id uuid primary key,
  first text not null,
  last text not null,
  email text not null
);

create table invoices (
  id uuid primary key,
  user_id uuid not null references users (id),
  total integer not null
);
