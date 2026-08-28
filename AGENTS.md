# gestione-conti-main

## Descrizione
Progressive Web App per la gestione dei conti personali con sincronizzazione cloud su **Supabase**, protetta da **login PIN a 6 cifre** (server-side). Supporta dark mode, budget threshold, dashboard finanziaria con grafici interattivi, export CSV, aggiunta/eliminazione dinamica di conti e sincronizzazione cross-device.

## Struttura
```
gestione-conti-main/
├── index.html                    — UI principale (Tailwind, Chart.js); schermata login PIN
├── manifest.json                 — PWA manifest
├── sw.js                         — Service Worker
├── config/
│   └── supabase-config.js        — window.SUPABASE_CONFIG {url, anonKey, pinEmail} (pubblico, committato)
├── assets/
│   ├── app.js                    — Logica principale (auth Supabase + REST Postgres)
│   └── style.css                 — Stili custom + dark mode + month picker + numpad PIN
├── script/
│   └── seed_supabase.py          — Seed/ripristino dati da JSON locale (usa service_role)
├── supabase/
│   ├── migrations/               — 0001 init schema + RLS, 0002 keepalive anon
│   └── config.toml               — Config CLI
├── data/                         — ⚠️ gitignored: solo origine locale del seed
├── finance-backup.json           — ⚠️ gitignored: dati mensili (origine seed), mai nel repo
└── .github/workflows/keepalive.yml — Anti-pausa free tier (URL e anon key da Actions variables)
```

## Stack
- HTML/CSS/JS vanilla, Tailwind CDN, Chart.js + zoom plugin, Hammer.js
- PWA con Service Worker
- Backend: **Supabase** (Postgres + Auth + RLS) — SDK `supabase-js` CDN UMD (global `window.supabase`).

## Login
- **PIN 6 cifre**: il PIN è la PASSWORD dell'account Supabase (`config/supabase-config.js → pinEmail`). Il codice non contiene mai il PIN: vive solo su Supabase (hashed), mai in repo, non clonabile.
- Primo accesso su un dispositivo: se l'utente non esiste ancora viene creato (`signUp`); se Supabase ha "Conferma email" attiva serve cliccare la mail di conferma una volta.
- **Sessione persistente**: dopo il login il dispositivo resta autorizzato (localStorage `sb-<ref>-auth-token`, refresh automatico) → niente PIN nelle aperture successive. Button "🚪 Esci" nell'header per l'uscita.
- Senza sessione valida l'app **non carica né renderizza** alcun dato cloud (schermata di login a schermo intero); il server rifiuta comunque le richieste anon (RLS).
- Non esistono più il vecchio PIN client-side né il flusso magic link.

## Database (Supabase, progetto `gfglazxhxxplhoteaahr`)
- `accounts(id PK, label, color, type enum, owner)` — conti; il merge all'avvio fonde cloud + localStorage + DEFAULT_ACCOUNTS
- `entries(month PK 'YYYY-MM', values jsonb in centesimi, note)` — snapshot mensili
- `budgets(month + account_id PK, amount real in euro)` — soglie per mese/conto
- `profiles(id uuid PK → auth.users, email)` — creato via trigger `handle_new_user`
- RLS: solo ruolo `authenticated` legge/scrive; l'anon può leggere solo `entries.month` (policy `using(false)`: 200 senza dati) per il keepalive
- Sincronizzazione dati/conti/soglie via REST PostgREST (`/rest/v1/...`) con `Authorization: Bearer <access_token>`

## Note operative
- Keepalive generico: le Actions variables del repo `SUPABASE_URL` e `SUPABASE_ANON_KEY` vanno impostate su GitHub (Settings → Secrets and variables → Actions → Variables), altrimenti il workflow si salta con un warning.
- `script/seed_supabase.py` legge i JSON locali (gitignored) e li upserta con la `service_role` key.
- I grafici in modalità "Gruppi" usano il campo `owner` (simone/michela/shared).
- **Segreti**: `config/supabase-config.js` è committato perché serve a GitHub Pages, ma contiene SOLO dati pubblici (url, anon key, `pinEmail` = email di login, funge da username). `service_role` e `db_password` stanno SOLO in `Config Utility/supabase-secrets.json` — mai nel repo/progetto pubblico. I dati finanziari (JSON) non devono MAI essere committati.