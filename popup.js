// ══════════════════════════════════════════════════════════
// Mark's Expander v5 — popup.js
// All logic self-contained. Firebase for users, local for snippets.
// ══════════════════════════════════════════════════════════

// ── Firebase config ──
const FB_API_KEY   = "AIzaSyAWb55G96cpUI6CdmW3QXUNWDZzC-RsCkU";
const FB_PROJECT   = "mark-s-expander";
const FB_BASE      = `https://firestore.googleapis.com/v1/projects/${FB_PROJECT}/databases/(default)/documents`;

// ── Storage keys ──
const SK_SESSION  = 'me_session';
const SK_OW_PW    = 'me_owner_pw';
const SK_OW_SNIP  = 'me_owner_snippets';
const DEFAULT_PW  = 'sync_' + Math.abs(djb2('mark2024')).toString(16);

function skUser(u) { return 'me_snip_' + u; }

// ── chrome.storage helpers — direct, no wrapper ──
function cGet(key) {
  return new Promise(resolve => {
    chrome.storage.local.get(key, result => resolve(result));
  });
}
function cSet(obj) {
  return new Promise(resolve => {
    chrome.storage.local.set(obj, resolve);
  });
}
function cRemove(key) {
  return new Promise(resolve => {
    chrome.storage.local.remove(key, resolve);
  });
}

// ── Hashing ──
async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str + '_marks_expander_salt'));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}
function djb2(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) { h = ((h << 5) + h) + str.charCodeAt(i); h = h & h; }
  return h;
}

// ── Firebase Firestore REST ──
function fsToObj(doc) {
  if (!doc || !doc.fields) return null;
  const obj = {};
  for (const [k, v] of Object.entries(doc.fields)) {
    if      (v.stringValue  !== undefined) obj[k] = v.stringValue;
    else if (v.integerValue !== undefined) obj[k] = parseInt(v.integerValue);
    else if (v.booleanValue !== undefined) obj[k] = v.booleanValue;
    else if (v.nullValue    !== undefined) obj[k] = null;
  }
  return obj;
}
function objToFs(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) fields[k] = { nullValue: null };
    else if (typeof v === 'boolean')   fields[k] = { booleanValue: v };
    else if (typeof v === 'number')    fields[k] = { integerValue: String(v) };
    else                               fields[k] = { stringValue: String(v) };
  }
  return fields;
}

async function fsGetUser(username) {
  const url = `${FB_BASE}/users/${encodeURIComponent(username)}?key=${FB_API_KEY}`;
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('Firebase error: ' + res.status);
  return fsToObj(await res.json());
}

async function fsListUsers() {
  const url = `${FB_BASE}/users?key=${FB_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Firebase error: ' + res.status);
  const data = await res.json();
  const users = {};
  if (data.documents) {
    for (const doc of data.documents) {
      const parts = doc.name.split('/');
      const name  = decodeURIComponent(parts[parts.length - 1]);
      users[name] = fsToObj(doc);
    }
  }
  return users;
}

async function fsSetUser(username, data) {
  const url = `${FB_BASE}/users/${encodeURIComponent(username)}?key=${FB_API_KEY}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: objToFs(data) })
  });
  if (!res.ok) throw new Error('Firebase write error: ' + res.status);
}

async function fsDeleteUser(username) {
  const url = `${FB_BASE}/users/${encodeURIComponent(username)}?key=${FB_API_KEY}`;
  await fetch(url, { method: 'DELETE' });
}

// ── Firebase logs ──
async function fsListLogs() {
  const url = `${FB_BASE}/logs?key=${FB_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) return {};
  const data = await res.json();
  const logs = {};
  if (data.documents) {
    for (const doc of data.documents) {
      const id = decodeURIComponent(doc.name.split('/').pop());
      logs[id] = fsToObj(doc);
    }
  }
  return logs;
}

// ── Firebase suggestions ──
async function fsAddSuggestion(username, message) {
  // Store with timestamp as document ID
  const docId = username + '_' + Date.now();
  const url   = `${FB_BASE}/suggestions/${encodeURIComponent(docId)}?key=${FB_API_KEY}`;
  await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: objToFs({ username, message, createdAt: Date.now(), read: false }) })
  });
}

async function fsListSuggestions() {
  const url = `${FB_BASE}/suggestions?key=${FB_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) return {};
  const data = await res.json();
  const items = {};
  if (data.documents) {
    for (const doc of data.documents) {
      const id = decodeURIComponent(doc.name.split('/').pop());
      items[id] = fsToObj(doc);
    }
  }
  return items;
}

async function fsMarkSuggestionRead(docId) {
  const url = `${FB_BASE}/suggestions/${encodeURIComponent(docId)}?key=${FB_API_KEY}&updateMask.fieldPaths=read`;
  await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { read: { booleanValue: true } } })
  });
}

async function fsDeleteSuggestion(docId) {
  await fetch(`${FB_BASE}/suggestions/${encodeURIComponent(docId)}?key=${FB_API_KEY}`, { method: 'DELETE' });
}

// ── Firebase broadcast ──
// Broadcast stored in: broadcast/current
// { message, sentAt (timestamp), active (bool) }
// Dismiss stored per-user in: broadcast/dismissed_{username}
// { sentAt } — if sentAt matches current broadcast, user has dismissed it

