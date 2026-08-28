-- Keepalive GitHub Actions (free tier anti-pausa).
-- L'anon può leggere solo la colonna non sensibile `month` di entries;
-- la policy `using (false)` esclude sempre le righe: l'API torna 200
-- senza esporre alcun dato. Gli altri accessi anon restano vietati.
revoke all on table public.accounts, public.entries, public.budgets, public.profiles from anon, public;
grant select (month) on public.entries to anon;

create policy "entries month for anon keepalive"
  on public.entries for select
  to anon using (false);