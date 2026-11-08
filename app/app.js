'use strict';
// SM-1 dashboard: a selectable server list, a detail readout, a live log and one row of keys that act on the
// selected server. All server data is written with textContent/attributes only.

const $ = (selector, parent = document) => parent.querySelector(selector);
const LABELS = {up: 'up', starting: 'starting', building: 'building', stopping: 'stopping',
  unhealthy: 'unhealthy', crashed: 'crashed', 'port-busy': 'port busy', stopped: 'stopped'};
const LINK_NAMES = {local: 'Local', lan: 'LAN', meshnet: 'Meshnet'};
const PUB_LABELS = {none: 'not published', publishing: 'publishing…', published: 'live', unpublishing: 'removing…', failed: 'failed'};
const label = state => LABELS[state] || String(state);

// ---------- pure helpers (tested in tests/test_ui.py) ----------
function safeLinks(links) {
  const out = {};
  for (const [key, value] of Object.entries(links || {})) {
    if (!value) continue;
    try {
      const url = new URL(value);
      if (['http:', 'https:'].includes(url.protocol)) out[key] = url.href;
    } catch (_) { /* Disabled config rows can carry invalid ports or hosts. */ }
  }
  return out;
}
function openUrlFor(links, hostname) {
  const valid = safeLinks(links);
  return Object.values(valid).find(url => new URL(url).hostname === hostname) || valid.local || null;
}
function uptime(seconds) {
  if (!seconds) return '';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}
function splitDetail(detail) {
  const text = detail || '';
  const cut = text.indexOf(' — ');
  return cut < 0 ? {main: text, cmd: ''} : {main: text.slice(0, cut), cmd: text.slice(cut + 3)};
}
function lcdText(servers) {
  const group = {up: 'up', 'port-busy': 'busy', starting: 'work', building: 'work', stopping: 'work',
    unhealthy: 'sick', crashed: 'crash', stopped: 'off'};
  const counts = {};
  for (const s of servers) { const key = group[s.state] || 'off'; counts[key] = (counts[key] || 0) + 1; }
  const line1 = ['up', 'busy', 'work', 'sick', 'crash', 'off'].filter(k => counts[k])
    .map(k => `${counts[k]} ${k}`).join(' · ') || 'no servers';
  const pick = state => servers.find(s => s.state === state);
  const crashed = pick('crashed'), sick = pick('unhealthy'),
    working = pick('building') || pick('starting') || pick('stopping'), busy = pick('port-busy');
  let line2 = 'SM-1 ready';
  if (crashed) line2 = `crashed: ${crashed.name}`;
  else if (sick) line2 = `not answering: ${sick.name}`;
  else if (working) line2 = `${label(working.state)}: ${working.name}`;
  else if (busy) line2 = `:${busy.port} ${splitDetail(busy.detail).main || 'held elsewhere'}`;
  return [line1, line2];
}
function controlState(server, pending) {
  const running = Boolean(server.pid) || ['up', 'starting', 'unhealthy'].includes(server.state);
  const busy = Boolean(server.busy || pending) || ['building', 'stopping'].includes(server.state);
  const blocked = busy || Boolean(server.disabled);
  const portBusy = server.state === 'port-busy';
  return {
    primary: running ? 'stop' : 'start',
    primaryDisabled: blocked || (portBusy && !running),
    restartDisabled: blocked || portBusy,
    rebuildDisabled: blocked || portBusy || !server.has_build,
    autoDisabled: blocked,
    openable: !['stopped', 'crashed', 'building'].includes(server.state),
  };
}
// Pairing link from the desktop: <pages app>#m=<manager base>&t=<token>. Returns null unless both are valid.
function parsePairing(hash) {
  const params = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  const base = params.get('m'), token = params.get('t');
  if (!base || !token || token.length < 43) return null;
  try {
    const url = new URL(base);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return {base: url.origin, token};
  } catch (_) { return null; }
}
Object.assign(globalThis, {safeLinks, openUrlFor, uptime, splitDetail, lcdText, controlState, parsePairing});

