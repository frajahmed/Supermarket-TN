/** Verwaltungsportal (eine Seite, ohne externe Abhängigkeiten). Wird unter GET /admin ausgeliefert. */
export const ADMIN_HTML = `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lizenzverwaltung</title>
<style>
  :root { --bg:#f6f7f9; --card:#fff; --ink:#1b1f24; --muted:#5b6470; --line:#dfe3e8; --accent:#0b6e4f; --warn:#b26a00; --bad:#b42318; }
  @media (prefers-color-scheme: dark) { :root { --bg:#14171b; --card:#1d2126; --ink:#e8ebee; --muted:#9aa3ad; --line:#2e343b; --accent:#3ccf91; --warn:#f0b44c; --bad:#ff7b72; } }
  * { box-sizing:border-box; }
  body { margin:0; font:15px/1.45 system-ui, sans-serif; background:var(--bg); color:var(--ink); }
  header { display:flex; align-items:center; justify-content:space-between; padding:14px 16px; border-bottom:1px solid var(--line); background:var(--card); }
  h1 { font-size:17px; margin:0; }
  main { max-width:1000px; margin:0 auto; padding:16px; }
  nav { display:flex; gap:8px; margin-bottom:16px; flex-wrap:wrap; }
  button { font:inherit; border:1px solid var(--line); background:var(--card); color:var(--ink); padding:7px 12px; border-radius:8px; cursor:pointer; }
  button.primary { background:var(--accent); color:#fff; border-color:var(--accent); }
  button.danger { color:var(--bad); }
  button[aria-pressed="true"] { border-color:var(--accent); color:var(--accent); font-weight:600; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px; margin-bottom:16px; }
  table { width:100%; border-collapse:collapse; }
  th, td { text-align:left; padding:8px 6px; border-bottom:1px solid var(--line); vertical-align:middle; }
  th { color:var(--muted); font-weight:500; font-size:13px; }
  .code { font:600 16px ui-monospace, monospace; letter-spacing:1px; }
  .muted { color:var(--muted); font-size:13px; }
  .pill { display:inline-block; padding:1px 8px; border-radius:99px; font-size:12px; border:1px solid currentColor; }
  .s-active, .s-approved { color:var(--accent); } .s-warning, .s-pending { color:var(--warn); }
  .s-suspended, .s-revoked, .s-rejected, .s-read_only { color:var(--bad); }
  input, select { font:inherit; padding:7px 9px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--ink); width:100%; }
  form.grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(170px, 1fr)); gap:10px; align-items:end; }
  label { font-size:13px; color:var(--muted); display:grid; gap:4px; }
  .secret { background:var(--bg); border:1px dashed var(--warn); padding:12px; border-radius:8px; word-break:break-all; }
  .table-wrap { overflow-x:auto; }
  #msg { min-height:20px; margin-bottom:8px; }
  .err { color:var(--bad); } .ok { color:var(--accent); }
  [hidden] { display:none !important; }
</style>
</head>
<body>
<header><h1>Supermarket-TN · Lizenzverwaltung</h1><button id="logout" hidden>Abmelden</button></header>
<main>
  <section id="login" class="card" style="max-width:380px;margin:40px auto">
    <form id="loginForm" style="display:grid;gap:10px">
      <label>E-Mail <input name="email" type="email" required autocomplete="username"></label>
      <label>Passwort <input name="password" type="password" required autocomplete="current-password"></label>
      <button class="primary" type="submit">Anmelden</button>
    </form>
  </section>

  <section id="app" hidden>
    <nav>
      <button data-tab="pending" aria-pressed="true">Offene Freischaltungen <span id="pendingCount"></span></button>
      <button data-tab="customers" aria-pressed="false">Kunden</button>
      <button data-tab="devices" aria-pressed="false">Alle Geräte</button>
    </nav>
    <div id="msg" role="status"></div>

    <div data-panel="pending" class="card">
      <p class="muted">Vergleiche den Code mit dem, was der Kunde auf seinem Gerät sieht (z. B. am Telefon), bevor du freischaltest.</p>
      <div class="table-wrap"><table><thead><tr><th>Kunde</th><th>Gerät</th><th>Typ</th><th>Code</th><th>Angefragt</th><th></th></tr></thead><tbody id="pendingRows"></tbody></table></div>
    </div>

    <div data-panel="customers" hidden>
      <div class="card">
        <h2 style="font-size:15px;margin-top:0">Neuen Kunden anlegen</h2>
        <form id="createForm" class="grid">
          <label>Name <input name="name" required></label>
          <label>Matricule fiscal <input name="taxId"></label>
          <label>Kontakt <input name="contact"></label>
          <label>Max. Geräte <input name="maxDevices" type="number" min="1" value="5" required></label>
          <label>Bezahlt bis <input name="paidUntil" type="date" required></label>
          <button class="primary" type="submit">Anlegen</button>
        </form>
        <div id="secretBox" class="secret" hidden></div>
      </div>
      <div class="card table-wrap">
        <table><thead><tr><th>Kunde</th><th>Status</th><th>Bezahlt bis</th><th>Geräte</th><th>Letzter Abgleich</th><th></th></tr></thead><tbody id="customerRows"></tbody></table>
      </div>
    </div>

    <div data-panel="devices" class="card table-wrap" hidden>
      <table><thead><tr><th>Kunde</th><th>Gerät</th><th>Typ</th><th>Status</th><th>Entschieden</th><th></th></tr></thead><tbody id="deviceRows"></tbody></table>
    </div>
  </section>
</main>

<script>
(() => {
  let token = null;
  try { token = sessionStorage.getItem('stn-admin'); } catch {}
  const $ = (s) => document.querySelector(s);
  const KIND = { pos: 'Kasse', scanner: 'Scanner', tablet: 'Tablet', phone: 'Handy', pc: 'PC' };
  const STATUS = { active: 'aktiv', suspended: 'gesperrt', pending: 'offen', approved: 'freigeschaltet', rejected: 'abgelehnt', revoked: 'gesperrt' };
  const fmt = (sec) => sec ? new Date(sec * 1000).toLocaleString('de-DE') : '–';

  function el(tag, text, cls) { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }
  function pill(status) { return el('span', STATUS[status] || status, 'pill s-' + status); }
  function btn(label, cls, fn) { const b = el('button', label, cls); b.type = 'button'; b.onclick = fn; return b; }
  function row(cells) { const tr = document.createElement('tr'); for (const c of cells) { const td = document.createElement('td'); td.append(c instanceof Node ? c : document.createTextNode(c ?? '')); tr.append(td); } return tr; }
  function say(text, ok) { const m = $('#msg'); m.textContent = text; m.className = ok ? 'ok' : 'err'; }

  async function api(method, path, body) {
    const res = await fetch('/admin/api' + path, {
      method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== '/login') { logout(); throw new Error('Sitzung abgelaufen'); }
    if (!res.ok) throw new Error(data.error || 'Fehler ' + res.status);
    return data;
  }

  function show(loggedIn) { $('#login').hidden = loggedIn; $('#app').hidden = !loggedIn; $('#logout').hidden = !loggedIn; }
  function logout() { api('POST', '/logout').catch(() => {}); token = null; try { sessionStorage.removeItem('stn-admin'); } catch {} show(false); }

  async function refresh() {
    const [pending, customers, devices] = await Promise.all([
      api('GET', '/devices?status=pending'), api('GET', '/licensees'), api('GET', '/devices'),
    ]);
    $('#pendingCount').textContent = pending.length ? '(' + pending.length + ')' : '';
    const pr = $('#pendingRows'); pr.replaceChildren();
    if (!pending.length) pr.append(row([el('span', 'Keine offenen Anfragen.', 'muted')]));
    for (const d of pending) {
      const actions = el('div'); actions.style.display = 'flex'; actions.style.gap = '6px';
      actions.append(
        btn('Freischalten', 'primary', () => act(\`/devices/\${d.id}/approve\`, \`\${d.name} freigeschaltet\`)),
        btn('Ablehnen', 'danger', () => act(\`/devices/\${d.id}/reject\`, \`\${d.name} abgelehnt\`)));
      pr.append(row([d.licenseeName, d.name, KIND[d.kind] || d.kind, el('span', d.activationCode, 'code'), fmt(d.requestedAt), actions]));
    }

    const cr = $('#customerRows'); cr.replaceChildren();
    for (const c of customers) {
      const actions = el('div'); actions.style.display = 'flex'; actions.style.gap = '6px'; actions.style.flexWrap = 'wrap';
      actions.append(
        btn('Verlängern', '', () => {
          const v = prompt('Bezahlt bis (JJJJ-MM-TT):', c.paidUntil);
          if (v) act(\`/licensees/\${c.id}\`, 'Laufzeit gespeichert', 'PATCH', { paidUntil: v });
        }),
        btn('Gerätelimit', '', () => {
          const v = prompt('Maximale Geräte:', c.maxDevices);
          if (v) act(\`/licensees/\${c.id}\`, 'Gerätelimit gespeichert', 'PATCH', { maxDevices: Number(v) });
        }),
        c.status === 'active'
          ? btn('Sperren', 'danger', () => confirm(\`\${c.name} wirklich sperren? Der Kunde kann dann nur noch lesen.\`) && act(\`/licensees/\${c.id}\`, 'Kunde gesperrt', 'PATCH', { status: 'suspended' }))
          : btn('Entsperren', '', () => act(\`/licensees/\${c.id}\`, 'Kunde entsperrt', 'PATCH', { status: 'active' })));
      const name = el('div'); name.append(el('div', c.name), el('div', 'ID ' + c.id, 'muted'));
      cr.append(row([name, pill(c.status), c.paidUntil, \`\${c.approvedDevices} / \${c.maxDevices}\` + (c.pendingDevices ? \` (+\${c.pendingDevices} offen)\` : ''), fmt(c.lastCheckAt), actions]));
    }

    const dr = $('#deviceRows'); dr.replaceChildren();
    for (const d of devices) {
      const action = d.status === 'approved'
        ? btn('Sperren', 'danger', () => confirm(\`Gerät „\${d.name}“ sperren?\`) && act(\`/devices/\${d.id}/revoke\`, \`\${d.name} gesperrt\`))
        : el('span');
      dr.append(row([d.licenseeName, d.name, KIND[d.kind] || d.kind, pill(d.status), fmt(d.decidedAt), action]));
    }
  }

  async function act(path, okText, method = 'POST', body) {
    try { await api(method, path, body); say(okText, true); await refresh(); } catch (e) { say(e.message); }
  }

  document.querySelectorAll('nav button').forEach((b) => b.onclick = () => {
    document.querySelectorAll('nav button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    document.querySelectorAll('[data-panel]').forEach((p) => p.hidden = p.dataset.panel !== b.dataset.tab);
  });

  $('#loginForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      const r = await api('POST', '/login', { email: f.get('email'), password: f.get('password') });
      token = r.token; try { sessionStorage.setItem('stn-admin', token); } catch {}
      show(true); await refresh();
    } catch (err) { alert(err.message); }
  };

  $('#createForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      const r = await api('POST', '/licensees', {
        name: f.get('name'), taxId: f.get('taxId') || undefined, contact: f.get('contact') || undefined,
        maxDevices: Number(f.get('maxDevices')), paidUntil: f.get('paidUntil'),
      });
      const box = $('#secretBox'); box.hidden = false; box.replaceChildren(
        el('strong', 'Installationsdaten – nur jetzt sichtbar, in den Kundenserver eintragen:'), el('br'),
        el('span', 'Installations-ID: ' + r.installationId), el('br'), el('span', 'Installations-Secret: ' + r.installationSecret));
      e.target.reset(); await refresh();
    } catch (err) { say(err.message); }
  };

  $('#logout').onclick = logout;
  if (token) { show(true); refresh().catch(() => logout()); } else show(false);
  setInterval(() => { if (token) refresh().catch(() => {}); }, 15000);
})();
</script>
</body>
</html>
`;
