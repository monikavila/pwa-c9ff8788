'use strict';
/* Finances — personal transactions app.
 * Data lives in IndexedDB on each device and (optionally) in one file in the user's Dropbox app folder,
 * optionally encrypted with AES-256-GCM. No other server is involved. */

// ---------- helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const now = () => Date.now();
const rid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + now().toString(36));
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayStr = () => ymd(new Date());
const fold = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
const slug = s => fold(s).replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
const nf = new Intl.NumberFormat('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = n => nf.format(n);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = ym => `${MONTHS[+ym.slice(5, 7) - 1]} ${ym.slice(0, 4)}`;
const dayLabel = d => new Date(d + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v;
  let s = String(v).trim().replace(/[\s'’ ]/g, '').replace(/^[A-Z]{3}|[A-Z]{3}$/gi, '');
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (/-$/.test(s)) { neg = true; s = s.slice(0, -1); }
  const lc = s.lastIndexOf(','), ld = s.lastIndexOf('.');
  s = lc > ld ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  const n = parseFloat(s);
  if (isNaN(n)) return null;
  return neg ? -Math.abs(n) : n;
}

function normDate(v) {
  if (v instanceof Date && !isNaN(v)) return ymd(new Date(v.getTime() + 12 * 3600e3));
  if (typeof v === 'number' && v > 20000 && v < 80000) return new Date(Math.round((v - 25569) * 86400e3)).toISOString().slice(0, 10);
  const s = String(v || '').trim();
  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  if ((m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})\b/))) {
    let y = m[3]; if (y.length === 2) y = '20' + y;
    return `${y}-${pad(m[2])}-${pad(m[1])}`;
  }
  return null;
}

// ---------- local storage ----------
const kv = {
  _db: null,
  db() {
    return this._db ||= new Promise((res, rej) => {
      const r = indexedDB.open('finances', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  },
  async get(k) { const db = await this.db(); return new Promise((res, rej) => { const r = db.transaction('kv').objectStore('kv').get(k); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  async set(k, v) { const db = await this.db(); return new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); }); },
};

// device-only settings (never synced)
const S = Object.assign({ appKey: '', refreshToken: '', accessToken: '', expiresAt: 0, passphrase: '', lastSync: 0, mappings: {} },
  JSON.parse(localStorage.getItem('fin.settings') || '{}'));
const saveSettings = () => localStorage.setItem('fin.settings', JSON.stringify(S));

// ---------- data model ----------
// DATA = { v, tx:{id:Tx}, cats:{id:Cat}, rules:{id:Rule} }; every item has ua (updated at) and optional del (tombstone).
let DATA = null;

const DEFAULT_CATEGORIES = [
  ['Groceries', 'expense', '#43a047'], ['Restaurants & cafés', 'expense', '#fb8c00'], ['Transport', 'expense', '#1e88e5'],
  ['Health insurance', 'expense', '#8e24aa'], ['Health & pharmacy', 'expense', '#d81b60'], ['Shopping', 'expense', '#6d4c41'],
  ['Housing & utilities', 'expense', '#546e7a'], ['Phone & subscriptions', 'expense', '#00acc1'], ['Baby & kids', 'expense', '#fbc02d'],
  ['Taxes', 'expense', '#e53935'], ['Bank fees', 'expense', '#9e9e9e'], ['Credit card bill', 'expense', '#3949ab'],
  ['Leisure & travel', 'expense', '#7cb342'], ['Other expense', 'expense', '#bdbdbd'],
  ['Salary', 'income', '#2e7d32'], ['Other income', 'income', '#66bb6a'],
  ['Transfers (own accounts)', 'transfer', '#78909c'],
];
const DEFAULT_RULES = [
  ['COOP', 'Groceries'], ['MIGROS', 'Groceries'], ['DENNER', 'Groceries'], ['ALDI', 'Groceries'], ['LIDL', 'Groceries'],
  ['MANOR FOOD', 'Groceries'], ['AIME POULY', 'Groceries'],
  ['SBB', 'Transport'], ['TPG', 'Transport'], ['PARKINGPAY', 'Transport'], ['UNIRESO', 'Transport'], ['MOBILITY', 'Transport'],
  ['ASSURA', 'Health insurance'], ['VISANA', 'Health insurance'],
  ['PHARMACIE', 'Health & pharmacy'], ['SUN STORE', 'Health & pharmacy'], ['AMAVITA', 'Health & pharmacy'], ['MEDECINS', 'Health & pharmacy'],
  ['SV (SUISSE)', 'Restaurants & cafés'], ['GELATO', 'Restaurants & cafés'], ['STARBUCKS', 'Restaurants & cafés'],
  ['DIGITEC', 'Shopping'], ['GALAXUS', 'Shopping'], ['ZALANDO', 'Shopping'], ['DECATHLON', 'Shopping'], ['SOESTRENE', 'Shopping'], ['IKEA', 'Shopping'],
  ['SPOTIFY', 'Phone & subscriptions'], ['WINGO', 'Phone & subscriptions'], ['SWISSCOM', 'Phone & subscriptions'], ['NETFLIX', 'Phone & subscriptions'],
  ['4MYBABY', 'Baby & kids'], ['ETAT DE GENEVE', 'Taxes'], ['DECOMPTE DES PRIX', 'Bank fees'],
  ['XXXX XXXX XXXX', 'Credit card bill'], ['SALAIRE', 'Salary'],
];

function seedData() {
  // Deterministic ids + ua=1 so seeds from two devices merge cleanly and any later edit wins.
  const d = { v: 1, tx: {}, cats: {}, rules: {} };
  for (const [name, kind, color] of DEFAULT_CATEGORIES) { const id = 'c:' + slug(name); d.cats[id] = { id, name, kind, color, ua: 1 }; }
  for (const [pattern, cat] of DEFAULT_RULES) { const id = 'r:' + slug(pattern); d.rules[id] = { id, pattern, cat: 'c:' + slug(cat), ua: 1 }; }
  return d;
}

const live = m => Object.values(m || {}).filter(x => !x.del);
const liveTx = () => live(DATA.tx);
const liveCats = () => live(DATA.cats).sort((a, b) => kindOrder(a.kind) - kindOrder(b.kind) || a.name.localeCompare(b.name));
const kindOrder = k => ({ expense: 0, income: 1, transfer: 2 }[k] ?? 3);
const cat = id => (id && DATA.cats[id] && !DATA.cats[id].del) ? DATA.cats[id] : null;

function mergeMaps(a = {}, b = {}) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) if (!out[k] || (v.ua || 0) > (out[k].ua || 0)) out[k] = v;
  return out;
}
const mergeData = (a, b) => ({ v: 1, tx: mergeMaps(a.tx, b.tx), cats: mergeMaps(a.cats, b.cats), rules: mergeMaps(a.rules, b.rules) });
function localAhead(local, remote) {
  for (const key of ['tx', 'cats', 'rules']) {
    const r = remote[key] || {};
    for (const [k, v] of Object.entries(local[key] || {})) if (!r[k] || (v.ua || 0) > (r[k].ua || 0)) return true;
  }
  return false;
}

async function commit() {
  await kv.set('data', DATA);
  renderAll();
  schedulePush();
}

// ---------- classification rules ----------
function sortedRules() {
  return live(DATA.rules).filter(r => r.pattern && cat(r.cat)).map(r => ({ ...r, P: fold(r.pattern) }))
    .sort((a, b) => b.P.length - a.P.length);
}
const haystack = t => fold(`${t.merchant} ${t.desc} ${t.type}`);
// a rule only gives an expense category to money going out, and an income category to money coming in
function fits(t, catId) { const k = cat(catId)?.kind; return k === 'transfer' || (k === 'expense' ? t.amount < 0 : k === 'income' ? t.amount > 0 : false); }
function matchCat(t, rules = sortedRules()) {
  const h = haystack(t);
  for (const r of rules) if (h.includes(r.P) && fits(t, r.cat)) return r.cat;
  return null;
}
function applyRulesToUncategorised() {
  const rules = sortedRules(); let n = 0;
  for (const t of liveTx()) if (!t.cat) { const c = matchCat(t, rules); if (c) { t.cat = c; t.ua = now(); n++; } }
  return n;
}

// ---------- encryption ----------
const te = new TextEncoder(), td = new TextDecoder();
function b64(buf) { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); }
function unb64(s) { const b = atob(s); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
const b64url = buf => b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const ITER = 310000;
async function deriveKey(pass, salt, iter = ITER) {
  const base = await crypto.subtle.importKey('raw', te.encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function serialize(data) {
  const plain = JSON.stringify(data);
  if (!S.passphrase) return plain;
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await deriveKey(S.passphrase, salt), te.encode(plain));
  return JSON.stringify({ format: 'finances-encrypted', v: 1, kdf: 'PBKDF2-SHA256', iter: ITER, salt: b64(salt), iv: b64(iv), data: b64(ct) });
}
class NeedPassword extends Error {}
async function deserialize(text) {
  const o = JSON.parse(text);
  if (o.format !== 'finances-encrypted') return { data: o, encrypted: false };
  if (!S.passphrase) throw new NeedPassword('Your Dropbox data is encrypted. Enter the password in Settings.');
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(o.iv) }, await deriveKey(S.passphrase, unb64(o.salt), o.iter), unb64(o.data));
    return { data: JSON.parse(td.decode(pt)), encrypted: true };
  } catch { throw new NeedPassword('Wrong encryption password for the Dropbox data. Check it in Settings.'); }
}

