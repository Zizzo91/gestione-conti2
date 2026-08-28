# gestione-conti-main

## Descrizione
Progressive Web App per la gestione dei conti personali con sincronizzazione cloud su **Supabase**. Supporta dark mode, PIN di sicurezza, budget threshold, dashboard finanziaria con grafici interattivi, export CSV, aggiunta/eliminazione dinamica di conti e sincronizzazione cross-device.

## Struttura
```
gestione-conti-main/
├── index.html                    — UI principale (Tailwind, Chart.js)
├── manifest.json                 — PWA manifest
├── sw.js                         — Service Worker
├── config/
│   └── supabase-config.js        — window.SUPABASE_CONFIG {url, anonKey}  ⚠️ gitignored
├── assets/
│   ├── app.js                    — Logica principale (auth Supabase + REST Postgres)
│   └── style.css                 — Stili custom + dark mode + month picker
├── script/
│   └── seed_supabase.py          — Seed/ripristino dati da JSON (usa service_role)
├── supabase/
│   ├── migrations/               — 0001 init schema + RLS, 0002 keepalive anon
│   └── config.toml               — Config CLI
├── data/
│   ├── accounts.json             — Conti (origine dati seed)
│   └── budgets.json              — Soglie budget (origine dati seed)
├── finance-backup.json           — Dati mensili 2023-12 → 2026-07 (origine seed)
└── .github/workflows/keepalive.yml — Anti-pausa free tier Supabase
```

## Stack
- HTML/CSS/JS vanilla, Tailwind CDN, Chart.js + zoom plugin, Hammer.js
- PWA con Service Worker
- Backend: **Supabase** (Postgres + Auth + RLS). Auth via **magic link email (PKCE)** gestita dall'SDK `supabase-js` CDN UMD (global `window.supabase`).

## Database (Supabase, progetto `gfglazxhxxplhoteaahr`)
- `accounts(id PK, label, color, type enum, owner)` — conti; il merge all'avvio fonde cloud + localStorage + DEFAULT_ACCOUNTS
- `entries(month PK 'YYYY-MM', values jsonb in centesimi, note)` — snapshot mensili
- `budgets(month + account_id PK, amount real in euro)` — soglie per mese/conto
- `profiles(id uuid PK → auth.users, email)` — creato via trigger `handle_new_user`
- RLS: solo ruolo `authenticated` legge/scrive; sorgente `anon` può leggere solo `entries.month` (policy `using(false)`: 200 senza dati) per il keepalive
- Sincronizzazione dati/conti/soglie via REST PostgREST (`/rest/v1/...`) con `Authorization: Bearer <access_token>`

## Funzionalità / note operative
- **Autorizzazione dispositivo**: la barra "🔑 Autorizza con email" invia un magic link (`signInWithOtp`, SDK gestisce il redirect PKCE in automatico). Il PIN resta un blocco locale.
- Sessione: salvata in localStorage (chiave `sb-<ref>-auth-token`), refresh automatico (flowType `pkce`).
- Soglie/entries non salvati nel cloud se il dispositivo non è autorizzato (fallback localStorage + toast).
- `script/seed_supabase.py` legge `finance-backup.json` e `data/*.json` e li upserta con la service_role key
- I grafici in modalità "Gruppi" usano il campo `owner` (simone/michela/shared).
- **Segreti**: anon key è pubblica (sta nel frontend/repo/workflow); service_role e db_password stanno SOLO in `Config Utility/supabase-secrets.json` — mai nel repo.