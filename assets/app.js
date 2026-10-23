if ('serviceWorker' in navigator)
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(()=>{}));

const DEFAULT_ACCOUNTS = [
  { id:"ccasimone",     label:"CC Arancio Simone",    color:"#2563eb", type:"liquidity", owner:"simone" },
  { id:"casimone",      label:"Conto Arancio Simone", color:"#0ea5e9", type:"savings",    owner:"simone" },
  { id:"traderepublic", label:"Trade Republic",       color:"#3b82f6", type:"liquidity", owner:"simone" },
  { id:"ccamichela",    label:"CC Arancio Michela",   color:"#8b5cf6", type:"liquidity", owner:"michela" },
  { id:"camichela",     label:"Conto Arancio Michela",color:"#ec4899", type:"savings",    owner:"michela" },
  { id:"creditagricole",label:"Credit Agricole",      color:"#14b8a6", type:"liquidity", owner:"shared" }
];

let supabaseConfig = window && window.SUPABASE_CONFIG ? window.SUPABASE_CONFIG : null;
let supabaseSdk = null;

function getSupabaseSdk() {
  if (supabaseSdk) return supabaseSdk;
  if (!supabaseConfig || !window.supabase || !window.supabase.createClient) return null;
  supabaseSdk = window.supabase.createClient(supabaseConfig.url, supabaseConfig.anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, flowType: "pkce" }
  });
  return supabaseSdk;
}

// ─── SESSIONE / AUTH SUPABASE (magic link via email) ─────────────────────────
async function getSessionFromStorage() {
  const sdk = getSupabaseSdk();
  try {
    const { data, error } = await sdk.auth.getSession();
    if (error) return null;
    return data.session || null;
  } catch(e) { return null; }
}
async function saveSessionToStorage(session) {
  const sdk = getSupabaseSdk();
  if (session && session.access_token) {
    try { await sdk.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token || "" }); } catch(_) {}
  } else {
    try { await sdk.auth.signOut(); } catch(_) {}
    try { sdk.auth.stopAutoRefresh(); } catch(_) {}
  }
  return session;
}
async function authFetch(path, opts) {
  const s = await getSessionFromStorage();
  if (!s || !s.access_token) throw new Error("UNR");
  const u = /^https?:\/\//i.test(path) ? path : `${supabaseConfig.url}${path}`;
  const r = await fetch(u, Object.assign({}, opts, {
    headers: Object.assign({}, (opts && opts.headers) || {}, {
      "apikey": supabaseConfig.anonKey,
      "Authorization": `Bearer ${s.access_token}`
    })
  }));
  if (r.status === 401) { saveSessionToStorage(null); throw new Error("UNR"); }
  if (!r.ok) { const txt = await r.text().catch(()=>""); throw new Error(`HTTP ${r.status}`+(txt?`: ${txt.slice(0,120)}`:"") ); }
  return r;
}
// ─── LOGIN: PIN 6 CIFRE (il PIN è la password dell'account Supabase) ─────────────
const PIN_LEN = 6;
let pinBuffer = "";

function pinPad(d) {
  if (pinBuffer.length >= PIN_LEN) return;
  pinBuffer += d;
  updateLoginDots();
  if (pinBuffer.length === PIN_LEN) setTimeout(() => doPinLogin(), 180);
}
function pinPadBackspace() { pinBuffer = pinBuffer.slice(0, -1); updateLoginDots(); }
function pinPadClear()      { pinBuffer = ""; updateLoginDots(); hideLoginError(); }
function updateLoginDots() {
  for (let i = 0; i < PIN_LEN; i++) {
    const el = document.getElementById("ldot" + i);
    if (el) el.classList.toggle("filled", i < pinBuffer.length);
  }
}
function showLoginError(msg) {
  const el = document.getElementById("loginError");
  if (el) { el.textContent = msg; el.classList.remove("hidden"); }
  const card = document.getElementById("loginCard");
  if (card && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    card.classList.remove("shake");
    void card.offsetWidth;
    card.classList.add("shake");
  }
}
function hideLoginError() {
  const el = document.getElementById("loginError");
  if (el) el.classList.add("hidden");
}
function setLoginBusy(busy) {
  const el = document.getElementById("loginTitle");
  if (el) el.textContent = busy ? "Verifica..." : "Accesso protetto";
  hideLoginError();
}

async function doPinLogin() {
  const sdk = getSupabaseSdk();
  const email = (supabaseConfig && supabaseConfig.pinEmail || "").trim().toLowerCase();
  if (!email) { showLoginError("Config mancante (pinEmail)."); return; }
  if (!sdk)   { showLoginError("SDK non disponibile."); return; }
  const password = pinBuffer; pinBuffer = ""; updateLoginDots();
  setLoginBusy(true);
  try {
    let { data, error } = await sdk.auth.signInWithPassword({ email, password });
    if (error && /invalid login credentials/i.test(error.message || "")) {
      const su = await sdk.auth.signUp({ email, password });
      if (su.error) {
        setLoginBusy(false);
        const m = (su.error.message || "").toLowerCase();
        if (/rate limit|troppi tentativi/i.test(m)) {
          showLoginError("Limite momentaneo di Supabase: riprova tra circa un'ora con lo stesso PIN.");
          return;
        }
        if (/weak_password|almeno 8|8 character|too short/i.test(m)) {
          showLoginError("Supabase richiede una password più lunga: imposta 'Minimum password length' a 6 nel dashboard Auth.");
          return;
        }
        if (/already registered/i.test(m)) showLoginError("PIN errato.");
        else showLoginError(su.error.message || "Errore");
        return;
      }
      if (!su.data || !su.data.session) {
        setLoginBusy(false);
        showLoginError("Account creato: verifica l'email di conferma, poi riprova con lo stesso PIN.");
        return;
      }
      data = su.data;
    }
    if (error) { setLoginBusy(false); showLoginError(error.message || "Errore"); return; }
    await applyAuthUI();
    await startApp();
  } catch(e) {
    setLoginBusy(false);
    showLoginError(e && e.message ? e.message : "Errore");
  }
}

async function clearAuthorization() {
  const sdk = getSupabaseSdk();
  try { if (sdk) await sdk.auth.signOut(); } catch(e) {}
}
async function logout() {
  await clearAuthorization();
  window.location.reload();
}

// ─── DATABASE (REST/PostgREST) ────────────────────────────────────────────────
async function selectRows(table, sel, range) {
  const path = `/rest/v1/${table}?select=${sel}` + (range ? `&order=${range}` : "");
  const r = await authFetch(path, {});
  return await r.json();
}
async function upsertRows(table, rows) {
  return await authFetch(`/rest/v1/${table}`, {
    method: "POST",
    headers: { "Prefer": "resolution=merge-duplicates,return=minimal", "Content-Type": "application/json" },
    body: JSON.stringify(rows)
  });
}
async function deleteRows(table, filter) {
  return await authFetch(`/rest/v1/${table}?${filter}`, {
    method: "DELETE",
    headers: { "Prefer": "return=minimal" }
  });
}
function sortByMonth(arr, dir="asc") {
  return [...arr].sort((a,b) => dir==="asc" ? a.month.localeCompare(b.month) : b.month.localeCompare(a.month));
}

let ACCOUNTS = [];

async function loadAccounts() {
  const session = await getSessionFromStorage();
  let cloudRows = null;
  if (session) {
    try {
      const rows = await selectRows("accounts", "id,label,color,type,owner", "id");
      if (Array.isArray(rows)) cloudRows = rows;
    } catch(e) {}
  }
  const deleted = getDeletedAccountIds();
  let localAccounts = [];
  const stored = localStorage.getItem("financeApp_accounts");
  if (stored) {
    try { localAccounts = JSON.parse(stored) || []; } catch(e) {}
  }
  if (cloudRows && cloudRows.length > 0) {
    ACCOUNTS = cloudRows.filter(a => a).map(a => ({...a}));
    const cloudIds = new Set(ACCOUNTS.map(a => a.id));
    const synced = getSyncedAccountIds();
    localAccounts.forEach(la => {
      if (!la || !la.id || deleted.has(la.id) || cloudIds.has(la.id)) return;
      if (!synced.has(la.id)) { ACCOUNTS.push({...la}); cloudIds.add(la.id); }
    });
    const nextSynced = new Set(synced);
    cloudRows.forEach(r => nextSynced.add(r.id));
    setSyncedAccountIds(nextSynced);
  } else if (!session) {
    if (localAccounts.length > 0) ACCOUNTS = localAccounts.filter(a => a && !deleted.has(a.id)).map(a => ({...a}));
    else ACCOUNTS = DEFAULT_ACCOUNTS.filter(a => !deleted.has(a.id)).map(a => ({...a}));
    DEFAULT_ACCOUNTS.forEach(def => {
      if (deleted.has(def.id) || ACCOUNTS.find(a => a.id === def.id)) return;
      ACCOUNTS.push({...def});
    });
  } else {
    ACCOUNTS = localAccounts.filter(a => a && !deleted.has(a.id)).map(a => ({...a}));
    if (ACCOUNTS.length === 0 && cloudRows && cloudRows.length === 0 && deleted.size === 0) {
      ACCOUNTS = DEFAULT_ACCOUNTS.map(a => ({...a}));
    }
  }
  ACCOUNTS.forEach(a => {
    if (!a.owner) {
      if (a.label.includes("Simone")) a.owner = "simone";
      else if (a.label.includes("Michela")) a.owner = "michela";
      else a.owner = "shared";
    }
  });
  selectedChartAccounts = new Set(ACCOUNTS.map(a => a.id));
  saveAccounts();
}