// ---------- Dropbox ----------
const DBX_FILE = '/finances.json';
const isStandalone = () => window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
const Dbx = {
  connected: () => !!(S.appKey && S.refreshToken),
  redirectUri: () => location.origin + location.pathname,
  async startAuth() {
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
    const challenge = b64url(await crypto.subtle.digest('SHA-256', te.encode(verifier)));
    // In the installed phone app, redirects open outside the app, so use the copy-the-code flow there.
    const manual = isStandalone();
    localStorage.setItem('fin.pkce', JSON.stringify({ verifier, manual }));
    const p = new URLSearchParams({ client_id: S.appKey, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', token_access_type: 'offline' });
    if (!manual) p.set('redirect_uri', this.redirectUri());
    const url = 'https://www.dropbox.com/oauth2/authorize?' + p;
    if (manual) { window.open(url, '_blank'); $('#dbxManual').classList.remove('hidden'); }
    else location.href = url;
  },
  async finishAuth(code) {
    const st = JSON.parse(localStorage.getItem('fin.pkce') || 'null');
    if (!st) throw new Error('Login session expired. Press Connect again.');
    const body = new URLSearchParams({ code: code.trim(), grant_type: 'authorization_code', code_verifier: st.verifier, client_id: S.appKey });
    if (!st.manual) body.set('redirect_uri', this.redirectUri());
    const r = await fetch('https://api.dropboxapi.com/oauth2/token', { method: 'POST', body });
    if (!r.ok) throw new Error('Dropbox login failed: ' + (await r.text()).slice(0, 200));
    const j = await r.json();
    Object.assign(S, { refreshToken: j.refresh_token, accessToken: j.access_token, expiresAt: now() + (j.expires_in - 60) * 1000 });
    saveSettings(); localStorage.removeItem('fin.pkce');
  },
  async token() {
    if (S.accessToken && now() < S.expiresAt) return S.accessToken;
    const r = await fetch('https://api.dropboxapi.com/oauth2/token', { method: 'POST',
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: S.refreshToken, client_id: S.appKey }) });
    if (!r.ok) {
      if (r.status === 400 || r.status === 401) { this.disconnect(); throw new Error('Dropbox access was revoked. Connect again in Settings.'); }
      throw new Error('Dropbox token refresh failed (' + r.status + ')');
    }
    const j = await r.json();
    S.accessToken = j.access_token; S.expiresAt = now() + (j.expires_in - 60) * 1000; saveSettings();
    return S.accessToken;
  },
  async download() {
    const r = await fetch('https://content.dropboxapi.com/2/files/download', { method: 'POST',
      headers: { Authorization: 'Bearer ' + await this.token(), 'Dropbox-API-Arg': JSON.stringify({ path: DBX_FILE }) } });
    if (r.status === 409) { const t = await r.text(); if (t.includes('not_found')) return null; throw new Error('Dropbox: ' + t.slice(0, 200)); }
    if (!r.ok) throw new Error('Dropbox download failed (' + r.status + ')');
    const meta = JSON.parse(r.headers.get('Dropbox-API-Result') || '{}');
    return { text: await r.text(), rev: meta.rev };
  },
  async upload(text, rev) {
    const mode = rev ? { '.tag': 'update', update: rev } : { '.tag': 'add' };
    const r = await fetch('https://content.dropboxapi.com/2/files/upload', { method: 'POST',
      headers: { Authorization: 'Bearer ' + await this.token(), 'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': JSON.stringify({ path: DBX_FILE, mode, autorename: false, mute: true, strict_conflict: true }) },
      body: text });
    if (r.status === 409) return { conflict: true };
    if (!r.ok) throw new Error('Dropbox upload failed (' + r.status + ')');
    return { rev: (await r.json()).rev };
  },
  disconnect() { Object.assign(S, { refreshToken: '', accessToken: '', expiresAt: 0 }); saveSettings(); renderSettings(); setStatus(); },
};

