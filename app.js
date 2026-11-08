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
// Note shown under a discovered server. A port already in use means it is running elsewhere (usually an agent's
// preview tool); SM-1 can add it but never stops what it doesn't own.
function suggestionNote(s) {
  if (s.conflict) return s.conflict;
  if (s.holder) {
    const exe = String(s.holder.exe || 'a process').split(/[\\/]/).pop();
    return `running elsewhere: ${exe} (PID ${s.holder.pid}) — stop it there, then start it here`;
  }
  return '';
}
// Incident rows from /api/state.events (`at` is epoch seconds). Tone drives colour; label is what the chip says.
const EVENT_KINDS = {
  crash: ['crashed', 'bad'], crash_loop: ['gave up', 'bad'], build_failure: ['build failed', 'bad'],
  build_rollback: ['rolled back', 'warn'], build_cleanup_failure: ['cleanup failed', 'warn'],
};
function ago(atSeconds, nowMs) {
  const s = Math.max(0, Math.round(nowMs / 1000 - atSeconds));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
function eventView(event, nowMs) {
  const [kindLabel, tone] = EVENT_KINDS[event.kind] || [String(event.kind || 'event').replace(/_/g, ' '), 'info'];
  return {kindLabel, tone, when: ago(Number(event.at) || 0, nowMs)};
}
// Newest first. The final crash of a loop is recorded twice (crash + crash_loop with the same message); show it
// once, as the give-up.
function collapseEvents(events) {
  const newest = [...(events || [])].sort((a, b) => b.id - a.id);
  const loops = new Set(newest.filter(e => e.kind === 'crash_loop').map(e => `${e.server_id}\n${e.message}`));
  return newest.filter(e => !(e.kind === 'crash' && loops.has(`${e.server_id}\n${e.message}`)));
}
// Reservation countdown, m:ss; `expiresAt` is epoch seconds.
function countdown(expiresAt, nowMs) {
  const left = Math.ceil(Number(expiresAt) - nowMs / 1000);
  if (!(left > 0)) return 'expired';
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
}
// A package script needs an explicit port; optional extra arguments are typed as words and may contain {port}.
// Mirrors the backend's rules so Add can be disabled before a doomed request.
function packageDraft(portText, argsText) {
  const raw = String(portText || '').trim();
  if (!raw) return {ok: false, error: 'Choose a port'};
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 65535) return {ok: false, error: 'Port must be 1-65535'};
  const text = String(argsText || '');
  // One argument per line, so an argument may contain spaces. npm runs through a Windows .cmd shim, which can't
  // take embedded double quotes, so those are refused rather than silently mangled.
  // Validate each raw line before trimming, so a tab at an argument's edge is refused rather than silently dropped.
  const lines = text.split(/\r?\n/);
  if (lines.some(line => /[\u0000-\u001f\u007f]/.test(line))) return {ok: false, error: 'Arguments cannot contain control characters'};
  const words = lines.map(line => line.trim()).filter(Boolean);
  if (words.some(w => w.includes('"'))) return {ok: false, error: 'No double quotes (the Windows npm runner rejects them)'};
  return {ok: true, port: Number(raw), port_args: words};
}
// The exact argument list a package suggestion will run, each argument shown in brackets so boundaries are visible.
function packageCommand(script, draft) {
  const words = draft.port_args.map(w => w.split('{port}').join(String(draft.port)));
  return ['npm', 'run', script, ...(words.length ? ['--', ...words] : [])].map(w => `[${w}]`).join(' ');
}
// Log search results as display lines, newest first. `line_from_end` counts back from the end of its file.
function searchLines(result) {
  return (result.matches || []).map(m =>
    `${m.file === undefined ? '' : m.file}:-${m.line_from_end}  ${m.text}${m.line_truncated ? ' …' : ''}`);
}
function searchSummary(result, limit) {
  const n = (result.matches || []).length;
  const parts = [n === 1 ? '1 match' : `${n} matches`, 'newest first',
    `${Number(result.scanned_lines || 0).toLocaleString('en-GB')} lines searched`];
  // The backend's single `truncated` flag covers both the match limit and the size limits; don't claim which.
  if (result.truncated) parts.push(limit && n >= limit ? `stopped at ${limit} matches or a size limit: there may be more`
    : 'partial: size limits reached');
  return parts.join(' · ');
}
Object.assign(globalThis, {safeLinks, openUrlFor, uptime, splitDetail, lcdText, controlState, parsePairing,
  suggestionNote, eventView, collapseEvents, countdown, packageDraft, packageCommand, searchLines, searchSummary});

