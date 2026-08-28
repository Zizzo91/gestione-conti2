-- gestione-conti: schema iniziale
-- Tabelle, funzione trigger e politiche RLS (single-user).

create type public.account_type as enum ('liquidity', 'savings');

-- Conti configurati (gli stessi DEFAULT_ACCOUNTS più quelli creati dall'utente)
create table public.accounts (
  id text primary key,
  label text not null,
  color text not null default '#6b7280',
  type public.account_type not null default 'liquidity',
  owner text not null default 'simone'
);

-- Snapshot mensile dei saldi (valori in centesimi)
create table public.entries (
  month text primary key,                    -- 'YYYY-MM'
  values jsonb not null default '{}',
  note text not null default ''
);

-- Soglie budget mensili per conto (valori in euro, come in data/budgets.json)
create table public.budgets (
  month text not null,
  account_id text not null references public.accounts(id) on delete cascade,
  amount real not null default 0,
  primary key (month, account_id)
);

-- Profili utente (creati automaticamente al primo accesso Supabase Auth)
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  created_at timestamptz not null default now()
);

alter table public.accounts enable row level security;
alter table public.entries enable row level security;
alter table public.budgets enable row level security;
alter table public.profiles enable row level security;

-- Funzione + trigger: crea il profilo al primo accesso dell'utente autenticato
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Politiche RLS
-- Single-user: l'accesso ai dati è consentito a ogni utente autenticato.
-- La connessione anonima non può leggere né scrivere nulla.
create policy "accounts read for authenticated"
  on public.accounts for select
  to authenticated using (true);

create policy "accounts write for authenticated"
  on public.accounts for all
  to authenticated using (true) with check (true);

create policy "entries read for authenticated"
  on public.entries for select
  to authenticated using (true);

create policy "entries write for authenticated"
  on public.entries for all
  to authenticated using (true) with check (true);

create policy "budgets read for authenticated"
  on public.budgets for select
  to authenticated using (true);

create policy "budgets read for authenticated"
  on public.budgets for select
  to authenticated using (true);

create policy "budgets write for authenticated"
  on public.budgets for all
  to authenticated using (true) with check (true);