// ---------- sync ----------
let syncing = false, again = false, pushTimer = null;
function setStatus(kind, msg) {
  const p = $('#syncPill'); p.className = 'pill';
  if (!Dbx.connected()) { p.textContent = 'Local only'; p.title = 'Not connected to Dropbox'; return; }
  const map = { busy: ['Syncing…', 'busy'], pending: ['Unsaved changes', 'busy'], ok: ['Synced ✓', 'ok'], err: ['Sync problem', 'err'], offline: ['Offline', 'err'] };
  const [txt, cls] = map[kind] || map.ok;
  p.textContent = txt; p.classList.add(cls); p.title = msg || txt;
}
function schedulePush() {
  if (!Dbx.connected()) return;
  setStatus('pending'); clearTimeout(pushTimer); pushTimer = setTimeout(sync, 1200);
}
async function sync() {
  if (!Dbx.connected()) { setStatus(); return; }
  if (syncing) { again = true; return; }
  syncing = true; setStatus('busy');
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      const remote = await Dbx.download();
      let remoteData = null, remoteEncrypted = false;
      if (remote) ({ data: remoteData, encrypted: remoteEncrypted } = await deserialize(remote.text));
      const merged = remoteData ? mergeData(remoteData, DATA) : DATA;
      const needUpload = !remoteData || localAhead(DATA, remoteData) || remoteEncrypted !== !!S.passphrase;
      DATA = merged; await kv.set('data', DATA);
      if (!needUpload) break;
      const up = await Dbx.upload(await serialize(DATA), remote?.rev);
      if (!up.conflict) break;            // someone else wrote in between: download, merge and try again
      if (attempt === 3) throw new Error('Could not save after several tries; try again.');
    }
    S.lastSync = now(); saveSettings();
    setStatus('ok'); renderAll();
  } catch (e) {
    console.warn(e);
    setStatus(navigator.onLine ? 'err' : 'offline', e.message);
    if (e instanceof NeedPassword) toast(e.message, 5000);
  } finally {
    syncing = false;
    if (again) { again = false; sync(); }
  }
}

// ---------- file import ----------
function detectDelimiter(text) {
  const sample = text.split(/\r?\n/).slice(0, 40).join('\n');
  const counts = [';', ',', '\t'].map(d => [d, sample.split(d).length]);
  return counts.sort((a, b) => b[1] - a[1])[0][0];
}
function parseCSV(text) {
  const d = detectDelimiter(text), rows = [];
  let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c;
    } else if (c === '"' && f === '') q = true;
    else if (c === d) { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows;
}
async function readSheet(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.csv') || name.endsWith('.txt')) {
    let text = await file.text();
    if (text.includes('�')) text = new TextDecoder('windows-1252').decode(await file.arrayBuffer());
    return parseCSV(text.replace(/^﻿/, ''));
  }
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' });
}

const FIELDS = [
  ['date', 'Date *'], ['amount', 'Amount (signed)'], ['debit', 'Debit / money out'], ['credit', 'Credit / money in'],
  ['desc', 'Description *'], ['type', 'Description 2 (type)'], ['details', 'Details'], ['id', 'Bank transaction no.'], ['currency', 'Currency'],
];
function findHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const r = rows[i].map(c => String(c ?? '').trim());
    if (r.filter(Boolean).length >= 3 && r.some(c => /date|datum|fecha|data/i.test(c))) return i;
  }
  return 0;
}
function guessMapping(header) {
  const H = header.map(h => fold(h).toLowerCase().trim());
  const find = (re, not) => H.findIndex(h => re.test(h) && !(not && not.test(h)));
  const firstOf = (...res) => { for (const re of res) { const i = find(re); if (i >= 0) return i; } return -1; };
  const descs = H.map((h, i) => /desc|libell|text|beschreib|detail|merchant|benefic|concepto|motif|payee|name/.test(h) ? i : -1).filter(i => i >= 0);
  const m = {
    date: firstOf(/date de transaction|transaction date|transaktionsdatum/, /^date$|^datum$|^fecha$/, /date|datum|fecha/),
    amount: find(/montant|amount|betrag|importe|monto/, /sous|sub|teil/),
    debit: find(/debit|belastung|lastschrift|withdraw|ausgang|cargo/),
    credit: find(/credit|gutschrift|deposit|eingang|abono/),
    desc: descs[0] ?? -1, type: descs[1] ?? -1, details: descs[2] ?? -1,
    id: find(/no de transaction|transaction (id|no|number)|transaktions-?nr|referen/),
    currency: find(/devise|currency|wahrung|moneda|^ccy$/),
  };
  if (m.debit >= 0 || m.credit >= 0) m.amount = m.amount >= 0 && m.debit < 0 ? m.amount : -1;
  return m;
}