// ---------- runtime ----------
if (typeof document !== 'undefined' && document.getElementById && document.getElementById('servers')) {
  const rows = new Map();
  const pending = new Set();
  let handoverSeq = 0;
  const resetHandover = () => {
    handoverSeq += 1;
    const dialog = document.getElementById('handover-dialog');
    if (dialog && dialog.open) dialog.close();
  };
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
  // Desktop-only API routes (port reservations, package ports, handover preview) answer 403 elsewhere.
  const desktop = !remote && ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname);

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
  // `auto` marks selections the UI makes itself; any explicit user selection cancels a pending auto-select of a
  // just-added server, so the controls never move to a server the user didn't choose.
  const select = (id, focus = false, auto = false) => {
    if (!auto) { pendingSelect = null; userSelections += 1; }
    if (selected !== id) {
      resetSearch(); resetHandover();
      selected = id; $('#log').textContent = ''; $('#log').dataset.fresh = 'true';
    }
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

  const suggestPending = new Set();
  const drafts = new Map();   // package suggestion key -> {port, args, gen}; survives re-renders while typing
  // One global, never-reused counter: a new generation invalidates any Free port reply still in flight for that
  // suggestion, even if the suggestion disappeared and came back under the same key.
  let draftSeq = 0;
  const bumpDraft = key => {
    const d = drafts.get(key) || {port: '', args: ''};
    draftSeq += 1;
    drafts.set(key, {...d, gen: draftSeq});
    return draftSeq;
  };
  const el = (tag, cls, text) => {
    const node = document.createElement(tag); if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  // Rows are keyed and rebuilt only when their own data changes, so typing, caret and focus survive polls.
  const suggRows = new Map();   // key -> {signature, row}
  const renderSuggestions = list => {
    const box = $('#suggestions');
    $('#discovered').hidden = !list.length;
    const keys = new Set(list.map(s => s.key));
    for (const [key, entry] of suggRows) if (!keys.has(key)) { entry.row.remove(); suggRows.delete(key); drafts.delete(key); }
    list.forEach((s, index) => {
      const signature = JSON.stringify([s, suggestPending.has(s.key)]);
      let entry = suggRows.get(s.key);
      if (!entry || entry.signature !== signature) {
        const row = suggestionRow(s);
        if (entry) entry.row.replaceWith(row);
        entry = {signature, row}; suggRows.set(s.key, entry);
      }
      if (box.children[index] !== entry.row) box.insertBefore(entry.row, box.children[index] || null);
    });
  };
  const suggestionRow = s => {
    {
      const pkg = s.kind === 'package';
      const row = el('div', pkg ? 'sugg sugg-pkg' : 'sugg');
      const led = el('span', 'led led-ghost'); led.setAttribute('aria-hidden', 'true');
      const name = el('span', 'sugg-name', s.name);
      const port = el('span', 'chip chip-port', pkg ? 'npm' : `:${s.port}`);
      const meta = el('span', 'sugg-meta', s.project || '');
      meta.title = [s.source, (s.command || []).join(' ')].filter(Boolean).join(' · ');
      const note = el('span', 'sugg-note', suggestionNote(s)); note.hidden = !note.textContent;
      const keys = el('span', 'sugg-keys');
      const busy = suggestPending.has(s.key) || Boolean(s.conflict);
      const make = (label, cls, handler, disabled, title) => {
        const b = el('button', `key key-small ${cls}`, label); b.type = 'button';
        b.disabled = disabled; if (title) b.title = title;
        b.addEventListener('click', handler); keys.append(b);
        return b;
      };
      row.append(led, name, port, meta);
      if (pkg) row.append(packageFields(s, busy, make));
      else {
        make('Add & start', 'key-hot', () => suggest(s, 'add', {start: true}), busy || Boolean(s.holder),
          s.holder ? 'Port in use elsewhere: add it, stop the other copy, then start it here' : '');
        make('Add', '', () => suggest(s, 'add', {start: false}), busy);
      }
      make('Dismiss', 'key-quiet', () => suggest(s, 'dismiss'), suggestPending.has(s.key));
      row.append(note, keys);
      return row;
    }
  };
  // package.json dev/preview scripts: show the script, ask for an explicit port (and optional extra arguments),
  // and keep Add disabled until the draft is valid. Only the desktop may choose ports.
  const packageFields = (s, busy, make) => {
    const wrap = el('div', 'pkg');
    const script = el('code', 'pkg-script', `npm run ${s.script}  →  ${s.script_text || ''}`);
    script.title = s.script_text || '';
    wrap.append(script);
    if (!desktop) {
      wrap.append(el('span', 'pkg-hint', 'Needs a port: add it from the desktop.'));
      make('Add', '', () => {}, true);
      return wrap;
    }
    const draft = drafts.get(s.key) || {port: '', args: ''};
    const fields = el('div', 'pkg-fields');
    const portField = el('input', 'field field-port');
    Object.assign(portField, {type: 'number', min: 1, max: 65535, inputMode: 'numeric', placeholder: 'port', value: draft.port});
    portField.setAttribute('aria-label', `Port for ${s.name}`);
    const pick = el('button', 'key key-small', 'Free port'); pick.type = 'button';
    pick.title = 'Reserve a free port from the allocation range and use it here';
    const args = el('textarea', 'field field-args');
    Object.assign(args, {rows: 3, placeholder: 'extra args (optional), one per line:\n--port\n{port}', value: draft.args, spellcheck: false});
    args.setAttribute('aria-label', `Extra arguments for ${s.name}, one per line; {port} is replaced with the port`);
    fields.append(portField, pick, args);
    const hint = el('span', 'pkg-hint');
    wrap.append(fields, hint);
    const start = make('Add & start', 'key-hot', () => addPackage(s, true), true);
    const add = make('Add', '', () => addPackage(s, false), true);
    // refresh() only reads this row's fields (safe before the row is attached); sync() also writes the shared
    // draft, and only while connected, so a row replaced by a re-render can't overwrite its successor.
    const refresh = () => {
      const d = packageDraft(portField.value, args.value);
      hint.textContent = d.ok ? `Runs: ${packageCommand(s.script, d)}` : d.error;
      hint.dataset.bad = String(!d.ok && Boolean(portField.value || args.value));
      start.disabled = add.disabled = busy || !d.ok;
    };
    const sync = () => {
      if (!portField.isConnected) return;
      const prev = drafts.get(s.key) || {gen: 0};
      drafts.set(s.key, {...prev, port: portField.value, args: args.value});
      refresh();
    };
    portField.addEventListener('input', () => { bumpDraft(s.key); sync(); });
    args.addEventListener('input', sync);
    pick.addEventListener('click', async () => {
      const gen = bumpDraft(s.key);
      pick.disabled = true;
      try {
        const r = await (await post('/api/ports/allocate', {label: s.name})).json();
        const current = drafts.get(s.key);
        if (!current || current.gen !== gen) return;   // the port was edited or re-picked meanwhile
        drafts.set(s.key, {...current, port: String(r.port)});
        const live = suggRows.get(s.key);
        const field = live && live.row.querySelector('.field-port');
        if (field) { field.value = String(r.port); field.dispatchEvent(new Event('input')); }
        pollSoon();
      } catch (error) { toast(error.message); }
      finally { pick.disabled = false; }
    });
    refresh();
    return wrap;
  };
  const addPackage = (s, start) => {
    const draft = drafts.get(s.key) || {};
    const d = packageDraft(draft.port, draft.args);
    if (!d.ok) { toast(d.error); return; }
    suggest(s, 'add', {start, port: d.port, port_args: d.port_args}).then(ok => { if (ok) drafts.delete(s.key); });
  };
  const suggest = async (s, action, body) => {
    suggestPending.add(s.key); renderSuggestions(lastSuggestions);
    const selectionsAtStart = userSelections;   // a click while Add is in flight wins over auto-select
    let ok = false, added = null;
    try {
      const reply = await (await post(`/api/suggestions/${encodeURIComponent(s.key)}/${action}`, body)).json();
      toast(action === 'dismiss' ? `Dismissed ${s.name}` : `Added ${reply.id || s.name}`);
      added = reply.id || null;
      ok = true;
    } catch (error) { toast(error.message); }
    finally {
      // Selected once a snapshot contains it, through the same transition as clicking the row.
      if (added && userSelections === selectionsAtStart) pendingSelect = added;
      suggestPending.delete(s.key); await poll(); pollSoon();
    }
    return ok;
  };
  let lastSuggestions = [];
  let pendingSelect = null, userSelections = 0;

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
    $('#d-handover').hidden = !(desktop && server.state === 'port-busy');
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

  // ---------- events (incidents) + alerts ----------
  let lastEvents = [], alerts = {enabled: true, quiet: false}, showAllEvents = false;
  // A state poll that began before the last Quiet change (or during one) must not overwrite it.
  let alertsGen = 0, quietInFlight = false;
  const serverName = id => (servers.find(s => s.id === id) || {}).name || id;
  const renderEvents = () => {
    const list = $('#events'), now = Date.now();
    const newest = collapseEvents(lastEvents);
    const shown = showAllEvents ? newest : newest.slice(0, 5);
    // Rebuilt only when the incidents themselves change; relative times are refreshed in place, keeping focus.
    const signature = JSON.stringify([shown, servers.map(s => [s.id, s.name])]);
    if (list.dataset.signature === signature) {
      for (const when of list.querySelectorAll('.event-when')) {
        when.textContent = ago(Date.parse(when.dateTime) / 1000, now);
      }
    } else {
      list.dataset.signature = signature;
      list.replaceChildren();
      for (const e of shown) {
        const v = eventView(e, now);
        const item = el('li', 'event'); item.dataset.tone = v.tone;
        item.dataset.server = e.server_id;
        const when = el('time', 'event-when', v.when);
        when.dateTime = new Date(e.at * 1000).toISOString(); when.title = new Date(e.at * 1000).toLocaleString();
        const name = el('button', 'event-server', serverName(e.server_id)); name.type = 'button';
        name.title = 'Select this server';
        name.addEventListener('click', () => { if (servers.some(s => s.id === e.server_id)) select(e.server_id); });
        const msg = el('span', 'event-msg', e.message || ''); msg.title = e.message || '';
        item.append(el('span', 'chip chip-event', v.kindLabel), name, when, msg);
        list.append(item);
      }
    }
    for (const item of list.children) item.dataset.current = String(item.dataset.server === selected);
    $('#events-empty').hidden = newest.length > 0;
    const more = $('#events-more');
    more.hidden = newest.length <= 5;
    more.textContent = showAllEvents ? 'Show fewer' : `Show all ${newest.length}`;
    const chip = $('#alerts-state'), quiet = $('#k-quiet');
    chip.dataset.mode = !alerts.enabled ? 'off' : alerts.quiet ? 'quiet' : 'on';
    chip.textContent = !alerts.enabled ? 'alerts off' : alerts.quiet ? 'alerts paused' : 'alerts on';
    chip.title = !alerts.enabled ? 'Turned off in servers.toml ([alerts] enabled = false)'
      : 'Tray notifications for crashes and failed builds';
    quiet.hidden = !alerts.enabled;
    quiet.setAttribute('aria-pressed', String(Boolean(alerts.quiet)));
  };
  $('#events-more').addEventListener('click', () => { showAllEvents = !showAllEvents; renderEvents(); });
  $('#k-quiet').addEventListener('click', async () => {
    const quiet = $('#k-quiet'), want = !alerts.quiet;   // apply the value sent, never a re-inversion
    quiet.disabled = true; quietInFlight = true; alertsGen += 1;
    try {
      await post('/api/alerts/quiet', {on: want});
      alerts = {...alerts, quiet: want}; alertsGen += 1; renderEvents();
      toast(want ? 'Desktop alerts paused' : 'Desktop alerts on');
    } catch (error) { toast(error.message); }
    finally { quiet.disabled = false; quietInFlight = false; alertsGen += 1; pollSoon(); }
  });

  // ---------- port reservations ----------
  let lastReservations = [], reservationsStale = false;
  const renderReservations = () => {
    const list = $('#reservations'), now = Date.now();
    const live = lastReservations.filter(r => countdown(r.expires_at, now) !== 'expired')
      .sort((a, b) => a.port - b.port);
    list.replaceChildren();
    for (const r of live) {
      const item = el('li', 'reservation');
      item.append(el('span', 'chip chip-port', `:${r.port}`), el('span', 'res-label', r.label || 'unlabelled'),
        el('span', 'res-left', countdown(r.expires_at, now)));
      item.title = `Held for an agent or a new server until it expires or a server registers on :${r.port}`;
      list.append(item);
    }
    list.hidden = !live.length;
    list.dataset.stale = String(reservationsStale);
    list.title = reservationsStale ? 'Manager offline: these may already have been released' : '';
  };
  $('#reserve').hidden = !desktop; $('#reserve-remote').hidden = desktop;
  setInterval(renderReservations, 1000);   // countdown ticks and expiry hide work even while offline
  $('#reserve').addEventListener('submit', async event => {
    event.preventDefault();
    const body = {}, labelText = $('#r-label').value.trim(), preferred = $('#r-port').value.trim();
    if (labelText) body.label = labelText;
    if (preferred) body.preferred = Number(preferred);
    const button = $('#reserve button'); button.disabled = true;
    try {
      const r = await (await post('/api/ports/allocate', body)).json();
      toast(`Reserved :${r.port} for 2 minutes`);
      $('#r-label').value = ''; $('#r-port').value = '';
      lastReservations = [...lastReservations.filter(x => x.port !== r.port), r]; renderReservations();
    } catch (error) { toast(error.message); }
    finally { button.disabled = false; pollSoon(); }
  });

  // ---------- handover preview (read-only) ----------
  // Bumped by every selection transition, so a reply for an abandoned preview is never shown.
  $('#d-handover').addEventListener('click', async () => {
    const id = selected; if (!id) return;
    const seq = ++handoverSeq;
    try {
      const plan = await (await request(`/api/servers/${encodeURIComponent(id)}/handover`)).json();
      if (seq !== handoverSeq || id !== selected) return;   // abandoned: never show stale steps
      $('#handover-dialog').dataset.server = id;
      $('#ho-title').textContent = `Handover preview · ${serverName(id)}`;
      const h = plan.holder;
      $('#ho-port').textContent = `:${plan.port}`;
      $('#ho-holder').textContent = !h ? 'nobody now: just press Start'
        : `${String(h.exe || 'unknown').split(/[\\/]/).pop()} · PID ${h.pid}${plan.managed_holder ? ' (SM-1)' : ''}`;
      $('#ho-holder').title = h ? h.exe || '' : '';
      $('#ho-holder-cmd').textContent = h ? h.command_line || 'not readable' : '—';
      $('#ho-command').textContent = (plan.command || []).join(' ');
      $('#ho-cwd').textContent = plan.cwd || '';
      $('#ho-step1').textContent = h ? 'Stop that process where it was started (its terminal, agent session or preview tool).'
        : 'Nothing holds the port any more.';
      $('#ho-step2').textContent = `Then select ${serverName(id)} and press Start.`;
      $('#handover-dialog').showModal();
    } catch (error) { toast(error.message); }
  });
  $('#ho-close').addEventListener('click', () => $('#handover-dialog').close());

  // ---------- log search ----------
  // Every search has a sequence number; Live log and any selection change bump it, so a late reply (success or
  // error) for an abandoned search is ignored.
  let searching = false, searchSeq = 0, searchController = null;
  const LIVE_HINT = 'Last 400 lines, live.';
  const resetSearch = () => {
    searchSeq += 1;
    if (searchController) { searchController.abort(); searchController = null; }
    const wasSearching = searching;
    searching = false; $('#q-clear').hidden = true;
    $('#log-hint').textContent = LIVE_HINT; delete $('#log-hint').dataset.bad;
    $('#log').dataset.mode = 'live';
    $('#search button[type="submit"]').disabled = false;
    return wasSearching;
  };
  const endSearch = () => {
    if (!resetSearch()) return;
    $('#log').dataset.fresh = 'true'; $('#log').textContent = '';
    refreshLog();
  };
  $('#q-regex').addEventListener('click', () => {
    const b = $('#q-regex'); b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'));
  });
  $('#q-clear').addEventListener('click', () => { $('#q').value = ''; endSearch(); });
  $('#search').addEventListener('submit', async event => {
    event.preventDefault();
    const q = $('#q').value, id = selected;
    if (!id) return;
    if (!q) { endSearch(); return; }
    const regex = $('#q-regex').getAttribute('aria-pressed') === 'true';
    const limit = Number($('#q-limit').value) || 50;
    const hint = $('#log-hint'), find = $('#search button[type="submit"]');
    if (searchController) searchController.abort();
    const seq = ++searchSeq, controller = new AbortController();
    searchController = controller;
    const current = () => seq === searchSeq && id === selected;
    find.disabled = true; hint.textContent = regex ? 'Searching (up to 3 seconds)…' : 'Searching…';
    delete hint.dataset.bad;
    try {
      const result = await (await request(`/api/servers/${encodeURIComponent(id)}/search?` +
        new URLSearchParams({q, regex: String(regex), limit: String(limit)}), {signal: controller.signal})).json();
      if (!current()) return;
      if (logRequest) { logRequest.controller.abort(); logRequest = null; }
      searching = true; $('#q-clear').hidden = false;
      const lines = searchLines(result);
      $('#log').dataset.mode = 'search';
      $('#log').textContent = lines.length ? lines.join('\n') : `No lines match "${q}".`;
      $('#log').scrollTop = 0;
      hint.textContent = searchSummary(result, limit);
    } catch (error) {
      if (!current() || error.name === 'AbortError') return;
      hint.textContent = error.message; hint.dataset.bad = 'true';
    } finally {
      if (seq === searchSeq) { find.disabled = false; searchController = null; }
    }
  });

  let logRequest = null;
  const refreshLog = async () => {
    const log = $('#log');
    if (!selected || searching) return;
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
    const pollGen = alertsGen;   // a Quiet change during this poll makes its alerts reply stale
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
        resetSearch(); resetHandover(); selected = null; $('#log').textContent = '';
        try { localStorage.removeItem('sm1.selected'); } catch (_) { /* storage optional */ }
        render();
      } else if (pendingSelect && ids.has(pendingSelect)) {
        const id = pendingSelect; pendingSelect = null; select(id, false, true);
      } else if (!ids.has(selected)) select(servers[0].id, false, true);
      else { markSelection(false); render(); refreshLog(); }
      lastSuggestions = Array.isArray(data.suggestions) ? data.suggestions : [];
      renderSuggestions(lastSuggestions);
      lastEvents = Array.isArray(data.events) ? data.events : [];
      if (data.alerts && !quietInFlight && pollGen === alertsGen) {
        alerts = {enabled: Boolean(data.alerts.enabled), quiet: Boolean(data.alerts.quiet)};
      }
      renderEvents();
      lastReservations = Array.isArray(data.reservations) ? data.reservations : [];
      reservationsStale = false;
      renderReservations();
      const errors = $('#config-errors'); errors.replaceChildren();
      for (const error of data.manager.config_errors || []) {
        const line = document.createElement('p'); line.textContent = error; errors.append(line);
      }
      errors.hidden = !errors.children.length;
      document.body.dataset.offline = 'false';
    } catch (error) {
      document.body.dataset.offline = 'true';
      reservationsStale = true; renderReservations();
      const unpaired = !remote && /\.github\.io$/.test(location.hostname);
      $('#lcd-1').textContent = unpaired ? 'not paired' : 'manager offline';
      $('#lcd-2').textContent = unpaired ? 'scan phone link on desktop' : 'retrying…';
    } finally { polling = false; }
  };

  let soon = null;
  const pollSoon = () => { clearTimeout(soon); soon = setTimeout(poll, 150); };

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
