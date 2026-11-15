create schema if not exists construction;

create table if not exists construction.users (
  id bigint generated always as identity primary key,
  name text not null check (char_length(name) between 1 and 120),
  email text not null unique check (char_length(email) <= 254),
  password_hash text not null,
  role text not null default 'customer' check (role in ('customer', 'admin')),
  created_at timestamptz not null default now()
);

create table if not exists construction.enquiries (
  id bigint generated always as identity primary key,
  name text not null check (char_length(name) between 1 and 120),
  phone text not null check (char_length(phone) between 5 and 40),
  customer_email text references construction.users (email) on update cascade on delete set null,
  location text not null default '' check (char_length(location) <= 120),
  plot_size text not null default '' check (char_length(plot_size) <= 120),
  message text not null default '' check (char_length(message) <= 5000),
  status text not null default 'new' check (status in ('new', 'contacted', 'in_progress', 'closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists construction.projects (
  id bigint generated always as identity primary key,
  project_name text not null check (char_length(project_name) between 1 and 160),
  customer_email text not null references construction.users (email) on update cascade on delete cascade,
  location text not null check (char_length(location) between 1 and 200),
  status text not null default 'planning' check (status in ('planning', 'in_progress', 'on_hold', 'completed')),
  progress integer not null default 0 check (progress between 0 and 100),
  estimated_cost numeric(14, 2) check (estimated_cost is null or estimated_cost >= 0),
  next_milestone text not null default '' check (char_length(next_milestone) <= 240),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists enquiries_status_created_idx
  on construction.enquiries (status, created_at desc);
create index if not exists projects_customer_updated_idx
  on construction.projects (customer_email, updated_at desc);

grant usage on schema construction to anon, authenticated, service_role;
grant select, insert, update, delete on all tables in schema construction to service_role;
grant usage, select on all sequences in schema construction to service_role;

alter default privileges in schema construction
  grant select, insert, update, delete on tables to service_role;
alter default privileges in schema construction
  grant usage, select on sequences to service_role;