function rowsToTx(rows, hdr, m) {
  const out = [], seen = {}; let skipped = 0;
  const cell = (r, i) => (i >= 0 ? r[i] : '');
  for (const r of rows.slice(hdr + 1)) {
    if (!r || !r.some(c => String(c ?? '').trim())) continue;
    const date = normDate(cell(r, m.date));
    let amount = null;
    if (m.amount >= 0) amount = num(cell(r, m.amount));
    else {
      const d = num(cell(r, m.debit)), c = num(cell(r, m.credit));
      if (d !== null || c !== null) amount = Math.abs(c || 0) - Math.abs(d || 0);
    }
    // Rows without a date are e.g. UBS "Sous-montant" breakdown lines of a grouped payment: skip to avoid double counting.
    if (!date || amount === null || amount === 0) { skipped++; continue; }
    const raw1 = String(cell(r, m.desc) ?? '').trim();
    const details = String(cell(r, m.details) ?? '').trim();
    const parts = raw1.split(';').map(s => s.trim()).filter(Boolean);
    const type = String(cell(r, m.type) ?? '').trim() || (/paiement|twint|debit|credit|ordre/i.test(parts.at(-1) || '') && parts.length > 1 ? parts.at(-1) : '');
    const merchant = parts[0] || type.split(';')[0].trim() || 'Unknown';
    const txno = String(cell(r, m.id) ?? '').trim();
    let key = `${txno}|${date}|${amount.toFixed(2)}|${txno ? '' : fold(raw1).slice(0, 40)}`;
    seen[key] = (seen[key] || 0) + 1;
    key += '#' + seen[key];
    out.push({ id: 'i:' + key, date, amount, currency: String(cell(r, m.currency) || 'CHF').trim() || 'CHF',
      merchant, desc: parts.join(', '), type, details, cat: null, note: '', src: 'import' });
  }
  return { list: out, skipped };
}

let IMP = null;
async function onImportFile(file) {
  try {
    const rows = await readSheet(file);
    const hdr = findHeader(rows);
    const header = (rows[hdr] || []).map(c => String(c ?? '').trim());
    const sig = header.join('|');
    const mapping = S.mappings[sig] || guessMapping(header);
    IMP = { file: file.name, rows, hdr, header, sig, mapping };
    $('#impDone').classList.add('hidden');
    $('#impStep2').classList.remove('hidden');
    $('#impName').textContent = file.name;
    renderImportMapping(); renderImportPreview();
  } catch (e) { console.error(e); toast('Could not read this file: ' + e.message, 5000); }
}
function renderImportMapping() {
  const opts = ['<option value="-1">—</option>', ...IMP.header.map((h, i) => `<option value="${i}">${esc(h || 'Column ' + (i + 1))}</option>`)].join('');
  $('#impMap').innerHTML = FIELDS.map(([k, lbl]) => `<label>${esc(lbl)}<select data-f="${k}">${opts}</select></label>`).join('');
  for (const s of $$('#impMap select')) {
    s.value = String(IMP.mapping[s.dataset.f] ?? -1);
    s.onchange = () => { IMP.mapping[s.dataset.f] = +s.value; renderImportPreview(); };
  }
}
function renderImportPreview() {
  const m = IMP.mapping;
  const ok = m.date >= 0 && m.desc >= 0 && (m.amount >= 0 || m.debit >= 0 || m.credit >= 0);
  const { list, skipped } = ok ? rowsToTx(IMP.rows, IMP.hdr, m) : { list: [], skipped: 0 };
  const fresh = list.filter(t => !DATA.tx[t.id]);
  IMP.fresh = fresh;
  const rules = sortedRules();
  const auto = fresh.filter(t => matchCat(t, rules)).length;
  $('#impStats').innerHTML = ok
    ? `<b>${list.length}</b> transactions found · <b>${fresh.length}</b> new · ${list.length - fresh.length} already imported · ${skipped} rows skipped · ${auto} of the new ones will be auto-classified`
    : 'Choose at least Date, Description and an Amount (or Debit/Credit) column.';
  const sample = list.slice(0, 8);
  $('#impPreview').innerHTML = '<tr><th>Date</th><th>Description</th><th>Type</th><th class="num">Amount</th></tr>' +
    sample.map(t => `<tr><td>${t.date}</td><td>${esc(t.merchant)}</td><td>${esc(t.type)}</td><td class="num ${t.amount < 0 ? 'neg' : 'pos'}">${money(t.amount)}</td></tr>`).join('');
  $('#impGo').disabled = !fresh.length;
  $('#impGo').textContent = fresh.length ? `Import ${fresh.length} new transactions` : 'Nothing new to import';
}
async function doImport() {
  const rules = sortedRules(), t0 = now(); let auto = 0;
  for (const t of IMP.fresh) { t.cat = matchCat(t, rules); if (t.cat) auto++; t.ua = t0; DATA.tx[t.id] = t; }
  S.mappings[IMP.sig] = IMP.mapping; saveSettings();
  const n = IMP.fresh.length, left = n - auto;
  $('#impStep2').classList.add('hidden');
  $('#impDone').classList.remove('hidden');
  $('#impDone').innerHTML = `<h3>✅ Imported ${n} transactions</h3><p>${auto} were classified automatically. ${left ? `<b>${left}</b> still need a category.` : ''}</p>
    ${left ? '<button id="goUncat" class="btn primary wide" type="button">Classify the remaining ones</button>' : ''}`;
  $('#goUncat')?.addEventListener('click', () => { F.cat = '__none'; F.period = 'all'; F.q = ''; show('tx'); });
  $('#impFile').value = ''; IMP = null;
  await commit();
}