function saveAccounts() {
  localStorage.setItem("financeApp_accounts", JSON.stringify(ACCOUNTS));
}

async function syncAccountsToCloud() {
  if (!await getSessionFromStorage()) return false;
  try {
    await upsertRows("accounts", ACCOUNTS);
    const synced = getSyncedAccountIds();
    ACCOUNTS.forEach(a => synced.add(a.id));
    setSyncedAccountIds(synced);
    return true;
  } catch(e) {
    if (isUnauthorized(e)) showLoginScreen();
    showToast("Salvataggio conti: " + (isUnauthorized(e) ? "dispositivo non autorizzato" : e.message), "error", 5000);
    return false;
  }
}

function getDeletedAccountIds() {
  try {
    const d = localStorage.getItem("financeApp_deletedAccounts");
    return d ? new Set(JSON.parse(d)) : new Set();
  } catch(e) { return new Set(); }
}
function getSyncedAccountIds() {
  try { return new Set(JSON.parse(localStorage.getItem("financeApp_syncedAccountIds") || "[]")); }
  catch(e) { return new Set(); }
}
function setSyncedAccountIds(set) {
  try { localStorage.setItem("financeApp_syncedAccountIds", JSON.stringify([...set])); } catch(e) {}
}
function getSyncedMonths() {
  try { return new Set(JSON.parse(localStorage.getItem("financeApp_syncedMonths") || "[]")); }
  catch(e) { return new Set(); }
}
function setSyncedMonths(set) {
  try { localStorage.setItem("financeApp_syncedMonths", JSON.stringify([...set])); } catch(e) {}
}
function isUnauthorized(e) {
  return ("" + ((e && e.message) || e)).startsWith("UNR");
}
function showLoginScreen() {
  const ls = document.getElementById("loginScreen");
  const lo = document.getElementById("logoutBtn");
  if (ls) ls.classList.remove("hidden");
  if (lo) lo.classList.add("hidden");
  setStatus("Sessione scaduta", "error");
}

const MONTH_NUMS   = ["01","02","03","04","05","06","07","08","09","10","11","12"];
const YEAR_COLORS  = ["#6366f1","#10b981","#f59e0b","#ef4444","#8b5cf6"];

let appData = [];
let budgetsData = { thresholds: [] };
let chartInstance = null;
let donutInstance = null;
let currentChartMode = "single";
let currentChartRange = 0;
let activeCalcInputId = null;
let selectedChartAccounts = new Set();
let sortCol = "month", sortDir = "desc";
let isZoomed = false;

// ─── HELPER: MESE SELEZIONATO ─────────────────────────────────────────────────
function getSelectedMonth() {
  return document.getElementById("inputMonth")?.value || new Date().toISOString().slice(0,7);
}

// ─── HELPER: APRI/CHIUDI MODAL (classList toggle) ─────────────────────────────
function setModalClass(id, open) {
  document.getElementById(id).classList.toggle("active", open);
}

// ─── DARK MODE ────────────────────────────────────────────────────────────────
function applyDarkMode(dark) {
  document.documentElement.classList.toggle("dark", dark);
  const icon=document.getElementById("darkToggleIcon");
  if(icon) icon.textContent = dark ? "☀️" : "🌙";
  else { const btn=document.getElementById("darkToggle"); if(btn) btn.textContent = dark ? "☀️" : "🌙"; }
  localStorage.setItem("darkMode", dark ? "1" : "0");
  if (chartInstance) updateChart();
  if (donutInstance) renderDonutChart();
}
function toggleDarkMode() {
  applyDarkMode(!document.documentElement.classList.contains("dark"));
}

// ─── TOAST ────────────────────────────────────────────────────────────────────
function showToast(msg, type="info", duration=3500) {
  const t = document.createElement("div");
  t.className = `toast toast-${type}`;
  const icon = document.createElement("span");
  icon.textContent = {success:"✅",error:"❌",info:"ℹ️"}[type] || "ℹ️";
  const text = document.createElement("span");
  text.textContent = String(msg == null ? "" : msg);
  t.append(icon, text);
  document.getElementById("toastContainer").appendChild(t);
  requestAnimationFrame(()=>requestAnimationFrame(()=>t.classList.add("show")));
  setTimeout(()=>{ t.classList.remove("show"); setTimeout(()=>t.remove(),400); }, duration);
}

// ─── BADGE STATO MESE ─────────────────────────────────────────────────────────
function updateMonthBadge() {
  const pickerBadge = document.getElementById("monthStatusBadge");
  const liveBadge   = document.getElementById("liveMonthStatusBadge");
  const month = document.getElementById("inputMonth")?.value || "";

  if (!month) {
    if (pickerBadge) { pickerBadge.className = "month-status-badge month-status-hidden"; pickerBadge.textContent = ""; }
    if (liveBadge)   { liveBadge.className = "live-month-status live-month-status-hidden"; liveBadge.textContent = ""; }
    return;
  }

  const exists = appData.some(d => d.month === month);

  if (pickerBadge) {
    if (exists) { pickerBadge.className = "month-status-badge month-status-edit"; pickerBadge.innerHTML = "✏️ Modifica mese già registrato"; }
    else        { pickerBadge.className = "month-status-badge month-status-new";  pickerBadge.innerHTML = "➕ Nuovo mese"; }
  }
  if (liveBadge) {
    if (exists) { liveBadge.className = "live-month-status live-month-status-existing"; liveBadge.innerHTML = `<span class="live-month-dot"></span>Mese già registrato ✅`; }
    else        { liveBadge.className = "live-month-status live-month-status-new";      liveBadge.innerHTML = `<span class="live-month-dot"></span>Nuovo mese ➕`; }
  }
}

// ─── FILL FORM ────────────────────────────────────────────────────────────────
function fillFormWithEntry(entry) {
  if (!entry) {
    ACCOUNTS.forEach(acc => { const el = document.getElementById("input"+acc.id); if(el) el.value = ""; });
    document.getElementById("inputNote").value = "";
  } else {
    ACCOUNTS.forEach(acc => {
      const el = document.getElementById("input"+acc.id);
      const val = entry.values[acc.id] || 0;
      if (el) el.value = val === 0 ? "" : EUR2_FMT.format(val/100);
    });
    document.getElementById("inputNote").value = entry.note || "";
  }
  updateLiveTotal();
}

// ─── AVVIO ────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  await loadAccounts();
  applyDarkMode(localStorage.getItem("darkMode") === "1");
  initUI();
  document.getElementById("calcInputValue").addEventListener("keypress", e=>{ if(e.key==="Enter") applyCalculator(); });
  document.addEventListener("keydown", e=>{ if(e.key==="Escape") { closeCalculator(); closeBudgetModal(); } });
});

// ─── MONTH PICKER CUSTOM ──────────────────────────────────────────────────────
let pickerYear = new Date().getFullYear();
const MONTHS = ['Gen','Feb','Mar','Apr','Mag','Giu','Lug','Ago','Set','Ott','Nov','Dic'];
function formatMonthLabel(val) {
  if (!val) return '';
  const [y, m] = val.split('-');
  return MONTHS[parseInt(m,10)-1] + ' ' + y;
}
function setPickerExpanded(open) {
  const trigger = document.getElementById('monthPickerTrigger');
  if (trigger) trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
}
function toggleMonthPicker() {
  const dp = document.getElementById('monthPickerDropdown');
  if (!dp) return;
  if (dp.parentElement !== document.body) document.body.appendChild(dp);
  if (!dp.classList.contains('hidden')) { dp.classList.add('hidden'); setPickerExpanded(false); return; }
  const monthEl = document.getElementById('inputMonth');
  pickerYear = monthEl && monthEl.value ? parseInt(monthEl.value.split('-')[0],10) : new Date().getFullYear();
  renderMonthPickerGrid();
  dp.classList.remove('hidden');
  setPickerExpanded(true);
  const trigger = document.getElementById('monthPickerTrigger');
  if (trigger) { const rect = trigger.getBoundingClientRect(); dp.style.top = (rect.bottom + 6) + 'px'; dp.style.left = rect.left + 'px'; }
}
function changePickerYear(delta) { pickerYear += delta; renderMonthPickerGrid(); }
function selectMonth(val) {
  const monthEl = document.getElementById('inputMonth');
  if (monthEl) { monthEl.value = val; monthEl.dispatchEvent(new Event('change')); }
  const label = document.getElementById('monthPickerLabel');
  if (label) label.textContent = formatMonthLabel(val);
  const dp = document.getElementById('monthPickerDropdown');
  if (dp) dp.classList.add('hidden');
  setPickerExpanded(false);
}
function renderMonthPickerGrid() {
  const grid = document.getElementById('monthPickerGrid');
  const yearEl = document.getElementById('monthPickerYear');
  if (yearEl) yearEl.textContent = pickerYear;
  if (!grid) return;
  const selected = document.getElementById('inputMonth')?.value || '';
  grid.innerHTML = '';
  for (let i = 0; i < 12; i++) {
    const val = pickerYear + '-' + String(i+1).padStart(2,'0');
    const btn = document.createElement('button');
    btn.type = 'button'; btn.textContent = MONTHS[i];
    const hasData = appData.some(d => d.month === val);
    btn.className = 'picker-month-btn' + (val === selected ? ' selected' : '') + (hasData ? ' has-data' : '');
    btn.setAttribute('aria-selected', val === selected ? 'true' : 'false');
    btn.setAttribute('aria-label', MONTHS[i] + ' ' + pickerYear);
    if (hasData) btn.title = 'Mese già registrato';
    btn.onclick = () => selectMonth(val);
    grid.appendChild(btn);
  }
}
document.addEventListener('click', e => {
  const dp = document.getElementById('monthPickerDropdown');
  const trigger = document.getElementById('monthPickerTrigger');
  if (dp && trigger && !dp.contains(e.target) && !trigger.contains(e.target)) { dp.classList.add('hidden'); setPickerExpanded(false); }
});

