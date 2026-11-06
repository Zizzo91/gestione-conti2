# gestione-conti-main

## Descrizione
Progressive Web App per la gestione dei conti personali con sincronizzazione cloud su **Supabase**, protetta da **login PIN a 6 cifre** (server-side). Supporta dark mode, budget threshold, dashboard finanziaria con grafici interattivi, export CSV, aggiunta/eliminazione dinamica di conti e sincronizzazione cross-device.

## Struttura
```
gestione-conti-main/
├── index.html                    — UI principale (Tailwind, Chart.js); schermata login PIN
├── manifest.json                 — PWA manifest (id/scope/start_url, icone locali, shortcut)
├── sw.js                         — Service Worker: network-first sul guscio, cache offline
├── config/
│   └── supabase-config.js        — window.SUPABASE_CONFIG {url, anonKey, pinEmail} (pubblico, committato)
├── assets/
│   ├── app.js                    — Logica principale (auth Supabase + REST Postgres)
│   ├── style.css                 — Stili custom + dark mode + month picker + numpad PIN
│   └── icons/                    — Icone PWA generate (192/512 any + maskable, apple 180, favicon)
├── script/
│   ├── seed_supabase.py          — Seed/ripristino dati da JSON locale (usa service_role)
│   └── generate_icons.py         — Rigenera assets/icons/ (Pillow, nessun'altra dipendenza)
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

## Design system (rebrand "Apple measured")
Palette e superfici derivano dallo studio in `../reverse-brand/out/www.apple.com/` (tokens misurati sul sito Apple). Tutto vive in `assets/style.css` come token CSS; non ci sono immagini di sfondo: gli wallpaper sono gradienti CSS.

- **Token** (`:root` / `.dark`): `--bg`, `--surface*`, `--border*`, `--text*`, `--accent` (`#0071e3` chiaro / `#0a84ff` scuro), `--success`, `--danger`, `--warning`, `--radius` 22px, `--btn-radius` 980px (pillole), `--glass`.
- **Sfondi aurora**: layer fisso `.aurora` (in `index.html`, `z-index:-1`) con radial-gradient giallo `#fdd30f` → ciano `#90ceee` → blu `#2789ff` su base chiara `#fbfbfd` / nera `#000`. Stessa famiglia di gradienti sul backdrop del login (`#loginScreen`), che resta scuro in entrambi i temi.
- **Componenti**: header sticky in vetro (`backdrop-filter`), card `--radius` 22px, eroe patrimonio `.hero-card` (card aurora scura), widget `.widget-card`, pulsanti a pillola, icon-button circolari, tabella con header uppercase.
- **Tipografia**: stack di sistema Apple (`-apple-system`, `SF Pro Text/Display`), letter-spacing negativo sui titoli.
- **Grafici**: colori Chart.js da `chartTheme()` in `app.js` (palette iOS: blu/verde/arancio/rosso/viola); `YEAR_COLORS` e i colori owner sono allineati.
- **Icone PWA**: tessera nera + "€" nel gradiente brand (giallo→ciano→blu), rigenerate da `script/generate_icons.py`.
- **Contrasto**: i testi secondari usano `--text-3`; in dark `--text-2`/`--text-3` sono `#c7c7cc`/`#8e8e93`.

## Note operative
- **PWA / Service Worker**: `sw.js` usa network-first solo per le richieste same-origin del guscio (HTML, CSS, JS, icone, manifest) e mette in cache la risposta buona solo come fallback offline. Le richieste cross-origin (Supabase REST/Auth, CDN Tailwind/Chart.js) non vengono mai intercettate né cacheate, così i dati restano sempre freschi. Per invalidare la cache al deploy cambiare `VERSION` in `sw.js`.
- **Icone**: `assets/icons/` è generato da `script/generate_icons.py` (tessera nera + € nel gradiente brand). Non modificare i PNG a mano: rigenerarli dallo script.
- **theme-color**: il meta `themeColorMeta` è aggiornato da `syncThemeColor()` in `applyDarkMode()` e segue `--bg` (`#fbfbfd` chiaro / `#000000` scuro); anche `manifest.json` usa `#fbfbfd` (`background_color` nero per lo splash).
- Keepalive generico: le Actions variables del repo `SUPABASE_URL` e `SUPABASE_ANON_KEY` vanno impostate su GitHub (Settings → Secrets and variables → Actions → Variables), altrimenti il workflow si salta con un warning.
- `script/seed_supabase.py` legge i JSON locali (gitignored) e li upserta con la `service_role` key.
- I grafici in modalità "Gruppi" usano il campo `owner` (simone/michela/shared).
- **Segreti**: `config/supabase-config.js` è committato perché serve a GitHub Pages, ma contiene SOLO dati pubblici (url, anon key, `pinEmail` = email di login, funge da username). `service_role` e `db_password` stanno SOLO in `Config Utility/supabase-secrets.json` — mai nel repo/progetto pubblico. I dati finanziari (JSON) non devono MAI essere committati.