// ---------- rendering ----------
let VIEW = 'tx';
const F = { q: '', period: 'all', cat: 'all', limit: 200 };

function show(v) {
  VIEW = v;
  for (const b of $$('#tabs button')) b.classList.toggle('active', b.dataset.view === v);
  for (const s of $$('.view')) s.classList.toggle('active', s.id === 'view-' + v);
  if (v === 'tx') F.limit = 200;
  renderAll(); window.scrollTo(0, 0);
}
function renderAll() {
  if (!DATA) return;
  if (VIEW === 'tx') renderTx();
  if (VIEW === 'add') renderAdd();
  if (VIEW === 'summary') renderSummary();
  if (VIEW === 'settings') renderSettings();
}

function catOptions(selected, { none = true, all = false } = {}) {
  const groups = { expense: 'Expenses', income: 'Income', transfer: 'Transfers' };
  let h = all ? '<option value="all">All categories</option><option value="__none">⚠ Uncategorised</option>' : '';
  if (none) h += '<option value="">— Uncategorised —</option>';
  for (const [k, lbl] of Object.entries(groups)) {
    const cs = liveCats().filter(c => c.kind === k);
    if (cs.length) h += `<optgroup label="${lbl}">` + cs.map(c => `<option value="${esc(c.id)}"${c.id === selected ? ' selected' : ''}>${esc(c.name)}</option>`).join('') + '</optgroup>';
  }
  return h;
}
function periods() {
  const ms = [...new Set(liveTx().map(t => t.date.slice(0, 7)))].sort().reverse();
  const ys = [...new Set(ms.map(m => m.slice(0, 4)))];
  return { ms, ys };
}
function periodOptions(sel, withAll) {
  const { ms, ys } = periods();
  return (withAll ? '<option value="all">All dates</option>' : '') +
    '<optgroup label="Years">' + ys.map(y => `<option value="${y}"${y === sel ? ' selected' : ''}>${y}</option>`).join('') + '</optgroup>' +
    '<optgroup label="Months">' + ms.map(m => `<option value="${m}"${m === sel ? ' selected' : ''}>${monthLabel(m)}</option>`).join('') + '</optgroup>';
}
const inPeriod = (t, p) => p === 'all' || t.date.startsWith(p);

function chip(c) {
  return c ? `<span class="chip"><span class="dot" style="background:${esc(c.color)}"></span>${esc(c.name)}</span>`
    : '<span class="chip none">Uncategorised</span>';
}

function filteredTx() {
  const q = fold(F.q.trim());
  return liveTx().filter(t => inPeriod(t, F.period)
    && (F.cat === 'all' || (F.cat === '__none' ? !cat(t.cat) : t.cat === F.cat))
    && (!q || fold(`${t.merchant} ${t.desc} ${t.type} ${t.note} ${t.details} ${cat(t.cat)?.name || ''}`).includes(q)))
    .sort((a, b) => b.date.localeCompare(a.date) || (b.ua || 0) - (a.ua || 0));
}

function renderTx() {
  $('#fPeriod').innerHTML = periodOptions(F.period, true); $('#fPeriod').value = F.period;
  $('#fCat').innerHTML = catOptions(F.cat, { none: false, all: true }); $('#fCat').value = F.cat;
  if ($('#fSearch').value !== F.q) $('#fSearch').value = F.q;
  const list = filteredTx();
  const inc = list.filter(t => t.amount > 0).reduce((s, t) => s + t.amount, 0);
  const out = list.filter(t => t.amount < 0).reduce((s, t) => s + t.amount, 0);
  const uncat = liveTx().filter(t => !cat(t.cat)).length;
  $('#txInfo').innerHTML = `<b>${list.length}</b> transactions · in <span class="pos">${money(inc)}</span> · out <span class="neg">${money(out)}</span>` +
    (uncat && F.cat !== '__none' ? ` · <button class="btn" id="showUncat" type="button">⚠ ${uncat} uncategorised</button>` : '');
  $('#showUncat')?.addEventListener('click', () => { F.cat = '__none'; renderTx(); });
  if (!liveTx().length) {
    $('#txList').innerHTML = '<div class="card"><h3>No transactions yet</h3><p class="muted">Go to <b>Import</b> to load your bank export, or <b>Add</b> to log one by hand.</p></div>';
    $('#txMore').classList.add('hidden'); return;
  }
  let h = '', day = '';
  for (const t of list.slice(0, F.limit)) {
    if (t.date !== day) { day = t.date; h += `<div class="day">${esc(dayLabel(day))}</div>`; }
    h += `<div class="tx" data-id="${esc(t.id)}"><div class="main"><div class="m">${esc(t.merchant)}</div>
      <div class="s">${chip(cat(t.cat))} ${esc(t.note || t.type || '')}</div></div>
      <div class="amt ${t.amount < 0 ? 'neg' : 'pos'}">${money(t.amount)}</div></div>`;
  }
  $('#txList').innerHTML = h;
  $('#txMore').classList.toggle('hidden', list.length <= F.limit);
}

function renderAdd() {
  const sel = $('#addCat').value;
  $('#addCat').innerHTML = catOptions(sel);
  if (!$('#addDate').value) $('#addDate').value = todayStr();
}