// ─── AUTH CHECK ALL'AVVIO (sessione persistente) ──────────────────────────────
// Mostra/nasconde la schermata di login in base alla sessione
async function applyAuthUI() {
  const authed = !!(await getSessionFromStorage());
  const ls = document.getElementById("loginScreen");
  const lo = document.getElementById("logoutBtn");
  if (ls) ls.classList.toggle("hidden", authed);
  if (lo) lo.classList.toggle("hidden", !authed);
  if (authed) setStatus("Cloud collegato", "success");
  return authed;
}

// Avvio dell'app dopo il login (carica e renderizza i dati)
async function startApp() {
  await loadAccounts();
  initUI();
  await loadData();
  await loadBudgets();
  const monthEl = document.getElementById("inputMonth");
  const nowMonth = new Date().toISOString().slice(0,7);
  let startMonth = nowMonth;
  if (!appData.some(d => d.month === nowMonth)) {
    const last = appData.slice().sort((a,b) => b.month.localeCompare(a.month))[0];
    if (last) startMonth = last.month;
  }
  monthEl.value = startMonth;
  document.getElementById('monthPickerLabel').textContent = formatMonthLabel(monthEl.value);
  if (!startApp._monthBound) {
    startApp._monthBound = true;
    monthEl.addEventListener("change", ()=>{
      renderDashboard();
      renderDonutChart();
      populateBudgetForm();
      updateMonthBadge();
      const lbl = document.getElementById('monthPickerLabel'); if (lbl) lbl.textContent = formatMonthLabel(monthEl.value);
      fillFormWithEntry(appData.find(d => d.month === monthEl.value) || null);
    });
  }
  renderDashboard();
  updateLiveTotal();
  updateMonthBadge();
  setChartRange(0);
  fillFormWithEntry(appData.find(d => d.month === monthEl.value) || null);
}

// ─── STATUS ───────────────────────────────────────────────────────────────────
function setStatus(msg, type="neutral") {
  const el = document.getElementById("ghStatus");
  const colors   = {success:"bg-emerald-500",error:"bg-red-500",loading:"bg-blue-500 animate-pulse",neutral:"bg-gray-400"};
  const wrappers = {success:"bg-emerald-50 text-emerald-700",error:"bg-red-50 text-red-700",loading:"bg-blue-50 text-blue-700",neutral:"bg-gray-100 text-gray-500"};
  const dot = document.createElement("span");
  dot.className = `w-2 h-2 rounded-full mr-2 ${colors[type]||colors.neutral}`;
  el.replaceChildren(dot, document.createTextNode(String(msg == null ? "" : msg)));
  el.className  = `inline-flex items-center px-3 py-1 rounded-full text-xs font-medium ${wrappers[type]||wrappers.neutral}`;
}
function showSkeleton(show) {
  document.getElementById("dashboardSkeleton").style.display = show ? "grid" : "none";
}

// ─── UTILS ────────────────────────────────────────────────────────────────────
function escapeHtml(v) {
  return String(v === null || v === undefined ? "" : v).replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
}
function calcTotal(row) { return ACCOUNTS.reduce((s,a)=>s+(row.values[a.id]||0),0); }
function makeNumFmt(opts){
  try { return new Intl.NumberFormat("it-IT",{...opts,useGrouping:"always"}); }
  catch(_) { return new Intl.NumberFormat("it-IT",opts); }
}
const EUR_FMT  = makeNumFmt({style:"currency",currency:"EUR"});
const EUR2_FMT = makeNumFmt({minimumFractionDigits:2});
function parseCurrency(str) {
  if (str === null || str === undefined) return 0;
  let s = String(str).trim();
  if (!s) return 0;
  const neg = s.startsWith("-");
  s = s.replace(/[^\d.,]/g, "");
  if (!s) return 0;
  const comma = s.lastIndexOf(","), dot = s.lastIndexOf(".");
  let norm;
  if (comma !== -1 && dot !== -1) {
    const decSep = comma > dot ? "," : ".";
    norm = s.split(decSep === "," ? "." : ",").join("").replace(decSep, ".");
  } else if (comma !== -1) {
    const parts = s.replace(/,/g, ".").split(".");
    norm = parts.length > 2 ? parts.slice(0, -1).join("") + "." + parts[parts.length-1] : parts.join(".");
  } else if (dot !== -1) {
    const parts = s.split(".");
    const dec = parts.pop();
    norm = dec.length <= 2 ? parts.join("") + "." + dec : parts.join("") + dec;
  } else {
    norm = s;
  }
  const v = parseFloat(norm);
  if (isNaN(v)) return 0;
  return Math.round(v * 100) * (neg ? -1 : 1);
}
function parseAmountEuros(str) { return parseCurrency(str) / 100; }
function formatCurrency(cents) { return EUR_FMT.format((cents || 0) / 100); }
function formatInput(el) {
  const v = parseCurrency(el.value);
  el.value = v === 0 ? "" : EUR2_FMT.format(v / 100);
  updateLiveTotal();
}
function formatDiff(val) {
  if(val===0) return `<span class="text-gray-500 font-bold">= 0,00 €</span>`;
  const sign=val>0?"+":"", cls=val>0?"text-emerald-500":"text-red-400";
  return `<span class="font-bold ${cls}">${sign}${formatCurrency(val)}</span>`;
}
function makeWidget(colorClass, title, subtitle, valueHtml, extraHtml="") {
  return `<div class="bg-white p-5 rounded-xl shadow-sm border border-gray-100 border-l-4 ${colorClass}">
    <p class="text-xs text-gray-500 uppercase font-bold mb-1">${title}</p>
    <p class="text-[11px] text-gray-400 font-medium mb-1">${subtitle}</p>
    <h3 class="text-xl mt-1">${valueHtml}</h3>${extraHtml}</div>`;
}

// ─── TREND ARROW ──────────────────────────────────────────────────────────────
function buildTrendArrow(currTotal, prevTotal) {
  if (prevTotal === 0) return "";
  const diff = currTotal - prevTotal;
  const perc = ((diff / prevTotal) * 100).toFixed(1);
  if (diff === 0) {
    return `<span class="inline-flex items-center gap-1 mt-2 px-2 py-0.5 rounded-full text-xs font-bold bg-slate-700 text-slate-300">
      <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 12h14"/></svg>
      0,0%
    </span>`;
  }
  if (diff > 0) {
    return `<span class="inline-flex items-center gap-1 mt-2 px-2 py-0.5 rounded-full text-xs font-bold bg-emerald-500/20 text-emerald-300">
      <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 15l7-7 7 7"/></svg>
      +${perc}%
    </span>`;
  }
  return `<span class="inline-flex items-center gap-1 mt-2 px-2 py-0.5 rounded-full text-xs font-bold bg-red-500/20 text-red-400">
    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M19 9l-7 7-7-7"/></svg>
    ${perc}%
  </span>`;
}

// ─── FAB ──────────────────────────────────────────────────────────────────────
function scrollToForm() { document.getElementById("entryForm").scrollIntoView({behavior:"smooth", block:"center"}); }
function printDashboard() { window.print(); }

// ─── BUDGET: CONVERTI TABELLA → FORMATO APP ──────────────────────────────────
function budgetsRowsToInternal(rows) {
  const byMonth = {};
  (rows||[]).forEach(r => {
    if (!byMonth[r.month]) byMonth[r.month] = {};
    byMonth[r.month][r.account_id] = r.amount;
  });
  const thresholds = Object.keys(byMonth).sort().map(month => ({ month, accounts: byMonth[month] }));
  return { thresholds };
}

// ─── BUDGET: LOAD ─────────────────────────────────────────────────────────────
async function loadBudgets() {
  try {
    if (await getSessionFromStorage()) {
      const rows = await selectRows("budgets", "month,account_id,amount", "month");
      budgetsData = budgetsRowsToInternal(rows);
      localStorage.setItem("financeApp_budgets", JSON.stringify(budgetsData));
    } else {
      const s = localStorage.getItem("financeApp_budgets");
      budgetsData = s ? JSON.parse(s) : { thresholds: [] };
    }
  } catch(e) {
    const s = localStorage.getItem("financeApp_budgets");
    if (s) budgetsData = JSON.parse(s);
    else budgetsData = { thresholds: [] };
  }
  renderBudgetBanner();
  populateBudgetForm();
}