async function fsSetBroadcast(message) {
  const url = `${FB_BASE}/broadcast/current?key=${FB_API_KEY}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fields: {
        message: { stringValue: message },
        sentAt:  { integerValue: String(Date.now()) },
        active:  { booleanValue: true }
      }
    })
  });
  if (!res.ok) throw new Error('Failed to send broadcast: ' + res.status);
}

async function fsClearBroadcast() {
  const url = `${FB_BASE}/broadcast/current?key=${FB_API_KEY}`;
  await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fields: {
        message: { stringValue: '' },
        sentAt:  { integerValue: '0' },
        active:  { booleanValue: false }
      }
    })
  });
}

async function fsGetBroadcast() {
  const url = `${FB_BASE}/broadcast/current?key=${FB_API_KEY}`;
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) return null;
  const doc = await res.json();
  if (!doc || !doc.fields) return null;
  return {
    message: doc.fields.message ? doc.fields.message.stringValue  : '',
    sentAt:  doc.fields.sentAt  ? parseInt(doc.fields.sentAt.integerValue) : 0,
    active:  doc.fields.active  ? doc.fields.active.booleanValue   : false
  };
}

// Store dismiss state in Firebase — works even after reinstall
async function fsDismissBroadcast(username, sentAt) {
  const url = `${FB_BASE}/broadcast/dismissed_${encodeURIComponent(username)}?key=${FB_API_KEY}`;
  await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fields: { sentAt: { integerValue: String(sentAt) } }
    })
  });
}

async function fsGetDismissed(username) {
  const url = `${FB_BASE}/broadcast/dismissed_${encodeURIComponent(username)}?key=${FB_API_KEY}`;
  const res = await fetch(url);
  if (res.status === 404) return 0;
  if (!res.ok) return 0;
  const doc = await res.json();
  if (!doc || !doc.fields || !doc.fields.sentAt) return 0;
  return parseInt(doc.fields.sentAt.integerValue);
}

// ── Firebase snippet functions ──
// Snippets stored as a single document: snippets/{username}
// Each keyword is a field: { keyword: { stringValue: expansion } }

async function fsGetSnippets(username) {
  const url = `${FB_BASE}/snippets/${encodeURIComponent(username)}?key=${FB_API_KEY}`;
  const res = await fetch(url);
  if (res.status === 404) return {};
  if (!res.ok) throw new Error('Firebase error: ' + res.status);
  const doc = await res.json();
  if (!doc.fields) return {};
  const snips = {};
  for (const [k, v] of Object.entries(doc.fields)) {
    if (v.stringValue !== undefined) snips[k] = v.stringValue;
  }
  return snips;
}

async function fsSetSnippets(username, snips) {
  const url = `${FB_BASE}/snippets/${encodeURIComponent(username)}?key=${FB_API_KEY}`;
  const fields = {};
  for (const [k, v] of Object.entries(snips)) {
    fields[k] = { stringValue: String(v) };
  }
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  });
  if (!res.ok) throw new Error('Firebase snippet write error: ' + res.status);
}

// ── Subscription helpers ──
function subStatus(user) {
  if (!user || !user.expiresAt) return { status: 'none', label: 'No subscription' };
  const diff = user.expiresAt - Date.now();
  if (diff <= 0) return { status: 'expired', label: 'Expired' };
  const days = Math.ceil(diff / 86400000);
  return days <= 3
    ? { status: 'expiring', label: days + 'd left' }
    : { status: 'active',   label: days + 'd left' };
}
function isActive(user) {
  return user && user.expiresAt && Date.now() < user.expiresAt;
}

// ── Session ──
async function getSession() {
  const d = await cGet(SK_SESSION);
  const s = d[SK_SESSION];
  if (!s) return null;
  if (s.expiry && Date.now() > s.expiry) { await cRemove(SK_SESSION); return null; }
  return s;
}
async function setSession(role, username) {
  await cSet({ [SK_SESSION]: { role, username, expiry: Date.now() + 8 * 3600000 } });
  // Immediately push snippets to the active key so content script can read them
  await syncActiveSnippets(role, username);
}

async function syncActiveSnippets(role, username) {
  try {
    let snips = {};
    if (role === 'owner') {
      const d = await cGet(SK_OW_SNIP);
      snips = d[SK_OW_SNIP] || {};
    } else {
      try {
        snips = await fsGetSnippets(username);
        await cSet({ [skUser(username)]: snips }); // local cache
      } catch(e) {
        const d = await cGet(skUser(username));
        snips = d[skUser(username)] || {};
      }
    }
    await cSet({ 'me_active_snippets': snips });
  } catch(e) {}
}
async function clearSession() { await cRemove(SK_SESSION); }

// ── Snippet helpers ──
// Owner snippets: local (chrome.storage). User snippets: Firebase.
async function loadSnippets(key) {
  if (key === SK_OW_SNIP) {
    // Owner: local storage
    const d = await cGet(key);
    return d[key] || {};
  } else {
    // User: Firebase — key is "me_snip_username", extract username
    const username = key.replace('me_snip_', '');
    try {
      return await fsGetSnippets(username);
    } catch(e) {
      // Fallback to local if offline
      const d = await cGet(key);
      return d[key] || {};
    }
  }
}

async function saveSnippets(key, snips) {
  if (key === SK_OW_SNIP) {
    await cSet({ [key]: snips });
  } else {
    const username = key.replace('me_snip_', '');
    await fsSetSnippets(username, snips);
    await cSet({ [key]: snips });
  }
  // Always keep active snippets in sync — content script reads this key directly
  await cSet({ 'me_active_snippets': snips });
}

// ── Password generator ──
const PW_CHARS = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789!@#$%';
function genPw(len = 14) {
  const a = new Uint8Array(len);
  crypto.getRandomValues(a);
  return Array.from(a).map(b => PW_CHARS[b % PW_CHARS.length]).join('');
}
function pwScore(pw) {
  let s = 0;
  if (pw.length >= 8) s += 25; if (pw.length >= 12) s += 15;
  if (/[A-Z]/.test(pw)) s += 20; if (/[0-9]/.test(pw)) s += 20;
  if (/[^a-zA-Z0-9]/.test(pw)) s += 20; return Math.min(s, 100);
}
function refreshPw() {
  const pw = genPw();
  document.getElementById('u-pw').value = pw;
  const s = pwScore(pw), f = document.getElementById('str-fill');
  f.style.width = s + '%';
  f.style.background = s < 40 ? '#f87171' : s < 70 ? '#fbbf24' : '#34d399';
  return pw;
}

// ── CSV ──
function toCSV(snips) {
  return [['keyword','expansion'], ...Object.entries(snips).map(([k,v]) => [csvQ(k), csvQ(v)])].map(r => r.join(',')).join('\n');
}
function csvQ(s) {
  return (s.includes(',') || s.includes('"') || s.includes('\n')) ? '"' + s.replace(/"/g,'""') + '"' : s;
}
function parseCSV(text) {
  const snips = {}, lines = text.trim().split('\n');
  const start = lines[0].toLowerCase().startsWith('keyword') ? 1 : 0;
  for (let i = start; i < lines.length; i++) {
    const parts = parseCSVLine(lines[i]);
    if (parts[0] && parts[1]) snips[parts[0].trim()] = parts.slice(1).join(',').trim();
  }
  return snips;
}
function parseCSVLine(line) {
  const r = []; let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (inQ && line[i+1] === '"') { cur += '"'; i++; } else inQ = !inQ; }
    else if (c === ',' && !inQ) { r.push(cur); cur = ''; }
    else cur += c;
  }
  r.push(cur); return r;
}
function dlCSV(name, snips) {
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob([toCSV(snips)], { type: 'text/csv' })),
    download: name
  });
  a.click(); URL.revokeObjectURL(a.href);
}

// ── Screen router ──
function show(id) {
  ['screen-login','screen-owner','screen-user'].forEach(s => {
    const el = document.getElementById(s);
    if (!el) return;
    el.style.display = (s === id) ? 'flex' : 'none';
    el.style.flexDirection = 'column';
    if (s === id && s !== 'screen-login') {
      el.style.flex = '1';
      el.style.overflow = 'hidden';
    }
  });
}

// ═══════════════════════════════════════
// INIT
// ═══════════════════════════════════════
(async () => {
  const session = await getSession();
  if (!session) { show('screen-login'); return; }

  if (session.role === 'owner') {
    await initOwner();
  } else {
    try {
      const user = await fsGetUser(session.username);
      if (user && isActive(user)) {
        // Always re-sync snippets from Firebase on every popup open
        await syncActiveSnippets('user', session.username);
        await initUser(session.username, user);
      } else {
        await initExpired(session.username, user);
      }
    } catch (e) {
      // Firebase error — still show user screen with cached session
      await initUser(session.username, { expiresAt: session.expiry });
    }
  }
})();

// ═══════════════════════════════════════
// LOGIN
// ═══════════════════════════════════════
document.getElementById('btn-login').addEventListener('click', doLogin);
document.getElementById('l-pass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

async function doLogin() {
  const username = document.getElementById('l-user').value.trim();
  const password = document.getElementById('l-pass').value;
  const errEl    = document.getElementById('l-err');
  errEl.textContent = '';

  if (!username || !password) { errEl.textContent = 'Enter username and password.'; return; }

  // Owner check
  if (username.toLowerCase() === 'mark' || username.toLowerCase() === 'owner') {
    const d      = await cGet(SK_OW_PW);
    const stored = d[SK_OW_PW] || DEFAULT_PW;
    const hash   = await sha256(password);
    const syncH  = 'sync_' + Math.abs(djb2(password)).toString(16);
    if (hash === stored || syncH === stored) {
      await setSession('owner', 'owner');
      await initOwner();
      return;
    }
    errEl.textContent = 'Incorrect password.'; return;
  }

  // User check via Firebase
  errEl.textContent = 'Checking…';
  try {
    const user = await fsGetUser(username);
    if (!user) { errEl.textContent = 'Username not found.'; return; }
    const hash = await sha256(password);
    if (hash !== user.passwordHash) { errEl.textContent = 'Incorrect password.'; return; }
    errEl.textContent = '';
    await setSession('user', username);
    if (isActive(user)) await initUser(username, user);
    else await initExpired(username, user);
  } catch (e) {
    errEl.textContent = 'Connection error. Check internet.';
  }
}

// ═══════════════════════════════════════
// OWNER
// ═══════════════════════════════════════
async function initOwner() {
  show('screen-owner');
  await renderOwnerSnippets();
  await renderUsers();
  await loadNotifications();
  await loadLogs();
  refreshPw();
}

// Owner tabs
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('#screen-owner .tab-content').forEach(t => t.classList.add('hidden'));
    const tab = document.getElementById(btn.dataset.tab);
    if (tab) { tab.classList.remove('hidden'); tab.style.display = 'flex'; tab.style.flexDirection = 'column'; }
    if (btn.dataset.tab === 'ot-notifs') {
      loadNotifications();
      document.getElementById('owner-notif-dot').style.display = 'none';
    }
    if (btn.dataset.tab === 'ot-logs') {
      loadLogs();
    }
  });
});

document.getElementById('btn-owner-logout').addEventListener('click', async () => {
  await clearSession(); show('screen-login');
});

// Owner snippets
async function renderOwnerSnippets(filter) {
  const snips = await loadSnippets(SK_OW_SNIP);
  renderSnipList('o-snip-list', snips, filter, SK_OW_SNIP);
}

document.getElementById('btn-o-add').addEventListener('click', async () => {
  const kw = document.getElementById('o-kw').value.trim();
  const ex = document.getElementById('o-exp').value.trim();
  const e  = document.getElementById('o-add-err');
  e.textContent = '';
  if (!kw || !ex) { e.textContent = 'Both fields required.'; return; }
  const snips = await loadSnippets(SK_OW_SNIP);
  if (snips[kw]) { e.textContent = '"' + kw + '" already exists.'; return; }
  snips[kw] = ex;
  await saveSnippets(SK_OW_SNIP, snips);
  document.getElementById('o-kw').value = '';
  document.getElementById('o-exp').value = '';
  await renderOwnerSnippets();
  pingContent();
});

document.getElementById('o-search').addEventListener('input', async e => {
  await renderOwnerSnippets(e.target.value.trim().toLowerCase());
});
document.getElementById('btn-o-export').addEventListener('click', async () => {
  dlCSV('owner-snippets.csv', await loadSnippets(SK_OW_SNIP));
});
document.getElementById('o-csv').addEventListener('change', async e => {
  const file = e.target.files[0]; if (!file) return;
  const merged = { ...await loadSnippets(SK_OW_SNIP), ...parseCSV(await file.text()) };
  await saveSnippets(SK_OW_SNIP, merged);
  e.target.value = ''; await renderOwnerSnippets(); pingContent();
});

// Owner users
let uSearchFilter = '';
document.getElementById('u-search').addEventListener('input', async e => {
  uSearchFilter = e.target.value.trim().toLowerCase(); await renderUsers();
});

document.getElementById('btn-u-gen').addEventListener('click', refreshPw);
document.getElementById('btn-u-copy').addEventListener('click', () => {
  const pw = document.getElementById('u-pw').value;
  if (!pw) return;
  navigator.clipboard.writeText(pw).then(() => {
    const btn = document.getElementById('btn-u-copy');
    const o = btn.textContent; btn.textContent = '✓'; btn.classList.add('copied');
    setTimeout(() => { btn.textContent = o; btn.classList.remove('copied'); }, 1800);
  });
});

document.getElementById('btn-u-create').addEventListener('click', async () => {
  const un  = document.getElementById('u-name').value.trim();
  const pw  = document.getElementById('u-pw').value.trim();
  const days= parseInt(document.getElementById('u-days').value);
  const err = document.getElementById('u-err');
  err.textContent = '';

  if (!un) { err.textContent = 'Username required.'; return; }
  if (!pw) { err.textContent = 'Password required.'; return; }
  if (['mark','owner'].includes(un.toLowerCase())) { err.textContent = 'Reserved username.'; return; }

  err.textContent = 'Creating…';
  try {
    const existing = await fsGetUser(un);
    if (existing) { err.textContent = '"' + un + '" already exists.'; return; }
    const passwordHash = await sha256(pw);
    const expiresAt    = (days && !isNaN(days)) ? Date.now() + days * 86400000 : null;
    // Store plain password so owner can view/share it later
    await fsSetUser(un, { passwordHash, plainPassword: pw, createdAt: Date.now(), expiresAt });
    document.getElementById('u-name').value = '';
    document.getElementById('u-days').value = '';
    refreshPw();
    err.style.color = '#34d399';
    err.textContent = '✓ "' + un + '" created!';
    setTimeout(() => { err.textContent = ''; err.style.color = ''; }, 3000);
    await renderUsers();
  } catch (e) {
    err.textContent = 'Error: ' + e.message;
  }
});

async function renderUsers() {
  const list = document.getElementById('u-list');
  list.innerHTML = '<div class="empty">Loading…</div>';
  try {
    const users = await fsListUsers();
    let keys = Object.keys(users).sort();
    if (uSearchFilter) keys = keys.filter(k => k.toLowerCase().includes(uSearchFilter));

    if (Object.keys(users).length === 0) {
      list.innerHTML = '<div class="empty">No users yet. Create one above.</div>'; return;
    }
    if (!keys.length) {
      list.innerHTML = '<div class="empty">No users match "' + esc(uSearchFilter) + '".</div>'; return;
    }

    list.innerHTML = '';
    keys.forEach(un => {
      const user = users[un];
      const sub  = subStatus(user);
      const exp  = (user.expiresAt && user.expiresAt > 0) ? new Date(user.expiresAt).toLocaleDateString() : 'None';
      const cre  = user.createdAt ? new Date(user.createdAt).toLocaleDateString() : '—';
      const dn   = uSearchFilter
        ? esc(un).replace(new RegExp('(' + esc(uSearchFilter) + ')', 'gi'), '<mark>$1</mark>')
        : esc(un);

      const card = document.createElement('div');
      card.className = 'user-card';
      card.innerHTML = `
        <div class="user-info">
          <div class="user-name">${dn}<span class="pill pill-${sub.status}">${sub.label}</span></div>
          <div class="user-meta">Created ${cre} · Expires ${exp}</div>
        </div>
        <div class="user-actions">
          <button class="btn-xs btn-sub-action">🗓 Sub</button>
          <button class="btn-xs btn-del-action">✕</button>
        </div>`;
      card.querySelector('.btn-sub-action').addEventListener('click', () => openSubModal(un, user));
      card.querySelector('.btn-del-action').addEventListener('click', async () => {
        if (!confirm('Remove "' + un + '"?')) return;
        await fsDeleteUser(un); await renderUsers();
      });
      list.appendChild(card);
    });
  } catch (e) {
    list.innerHTML = '<div class="empty" style="color:#f87171">Error: ' + esc(e.message) + '</div>';
  }
}

// Subscription modal
let subTarget = null;
function openSubModal(un, user) {
  subTarget = un;
  const sub = subStatus(user);
  const exp = (user.expiresAt && user.expiresAt > 0) ? new Date(user.expiresAt).toLocaleDateString() : 'None';
  document.getElementById('sub-info').innerHTML =
    '<strong>' + esc(un) + '</strong><br>Status: <span class="pill pill-' + sub.status + '">' + sub.label + '</span><br>Expires: ' + exp;
  document.getElementById('sub-days').value = '';
  document.getElementById('sub-date').value = '';
  document.getElementById('sub-err').textContent = '';
  document.getElementById('modal-sub').classList.remove('hidden');
}
document.getElementById('btn-sub-cancel').addEventListener('click', () => document.getElementById('modal-sub').classList.add('hidden'));
document.getElementById('btn-sub-revoke').addEventListener('click', async () => {
  try {
    const u = await fsGetUser(subTarget);
    await fsSetUser(subTarget, { ...u, expiresAt: 0 });
    document.getElementById('modal-sub').classList.add('hidden');
    await renderUsers();
  } catch (e) { document.getElementById('sub-err').textContent = e.message; }
});
document.getElementById('btn-sub-save').addEventListener('click', async () => {
  const days = parseInt(document.getElementById('sub-days').value);
  const date = document.getElementById('sub-date').value;
  const err  = document.getElementById('sub-err');
  err.textContent = '';
  if (!days && !date) { err.textContent = 'Enter days or pick a date.'; return; }
  try {
    const u = await fsGetUser(subTarget);
    let newExp;
    if (date) newExp = new Date(date).getTime() + 86400000 - 1;
    else { const base = (u.expiresAt && u.expiresAt > Date.now()) ? u.expiresAt : Date.now(); newExp = base + days * 86400000; }
    await fsSetUser(subTarget, { ...u, expiresAt: newExp });
    document.getElementById('modal-sub').classList.add('hidden');
    await renderUsers();
  } catch (e) { err.textContent = e.message; }
});

// Owner settings
document.getElementById('btn-s-save').addEventListener('click', async () => {
  const cur = document.getElementById('s-cur').value;
  const nw  = document.getElementById('s-new').value;
  const con = document.getElementById('s-con').value;
  const err = document.getElementById('s-err');
  const ok  = document.getElementById('s-ok');
  err.textContent = ''; ok.textContent = '';
  if (!cur || !nw || !con) { err.textContent = 'All fields required.'; return; }
  if (nw !== con)           { err.textContent = 'Passwords do not match.'; return; }
  if (nw.length < 6)        { err.textContent = 'Min 6 characters.'; return; }
  const d = await cGet(SK_OW_PW);
  const stored = d[SK_OW_PW] || DEFAULT_PW;
  const curHash = await sha256(cur);
  const curSync = 'sync_' + Math.abs(djb2(cur)).toString(16);
  if (curHash !== stored && curSync !== stored) { err.textContent = 'Current password wrong.'; return; }
  await cSet({ [SK_OW_PW]: await sha256(nw) });
  ['s-cur','s-new','s-con'].forEach(id => document.getElementById(id).value = '');
  ok.textContent = '✓ Password updated.';
});

// ═══════════════════════════════════════
// USER
// ═══════════════════════════════════════
let currentUser = null;

async function initUser(username, user) {
  currentUser = username;
  show('screen-user');
  document.getElementById('u-greeting').textContent = username;
  document.getElementById('u-expired-wall').classList.add('hidden');
  document.getElementById('u-active-content').style.display = 'flex';
  document.getElementById('u-active-content').style.flexDirection = 'column';

  // Set personalized welcome message
  var hour = new Date().getHours();
  var greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  document.getElementById('u-welcome-hello').textContent = greeting + ', ' + username + '! 👋';

  // Check for broadcast AFTER screen is shown — pass username for Firebase dismiss tracking
  setTimeout(() => loadBroadcast(username), 300);
  const sub   = subStatus(user);
  const badge = document.getElementById('u-sub-badge');
  badge.textContent = sub.label;
  badge.className   = 'sub-badge sub-' + sub.status;
  // Push snippets to active key so content script can read them immediately
  await syncActiveSnippets('user', username);
  await renderUserSnippets();
}

async function initExpired(username, user) {
  currentUser = username;
  show('screen-user');
  document.getElementById('u-greeting').textContent = username;
  document.getElementById('u-expired-wall').classList.remove('hidden');
  document.getElementById('u-active-content').style.display = 'none';
  const badge = document.getElementById('u-sub-badge');
  badge.textContent = 'Expired';
  badge.className   = 'sub-badge sub-expired';
}

document.getElementById('btn-user-logout').addEventListener('click', async () => {
  await clearSession(); currentUser = null; show('screen-login');
});

// Refresh button — re-fetches snippets from Firebase without logging out
document.getElementById('btn-user-refresh').addEventListener('click', async () => {
  const btn = document.getElementById('btn-user-refresh');
  btn.textContent = '…';
  btn.disabled = true;
  try {
    await syncActiveSnippets('user', currentUser);
    await renderUserSnippets();
    btn.textContent = '✓';
    setTimeout(() => { btn.textContent = '↺'; btn.disabled = false; }, 1200);
  } catch(e) {
    btn.textContent = '↺'; btn.disabled = false;
  }
});

async function renderUserSnippets(filter) {
  if (!currentUser) return;
  const snips = await loadSnippets(skUser(currentUser));
  renderSnipList('us-snip-list', snips, filter, skUser(currentUser));
}

document.getElementById('btn-us-add').addEventListener('click', async () => {
  const kw = document.getElementById('us-kw').value.trim();
  const ex = document.getElementById('us-exp').value.trim();
  const e  = document.getElementById('us-add-err');
  e.textContent = '';
  if (!kw || !ex) { e.textContent = 'Both fields required.'; return; }
  const key   = skUser(currentUser);
  const snips = await loadSnippets(key);
  if (snips[kw]) { e.textContent = '"' + kw + '" already exists.'; return; }
  snips[kw] = ex;
  await saveSnippets(key, snips);
  document.getElementById('us-kw').value = '';
  document.getElementById('us-exp').value = '';
  await renderUserSnippets();
  pingContent();
});

document.getElementById('us-search').addEventListener('input', async e => {
  await renderUserSnippets(e.target.value.trim().toLowerCase());
});
document.getElementById('btn-us-export').addEventListener('click', async () => {
  dlCSV('my-snippets.csv', await loadSnippets(skUser(currentUser)));
});
document.getElementById('us-csv').addEventListener('change', async e => {
  const file = e.target.files[0]; if (!file) return;
  const key    = skUser(currentUser);
  const merged = { ...await loadSnippets(key), ...parseCSV(await file.text()) };
  await saveSnippets(key, merged);
  e.target.value = ''; await renderUserSnippets(); pingContent();
});

// ═══════════════════════════════════════
// SHARED SNIPPET RENDERER
// ═══════════════════════════════════════
let editCb = null;

function renderSnipList(containerId, snips, filter, storageKey) {
  const container = document.getElementById(containerId);
  let keys = Object.keys(snips).sort();
  if (filter) keys = keys.filter(k => k.toLowerCase().includes(filter) || snips[k].toLowerCase().includes(filter));

  if (!keys.length) {
    container.innerHTML = '<div class="empty">' + (filter ? 'No snippets match.' : 'No snippets yet. Add one above!') + '</div>';
    return;
  }
  container.innerHTML = '';
  keys.forEach(kw => {
    const card = document.createElement('div');
    card.className = 'snip-card';
    card.innerHTML = `
      <div class="snip-body">
        <div class="snip-kw">${esc(kw)}</div>
        <div class="snip-preview">${esc(snips[kw])}</div>
      </div>
      <div class="snip-btns">
        <button class="card-btn">✏️</button>
        <button class="card-btn del">🗑</button>
      </div>`;

    card.querySelectorAll('.card-btn')[0].addEventListener('click', () => {
      editCb = async (newKw, newEx) => {
        delete snips[kw]; snips[newKw] = newEx;
        await saveSnippets(storageKey, snips);
        renderSnipList(containerId, snips, filter, storageKey);
        pingContent();
      };
      document.getElementById('e-kw').value  = kw;
      document.getElementById('e-exp').value = snips[kw];
      document.getElementById('e-err').textContent = '';
      document.getElementById('modal-edit').classList.remove('hidden');
    });

    card.querySelectorAll('.card-btn')[1].addEventListener('click', async () => {
      delete snips[kw];
      await saveSnippets(storageKey, snips);
      renderSnipList(containerId, snips, filter, storageKey);
      pingContent();
    });

    container.appendChild(card);
  });
}

// Edit modal
document.getElementById('btn-e-cancel').addEventListener('click', () => document.getElementById('modal-edit').classList.add('hidden'));
document.getElementById('btn-e-save').addEventListener('click', async () => {
  const kw = document.getElementById('e-kw').value.trim();
  const ex = document.getElementById('e-exp').value.trim();
  const e  = document.getElementById('e-err');
  if (!kw) { e.textContent = 'Keyword required.'; return; }
  if (!ex) { e.textContent = 'Expanded text required.'; return; }
  document.getElementById('modal-edit').classList.add('hidden');
  if (editCb) { await editCb(kw, ex); editCb = null; }
});

// ═══════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function pingContent() {
  chrome.tabs.query({}, tabs => {
    tabs.forEach(t => chrome.tabs.sendMessage(t.id, { type: 'RELOAD' }).catch(() => {}));
  });
}



// Alias for compatibility
function escapeHtml(s) { return esc(s); }


// ═══════════════════════════════════════
// LOGS (Owner views user activity)
// ═══════════════════════════════════════
async function loadLogs() {
  const list = document.getElementById('logs-list');
  if (!list) return;
  list.innerHTML = '<div class="empty">Loading…</div>';
  try {
    const logs = await fsListLogs();
    const keys = Object.keys(logs).sort((a, b) => (logs[b].lastUsed || 0) - (logs[a].lastUsed || 0));

    if (!keys.length) {
      list.innerHTML = '<div class="empty">No activity yet. Logs appear when users expand text.</div>';
      return;
    }

    list.innerHTML = '';
    keys.forEach(username => {
      const log  = logs[username];
      const card = document.createElement('div');
      card.className = 'log-card';

      const lastUsed = log.lastUsed ? new Date(parseInt(log.lastUsed)).toLocaleString() : '—';
      const entries  = [log.e1, log.e2, log.e3].filter(Boolean);

      let entriesHtml = '';
      entries.forEach((entry, i) => {
        // Parse "keyword → expanded | timestamp"
        const pipeIdx = entry.lastIndexOf(' | ');
        const time    = pipeIdx !== -1 ? entry.slice(pipeIdx + 3) : '';
        const main    = pipeIdx !== -1 ? entry.slice(0, pipeIdx) : entry;
        const arrowIdx = main.indexOf(' → ');
        const kw      = arrowIdx !== -1 ? main.slice(0, arrowIdx) : main;
        const exp     = arrowIdx !== -1 ? main.slice(arrowIdx + 3) : '';

        entriesHtml += `
          <div class="log-entry">
            <span class="log-num">#${i + 1}</span>
            <span class="log-kw" title="${esc(kw)}">${esc(kw)}</span>
            <span class="log-arrow">→</span>
            <span class="log-exp" title="${esc(exp)}">${esc(exp)}</span>
            <span class="log-time">${esc(time)}</span>
          </div>`;
      });

      card.innerHTML = `
        <div class="log-user">
          👤 ${esc(username)}
          <span style="font-size:9px;color:#333;font-weight:400">Last active: ${esc(lastUsed)}</span>
        </div>
        ${entriesHtml || '<div style="font-size:10px;color:#333;padding:2px 0">No expansions logged yet</div>'}`;

      list.appendChild(card);
    });
  } catch(e) {
    list.innerHTML = `<div class="empty" style="color:#f87171">Error: ${esc(e.message)}</div>`;
  }
}

document.getElementById('btn-refresh-logs')?.addEventListener('click', loadLogs);

// ═══════════════════════════════════════
// NOTIFICATIONS (Owner)
// ═══════════════════════════════════════
async function loadNotifications() {
  const list = document.getElementById('notif-list');
  if (!list) return;
  list.innerHTML = '<div class="empty">Loading…</div>';
  try {
    const items = await fsListSuggestions();
    const keys  = Object.keys(items).sort((a,b) => (items[b].createdAt||0) - (items[a].createdAt||0));
    const unread = keys.filter(k => !items[k].read).length;

    // Show red dot if unread
    const dot = document.getElementById('owner-notif-dot');
    if (dot) dot.style.display = unread > 0 ? 'block' : 'none';

    if (!keys.length) {
      list.innerHTML = '<div class="empty">No suggestions yet.</div>';
      return;
    }

    list.innerHTML = '';
    keys.forEach(id => {
      const item = items[id];
      const card = document.createElement('div');
      card.className = 'notif-card' + (item.read ? '' : ' unread');
      const time = item.createdAt ? new Date(item.createdAt).toLocaleString() : '';
      card.innerHTML = `
        <div class="notif-header">
          <span class="notif-user">👤 ${escapeHtml(item.username || '?')}</span>
          <span class="notif-time">${time}</span>
        </div>
        <div class="notif-text">${escapeHtml(item.message || '')}</div>
        <div class="notif-actions">
          ${!item.read ? `<button class="btn-xs btn-mark-read" data-id="${escapeHtml(id)}">✓ Mark read</button>` : '<span style="font-size:10px;color:#333">✓ Read</span>'}
          <button class="btn-xs btn-del-notif" data-id="${escapeHtml(id)}" style="color:#f87171;border-color:rgba(248,113,113,.2)">🗑 Delete</button>
        </div>`;
      list.appendChild(card);
    });

    // Attach listeners
    list.querySelectorAll('.btn-mark-read').forEach(btn => {
      btn.addEventListener('click', async () => {
        await fsMarkSuggestionRead(btn.dataset.id);
        await loadNotifications();
      });
    });
    list.querySelectorAll('.btn-del-notif').forEach(btn => {
      btn.addEventListener('click', async () => {
        await fsDeleteSuggestion(btn.dataset.id);
        await loadNotifications();
      });
    });
  } catch(e) {
    list.innerHTML = `<div class="empty" style="color:#f87171">Error: ${escapeHtml(e.message)}</div>`;
  }
}

document.getElementById('btn-refresh-notifs')?.addEventListener('click', loadNotifications);

document.getElementById('btn-broadcast-clear')?.addEventListener('click', async () => {
  const btn = document.getElementById('btn-broadcast-clear');
  const err = document.getElementById('broadcast-err');
  btn.textContent = 'Clearing…';
  try {
    await fsClearBroadcast();
    btn.textContent = '✕ Clear broadcast (hide from users)';
    err.style.color = '#34d399';
    err.textContent = '✓ Broadcast cleared. Users will no longer see it.';
    setTimeout(() => { err.textContent = ''; err.style.color = ''; }, 3000);
  } catch(e) {
    btn.textContent = '✕ Clear broadcast (hide from users)';
    err.style.color = '#f87171';
    err.textContent = 'Error: ' + e.message;
  }
});

document.getElementById('btn-mark-all-read')?.addEventListener('click', async () => {
  try {
    const items = await fsListSuggestions();
    for (const id of Object.keys(items)) {
      if (!items[id].read) await fsMarkSuggestionRead(id);
    }
    await loadNotifications();
  } catch(e) {}
});

// ═══════════════════════════════════════
// BROADCAST (Owner sends, User receives)
// Dismiss state stored in Firebase — works after reinstall
// ═══════════════════════════════════════
document.getElementById('btn-broadcast-send')?.addEventListener('click', async () => {
  const msg = document.getElementById('broadcast-msg').value.trim();
  const err = document.getElementById('broadcast-err');
  const btn = document.getElementById('btn-broadcast-send');
  err.textContent = '';
  if (!msg) { err.textContent = 'Type a message first.'; return; }
  btn.textContent = 'Sending…';
  btn.disabled    = true;
  try {
    await fsSetBroadcast(msg);
    btn.textContent    = 'Send';
    btn.disabled       = false;
    err.style.color    = '#34d399';
    err.textContent    = '✓ Sent! Users will see it when they open the extension.';
    document.getElementById('broadcast-msg').value = '';
    setTimeout(() => { err.textContent = ''; err.style.color = ''; }, 4000);
  } catch(e) {
    btn.textContent = 'Send';
    btn.disabled    = false;
    err.style.color = '#f87171';
    err.textContent = 'Error: ' + e.message;
  }
});

// ── Load and show broadcast for user ──
let activeBroadcastSentAt = null;

async function loadBroadcast(username) {
  const banner = document.getElementById('broadcast-banner');
  const text   = document.getElementById('broadcast-text');
  if (!banner || !text) return;

  try {
    // Fetch directly from Firebase REST API
    const url = FB_BASE + '/broadcast/current?key=' + FB_API_KEY;
    const res = await fetch(url);

    if (res.status === 404) { banner.style.display = 'none'; return; }
    if (!res.ok)            { banner.style.display = 'none'; return; }

    const doc = await res.json();
    if (!doc || !doc.fields) { banner.style.display = 'none'; return; }

    // Read raw Firestore fields
    const message = doc.fields.message ? doc.fields.message.stringValue  : '';
    const sentAt  = doc.fields.sentAt  ? parseInt(doc.fields.sentAt.integerValue) : 0;
    const active  = doc.fields.active  ? doc.fields.active.booleanValue  : false;

    if (!active || !message || !sentAt) { banner.style.display = 'none'; return; }

    // Check if dismissed (stored in Firebase)
    const dismissedAt = await fsGetDismissed(username);
    if (dismissedAt >= sentAt) { banner.style.display = 'none'; return; }

    // Show banner
    activeBroadcastSentAt = sentAt;
    text.textContent      = message;
    banner.style.display  = 'flex';

  } catch(e) {
    banner.style.display = 'none';
  }
}

document.getElementById('btn-dismiss-broadcast')?.addEventListener('click', async () => {
  const banner = document.getElementById('broadcast-banner');
  if (banner) banner.style.display = 'none';
  // Save dismiss to Firebase so it persists across reinstalls
  if (activeBroadcastSentAt && currentUser) {
    try {
      await fsDismissBroadcast(currentUser, activeBroadcastSentAt);
    } catch(e) {}
  }
});

// ═══════════════════════════════════════
// SUGGESTIONS (User submits)
// ═══════════════════════════════════════
document.getElementById('btn-open-suggest')?.addEventListener('click', () => {
  document.getElementById('suggest-text').value = '';
  document.getElementById('suggest-err').textContent = '';
  document.getElementById('suggest-ok').textContent = '';
  document.getElementById('modal-suggest').classList.remove('hidden');
});

document.getElementById('btn-suggest-cancel')?.addEventListener('click', () => {
  document.getElementById('modal-suggest').classList.add('hidden');
});

document.getElementById('btn-suggest-send')?.addEventListener('click', async () => {
  const msg = document.getElementById('suggest-text').value.trim();
  const err = document.getElementById('suggest-err');
  const ok  = document.getElementById('suggest-ok');
  err.textContent = ''; ok.textContent = '';
  if (!msg) { err.textContent = 'Please type a suggestion first.'; return; }
  if (msg.length > 500) { err.textContent = 'Max 500 characters.'; return; }
  try {
    document.getElementById('btn-suggest-send').textContent = 'Sending…';
    await fsAddSuggestion(currentUser || 'unknown', msg);
    document.getElementById('btn-suggest-send').textContent = 'Send 💡';
    ok.textContent = '✓ Suggestion sent! Thank you.';
    document.getElementById('suggest-text').value = '';
    setTimeout(() => {
      document.getElementById('modal-suggest').classList.add('hidden');
      ok.textContent = '';
    }, 2000);
  } catch(e) {
    document.getElementById('btn-suggest-send').textContent = 'Send 💡';
    err.textContent = 'Error sending. Try again.';
  }
});