// summary
function totals(p) {
  const exp = {}, inc = {}; let tin = 0, tout = 0;
  for (const t of liveTx()) {
    if (!inPeriod(t, p)) continue;
    const c = cat(t.cat);
    if (c?.kind === 'transfer') continue;
    const key = c ? c.id : '__none';
    if (t.amount < 0 || c?.kind === 'expense') { exp[key] = (exp[key] || 0) - t.amount; tout -= t.amount; } // refunds reduce their expense category
    else { inc[key] = (inc[key] || 0) + t.amount; tin += t.amount; }
  }
  return { exp, inc, tin, tout };
}
function bars(el, obj, p) {
  const rows = Object.entries(obj).filter(([, v]) => Math.abs(v) >= 0.005).sort((a, b) => b[1] - a[1]);
  const max = Math.max(...rows.map(r => r[1]), 1);
  el.innerHTML = rows.length ? rows.map(([id, v]) => {
    const c = cat(id), color = c?.color || '#c0392b';
    return `<div class="b" data-cat="${esc(id)}" data-p="${esc(p)}"><div class="lbl"><span class="dot" style="background:${esc(color)}"></span>${esc(c?.name || '⚠ Uncategorised')}</div>
      <div class="track"><div class="fill" style="width:${Math.max(0, v / max * 100).toFixed(1)}%;background:${esc(color)}"></div></div><div class="val">${money(v)}</div></div>`;
  }).join('') : '<p class="muted">Nothing in this period.</p>';
}
let SP = null;
function renderSummary() {
  const { ms } = periods();
  if (!SP || (SP !== 'all' && !periods().ys.includes(SP) && !ms.includes(SP))) SP = ms[0] || 'all';
  $('#sPeriod').innerHTML = periodOptions(SP, true); $('#sPeriod').value = SP;
  const T = totals(SP);
  $('#kIn').textContent = money(T.tin); $('#kOut').textContent = money(T.tout);
  const net = T.tin - T.tout; $('#kNet').textContent = money(net); $('#kNet').className = 'v ' + (net >= 0 ? 'pos' : 'neg');
  bars($('#sCats'), T.exp, SP); bars($('#sInc'), T.inc, SP);
  const last = ms.slice(0, 12).reverse();
  const tr = last.map(m => ({ m, ...totals(m) }));
  const max = Math.max(1, ...tr.map(x => Math.max(x.tin, x.tout)));
  $('#sTrend').innerHTML = tr.map(x => `<div class="m" data-p="${x.m}" title="${monthLabel(x.m)}: in ${money(x.tin)}, out ${money(x.tout)}">
    <div class="pair"><div class="in" style="height:${(x.tin / max * 100).toFixed(1)}%"></div><div class="out" style="height:${(Math.max(0, x.tout) / max * 100).toFixed(1)}%"></div></div>
    <div class="lb">${MONTHS[+x.m.slice(5) - 1]}</div></div>`).join('') || '<p class="muted">No data yet.</p>';
}

// settings
function renderSettings() {
  const c = Dbx.connected();
  $('#dbxDisconnected').classList.toggle('hidden', c);
  $('#dbxConnected').classList.toggle('hidden', !c);
  if (!$('#dbxKey').value) $('#dbxKey').value = S.appKey;
  $('#dbxLast').textContent = S.lastSync ? 'Last sync: ' + new Date(S.lastSync).toLocaleString() : '';
  if (localStorage.getItem('fin.pkce') && JSON.parse(localStorage.getItem('fin.pkce')).manual) $('#dbxManual').classList.remove('hidden');
  $('#encState').innerHTML = S.passphrase ? '🔒 Encryption is <b>on</b> on this device.' : '🔓 Encryption is <b>off</b> on this device.';
  $('#encOff').classList.toggle('hidden', !S.passphrase);

  const kinds = { expense: 'Expense', income: 'Income', transfer: 'Transfer' };
  $('#catList').innerHTML = liveCats().map(c => `<div class="it" data-id="${esc(c.id)}">
    <input type="color" value="${esc(c.color)}" data-k="color"><input type="text" value="${esc(c.name)}" data-k="name">
    <select data-k="kind">${Object.entries(kinds).map(([k, l]) => `<option value="${k}"${k === c.kind ? ' selected' : ''}>${l}</option>`).join('')}</select>
    <button class="x" data-del="cat" title="Delete" type="button">✕</button></div>`).join('');
  $('#ruleNewCat').innerHTML = catOptions('', { none: false });
  const rules = live(DATA.rules).sort((a, b) => (cat(a.cat)?.name || '').localeCompare(cat(b.cat)?.name || '') || a.pattern.localeCompare(b.pattern));
  $('#ruleList').innerHTML = rules.map(r => `<div class="it" data-id="${esc(r.id)}">
    <input type="text" value="${esc(r.pattern)}" data-k="pattern"><select data-k="cat">${catOptions(r.cat, { none: false })}</select>
    <button class="x" data-del="rule" title="Delete" type="button">✕</button></div>`).join('') || '<p class="muted">No rules yet.</p>';
}