// ---------- runtime ----------
if (typeof document !== 'undefined' && document.getElementById && document.getElementById('servers')) {
  const rows = new Map();
  const pending = new Set();
  let servers = [];
  let selected = null;
  let polling = false;
  let toastTimer;
  let dialogUrl = '';
  let reloading = false;
  try { selected = localStorage.getItem('sm1.selected'); } catch (_) { /* storage optional */ }
  // Native shell: the manager's pywebview window loads /?shell=native and exposes minimize()/hide().
  if (new URLSearchParams(location.search).get('shell') === 'native') {
    document.documentElement.dataset.shell = 'native';
    const api = name => () => { try { window.pywebview.api[name](); } catch (error) { toast('Window control unavailable'); } };
    $('#win-min').addEventListener('click', api('minimize'));
    $('#win-hide').addEventListener('click', api('hide'));
  }

  // Remote mode: the installable copy on GitHub Pages talks to the manager over Meshnet with a bearer token.
  // The token arrives in the URL fragment (never sent to GitHub), is kept in this origin's storage, then removed
  // from the address bar.
  let remote = null;
  const paired = parsePairing(location.hash);
  if (paired) {
    try { localStorage.setItem('sm1.remote', JSON.stringify(paired)); } catch (_) { /* storage optional */ }
    remote = paired;
    history.replaceState(null, '', location.pathname + location.search);
  } else {
    try { remote = JSON.parse(localStorage.getItem('sm1.remote') || 'null'); } catch (_) { remote = null; }
  }
  if (remote && remote.base === location.origin) remote = null;   // served by the manager itself
  const API = remote ? remote.base : '';
  const linkHost = remote ? new URL(remote.base).hostname : location.hostname;

  const request = async (path, options = {}) => {
    const headers = {...(options.headers || {})};
    if (remote) headers.Authorization = `Bearer ${remote.token}`;
    const response = await fetch(API + path, {cache: 'no-store', ...options, headers});
    if (!response.ok) {
      const data = await response.json().catch(() => ({error: `Request failed (${response.status})`}));
      throw new Error(data.error || `Request failed (${response.status})`);
    }
    return response;
  };
  const post = (path, body) => request(path, {method: 'POST',
    headers: {'X-ServerMgr': '1', 'Content-Type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body)});
  const toast = message => {
    const el = $('#toast'); el.textContent = message; el.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 5000);
  };
  const copy = async text => {
    try {
      if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
      else {
        // Plain-HTTP Meshnet pages have no Clipboard API; fall back to a user-initiated execCommand copy.
        const field = document.createElement('textarea');
        field.className = 'copy-field'; field.value = text; field.setAttribute('aria-label', 'Link to copy');
        const dialog = $('#qr-dialog'), host = dialog.open ? dialog : document.body;
        host.append(field); field.select();
        const ok = document.execCommand('copy'); field.remove();
        if (dialog.open) $('#qr-copy').focus();
        if (!ok) throw new Error('Copy blocked: select the link and copy it yourself.');
      }
      toast('Link copied');
    } catch (error) { toast(error.message); }
  };
  const showQr = (title, url, note, alt) => {
    dialogUrl = url;
    const altButton = $('#qr-alt');
    altButton.hidden = !alt;
    if (alt) {
      altButton.textContent = alt.label;
      altButton.onclick = () => showQr(title, alt.url, alt.note, {label: alt.backLabel, url, note, backLabel: alt.label});
    }
    $('#qr-title').textContent = title;
    $('#qr-note').textContent = note || ''; $('#qr-note').hidden = !note;
    $('#qr-url').textContent = url; $('#qr-url').href = url;
    const box = $('#qr'); box.replaceChildren();
    try { new QRCode(box, {text: url, width: 220, height: 220, correctLevel: QRCode.CorrectLevel.M}); }
    catch (_) { box.textContent = 'QR unavailable. Use the link below.'; }
    $('#qr-dialog').showModal();
  };

  const markSelection = focus => {
    for (const [rid, row] of rows) {
      const on = rid === selected;
      row.setAttribute('aria-selected', String(on)); row.tabIndex = on ? 0 : -1;
      if (on && focus) row.focus();
    }
  };
  const select = (id, focus = false) => {
    if (selected !== id) { selected = id; $('#log').textContent = ''; $('#log').dataset.fresh = 'true'; }
    try { localStorage.setItem('sm1.selected', id); } catch (_) { /* storage optional */ }
    markSelection(focus); render(); refreshLog();
  };

  const makeRow = server => {
    const row = document.createElement('div');
    row.className = 'row'; row.setAttribute('role', 'option'); row.dataset.id = server.id;
    for (const cls of ['led', 'row-name', 'chip chip-port', 'chip chip-state', 'row-meta', 'row-note']) {
      const part = document.createElement('span'); part.className = cls;
      if (cls === 'led') part.setAttribute('aria-hidden', 'true');
      row.append(part);
    }
    row.addEventListener('click', () => select(server.id));
    row.addEventListener('keydown', event => {
      const ids = servers.map(s => s.id), at = ids.indexOf(server.id);
      const next = {ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: ids.length - 1}[event.key];
      if (next === undefined) return;
      event.preventDefault();
      select(ids[Math.max(0, Math.min(ids.length - 1, next))], true);
    });
    $('#servers').append(row); rows.set(server.id, row);
    return row;
  };

  const updateRow = server => {
    const row = rows.get(server.id) || makeRow(server);
    row.dataset.state = server.state;
    $('.row-name', row).textContent = server.name;
    $('.chip-port', row).textContent = `:${server.port}`;
    $('.chip-state', row).textContent = label(server.state);
    $('.row-meta', row).textContent = uptime(server.uptime_s);
    const note = splitDetail(server.detail).main;
    $('.row-note', row).textContent = note; $('.row-note', row).hidden = !note;
    row.title = server.detail || '';
  };

  const setOpen = url => {
    const open = $('#k-open');
    if (url) { open.href = url; open.removeAttribute('aria-disabled'); open.tabIndex = 0; }
    else { open.removeAttribute('href'); open.setAttribute('aria-disabled', 'true'); open.tabIndex = -1; }
  };

  const renderLinks = server => {
    const box = $('#d-links');
    const valid = safeLinks(server.links);
    const signature = server.id + JSON.stringify(valid);
    if (box.dataset.signature === signature) return;
    box.dataset.signature = signature;
    box.replaceChildren();
    for (const key of ['local', 'lan', 'meshnet']) {
      if (!valid[key]) continue;
      const chip = document.createElement('button');
      chip.type = 'button'; chip.className = 'chip chip-link';
      chip.textContent = LINK_NAMES[key]; chip.title = valid[key];
      chip.addEventListener('click', () => showQr(`${server.name} · ${LINK_NAMES[key]}`, valid[key]));
      box.append(chip);
    }
    if (!box.children.length) box.textContent = 'No usable links.';
  };

  const render = () => {
    const [l1, l2] = lcdText(servers);
    $('#reload').disabled = reloading || pending.size > 0 ||
      servers.some(s => s.busy || ['building', 'stopping'].includes(s.state));
    $('#lcd-1').textContent = l1; $('#lcd-2').textContent = l2;
    const server = servers.find(s => s.id === selected);
    $('#detail').hidden = !server;
    $('#log-name').textContent = server ? `· ${server.name}` : '';
    if (!server) {
      for (const k of document.querySelectorAll('.keys [data-action], #k-auto')) k.disabled = true;
      setOpen(null); return;
    }
    const c = controlState(server, pending.has(server.id));
    document.querySelector('.detail-head').dataset.state = server.state;
    $('#d-name').textContent = server.name;
    $('#d-state').textContent = label(server.state);
    $('#d-port').textContent = `:${server.port}`;
    $('#d-pid').textContent = server.pid ? String(server.pid) : '—';
    $('#d-uptime').textContent = uptime(server.uptime_s) || '—';
    $('#d-build').textContent = server.build ? (server.build.commit || 'built') : '—';
    $('#d-build').title = server.build ? `Built ${new Date(server.build.at).toLocaleString()}` : '';
    const note = splitDetail(server.detail);
    $('#d-note').hidden = !note.main; $('#d-note').dataset.state = server.state;
    $('#d-note-main').textContent = note.main; $('#d-note-cmd').textContent = note.cmd;
    $('#d-note-cmd').hidden = !note.cmd;
    renderLinks(server);

    const primary = $('#k-primary');
    primary.dataset.mode = c.primary;
    primary.textContent = c.primary === 'stop' ? '■ Stop' : '▶ Start';
    primary.disabled = c.primaryDisabled;
    $('#k-restart').disabled = c.restartDisabled;
    $('#k-rebuild').disabled = c.rebuildDisabled;
    $('#k-rebuild').hidden = !server.has_build;
    $('#k-auto').disabled = c.autoDisabled;
    $('#k-auto').setAttribute('aria-pressed', String(Boolean(server.autorestart)));
    setOpen(c.openable ? openUrlFor(server.links, linkHost) : null);
    renderPublish(server, c);
  };

  const renderPublish = (server, c) => {
    const pub = server.publish || {state: 'none'};
    const box = $('#d-publish');
    box.hidden = !server.can_publish && pub.state === 'none';
    if (box.hidden) return;
    const moving = ['publishing', 'unpublishing'].includes(pub.state);
    box.dataset.pub = pub.state;
    $('#p-state').textContent = PUB_LABELS[pub.state] || pub.state;
    const url = safeLinks({hosted: pub.url}).hosted;
    $('#p-link').hidden = !url;
    $('#p-link').title = url || '';
    $('#p-link').onclick = url ? () => showQr(`${server.name} · hosted copy`, url,
      'Public GitHub Pages copy (marked noindex). It stays up with the desktop off until you unpublish.') : null;
    const when = pub.at ? new Date(pub.at).toLocaleString([], {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'}) : '';
    $('#p-detail').textContent = [pub.detail, pub.commit, when].filter(Boolean).join(' · ');
    const blocked = c.autoDisabled || moving || !server.can_publish;
    $('#k-publish').textContent = pub.state === 'published' ? 'Republish' : 'Publish';
    $('#k-publish').disabled = blocked;
    $('#k-unpublish').hidden = !pub.repo;
    $('#k-unpublish').disabled = c.autoDisabled || moving;
  };

  let logRequest = null;
  const refreshLog = async () => {
    const log = $('#log');
    if (!selected) return;
    if (logRequest && logRequest.id === selected) return;   // one in flight for this server is enough
    if (logRequest) logRequest.controller.abort();          // selection changed: drop the stale request
    const id = selected, controller = new AbortController(), mine = {id, controller};
    logRequest = mine;
    try {
      const atEnd = log.dataset.fresh === 'true' || log.scrollHeight - log.scrollTop - log.clientHeight < 24;
      const text = await (await request(`/api/servers/${encodeURIComponent(id)}/log?tail=400`,
        {signal: controller.signal})).text();
      if (id !== selected) return;
      // Strip terminal colour/cursor codes (Astro, npm) so the log reads cleanly.
      const shown = text.replace(/\[[0-9;?]*[A-Za-z]/g, '') || 'No output yet.';
      if (log.textContent !== shown) log.textContent = shown;
      if (atEnd) log.scrollTop = log.scrollHeight;
      log.dataset.fresh = 'false';
    } catch (error) { if (error.name !== 'AbortError') toast(error.message); }
    finally { if (logRequest === mine) logRequest = null; }
  };

  const operate = async (action, body) => {
    const id = selected; if (!id) return;
    pending.add(id); render();
    try { await post(`/api/servers/${encodeURIComponent(id)}/${action}`, body); }
    catch (error) { toast(error.message); }
    finally { pending.delete(id); await poll(); }
  };

  const poll = async () => {
    if (document.hidden || polling) return;
    polling = true;
    try {
      const data = await (await request('/api/state')).json();
      servers = data.servers;
      for (const server of servers) {
        try { updateRow(server); } catch (error) { console.error(error); }
      }
      const ids = new Set(servers.map(s => s.id));
      for (const [id, row] of rows) if (!ids.has(id)) { row.remove(); rows.delete(id); }
      $('#empty').hidden = servers.length > 0;
      if (!servers.length) {
        selected = null; $('#log').textContent = '';
        try { localStorage.removeItem('sm1.selected'); } catch (_) { /* storage optional */ }
        render();
      } else if (!ids.has(selected)) select(servers[0].id);
      else { markSelection(false); render(); refreshLog(); }
      const errors = $('#config-errors'); errors.replaceChildren();
      for (const error of data.manager.config_errors || []) {
        const line = document.createElement('p'); line.textContent = error; errors.append(line);
      }
      errors.hidden = !errors.children.length;
      document.body.dataset.offline = 'false';
    } catch (error) {
      document.body.dataset.offline = 'true';
      const unpaired = !remote && /\.github\.io$/.test(location.hostname);
      $('#lcd-1').textContent = unpaired ? 'not paired' : 'manager offline';
      $('#lcd-2').textContent = unpaired ? 'scan phone link on desktop' : 'retrying…';
    } finally { polling = false; }
  };

  for (const key of document.querySelectorAll('.keys [data-action]')) {
    key.addEventListener('click', () => {
      operate(key.dataset.action === 'primary' ? key.dataset.mode : key.dataset.action);
    });
  }
  $('#k-publish').addEventListener('click', () => {
    const server = servers.find(s => s.id === selected);
    if (server && confirm(`Build and publish "${server.name}" to GitHub Pages?

It will be public to anyone with the link (marked noindex, hard to guess) until you unpublish.`)) operate('publish');
  });
  $('#k-unpublish').addEventListener('click', () => {
    const server = servers.find(s => s.id === selected);
    if (server && confirm(`Remove the hosted copy of "${server.name}"?

This turns Pages off and deletes its GitHub repo.`)) operate('unpublish');
  });
  $('#k-auto').addEventListener('click', () => {
    const server = servers.find(s => s.id === selected);
    if (server) operate('autorestart', {on: !server.autorestart});
  });
  $('#reload').addEventListener('click', async event => {
    reloading = true; render();
    try { await post('/api/reload-config'); toast('Config reloaded'); }
    catch (error) { toast(error.message); }
    finally { reloading = false; await poll(); }
  });
  $('#phone').addEventListener('click', async () => {
    try {
      const link = await (await request('/api/phone-link')).json();
      const plainNote = 'This private link controls your servers. Open it over Meshnet and keep it to yourself.';
      if (link.app_url) {
        showQr('Open on your phone', link.app_url,
          'Opens the installable SM-1 app (GitHub Pages) and pairs it with this manager over Meshnet. ' +
          'The private key stays after the # and is never sent to GitHub.',
          {label: 'Use the plain browser link instead', url: link.url, note: plainNote, backLabel: 'Use the installable app link'});
      } else showQr('Open on your phone', link.url, plainNote);
    } catch (error) { toast(error.message); }
  });
  $('#qr-close').addEventListener('click', () => $('#qr-dialog').close());
  $('#qr-copy').addEventListener('click', () => copy(dialogUrl));
  if (['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname)) $('#phone').hidden = false;
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  setInterval(poll, 2000);
  poll();
  // Installable phone app: needs a secure context (localhost, HTTPS, or Chrome's insecure-origin flag; see README).
  if ('serviceWorker' in navigator && window.isSecureContext && document.documentElement.dataset.shell !== 'native') {
    navigator.serviceWorker.register('sw.js').catch(() => { /* install stays unavailable; dashboard unaffected */ });
  }
}