// ─── BUDGET: GET THRESHOLD FOR MONTH ──────────────────────────────────────────
function getBudgetForMonth(month) {
  const entry = (budgetsData.thresholds || []).find(t => t.month === month);
  return entry ? entry.accounts : null;
}

// ─── BUDGET: CHECK VIOLATIONS ─────────────────────────────────────────────────
function checkBudgetViolations(month, values) {
  const thresholds = getBudgetForMonth(month);
  if (!thresholds) return [];
  return ACCOUNTS.filter(acc => {
    const thresh = thresholds[acc.id];
    if (!thresh || thresh <= 0) return false;
    const val = values[acc.id] || 0;
    return val < Math.round(thresh * 100);
  }).map(acc => ({
    acc,
    threshold: Math.round(thresholds[acc.id] * 100),
    value: values[acc.id] || 0
  }));
}

// ─── BUDGET: BANNER DASHBOARD ─────────────────────────────────────────────────
function renderBudgetBanner() {
  const banner = document.getElementById("budgetAlertBanner");
  if (!banner) return;
  if (appData.length === 0) { banner.classList.add("hidden"); return; }
  const sorted = sortByMonth(appData);
  const latest = sorted[sorted.length - 1];
  const violations = checkBudgetViolations(latest.month, latest.values);
  if (violations.length === 0) { banner.classList.add("hidden"); return; }
  banner.classList.remove("hidden");
  banner.innerHTML = `
    <div class="flex items-start gap-3">
      <span class="text-2xl">⚠️</span>
      <div class="flex-1">
        <p class="font-bold text-red-800 dark:text-red-300 text-sm mb-1">Soglie minime superate — ${escapeHtml(latest.month)}</p>
        <ul class="space-y-1">
          ${violations.map(v=>`
            <li class="text-xs text-red-700 dark:text-red-400 flex justify-between items-center">
              <span><span class="w-2 h-2 rounded-full inline-block mr-1" style="background:${v.acc.color}"></span>${escapeHtml(v.acc.label)}</span>
              <span class="tabular-nums font-bold">${formatCurrency(v.value)} <span class="text-red-400">&lt;</span> soglia ${formatCurrency(v.threshold)}</span>
            </li>`).join("")}
        </ul>
      </div>
    </div>`;
}

// ─── BUDGET: MODAL OPEN/CLOSE ─────────────────────────────────────────────────
function openBudgetModal()  { populateBudgetForm(); setModalClass("budgetModal", true);  }
function closeBudgetModal() { setModalClass("budgetModal", false); }
function handleBudgetBackdrop(e) {
  if (e.target === document.getElementById("budgetModal")) closeBudgetModal();
}

// ─── BUDGET: POPULATE FORM ────────────────────────────────────────────────────
function populateBudgetForm() {
  const month = getSelectedMonth();
  document.getElementById("budgetModalMonth").textContent = month;
  const thresholds = getBudgetForMonth(month) || {};
  ACCOUNTS.forEach(acc => {
    const el = document.getElementById("budget_" + acc.id);
    if (!el) return;
    const v = thresholds[acc.id] || 0;
    el.value = v > 0 ? EUR2_FMT.format(v) : "";
  });
}

// ─── BUDGET: SAVE ─────────────────────────────────────────────────────────────
async function saveBudgets() {
  const month = getSelectedMonth();
  const accounts = {};
  ACCOUNTS.forEach(acc => {
    const el = document.getElementById("budget_" + acc.id);
    const raw = el ? el.value.trim() : "";
    accounts[acc.id] = parseAmountEuros(raw);
  });
  budgetsData.thresholds = (budgetsData.thresholds || []).filter(t => t.month !== month);
  const hasAny = Object.values(accounts).some(v => v > 0);
  if (hasAny) budgetsData.thresholds.push({ month, accounts });
  budgetsData.thresholds.sort((a,b) => a.month.localeCompare(b.month));
  localStorage.setItem("financeApp_budgets", JSON.stringify(budgetsData));
  if (!await getSessionFromStorage()) {
    showToast("Dispositivo non autorizzato: soglie salvate solo in locale.", "error", 5000);
    return;
  }
  let ok = true;
  try {
    await deleteRows("budgets", `month=eq.${month}`);
    const rows = Object.keys(accounts)
      .filter(accId => accounts[accId] > 0)
      .map(accId => ({ month, account_id: accId, amount: accounts[accId] }));
    if (rows.length > 0) await upsertRows("budgets", rows);
  } catch(e) { ok = false; showToast("Errore salvataggio soglie: " + e.message, "error", 5000); }
  if (ok) { closeBudgetModal(); renderBudgetBanner(); showToast("Soglie salvate per " + month, "success"); }
}

// ─── SYNC: SALVA DATI + CONTI + SOGLIE SU SUPABASE ───────────────────────────
async function syncToCloud() {
  if (!await getSessionFromStorage()) { showToast("Dispositivo non autorizzato. Usa l'autorizzazione email.", "error", 6000); return false; }
  setStatus("Salvataggio...","loading");
  try {
    await Promise.all([
      upsertRows("entries", appData),
      upsertRows("accounts", ACCOUNTS),
      upsertRows("budgets", budgetsRowsToSupabase(budgetsData))
    ]);
    const synced = getSyncedMonths();
    appData.forEach(d => synced.add(d.month));
    setSyncedMonths(synced);
    const syncedAccounts = getSyncedAccountIds();
    ACCOUNTS.forEach(a => syncedAccounts.add(a.id));
    setSyncedAccountIds(syncedAccounts);
    setStatus("Salvato!","success");
    return true;
  } catch(e) {
    if (isUnauthorized(e)) showLoginScreen();
    setStatus("Errore Cloud","error");
    showToast("Errore salvataggio: " + e.message, "error", 5000);
    return false;
  }
}