// ---------- edit dialog ----------
let EDIT = null;
function openEdit(id) {
  const t = DATA.tx[id]; if (!t) return;
  EDIT = t;
  const manual = t.src === 'manual';
  $('#eTitle').textContent = t.merchant;
  $('#eSub').innerHTML = `${esc(dayLabel(t.date))} · <b class="${t.amount < 0 ? 'neg' : 'pos'}">${money(t.amount)} ${esc(t.currency || '')}</b>${t.desc && t.desc !== t.merchant ? '<br>' + esc(t.desc) : ''}${t.type ? '<br>' + esc(t.type) : ''}`;
  $('#eManual').classList.toggle('hidden', !manual);
  if (manual) { $('#eDesc').value = t.merchant; $('#eAmount').value = t.amount; $('#eDate').value = t.date; }
  $('#eCat').innerHTML = catOptions(t.cat || '');
  $('#eNote').value = t.note || '';
  $('#eRuleBox').classList.toggle('hidden', manual);
  $('#eRule').checked = !manual && !t.cat;
  $('#eRulePat').value = t.merchant.toUpperCase();
  $('#eDetails').classList.toggle('hidden', !t.details);
  $('#eDetailsTxt').textContent = t.details || '';
  updateRuleCount();
  $('#editDlg').showModal();
}
function updateRuleCount() {
  const P = fold($('#eRulePat').value.trim());
  if (!P) { $('#eRuleCount').textContent = ''; return; }
  const c = $('#eCat').value;
  const n = liveTx().filter(t => t !== EDIT && !cat(t.cat) && haystack(t).includes(P) && (!c || fits(t, c))).length;
  $('#eRuleCount').textContent = `Will also classify ${n} other uncategorised transaction${n === 1 ? '' : 's'}, plus future imports.`;
}
async function saveEdit() {
  const t = EDIT, ts = now();
  if (t.src === 'manual') {
    const a = num($('#eAmount').value), d = $('#eDate').value;
    if (a === null || !d) { toast('Please enter a valid amount and date'); return; }
    t.merchant = $('#eDesc').value.trim() || t.merchant; t.desc = t.merchant; t.amount = a; t.date = d;
  }
  t.cat = $('#eCat').value || null; t.note = $('#eNote').value.trim(); t.ua = ts;
  let extra = 0;
  const pat = $('#eRulePat').value.trim();
  if (t.src !== 'manual' && $('#eRule').checked && pat && t.cat) {
    const id = 'r:' + slug(pat);
    DATA.rules[id] = { id, pattern: pat, cat: t.cat, ua: ts };
    const P = fold(pat);
    for (const o of liveTx()) if (o !== t && !cat(o.cat) && haystack(o).includes(P) && fits(o, t.cat)) { o.cat = t.cat; o.ua = ts; extra++; }
  }
  $('#editDlg').close();
  await commit();
  toast(extra ? `Saved · ${extra} similar transactions classified too` : 'Saved');
}
async function deleteEdit() {
  if (!confirm('Delete this transaction? (Re-importing the same bank file will not bring it back.)')) return;
  EDIT.del = true; EDIT.ua = now();
  $('#editDlg').close(); await commit(); toast('Deleted');
}

// ---------- exports ----------
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function exportCsv() {
  const q = v => { const s = String(v ?? ''); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const rows = [['Date', 'Description', 'Details', 'Type', 'Amount', 'Currency', 'Category', 'Category kind', 'Note', 'Source']];
  for (const t of liveTx().sort((a, b) => a.date.localeCompare(b.date))) {
    const c = cat(t.cat);
    rows.push([t.date, t.merchant, t.desc, t.type, t.amount.toFixed(2), t.currency, c?.name || '', c?.kind || '', t.note, t.src]);
  }
  download(`transactions_${todayStr()}.csv`, '﻿' + rows.map(r => r.map(q).join(';')).join('\r\n'), 'text/csv;charset=utf-8');
}

// ---------- events ----------
function bind() {
  for (const b of $$('#tabs button')) b.addEventListener('click', () => show(b.dataset.view));
  $('#syncPill').addEventListener('click', () => Dbx.connected() ? sync() : show('settings'));

  // transactions
  $('#fSearch').addEventListener('input', e => { F.q = e.target.value; F.limit = 200; renderTx(); });
  $('#fPeriod').addEventListener('change', e => { F.period = e.target.value; F.limit = 200; renderTx(); });
  $('#fCat').addEventListener('change', e => { F.cat = e.target.value; F.limit = 200; renderTx(); });
  $('#txList').addEventListener('click', e => { const r = e.target.closest('.tx'); if (r) openEdit(r.dataset.id); });
  $('#txMore').addEventListener('click', () => { F.limit += 300; renderTx(); });

  // add
  $('#addForm').addEventListener('submit', async e => {
    e.preventDefault();
    const a = num($('#addAmount').value);
    if (a === null || a === 0) { toast('Please enter an amount'); return; }
    const kind = $('input[name=addKind]:checked').value;
    const id = 'm:' + rid(), desc = $('#addDesc').value.trim();
    const t = { id, date: $('#addDate').value || todayStr(), amount: kind === 'expense' ? -Math.abs(a) : Math.abs(a), currency: 'CHF',
      merchant: desc, desc, type: '', details: '', cat: $('#addCat').value || null, note: $('#addNote').value.trim(), src: 'manual', ua: now() };
    if (!t.cat) t.cat = matchCat(t);
    DATA.tx[id] = t;
    $('#addAmount').value = ''; $('#addDesc').value = ''; $('#addNote').value = '';
    await commit(); toast('Saved ✓');
  });

  // import
  $('#impFile').addEventListener('change', e => e.target.files[0] && onImportFile(e.target.files[0]));
  $('#impGo').addEventListener('click', doImport);

  // summary
  $('#sPeriod').addEventListener('change', e => { SP = e.target.value; renderSummary(); });
  const drill = e => {
    const b = e.target.closest('[data-cat]'); if (!b) return;
    F.cat = b.dataset.cat; F.period = b.dataset.p; F.q = ''; show('tx');
  };
  $('#sCats').addEventListener('click', drill); $('#sInc').addEventListener('click', drill);
  $('#sTrend').addEventListener('click', e => { const m = e.target.closest('[data-p]'); if (m) { SP = m.dataset.p; renderSummary(); } });

  // edit dialog
  $('#eSave').addEventListener('click', saveEdit);
  $('#eDelete').addEventListener('click', deleteEdit);
  $('#eRulePat').addEventListener('input', updateRuleCount);
  $('#eCat').addEventListener('change', () => { if (EDIT && EDIT.src !== 'manual' && !EDIT.cat) $('#eRule').checked = !!$('#eCat').value; updateRuleCount(); });

  // settings: dropbox
  $('#dbxConnect').addEventListener('click', async () => {
    const k = $('#dbxKey').value.trim();
    if (!/^[a-z0-9]{8,32}$/i.test(k)) { toast('Paste the App key from your Dropbox app page'); return; }
    S.appKey = k; saveSettings();
    try { await Dbx.startAuth(); } catch (e) { toast(e.message, 5000); }
  });
  $('#dbxCodeGo').addEventListener('click', async () => {
    try { await Dbx.finishAuth($('#dbxCode').value); $('#dbxManual').classList.add('hidden'); toast('Dropbox connected'); renderSettings(); await sync(); }
    catch (e) { toast(e.message, 5000); }
  });
  $('#dbxSync').addEventListener('click', sync);
  $('#dbxOff').addEventListener('click', () => { if (confirm('Disconnect Dropbox on this device? Your data stays in Dropbox and on this device.')) Dbx.disconnect(); });

  // settings: encryption
  $('#encSet').addEventListener('click', async () => {
    const p = $('#encPass').value;
    if (p.length < 8) { toast('Use at least 8 characters'); return; }
    if (S.passphrase && S.passphrase !== p && !confirm('Change the password? Other devices will need the new password.')) return;
    S.passphrase = p; saveSettings(); $('#encPass').value = '';
    renderSettings(); toast('Password saved on this device'); sync();
  });
  $('#encOff').addEventListener('click', () => {
    if (!confirm('Turn off encryption? The Dropbox file will be saved unencrypted.')) return;
    S.passphrase = ''; saveSettings(); renderSettings(); sync();
  });

  // settings: categories
  $('#catList').addEventListener('change', async e => {
    const it = e.target.closest('.it'), c = DATA.cats[it.dataset.id], k = e.target.dataset.k;
    if (!c || !k) return;
    const v = e.target.value.trim(); if (k === 'name' && !v) { renderSettings(); return; }
    c[k] = v; c.ua = now(); await commit();
  });
  $('#catList').addEventListener('click', async e => {
    if (!e.target.dataset.del) return;
    const c = DATA.cats[e.target.closest('.it').dataset.id];
    const used = liveTx().filter(t => t.cat === c.id).length;
    if (!confirm(`Delete category "${c.name}"?${used ? ` ${used} transactions will become uncategorised.` : ''}`)) return;
    const ts = now(); c.del = true; c.ua = ts;
    for (const t of liveTx()) if (t.cat === c.id) { t.cat = null; t.ua = ts; }
    for (const r of live(DATA.rules)) if (r.cat === c.id) { r.del = true; r.ua = ts; }
    await commit();
  });
  $('#catAdd').addEventListener('click', async () => {
    const name = $('#catNew').value.trim(); if (!name) return;
    const id = 'c:' + slug(name) + '-' + rid().slice(0, 4);
    const palette = ['#26a69a', '#ab47bc', '#ef6c00', '#5c6bc0', '#8d6e63', '#ec407a', '#29b6f6', '#9ccc65'];
    DATA.cats[id] = { id, name, kind: $('#catNewKind').value, color: palette[Object.keys(DATA.cats).length % palette.length], ua: now() };
    $('#catNew').value = ''; await commit();
  });

  // settings: rules
  $('#ruleList').addEventListener('change', async e => {
    const r = DATA.rules[e.target.closest('.it').dataset.id], k = e.target.dataset.k;
    if (!r || !k) return; r[k] = e.target.value.trim(); r.ua = now(); await commit();
  });
  $('#ruleList').addEventListener('click', async e => {
    if (!e.target.dataset.del) return;
    const r = DATA.rules[e.target.closest('.it').dataset.id]; r.del = true; r.ua = now(); await commit();
  });
  $('#ruleAdd').addEventListener('click', async () => {
    const pattern = $('#ruleNew').value.trim(), c = $('#ruleNewCat').value; if (!pattern || !c) return;
    const id = 'r:' + slug(pattern);
    DATA.rules[id] = { id, pattern, cat: c, ua: now() }; $('#ruleNew').value = '';
    const n = applyRulesToUncategorised(); await commit(); toast(`Rule added${n ? ` · ${n} transactions classified` : ''}`);
  });
  $('#ruleApply').addEventListener('click', async () => { const n = applyRulesToUncategorised(); await commit(); toast(`${n} transactions classified`); });

  // settings: data
  $('#expCsv').addEventListener('click', exportCsv);
  $('#expJson').addEventListener('click', () => download(`finances_backup_${todayStr()}.json`, JSON.stringify(DATA), 'application/json'));
  $('#impJson').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const { data } = await deserialize(await f.text());
      if (!data || !data.tx) throw new Error('Not a Finances backup');
      DATA = mergeData(DATA, data); await commit(); toast('Backup merged');
    } catch (err) { toast(err.message, 5000); }
    e.target.value = '';
  });
  $('#wipe').addEventListener('click', async () => {
    if (!confirm('Erase all data and settings on THIS device? Data in Dropbox is not touched.')) return;
    localStorage.clear(); await kv.set('data', null); location.reload();
  });

  // keep devices in step
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(); });
  window.addEventListener('online', sync);
}

// ---------- start ----------
async function start() {
  bind();
  DATA = (await kv.get('data')) || seedData();
  await kv.set('data', DATA);
  // returning from Dropbox login (desktop / browser)
  const qs = new URLSearchParams(location.search);
  if (qs.get('code') || qs.get('error')) {
    history.replaceState(null, '', location.pathname);
    if (qs.get('code')) {
      try { await Dbx.finishAuth(qs.get('code')); toast('Dropbox connected'); } catch (e) { toast(e.message, 6000); }
    } else toast('Dropbox login cancelled');
    show('settings');
  } else show('tx');
  setStatus();
  sync();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
}
start();