function budgetsRowsToSupabase(data) {
  const rows = [];
  (data.thresholds || []).forEach(t => {
    Object.keys(t.accounts || {}).forEach(accId => {
      if (t.accounts[accId] > 0) rows.push({ month: t.month, account_id: accId, amount: t.accounts[accId] });
    });
  });
  return rows;
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
function renderDashboard() {
  const dashEl = document.getElementById("dashboardWidget");
  if (appData.length===0) { dashEl.classList.add("hidden"); return; }
  dashEl.classList.remove("hidden");
  const sorted = sortByMonth(appData);
  const selectedMonth = getSelectedMonth();
  let selectedIndex = sorted.length-1, selectedMonthFound=false;
  if (selectedMonth) { const idx=sorted.findIndex(d=>d.month===selectedMonth); if(idx!==-1){selectedIndex=idx;selectedMonthFound=true;} }
  const current=sorted[selectedIndex], prev=selectedIndex>0?sorted[selectedIndex-1]:null;
  const currentYear=parseInt(current.month.substring(0,4),10);
  let yearStartData=null;
  const decPrevYear=`${currentYear-1}-12`;
  const decPrevIdx=sorted.findIndex(d=>d.month===decPrevYear);
  if(decPrevIdx!==-1) yearStartData=sorted[decPrevIdx];
  else { const f=sorted.find(d=>d.month.startsWith(String(currentYear))); if(f&&f.month!==current.month) yearStartData=f; }
  const currTotal=calcTotal(current);
  const currLiq=ACCOUNTS.filter(a=>a.type==="liquidity").reduce((s,a)=>s+(current.values[a.id]||0),0);
  const prevTotal=prev?calcTotal(prev):0;
  const yearStartTotal=yearStartData?calcTotal(yearStartData):0;
  const diff1=prev?currTotal-prevTotal:null;
  const diffYTD=yearStartData?currTotal-yearStartTotal:null;
  const percLiq=currTotal>0?Math.round((currLiq/currTotal)*100):0;
  const percSav=100-percLiq;
  const titleMonth=selectedMonthFound?current.month:(selectedMonth?`Ultimo: ${current.month}`:current.month);
  const missingNote=(!selectedMonthFound&&selectedMonth)?`<p class="text-xs text-amber-400 font-semibold mt-1">Mese senza dati</p>`:"";
  let ytdPercStr="";
  if(yearStartData&&yearStartTotal>0){
    const p=((diffYTD/yearStartTotal)*100).toFixed(1);
    ytdPercStr=`<span class="text-xs font-bold ${p>0?"text-emerald-500 bg-emerald-50":"text-red-500 bg-red-50"} ml-2 px-1.5 py-0.5 rounded">${p>0?"+":""}${p}%</span>`;
  }
  const ytdSub=yearStartData?(decPrevIdx!==-1?`Da Dic. ${currentYear-1}`:yearStartData.month):"inizio anno";
  const last6=sorted.slice(Math.max(0,selectedIndex-5),selectedIndex+1);
  const sparkData=last6.map(d=>calcTotal(d)/100);
  const sparkSvg=buildSparkline(sparkData, currTotal>prevTotal||prev===null);
  const trendArrow = prev ? buildTrendArrow(currTotal, prevTotal) : "";
  dashEl.innerHTML=`
    <div class="bg-slate-900 p-5 rounded-xl shadow-sm border border-slate-800 border-l-4 border-l-emerald-500 relative overflow-hidden lg:col-span-2">
      <div class="absolute bottom-0 right-0 opacity-20">${sparkSvg}</div>
      <p class="text-xs text-slate-400 uppercase font-bold mb-1">Patrimonio (${escapeHtml(titleMonth)})</p>
      <div class="flex items-center gap-3 flex-wrap">
        <h3 class="text-3xl font-black text-white">${formatCurrency(currTotal)}</h3>
        ${trendArrow}
      </div>
      ${missingNote}
      <p class="text-xs text-slate-500 mt-2">Trend ultimi mesi</p>
    </div>
    ${makeWidget("border-l-amber-400","Anno in corso (YTD)",escapeHtml(ytdSub),
      diffYTD!==null?`${formatDiff(diffYTD)}${ytdPercStr}`:`<span class="text-gray-400 text-sm">Dati insufficienti</span>`)}
    ${makeWidget("border-l-blue-400","Mese precedente",
      prev?`${escapeHtml(prev.month)} → ${escapeHtml(current.month)}`:escapeHtml(current.month),
      diff1!==null?formatDiff(diff1):`<span class="text-gray-400 text-sm">Dati insufficienti</span>`)}
    ${makeWidget("border-l-emerald-500","Allocazione",escapeHtml(current.month),`
      <div class="flex justify-between items-end -mt-1">
        <div><span class="text-sm font-bold text-gray-700">${percLiq}%</span> <span class="text-xs text-gray-500">Liq.</span></div>
        <div><span class="text-sm font-bold text-emerald-600">${percSav}%</span> <span class="text-xs text-gray-500">Risp.</span></div>
      </div>
      <div class="w-full bg-gray-100 rounded-full h-2 mt-1 flex overflow-hidden">
        <div class="bg-gray-400 h-2" style="width:${percLiq}%"></div>
        <div class="bg-emerald-500 h-2" style="width:${percSav}%"></div>
      </div>`,"")}`
  ;
  renderBudgetBanner();
}

// ─── SPARKLINE ────────────────────────────────────────────────────────────────
function buildSparkline(data, positive=true) {
  if (data.length < 2) return "";
  const W=120, H=40, pad=2;
  const min=Math.min(...data), max=Math.max(...data);
  const range=max-min||1;
  const pts=data.map((v,i)=>{
    const x=pad+(i/(data.length-1))*(W-pad*2);
    const y=H-pad-((v-min)/range)*(H-pad*2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const color=positive?"#34d399":"#f87171";
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

// ─── LIVE TOTAL ───────────────────────────────────────────────────────────────
function updateLiveTotal() {
  const total=ACCOUNTS.reduce((s,acc)=>{ const el=document.getElementById("input"+acc.id); return s+(el?parseCurrency(el.value):0); },0);
  const badge=document.getElementById("liveTotalBadge");
  if(badge){ badge.innerText=formatCurrency(total); badge.classList.add("scale-105"); setTimeout(()=>badge.classList.remove("scale-105"),200); }
}

// ─── LOAD DATA ────────────────────────────────────────────────────────────────
async function loadData() {
  setStatus("Sincronizzazione...","loading"); showSkeleton(true);
  try {
    if (await getSessionFromStorage()) {
      const rows = await selectRows("entries", "month,values,note", "month");
      const cloud = Array.isArray(rows) ? rows.map(r => ({ month: r.month, values: r.values || {}, note: r.note || "" })) : [];
      let local = [];
      const s = localStorage.getItem("financeApp_data");
      if (s) { try { local = JSON.parse(s); } catch(_) {} }
      const synced = getSyncedMonths();
      const byMonth = new Map(cloud.map(d => [d.month, d]));
      (Array.isArray(local) ? local : []).forEach(d => {
        if (!d || !d.month || byMonth.has(d.month)) return;
        if (!synced.has(d.month)) byMonth.set(d.month, d);
      });
      appData = [...byMonth.values()].sort((a,b) => a.month.localeCompare(b.month));
      localStorage.setItem("financeApp_data", JSON.stringify(appData));
      const nextSynced = new Set(synced);
      cloud.forEach(d => nextSynced.add(d.month));
      setSyncedMonths(nextSynced);
      setStatus(appData.length>0 ? "Sincronizzato" : "Cloud collegato", "success");
    } else {
      const s=localStorage.getItem("financeApp_data");
      if(s){appData=JSON.parse(s);setStatus("Modalità offline (nessun login)","neutral");}
      else setStatus("Nessun dato","neutral");
    }
  } catch(e) {
    if (isUnauthorized(e)) { showSkeleton(false); showLoginScreen(); return; }
    const s=localStorage.getItem("financeApp_data");
    if(s){appData=JSON.parse(s);setStatus("Offline","neutral");}
    else setStatus("Nessun dato","neutral");
  }
  showSkeleton(false);
  renderAll();
  updateMonthBadge();
}

// ─── SYNC SUPABASE (dati + conti + soglie) ────────────────────────────────────
async function syncAll() {
  const ok = await syncToCloud();
  if (ok) {
    showToast("Dati salvati su Supabase!","success");
    const btn=document.getElementById("saveBtn"), bTxt=document.getElementById("saveBtnText"), bIco=document.getElementById("saveBtnIcon");
    if(btn){
      const ot=bTxt.innerText, oi=bIco.innerHTML;
      btn.style.background="#059669"; bTxt.innerText="Salvato!";
      bIco.innerHTML=`<svg class="w-6 h-6 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>`;
      setTimeout(()=>{ btn.style.background=""; bTxt.innerText=ot; bIco.innerHTML=oi; },3000);
    }
    setTimeout(()=>setStatus("Pronto","neutral"),3000);
  }
  return ok;
}

// ─── SAVE DATA ────────────────────────────────────────────────────────────────
async function saveData() {
  const month = getSelectedMonth();
  if (!month) { showToast("Seleziona un mese.","error"); return; }
  const values = {};
  let any = false;
  ACCOUNTS.forEach(acc => {
    const el = document.getElementById("input"+acc.id);
    const v = el ? parseCurrency(el.value) : 0;
    values[acc.id] = v;
    if (v !== 0) any = true;
  });
  if (!any) { showToast("Inserisci almeno un valore.","error"); return; }
  const exists = appData.some(d => d.month === month);
  const violations = checkBudgetViolations(month, values);
  const msgs = [];
  if (exists) msgs.push(`Dati per ${month} già presenti: verranno sovrascritti.`);
  if (violations.length > 0) {
    const list = violations.map(v => `• ${v.acc.label}: ${formatCurrency(v.value)} (soglia: ${formatCurrency(v.threshold)})`).join("\n");
    msgs.push(`⚠️ Conti sotto la soglia minima:\n\n${list}`);
  }
  if (msgs.length > 0 && !confirm(msgs.join("\n\n") + "\n\nVuoi salvare comunque?")) {
    showToast("Salvataggio annullato, dati invariati.", "info");
    return;
  }
  const note = document.getElementById("inputNote").value.trim();
  appData = appData.filter(d => d.month !== month);
  appData.push({ month, values, note });
  appData.sort((a,b) => b.month.localeCompare(a.month));
  localStorage.setItem("financeApp_data", JSON.stringify(appData));
  renderAll();
  updateMonthBadge();
  const ok = await syncAll();
  if (ok) resetForm();
}
function resetForm() {
  fillFormWithEntry(null);
}

// ─── INIT UI ──────────────────────────────────────────────────────────────────
function initUI() {
  const container=document.getElementById("accountInputsContainer");
  const filtersContainer=document.getElementById("multiSelectFilters");
  container.innerHTML="";
  const filterAll=document.getElementById("filter-all").parentElement;
  filtersContainer.innerHTML=""; filtersContainer.appendChild(filterAll);
  ACCOUNTS.forEach(acc=>{
    const div=document.createElement("div");
    div.className="account-card group relative";
    div.innerHTML=`
      <label for="input${acc.id}" class="block text-xs font-bold text-gray-500 uppercase mb-1">${escapeHtml(acc.label)}</label>
      <div class="flex items-center">
        <input type="text" inputmode="decimal" id="input${acc.id}" placeholder="0,00 €"
          onblur="formatInput(this)" oninput="updateLiveTotal()"
          class="w-full text-lg tabular-nums text-gray-800 focus:outline-none border-b border-transparent focus:border-indigo-500 transition-colors bg-transparent pr-8">
        <button type="button" onclick="openCalculator('input${acc.id}')"
          class="absolute right-3 text-gray-400 hover:text-indigo-600 bg-gray-50 hover:bg-indigo-50 p-1.5 rounded-md transition-all" title="Calcolatrice" aria-label="Calcolatrice per ${escapeHtml(acc.label)}">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z"></path></svg>
        </button>
        <button type="button" onclick="deleteAccount('${acc.id}')"
          class="absolute -top-1.5 -right-1.5 w-5 h-5 bg-red-400 hover:bg-red-600 text-white rounded-full flex items-center justify-center text-xs opacity-0 group-hover:opacity-100 transition-opacity shadow-sm" title="Elimina conto">&times;</button>
      </div>`;
    container.appendChild(div);
    const lbl=document.createElement("label");
    lbl.className="checkbox-badge cursor-pointer relative";
    lbl.innerHTML=`<input type="checkbox" value="${acc.id}" class="sr-only" onchange="toggleAccountFilter('${acc.id}',this.checked)">
      <div class="flex items-center px-3 py-1.5 text-xs font-medium rounded-full border border-gray-200 bg-white text-gray-600 transition-colors">
        <span class="w-2 h-2 rounded-full mr-2" style="background-color:${acc.color}"></span>
        ${escapeHtml(acc.label).replace("Conto Corrente","CC").replace("Conto","C.")}</div>`;
    filtersContainer.appendChild(lbl);
  });
  const addCard=document.createElement("div");
  addCard.className="account-card flex items-center justify-center border-dashed cursor-pointer hover:border-indigo-400";
  addCard.innerHTML=`<button type="button" onclick="openAddAccountModal()" class="flex items-center gap-2 text-indigo-500 hover:text-indigo-700 font-semibold text-sm py-2"><svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg> Aggiungi Conto</button>`;
  container.appendChild(addCard);
  const headerRow=document.querySelector("thead tr");
  const totalHeader=headerRow.querySelector("th.text-indigo-700");
  while(headerRow.children.length>3) headerRow.removeChild(headerRow.children[1]);
  document.getElementById("headerPlaceholder")?.remove();
  ACCOUNTS.forEach(acc=>{
    const th=document.createElement("th");
    th.className="py-3 px-2 text-left font-semibold text-gray-600 border-b hidden md:table-cell";
    th.scope="col";
    th.innerText=acc.label.replace("Conto Corrente","CC").replace("Conto","C.");
    headerRow.insertBefore(th,totalHeader);
  });
  const noteTh=document.createElement("th");
  noteTh.className="py-3 px-3 text-left font-semibold text-gray-600 border-b hidden xl:table-cell";
  noteTh.scope="col";
  noteTh.innerText="Note";
  headerRow.insertBefore(noteTh,totalHeader);
  syncFilterUI();
  buildBudgetForm();
}

// ─── BUDGET: BUILD FORM (una tantum) ──────────────────────────────────────────
function buildBudgetForm() {
  const container = document.getElementById("budgetInputsContainer");
  if (!container) return;
  container.innerHTML = "";
  ACCOUNTS.forEach(acc => {
    const div = document.createElement("div");
    div.className = "flex items-center justify-between gap-3 py-2 border-b border-gray-100 last:border-0";
    div.innerHTML = `
      <label for="budget_${acc.id}" class="flex items-center gap-2 text-sm font-medium text-gray-700 min-w-0 flex-1">
        <span class="w-3 h-3 rounded-full flex-shrink-0" style="background:${acc.color}"></span>
        <span class="truncate">${escapeHtml(acc.label)}</span>
      </label>
      <div class="flex items-center gap-1 flex-shrink-0">
        <input type="text" inputmode="decimal" id="budget_${acc.id}" placeholder="0,00"
          class="w-32 text-right tabular-nums text-sm border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-amber-300 focus:border-amber-400 dark:bg-slate-700 dark:border-slate-500">
        <span class="text-xs text-gray-400">€</span>
      </div>`;
    container.appendChild(div);
  });
}

// ─── GESTIONE CONTI (AGGIUNTA/ELIMINAZIONE) ────────────────────────────────────
function openAddAccountModal() {
  document.getElementById("newAccountName").value = "";
  setModalClass("addAccountModal", true);
}
function closeAddAccountModal() {
  setModalClass("addAccountModal", false);
}
function handleAddAccountBackdrop(e) {
  if (e.target === document.getElementById("addAccountModal")) closeAddAccountModal();
}
function addNewAccount() {
  const name = document.getElementById("newAccountName").value.trim();
  if (!name) { showToast("Inserisci un nome per il conto.", "error"); return; }
  const owner = document.querySelector('input[name="newAccountOwner"]:checked')?.value;
  if (!owner) { showToast("Seleziona l'intestatario.", "error"); return; }
  const type = document.querySelector('input[name="newAccountType"]:checked')?.value;
  if (!type) { showToast("Seleziona il tipo di conto.", "error"); return; }
  let id = name.toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (!id) id = 'conto';
  let counter = 0;
  let uniqueId = id;
  while (ACCOUNTS.find(a => a.id === uniqueId)) {
    counter++;
    uniqueId = id + counter;
  }
  const ownerColors = { simone:"#10b981", michela:"#f59e0b", shared:"#f97316" };
  const newAccount = { id:uniqueId, label:name, color:ownerColors[owner]||"#6b7280", type:type, owner:owner };
  const deleted = getDeletedAccountIds();
  if (deleted.delete(uniqueId)) localStorage.setItem("financeApp_deletedAccounts", JSON.stringify([...deleted]));
  ACCOUNTS.push(newAccount);
  selectedChartAccounts.add(uniqueId);
  saveAccounts();
  syncAccountsToCloud();
  initUI();
  renderAll();
  updateLiveTotal();
  updateMonthBadge();
  closeAddAccountModal();
  showToast(`Conto "${name}" aggiunto!`, "success");
}

async function deleteAccount(id) {
  const acc = ACCOUNTS.find(a => a.id === id);
  if (!acc) return;
  if (!confirm(`Eliminare il conto "${acc.label}"?\nI dati rimarranno nello storico ma il conto non sarà più visibile.`)) return;
  const deleted = getDeletedAccountIds();
  deleted.add(id);
  localStorage.setItem("financeApp_deletedAccounts", JSON.stringify([...deleted]));
  ACCOUNTS = ACCOUNTS.filter(a => a.id !== id);
  selectedChartAccounts.delete(id);
  saveAccounts();
  initUI();
  renderAll();
  updateLiveTotal();
  updateMonthBadge();
  if (await getSessionFromStorage()) {
    try {
      await deleteRows("accounts", `id=eq.${encodeURIComponent(id)}`);
    } catch(e) {
      showToast("Eliminazione conto dal cloud fallita: " + e.message, "error", 5000);
      return;
    }
  }
  showToast(`Conto "${acc.label}" eliminato.`, "info");
}

// ─── FILTRI ───────────────────────────────────────────────────────────────────
function toggleAccountFilter(id,checked){ checked?selectedChartAccounts.add(id):selectedChartAccounts.delete(id); document.getElementById("filter-all").checked=selectedChartAccounts.size===ACCOUNTS.length; updateChart(); }
function toggleAllFilters(cb){
  const cbs=document.querySelectorAll('#multiSelectFilters input[type="checkbox"]:not(#filter-all)');
  if(cb.checked){ACCOUNTS.forEach(a=>selectedChartAccounts.add(a.id));cbs.forEach(c=>c.checked=true);}
  else{selectedChartAccounts.clear();cbs.forEach(c=>c.checked=false);}
  updateChart();
}
function syncFilterUI(){
  document.getElementById("filter-all").checked=selectedChartAccounts.size===ACCOUNTS.length;
  document.querySelectorAll('#multiSelectFilters input[type="checkbox"]:not(#filter-all)').forEach(cb=>cb.checked=selectedChartAccounts.has(cb.value));
}

// ─── RANGE FILTRO GRAFICO ─────────────────────────────────────────────────────
function setChartRange(months) {
  currentChartRange=months;
  [3,6,12,0].forEach(m=>{
    const btn=document.getElementById("range-"+m);
    if(btn) btn.className=m===months
      ?"px-3 py-1 text-xs rounded-full bg-indigo-600 text-white shadow-sm"
      :"px-3 py-1 text-xs rounded-full text-gray-600 hover:bg-gray-200 dark:text-gray-300 dark:hover:bg-slate-600";
  });
  updateChart();
}
function getFilteredData() {
  const sorted=sortByMonth(appData);
  if(currentChartRange===0||sorted.length<=currentChartRange) return sorted;
  return sorted.slice(sorted.length-currentChartRange);
}

// ─── RESET ZOOM ───────────────────────────────────────────────────────────────
function resetChartZoom() {
  if(chartInstance) { chartInstance.resetZoom(); isZoomed=false; document.getElementById("resetZoomBtn").style.display="none"; }
}

// ─── CALCOLATRICE ─────────────────────────────────────────────────────────────
function handleModalBackdrop(e){if(e.target===document.getElementById("calcModal"))closeCalculator();}
function openCalculator(inputId){
  activeCalcInputId=inputId;
  const acc=ACCOUNTS.find(a=>"input"+a.id===inputId);
  const label=acc?acc.label:"";
  const val=parseCurrency(document.getElementById(inputId).value);
  document.getElementById("calcModalTitle").innerText=`Calcolatrice – ${label}`;
  document.getElementById("calcCurrentValue").innerText=val===0?"0,00 €":formatCurrency(val);
  document.getElementById("calcInputValue").value="";
  setModalClass("calcModal", true);
  document.getElementById("calcInputValue").focus();
}
function closeCalculator(){ setModalClass("calcModal", false); activeCalcInputId=null; }
function applyCalculator(){
  if(!activeCalcInputId)return;
  const el=document.getElementById(activeCalcInputId);
  const raw=document.getElementById("calcInputValue").value;
  if(!raw.trim()){closeCalculator();return;}
  const final=Math.max(0,parseCurrency(el.value)+parseCurrency(raw));
  el.value=final===0?"":EUR2_FMT.format(final/100);
  el.focus(); setTimeout(()=>el.blur(),100); closeCalculator();
}

// ─── RENDER ALL ───────────────────────────────────────────────────────────────
function renderAll(){renderDashboard();renderTable();updateChart();renderDonutChart();}

// ─── TABELLA + SORT ───────────────────────────────────────────────────────────
function sortTable(col){
  if(sortCol===col) sortDir=sortDir==="asc"?"desc":"asc";
  else{sortCol=col;sortDir=col==="month"?"desc":"asc";}
  document.querySelectorAll("th.sortable").forEach(th=>{
    th.classList.remove("asc","desc");
    if(th.dataset.col===col) th.classList.add(sortDir);
  });
  renderTable();
}
function renderTable(){
  const tbody=document.getElementById("dataTableBody");
  tbody.innerHTML="";
  document.getElementById("emptyState").classList.toggle("hidden",appData.length>0);
  const sorted=sortByMonth(appData, sortCol==="month" ? sortDir : "asc").sort((a,b)=>{
    if(sortCol==="total") return sortDir==="asc"?calcTotal(a)-calcTotal(b):calcTotal(b)-calcTotal(a);
    return 0;
  });
  sorted.forEach(row=>{
    const rowTotal=calcTotal(row);
    const thresholds=getBudgetForMonth(row.month);
    const safeMonth=/^\d{4}-\d{2}$/.test(row.month||"")?row.month:"";
    const accCells=ACCOUNTS.map(acc=>{
      const v=row.values[acc.id]||0;
      const thresh=thresholds?Math.round((thresholds[acc.id]||0)*100):0;
      const alert=thresh>0&&v<thresh;
      return `<td class="py-4 px-2 hidden md:table-cell tabular-nums text-xs ${alert?'text-red-500 font-bold':'text-gray-600'}">${v===0?"–":formatCurrency(v)}${alert?' ⚠️':''}</td>`;
    }).join("");
    const tr=document.createElement("tr");
    tr.className="hover:bg-gray-50 transition-colors";
    tr.innerHTML=
      `<td class="py-4 px-4 font-medium text-indigo-900 whitespace-nowrap">${escapeHtml(row.month)}</td>`+
      accCells+
      `<td class="py-4 px-3 text-gray-500 text-xs italic max-w-[140px] truncate hidden xl:table-cell" title="${escapeHtml(row.note||"")}"> ${escapeHtml(row.note||"–")}</td>`+
      `<td class="py-4 px-3 text-right font-bold text-indigo-700 tabular-nums text-xs whitespace-nowrap">${formatCurrency(rowTotal)}</td>`+
      `<td class="py-3 px-3 text-right whitespace-nowrap no-print">`+
      `<div class="table-actions">`+
      `<button type="button" onclick="editEntry('${safeMonth}')" class="table-action-btn" aria-label="Modifica ${escapeHtml(row.month)}">Modifica</button>`+
      `<button type="button" onclick="deleteEntry('${safeMonth}')" class="table-action-btn danger" aria-label="Elimina ${escapeHtml(row.month)}">Elimina</button>`+
      `</div></td>`;
    tbody.appendChild(tr);
  });
  renderMobileHistory();
}
function renderMobileHistory(){
  const el=document.getElementById("mobileHistory");
  if(!el) return;
  el.innerHTML="";
  if(appData.length===0) return;
  const chrono=sortByMonth(appData);
  const rows=chrono.slice().reverse();
  rows.forEach(row=>{
    const total=calcTotal(row);
    const idx=chrono.findIndex(d=>d.month===row.month);
    const prev=idx>0?chrono[idx-1]:null;
    const diff=prev?total-calcTotal(prev):null;
    const safeMonth=/^\d{4}-\d{2}$/.test(row.month||"")?row.month:"";
    const thresholds=getBudgetForMonth(row.month)||{};
    const accs=ACCOUNTS.map(acc=>({acc,v:row.values[acc.id]||0})).filter(x=>x.v!==0);
    const shown=accs.slice(0,4);
    const rest=accs.length-shown.length;
    const accHtml=shown.map(({acc,v})=>{
      const thresh=Math.round((thresholds[acc.id]||0)*100);
      const alert=thresh>0&&v<thresh;
      const color=/^#[0-9a-f]{3,8}$/i.test(acc.color||"")?acc.color:"#64748b";
      return `<div class="month-card-acc"><span class="month-card-dot" style="background-color:${color}"></span><span>${escapeHtml(acc.label)}</span><b class="${alert?'text-red-500':''}">${formatCurrency(v)}</b></div>`;
    }).join("")+(rest>0?`<div class="month-card-acc"><span class="month-card-dot" style="background:var(--border-strong)"></span><span>+${rest} altri</span></div>`:"");
    const deltaHtml=diff===null?"":`<p class="month-card-delta ${diff>=0?'up':'down'}">${diff>=0?"+":""}${formatCurrency(diff)} vs mese prec.</p>`;
    const card=document.createElement("article");
    card.className="month-card";
    card.innerHTML=
      `<div class="month-card-top">
        <div class="min-w-0">
          <p class="month-card-month">${escapeHtml(row.month)}</p>
          ${deltaHtml}
        </div>
        <p class="month-card-total">${formatCurrency(total)}</p>
      </div>`+
      (accHtml?`<div class="month-card-accounts">${accHtml}</div>`:"")+
      (row.note?`<p class="month-card-note" title="${escapeHtml(row.note)}">${escapeHtml(row.note)}</p>`:"")+
      `<div class="month-card-actions">
        <button type="button" onclick="editEntry('${safeMonth}')">Modifica</button>
        <button type="button" class="danger" onclick="deleteEntry('${safeMonth}')">Elimina</button>
      </div>`;
    el.appendChild(card);
  });
}
function toggleHistory(){
  const c=document.getElementById("historyContent"), a=document.getElementById("toggleHistoryBtn").querySelector("svg"), b=document.getElementById("toggleHistoryBtn");
  c.classList.toggle("active");
  const open=c.classList.contains("active");
  a.style.transform=open?"rotate(180deg)":"rotate(0deg)";
  if (b) b.setAttribute("aria-expanded", open ? "true" : "false");
}
async function deleteEntry(month){
  if(!confirm(`Eliminare i dati di ${month}?`))return;
  appData=appData.filter(d=>d.month!==month);
  localStorage.setItem("financeApp_data",JSON.stringify(appData));
  renderAll();
  if (await getSessionFromStorage()) {
    try {
      await deleteRows("entries", `month=eq.${month}`);
      const synced = getSyncedMonths();
      synced.delete(month);
      setSyncedMonths(synced);
      showToast("Registrazione eliminata dal cloud", "success");
    }
    catch(e) { showToast("Eliminazione cloud fallita: " + e.message, "error", 5000); }
  }
}
function editEntry(month){
  const e=appData.find(d=>d.month===month); if(!e)return;
  const monthEl=document.getElementById("inputMonth");
  monthEl.value=e.month;
  pickerYear=parseInt(e.month.slice(0,4),10);
  const lbl=document.getElementById("monthPickerLabel"); if(lbl) lbl.textContent=formatMonthLabel(e.month);
  fillFormWithEntry(e);
  updateMonthBadge();
  renderDashboard(); renderDonutChart();
  window.scrollTo({top:0,behavior:"smooth"});
}

// ─── EXPORT CSV ───────────────────────────────────────────────────────────────
function exportToCSV(){
  if(appData.length===0){showToast("Nessun dato.","error");return;}
  const headers=["Mese",...ACCOUNTS.map(a=>a.label),"Note","Totale"];
  let csv=headers.join(";")+"\n";
  sortByMonth(appData,"desc").forEach(row=>{
    let total=0;
    const cells=[row.month];
    ACCOUNTS.forEach(acc=>{const v=row.values[acc.id]||0;total+=v;cells.push(`"${(v/100).toFixed(2).replace(".",",")}"`)});
    let note=row.note||"";
    if(note.includes(";")||note.includes('"')||note.includes(",")||note.includes("\n")) note='"'+note.replace(/"/g,'""')+'"';
    else if(note) note=`"${note}"`;
    cells.push(note,`"${(total/100).toFixed(2).replace(".",",")}"`);
    csv+=cells.join(";")+"\n";
  });
  const blob=new Blob([new Uint8Array([0xEF,0xBB,0xBF]),"sep=;\n"+csv],{type:"text/csv;charset=utf-8;"});
  const a=document.createElement("a"); a.href=URL.createObjectURL(blob);
  a.download=`Gestione_Conti_${new Date().toISOString().slice(0,10)}.csv`; a.click();
  showToast("CSV esportato!","success");
}

// ─── DONUT CHART ──────────────────────────────────────────────────────────────
function renderDonutChart(){
  if(appData.length===0)return;
  const isDark=document.documentElement.classList.contains("dark");
  const surface=(getComputedStyle(document.documentElement).getPropertyValue("--surface").trim()||"#fff");
  const tickColor=isDark?"#8b9ab3":"#6b7280";
  const sorted=sortByMonth(appData);
  const sel=getSelectedMonth();
  let target=sorted[sorted.length-1];
  if(sel){const f=sorted.find(d=>d.month===sel);if(f)target=f;}
  document.getElementById("donutMonthLabel").innerText="Dettaglio mese: "+target.month;
  const labels=[],data=[],bgColors=[];
  ACCOUNTS.forEach(acc=>{const v=target.values[acc.id]||0;if(v>0){labels.push(acc.label);data.push(v/100);bgColors.push(acc.color);}});
  if(donutInstance){
    donutInstance.data.labels=labels;
    donutInstance.data.datasets[0].data=data;
    donutInstance.data.datasets[0].backgroundColor=bgColors;
    donutInstance.data.datasets[0].borderColor=surface;
    if(donutInstance.options.plugins.legend?.labels) donutInstance.options.plugins.legend.labels.color=tickColor;
    donutInstance.update();
  }
  else{
    donutInstance=new Chart(document.getElementById("donutChart").getContext("2d"),{
      type:"doughnut",
      data:{labels,datasets:[{data,backgroundColor:bgColors,borderWidth:2,borderColor:surface}]},
      options:{responsive:true,maintainAspectRatio:false,cutout:"65%",
        onClick:(_,elements)=>{
          if(!elements.length)return;
          const acc=ACCOUNTS.find(a=>a.label===donutInstance.data.labels[elements[0].index]);if(!acc)return;
          if(currentChartMode!=="single")setChartMode("single");
          selectedChartAccounts.clear();selectedChartAccounts.add(acc.id);syncFilterUI();updateChart();
          document.getElementById("financeChart").scrollIntoView({behavior:"smooth",block:"center"});
        },
        plugins:{legend:{position:"bottom",labels:{boxWidth:12,color:tickColor,font:{size:11}}},
          tooltip:{callbacks:{label(ctx){const tot=ctx.dataset.data.reduce((a,b)=>a+b,0);return ` ${EUR_FMT.format(ctx.parsed)} (${((ctx.parsed/tot)*100).toFixed(1)}%)`;}}
        }}
      }
    });
  }
}

// ─── LINE CHART ───────────────────────────────────────────────────────────────
function setChartMode(mode){
  currentChartMode=mode;
  ["single","type","aggregated","total","variation","compare"].forEach(m=>{
    const btn=document.getElementById("tab-"+m);
    if(btn) btn.className=m===mode?"px-3 py-1.5 text-xs rounded-full bg-indigo-600 text-white shadow-sm":"px-3 py-1.5 text-xs rounded-full text-gray-600 hover:bg-white dark:text-gray-300";
  });
  document.getElementById("chartFilterContainer").style.display=mode==="single"?"flex":"none";
  updateChart();
}
function updateChart(){
  const isDark=document.documentElement.classList.contains("dark");
  const gridColor=isDark?"rgba(255,255,255,.08)":"rgba(0,0,0,.06)";
  const tickColor=isDark?"#94a3b8":"#6b7280";
  const filtered=getFilteredData();
  const labels=filtered.map(d=>d.month);
  if(!chartInstance){
    chartInstance=new Chart(document.getElementById("financeChart").getContext("2d"),{
      type:"line",data:{labels:[],datasets:[]},
      options:{
        responsive:true,maintainAspectRatio:false,
        interaction:{mode:"index",intersect:false},
        plugins:{
          legend:{position:"bottom",labels:{color:tickColor,usePointStyle:true,pointStyle:"circle",boxWidth:8}},
          tooltip:{callbacks:{
            label(ctx){ return (ctx.dataset.label||"")+": "+EUR_FMT.format(ctx.parsed.y); },
            footer(items){const note=filtered[items[0].dataIndex]?.note;return note?"\n📌 "+note:"";}
          }},
          zoom:{
            pan:{enabled:true,mode:"x",onPan(){isZoomed=true;document.getElementById("resetZoomBtn").style.display="block";}},
            zoom:{wheel:{enabled:true,speed:0.1},pinch:{enabled:true},mode:"x",onZoom(){isZoomed=true;document.getElementById("resetZoomBtn").style.display="block";}}
          }
        },
        scales:{
          x:{ticks:{color:tickColor},grid:{color:gridColor}},
          y:{beginAtZero:true,ticks:{color:tickColor,callback:v=>makeNumFmt({notation:"compact",style:"currency",currency:"EUR"}).format(v)},grid:{color:gridColor}}
        }
      }
    });
  }
  const opts=chartInstance.options;
  opts.plugins.legend.labels.color=tickColor;
  opts.scales.x.ticks.color=tickColor; opts.scales.x.grid.color=gridColor;
  opts.scales.y.ticks.color=tickColor; opts.scales.y.grid.color=gridColor;
  const isStacked=["type","aggregated"].includes(currentChartMode);
  opts.scales.x.stacked=isStacked; opts.scales.y.stacked=isStacked;
  let datasets=[];
  if(currentChartMode==="single"){
    ACCOUNTS.filter(a=>selectedChartAccounts.has(a.id)).forEach(acc=>{
      datasets.push({label:acc.label,data:filtered.map(d=>(d.values[acc.id]||0)/100),borderColor:acc.color,backgroundColor:acc.color+"22",fill:false,tension:0.35,borderWidth:2.5,pointRadius:filtered.length<=12?4:2,pointHoverRadius:6,pointBackgroundColor:acc.color});
    });
  } else if(currentChartMode==="type"){
    const mk=t=>filtered.map(d=>ACCOUNTS.filter(a=>a.type===t).reduce((s,a)=>s+(d.values[a.id]||0)/100,0));
    datasets.push({label:"Liquidità (CC)",data:mk("liquidity"),borderColor:"#64748b",backgroundColor:"rgba(100,116,139,.15)",fill:true,tension:.4});
    datasets.push({label:"Risparmio",data:mk("savings"),borderColor:"#10b981",backgroundColor:"rgba(16,185,129,.15)",fill:true,tension:.4});
  } else if(currentChartMode==="aggregated"){
    [{name:"Totale Simone",owner:"simone",color:"#8b5cf6"},{name:"Totale Michela",owner:"michela",color:"#f97316"}].forEach(g=>{
      datasets.push({label:g.name,data:filtered.map(d=>ACCOUNTS.filter(a=>a.owner===g.owner).reduce((s,a)=>s+(d.values[a.id]||0)/100,0)),borderColor:g.color,backgroundColor:g.color+"26",fill:true,tension:.4});
    });
  } else if(currentChartMode==="total"){
    datasets.push({label:"Patrimonio Netto",data:filtered.map(d=>ACCOUNTS.reduce((s,a)=>s+(d.values[a.id]||0)/100,0)),borderColor:isDark?"#34d399":"#0f766e",backgroundColor:isDark?"rgba(52,211,153,.12)":"rgba(15,118,110,.1)",fill:true,tension:.4,borderWidth:3});
  } else if(currentChartMode==="variation"){
    const all=sortByMonth(appData);
    const data=filtered.map(d=>{ const idx=all.findIndex(x=>x.month===d.month); if(idx===0)return 0; return ACCOUNTS.reduce((s,a)=>s+(d.values[a.id]||0)-(all[idx-1].values[a.id]||0),0)/100; });
    datasets.push({type:"bar",label:"Variazione Mensile",data,backgroundColor:data.map(v=>v>=0?"#10b981":"#ef4444")});
  } else if(currentChartMode==="compare"){
    const allSorted=sortByMonth(appData);
    const years=[...new Set(allSorted.map(d=>d.month.substring(0,4)))].sort();
    const compareLabels=MONTH_NUMS.map((_,i)=>MONTHS[i]);
    years.forEach((yr,i)=>{
      const data=MONTH_NUMS.map(m=>{ const row=allSorted.find(d=>d.month===`${yr}-${m}`); return row?ACCOUNTS.reduce((s,a)=>s+(row.values[a.id]||0),0)/100:null; });
      datasets.push({label:yr,data,borderColor:YEAR_COLORS[i%YEAR_COLORS.length],backgroundColor:"transparent",fill:false,tension:.4,spanGaps:false,borderWidth:2.5,pointRadius:3,pointHoverRadius:6});
    });
    chartInstance.data.labels=compareLabels;
    chartInstance.data.datasets=datasets;
    opts.scales.x.stacked=false; opts.scales.y.stacked=false;
    chartInstance.update(); return;
  }
  chartInstance.options.plugins.tooltip.callbacks.footer=items=>{ const note=filtered[items[0].dataIndex]?.note; return note?"\n📌 "+note:""; };
  chartInstance.data.labels=labels;
  chartInstance.data.datasets=datasets;
  chartInstance.update();
}

// ─── Tastiera fisica durante il login PIN (opzionale: aggiuntiva al tastierino/touch) ─────────
document.addEventListener("keydown", function(e){
  const ls = document.getElementById("loginScreen");
  if (!ls || ls.classList.contains("hidden")) return;
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return;
  if (e.repeat) return; // ignora la ripetizione di un tasto tenuto premuto
  if (/^[0-9]$/.test(e.key)) { e.preventDefault(); pinPad(e.key); }
  else if (e.key === "Backspace") { e.preventDefault(); pinPadBackspace(); }
  else if (e.key === "Escape") { e.preventDefault(); pinPadClear(); }
  else if (e.key === "Enter" && pinBuffer.length > 0) { e.preventDefault(); doPinLogin(); }
});
