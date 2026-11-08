/* Game Master console */
(function () {
  'use strict';
  const { html, raw, escape: esc, get, post, put, del, toast, error, confirm, prompt, modal, drawer, menu, formatTime, parseTime, copy, $, $$ } = QC;

  const roomId = QC.roomIdFromPath();
  if (!roomId) {
    document.body.innerHTML = '<div class="empty"><h3>No room selected</h3><a class="btn" href="/">Back to dashboard</a></div>';
    return;
  }

  const S = {
    room: null,
    timers: { main: null, secondary: null },
    variables: {},
    media: [],
    selectedMedia: null,
    automations: [],
    slideshows: [],
    mode: 'hint',
    hintsSent: loadSession('hints', []),
    usedPresets: new Set(loadSession('usedPresets', [])),
    unread: 0
  };

  function sessionKey(k) { return `qc-gm-${roomId}-${k}`; }
  function loadSession(k, fallback) {
    try { return JSON.parse(sessionStorage.getItem(sessionKey(k))) ?? fallback; } catch (_) { return fallback; }
  }
  function saveSession(k, v) {
    try { sessionStorage.setItem(sessionKey(k), JSON.stringify(v)); } catch (_) { /* ignore */ }
  }

  const socket = io();
  window.socket = socket;

  /* ============================================================ connection */
  function setConn(state) {
    const el = $('#conn');
    const map = {
      connecting: ['dot-warning dot-pulse', 'Connecting…'],
      online: ['dot-success', 'Live'],
      offline: ['dot-danger dot-pulse', 'Disconnected – retrying…']
    };
    const [cls, text] = map[state];
    el.innerHTML = `<span class="dot ${cls}"></span><span>${text}</span>`;
  }

  socket.on('connect', () => {
    setConn('online');
    socket.emit('join_room', { roomId, clientType: 'gm' });
  });
  socket.on('disconnect', () => setConn('offline'));
  socket.on('error', (msg) => { if (msg === 'Room not found') { toast('This room no longer exists', 'error'); } });

  // Automations can play sounds on the GM console ("GM console only" / "Everywhere")
  socket.on('play_sound', (d) => {
    if (!d || d.playerOnly || !d.url) return;
    const audio = new Audio(d.url);
    audio.volume = Math.max(0, Math.min(1, (Number(d.volume) || 70) / 100));
    audio.play().catch(() => toast('A sound was blocked by the browser – click anywhere on this page once to allow sounds', 'warning'));
  });

  socket.on('presence', ({ players }) => {
    $('#screens span').textContent = players;
    $('#screens').className = `badge ${players ? 'badge-success' : ''}`;
  });

  /* ================================================================= timers */
  socket.on('timer_update', (t) => { S.timers.main = t; drawTimer('main'); });
  socket.on('secondary_timer_update', (t) => { S.timers.secondary = t; drawTimer('secondary'); });
  socket.on('timer_complete', () => { logActivity('info', 'icon-alarm-clock', "Main timer reached zero"); });

  function statusOf(t) {
    if (!t) return 'ready';
    if (t.running) return 'running';
    if (t.status === 'complete' || t.remaining === 0) return 'complete';
    if (t.remaining < t.duration) return 'paused';
    return 'ready';
  }
  const STATUS_LABEL = { running: 'Running', paused: 'Paused', complete: "Time's up", ready: 'Ready' };
  const STATUS_BADGE = { running: 'badge-success', paused: 'badge-warning', complete: 'badge-danger', ready: '' };

  function drawTimer(type) {
    const t = S.timers[type];
    if (!t) return;
    const st = statusOf(t);
    if (type === 'main') {
      const card = $('#main-timer-card');
      card.classList.remove('running', 'paused', 'complete', 'low');
      card.classList.add(st);
      if (st === 'running' && t.remaining <= 300) card.classList.add('low');
      $('#timer-display').textContent = formatTime(t.remaining);
      $('#timer-progress').style.width = `${t.duration ? ((t.duration - t.remaining) / t.duration) * 100 : 0}%`;
      $('#timer-elapsed').textContent = `${formatTime(t.duration - t.remaining)} elapsed`;
      $('#timer-total').textContent = `of ${formatTime(t.duration)}`;
      const badge = $('#timer-status');
      badge.className = `badge ${STATUS_BADGE[st]}`;
      badge.textContent = STATUS_LABEL[st];
      const btn = $('#timer-toggle');
      btn.className = `btn btn-lg timer-primary ${st === 'running' ? 'btn-warning' : 'btn-success'}`;
      btn.innerHTML = st === 'running' ? '<i class="icon-pause"></i><span>Pause</span>' : `<i class="icon-play"></i><span>${st === 'paused' ? 'Resume' : 'Start game'}</span>`;
      document.title = `${formatTime(t.remaining)} · ${S.room ? S.room.name : 'Game Master'}`;
      if (st === 'ready' && S.lastMainStatus && S.lastMainStatus !== 'ready') newGame();
      S.lastMainStatus = st;
    } else {
      const card = $('#secondary-timer-card');
      card.hidden = t.enabled === false;
      card.classList.remove('running', 'paused', 'complete');
      card.classList.add(st);
      $('#secondary-display').textContent = formatTime(t.remaining);
      const badge = $('#secondary-status');
      badge.className = `badge ${STATUS_BADGE[st]}`;
      badge.textContent = STATUS_LABEL[st];
      const btn = $('#secondary-toggle');
      btn.className = `btn btn-icon ${st === 'running' ? 'btn-warning' : 'btn-success'}`;
      btn.innerHTML = st === 'running' ? '<i class="icon-pause"></i>' : '<i class="icon-play"></i>';
    }
  }

  function timerCmd(type, action, amount) {
    const ev = type === 'secondary' ? 'secondary_timer_control' : 'timer_control';
    socket.emit(ev, { roomId, action, amount });
  }

  function toggleMain() {
    const st = statusOf(S.timers.main);
    if (st === 'running') timerCmd('main', 'pause');
    else {
      if (st === 'complete') timerCmd('main', 'reset', S.room && S.room.timer.duration);
      timerCmd('main', 'start');
      if (st === 'ready') logActivity('info', 'icon-play', 'Game started');
    }
  }

  async function resetMain() {
    const st = statusOf(S.timers.main);
    if (st === 'running' && !(await confirm({ title: 'Reset the timer?', message: 'The game is running. Resetting stops the clock and sets it back to the full time.', confirmText: 'Reset timer', danger: true }))) return;
    timerCmd('main', 'reset', S.room && S.room.timer.duration);
  }

  function adjust(type, seconds) {
    timerCmd(type, 'adjust', seconds);
    const sign = seconds > 0 ? '+' : '−';
    toast(`${sign}${formatTime(Math.abs(seconds))} ${type === 'secondary' ? 'secondary ' : ''}timer`, 'info', { timeout: 1500 });
  }

  $('#timer-toggle').onclick = toggleMain;
  $('#timer-reset').onclick = resetMain;
  $$('[data-adjust]').forEach(b => b.onclick = () => adjust('main', Number(b.dataset.adjust)));
  $$('[data-sadjust]').forEach(b => b.onclick = () => adjust('secondary', Number(b.dataset.sadjust)));
  function applyCustomAdjust() {
    const raw = $('#custom-adjust').value.trim();
    if (!raw) return;
    const negative = raw.startsWith('-') || raw.startsWith('−');
    const secs = parseTime(raw.replace(/^[+\-−]/, ''));
    if (!Number.isFinite(secs) || secs <= 0) return toast('Use a format like +2:30, -45s or 5 (minutes)', 'warning');
    adjust('main', negative ? -secs : secs);
    $('#custom-adjust').value = '';
  }
  $('#custom-adjust-btn').onclick = applyCustomAdjust;
  $('#custom-adjust').onkeydown = (e) => { if (e.key === 'Enter') applyCustomAdjust(); };
  $('#secondary-toggle').onclick = () => {
    const st = statusOf(S.timers.secondary);
    if (st === 'running') timerCmd('secondary', 'pause');
    else { if (st === 'complete') timerCmd('secondary', 'reset'); timerCmd('secondary', 'start'); }
  };
  $('#secondary-reset').onclick = () => timerCmd('secondary', 'reset');
  $('#start-both').onclick = () => { timerCmd('main', 'start'); timerCmd('secondary', 'start'); };

  /** Timer back at "ready" → a new game: reset per-game counters. */
  function newGame() {
    S.hintsSent = [];
    S.usedPresets = new Set();
    saveSession('hints', []);
    saveSession('usedPresets', []);
    drawHistory();
    drawPresets();
  }

  /* =============================================================== composer */
  function setMode(mode) {
    S.mode = mode;
    $$('.composer-card .tab').forEach(t => t.classList.toggle('active', t.dataset.mode === mode));
    $('#message-options').hidden = mode !== 'message';
    $('#send-btn').innerHTML = mode === 'hint' ? '<i class="icon-send"></i>Send hint' : '<i class="icon-megaphone"></i>Show message';
    $('#composer').placeholder = mode === 'hint'
      ? 'Type a hint for the players…  (Enter to send, Shift+Enter for a new line)'
      : 'Message to flash on every player screen…';
    $('#composer-hint').textContent = mode === 'hint'
      ? (S.room && S.room.hints.type === 'chat' ? 'Room is in chat mode – hints also appear in the hint panel.' : 'Sends a full-screen hint to every player screen.')
      : 'A styled pop-up over the player screen (doesn\'t count as a hint).';
  }
  $$('.composer-card .tab').forEach(t => t.onclick = () => setMode(t.dataset.mode));

  function send(text, { presetId } = {}) {
    const message = (text ?? $('#composer').value).trim();
    if (!message) { $('#composer').focus(); return; }
    if (S.mode === 'message' && presetId === undefined) {
      socket.emit('show_message', {
        roomId,
        text: message,
        title: $('#msg-title').value.trim(),
        style: $('#msg-style').value,
        duration: Number($('#msg-duration').value)
      });
      addHistory('message', message);
      toast('Message shown on screens', 'success', { timeout: 1800 });
    } else {
      socket.emit('sendHint', { roomId, message });
      addHistory('hint', message);
      if (presetId) { S.usedPresets.add(presetId); saveSession('usedPresets', [...S.usedPresets]); drawPresets(); }
    }
    if (text === undefined) $('#composer').value = '';
  }
  $('#send-btn').onclick = () => send();
  $('#composer').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });

  socket.on('hintConfirmed', () => toast('Hint sent', 'success', { timeout: 1500 }));

  function addHistory(kind, text) {
    S.hintsSent.unshift({ kind, text, at: Date.now(), gameTime: S.timers.main ? S.timers.main.duration - S.timers.main.remaining : null });
    S.hintsSent = S.hintsSent.slice(0, 100);
    saveSession('hints', S.hintsSent);
    drawHistory();
  }

  function drawHistory() {
    const host = $('#hint-history');
    const hints = S.hintsSent.filter(h => h.kind === 'hint').length;
    const limit = S.room ? S.room.hints.limit : 0;
    const badge = $('#hint-count');
    badge.textContent = limit ? `${hints} / ${limit} hints` : `${hints} hint${hints === 1 ? '' : 's'}`;
    badge.className = `badge ${limit && hints >= limit ? 'badge-danger' : hints ? 'badge-accent' : ''}`;
    if (!S.hintsSent.length) {
      host.innerHTML = '<div class="faint small" style="padding:12px 16px">Nothing sent yet.</div>';
      return;
    }
    host.innerHTML = S.hintsSent.map((h, i) => html`
      <div class="hist-item">
        <i class="${h.kind === 'hint' ? 'icon-lightbulb' : 'icon-megaphone'}"></i>
        <div class="grow">${h.text}</div>
        <span class="when" title="${new Date(h.at).toLocaleTimeString()}">${h.gameTime != null ? formatTime(h.gameTime) : new Date(h.at).toLocaleTimeString()}</span>
        <button class="btn btn-ghost btn-icon btn-xs resend" data-i="${i}" aria-label="Send again" data-tip="Send again"><i class="icon-redo-2"></i></button>
      </div>`).join('');
    host.querySelectorAll('.resend').forEach(b => b.onclick = () => {
      const h = S.hintsSent[+b.dataset.i];
      const prev = S.mode;
      S.mode = h.kind === 'hint' ? 'hint' : 'message';
      send(h.text, h.kind === 'hint' ? { presetId: null } : {});
      S.mode = prev;
    });
  }

  $('#clear-hints').onclick = async () => {
    if (!(await confirm({ title: 'Clear hints from player screens?', message: 'Players will no longer see previous hints. Your history here is kept.', confirmText: 'Clear' }))) return;
    socket.emit('clear_hints', { roomId });
  };

  /* --------------------------------------------------------------- presets */
  function drawPresets() {
    const host = $('#presets');
    const presets = (S.room && S.room.hints.presets) || [];
    if (!presets.length) {
      host.innerHTML = html`<div class="faint small">Tip: add one-click hints in <a href="/#rooms" id="presets-link">room settings → Hints</a>.</div>`;
      return;
    }
    const groups = new Map();
    presets.forEach(p => {
      const k = p.category || 'Saved hints';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(p);
    });
    host.innerHTML = [...groups.entries()].map(([cat, list]) => html`
      <div class="preset-group"><h4>${cat}</h4><div class="preset-chips">
        ${raw(list.map(p => html`<span class="preset-chip ${S.usedPresets.has(p.id) ? 'used' : ''}" title="${p.text}">
          <button class="pc-text" data-fill="${p.id}">${p.text}</button>
          <button class="pc-send" data-send="${p.id}" aria-label="Send now"><i class="icon-send"></i></button></span>`).join(''))}
      </div></div>`).join('');
    host.querySelectorAll('[data-fill]').forEach(b => b.onclick = () => {
      const p = presets.find(x => x.id === b.dataset.fill);
      setMode('hint');
      $('#composer').value = p.text;
      $('#composer').focus();
    });
    host.querySelectorAll('[data-send]').forEach(b => b.onclick = () => {
      const p = presets.find(x => x.id === b.dataset.send);
      const prev = S.mode;
      S.mode = 'hint';
      send(p.text, { presetId: p.id });
      S.mode = prev;
    });
  }

  /* ==================================================================== chat */
  socket.on('chat_message', (m) => {
    addBubble(m);
    if (m.sender === 'player') {
      $('#chat-typing').hidden = true;
      if (window.notificationManager) window.notificationManager.onChatReceived && window.notificationManager.playNotification('gm_chat_receive');
      const card = $('#chat-card');
      const r = card.getBoundingClientRect();
      const visible = r.top < innerHeight && r.bottom > 0;
      if (!visible || document.hidden) {
        S.unread += 1;
        $('#chat-unread').hidden = false;
        $('#chat-unread').textContent = `${S.unread} new`;
      }
      card.classList.remove('flash'); void card.offsetWidth; card.classList.add('flash');
      logActivity('info', 'icon-message-circle', html`${chatNames().players}: “${m.message}”`);
    }
  });
  socket.on('clear_chat', (data) => {
    $('#chat-log').innerHTML = `<div class="bubble system">${data && data.reason === 'idle' ? 'Chat cleared automatically (room was idle)' : 'Chat cleared'}</div>`;
  });

  // Server cleared player screens after the room sat idle between games
  socket.on('auto_cleared', (d) => {
    const what = [d.hints && 'hints', d.chat && 'chat'].filter(Boolean).join(' and ') || 'pop-ups';
    logActivity('info', 'icon-eraser', `Player screens cleared automatically (${esc(what)}) after ${Number(d.minutes) || 15} idle minutes`);
    toast(`Idle room: cleared ${what} on player screens`, 'info', { timeout: 6000 });
  });
  let typingTimer;
  socket.on('typing', ({ sender }) => {
    if (sender !== 'player') return;
    $('#chat-typing').hidden = false;
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => { $('#chat-typing').hidden = true; }, 3000);
  });

  /** Labels for chat bubbles, using the room's custom chat names when set. */
  function chatNames() {
    const h = (S.room && S.room.hints) || {};
    const gm = h.gmName && h.gmName !== 'GM' ? `You as ${h.gmName}` : 'You';
    const players = h.playerName && h.playerName !== 'Player' ? h.playerName : 'Players';
    return { gm, players };
  }

  function addBubble(m) {
    const log = $('#chat-log');
    const empty = log.querySelector('.chat-empty');
    if (empty) empty.remove();
    const b = document.createElement('div');
    b.className = `bubble ${m.sender === 'gm' ? 'gm' : m.sender === 'player' ? 'player' : 'system'}`;
    b.innerHTML = html`${m.message}<small>${m.sender === 'gm' ? chatNames().gm : chatNames().players} · ${new Date(m.timestamp || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small>`;
    log.appendChild(b);
    log.scrollTop = log.scrollHeight;
  }

  function sendChat() {
    const input = $('#chat-input');
    const message = input.value.trim();
    if (!message) return;
    socket.emit('chat_message', { roomId, sender: 'gm', message });
    input.value = '';
  }
  $('#chat-send').onclick = sendChat;
  $('#chat-input').onkeydown = (e) => { if (e.key === 'Enter') sendChat(); };
  $('#chat-input').onfocus = () => { S.unread = 0; $('#chat-unread').hidden = true; };
  $('#clear-chat').onclick = async () => {
    if (await confirm({ title: 'Clear the chat?', message: 'This clears the conversation on player screens too.', confirmText: 'Clear chat' })) socket.emit('clear_chat', { roomId });
  };

  /* =============================================================== variables */
  const TIMER_VARS = ['timer_main', 'timer_main_remaining', 'timer_secondary', 'timer_secondary_remaining'];
  socket.on('variableUpdate', (data) => {
    if (data.variables) {
      const prev = S.variables;
      S.variables = data.variables;
      drawVariables(Object.keys(data.variables).filter(k => JSON.stringify(prev[k]) !== JSON.stringify(data.variables[k])));
    } else if (data.name) {
      S.variables[data.name] = data.value;
      drawVariables([data.name]);
    }
    if (data.name && data.source && data.source !== 'gm' && !TIMER_VARS.includes(data.name)) {
      logActivity('info', 'icon-variable', html`<strong>${data.name}</strong> → ${JSON.stringify(data.value)} <span class="faint">(${String(data.source).replace(/^automation:/, 'automation ').replace(/^http:.*/, 'device')})</span>`);
    }
  });

  function setVar(name, value, mode) {
    socket.emit('set_variable', { roomId, name, value, mode }, (res) => {
      if (!res || !res.success) toast((res && res.error) || 'Could not update variable', 'error');
    });
  }

  function drawVariables(changed = []) {
    const host = $('#var-list');
    const entries = Object.entries(S.variables).filter(([k]) => !TIMER_VARS.includes(k)).sort(([a], [b]) => a.localeCompare(b));
    if (!entries.length) {
      host.innerHTML = '<div class="faint small" style="padding:12px 16px">No variables yet. Props, webhooks and automations can create them.</div>';
    } else {
      host.innerHTML = entries.map(([name, value]) => {
        let ctrl;
        if (typeof value === 'boolean') {
          ctrl = html`<label class="switch"><input type="checkbox" data-bool="${name}" ${value ? 'checked' : ''}><span class="track"></span></label>`;
        } else if (typeof value === 'number') {
          ctrl = html`<button class="btn btn-xs btn-icon" data-dec="${name}" aria-label="Decrease"><i class="icon-minus"></i></button>
            <span class="vnum" data-edit="${name}" title="Click to edit">${value}</span>
            <button class="btn btn-xs btn-icon" data-inc="${name}" aria-label="Increase"><i class="icon-plus"></i></button>`;
        } else if (value && typeof value === 'object') {
          ctrl = html`<code class="truncate" style="max-width:150px" title="${JSON.stringify(value)}">${JSON.stringify(value)}</code><button class="btn btn-xs btn-icon" data-json="${name}"><i class="icon-pencil"></i></button>`;
        } else {
          ctrl = html`<input class="input input-sm vtext" data-text="${name}" value="${value ?? ''}">`;
        }
        return html`<div class="var-item ${changed.includes(name) ? 'changed' : ''}"><span class="vname" title="${name}">${name}</span><div class="vctrl">${raw(ctrl)}</div></div>`;
      }).join('');
    }
    host.querySelectorAll('[data-bool]').forEach(i => i.onchange = () => setVar(i.dataset.bool, i.checked));
    host.querySelectorAll('[data-inc]').forEach(b => b.onclick = () => setVar(b.dataset.inc, 1, 'increment'));
    host.querySelectorAll('[data-dec]').forEach(b => b.onclick = () => setVar(b.dataset.dec, 1, 'decrement'));
    host.querySelectorAll('[data-text]').forEach(i => {
      const commit = () => { if (String(S.variables[i.dataset.text] ?? '') !== i.value) setVar(i.dataset.text, i.value); };
      i.onkeydown = (e) => { if (e.key === 'Enter') { commit(); i.blur(); } if (e.key === 'Escape') { i.value = S.variables[i.dataset.text] ?? ''; i.blur(); } };
      i.onblur = commit;
    });
    host.querySelectorAll('[data-edit]').forEach(s => s.onclick = async () => {
      const v = await prompt({ title: `Set ${s.dataset.edit}`, label: 'Value', value: String(S.variables[s.dataset.edit]) });
      if (v !== null && v !== undefined) setVar(s.dataset.edit, v);
    });
    host.querySelectorAll('[data-json]').forEach(b => b.onclick = async () => {
      const v = await prompt({ title: `Edit ${b.dataset.json}`, label: 'JSON value', value: JSON.stringify(S.variables[b.dataset.json]) });
      if (v) { try { setVar(b.dataset.json, JSON.parse(v)); } catch (_) { toast('That is not valid JSON', 'error'); } }
    });

    const tv = $('#timer-vars');
    tv.innerHTML = TIMER_VARS.filter(k => k in S.variables).map(k => html`<div class="var-item"><span class="vname">${k}</span><span class="mono small">${S.variables[k]} <span class="faint">(${formatTime(S.variables[k])})</span></span></div>`).join('') || '<div class="faint small" style="padding:8px 16px">Start a timer to see live values.</div>';
  }

  // Timer variables are not pushed every second; derive them locally for display
  setInterval(() => {
    const m = S.timers.main, s = S.timers.secondary;
    if (m) { S.variables.timer_main = m.duration - m.remaining; S.variables.timer_main_remaining = m.remaining; }
    if (s && s.enabled !== false) { S.variables.timer_secondary = s.duration - s.remaining; S.variables.timer_secondary_remaining = s.remaining; }
    const details = $('.builtin-vars');
    if (details && details.open) drawVariables();
  }, 1000);

  $('#add-var').onclick = async () => {
    const body = document.createElement('div');
    body.className = 'stack';
    body.innerHTML = `
      <div class="field"><label>Name</label><input class="input mono" id="nv-name" placeholder="door_open"></div>
      <div class="field"><label>Value</label><input class="input" id="nv-value" placeholder="false, 0, or any text"><div class="hint">true/false and numbers are detected automatically.</div></div>`;
    const ok = await modal({
      title: 'Add variable', size: 'sm', body,
      actions: [{ label: 'Cancel', value: null }, {
        label: 'Add', variant: 'primary', onClick: () => {
          const name = body.querySelector('#nv-name').value.trim().replace(/[^\w.-]/g, '_');
          if (!name) return false;
          setVar(name, body.querySelector('#nv-value').value);
          return true;
        }
      }]
    });
    if (ok) toast('Variable added', 'success');
  };

  /* =================================================================== media */
  async function loadMedia() {
    try {
      S.media = (await get(`/api/v2/rooms/${roomId}/media`))
        .filter(m => (m.type === 'image' || m.type === 'video') && (m.metadata && m.metadata.category) !== 'icon');
    } catch (_) { S.media = []; }
    drawMedia();
  }

  function drawMedia() {
    const grid = $('#media-grid');
    if (!S.media.length) {
      grid.innerHTML = '<div class="media-empty">No media yet – upload images or videos to show players. You can also send just a headline.</div>';
      return;
    }
    grid.innerHTML = S.media.map(m => html`
      <button class="media-tile ${S.selectedMedia === m.id ? 'selected' : ''}" data-id="${m.id}" title="${m.title || ''}">
        ${m.type === 'image' ? raw(html`<img src="${m.url}" alt="" loading="lazy">`) : raw(html`<video src="${m.url}#t=0.5" muted preload="metadata"></video>`)}
        <span class="mt-type">${m.type === 'video' ? raw('<i class="icon-video"></i>') : raw('<i class="icon-image"></i>')}</span>
        <span class="mt-del" data-del="${m.id}" role="button" aria-label="Delete"><i class="icon-trash-2"></i></span>
      </button>`).join('');
    grid.querySelectorAll('.media-tile').forEach(t => t.onclick = (e) => {
      if (e.target.closest('[data-del]')) return;
      S.selectedMedia = S.selectedMedia === t.dataset.id ? null : t.dataset.id;
      drawMedia();
    });
    grid.querySelectorAll('[data-del]').forEach(d => d.onclick = async (e) => {
      e.stopPropagation();
      if (!(await confirm({ title: 'Remove this media?', message: 'It will be removed from this room\'s media list.', confirmText: 'Remove', danger: true }))) return;
      try { await QC.api('DELETE', `/api/media/${d.dataset.del}`); if (S.selectedMedia === d.dataset.del) S.selectedMedia = null; loadMedia(); } catch (err) { error(err); }
    });
  }

  $('#upload-media').onclick = async () => {
    const files = await QC.pickFiles({ accept: 'image/*,video/*', multiple: true });
    if (!files) return;
    const t = toast(`Uploading ${files.length} file${files.length > 1 ? 's' : ''}…`, 'info', { timeout: 0 });
    try {
      const up = await QC.upload(files, { roomId, category: 'media' });
      t();
      toast('Upload complete', 'success');
      await loadMedia();
      if (up.length === 1 && up[0].mediaId) { S.selectedMedia = up[0].mediaId; drawMedia(); }
    } catch (err) { t(); error(err); }
  };

  $('#show-media').onclick = () => {
    const headline = $('#media-headline').value.trim();
    if (!S.selectedMedia && !headline) return toast('Pick an image/video or type a headline', 'warning');
    const seconds = Number($('#media-close').value);
    socket.emit('show_lightbox', { roomId, mediaId: S.selectedMedia, headline, autoCloseEnabled: seconds > 0, autoCloseSeconds: seconds });
    const m = S.media.find(x => x.id === S.selectedMedia);
    logActivity('info', 'icon-cast', html`Showed ${m ? (m.title || 'media') : 'headline'}${headline ? html` – “${headline}”` : ''}`);
    toast('Showing on player screens', 'success', { timeout: 1500 });
  };

  /* ============================================================ quick actions */
  async function loadAutomations() {
    try { S.automations = await get(`/api/v2/rooms/${roomId}/automations`); } catch (_) { S.automations = []; }
    const manual = S.automations.filter(a => a.enabled && a.trigger && a.trigger.type === 'manual');
    const host = $('#quick-actions');
    host.innerHTML = manual.map(a => html`
      <button class="quick-btn" data-run="${a.id}" style="--qa:${a.trigger.color || 'var(--accent)'}" title="${a.name}">
        <i class="${a.trigger.icon ? `icon-${a.trigger.icon}` : 'icon-zap'}"></i><span>${a.trigger.label || a.name}</span>
      </button>`).join('');
    if (!manual.length) {
      host.insertAdjacentHTML('afterend', '');
      host.outerHTML = `<div class="quick-grid" id="quick-actions"></div><div class="quick-empty" id="quick-empty">Add a <a href="/room/${esc(roomId)}/automations">GM button automation</a> to get one-click actions here (lights off, open a door, play a sound…).</div>`;
      return;
    }
    const empty = $('#quick-empty');
    if (empty) empty.remove();
    host.querySelectorAll('[data-run]').forEach(b => b.onclick = () => {
      b.classList.add('running');
      socket.emit('run_automation', { roomId, automationId: b.dataset.run }, (res) => {
        b.classList.remove('running');
        if (!res || !res.success) return toast((res && res.error) || 'Action failed', 'error');
        const r = res.data || {};
        if (r.ran === false) toast(`Skipped: ${r.reason === 'conditions' ? 'conditions not met' : r.reason}`, 'warning');
        else toast(`${b.textContent.trim()} ✓`, 'success', { timeout: 1500 });
      });
    });
  }

  async function loadSlideshows() {
    try { S.slideshows = await get(`/api/v2/rooms/${roomId}/slideshows`); } catch (_) { S.slideshows = []; }
    const sel = $('#slideshow-select');
    sel.innerHTML = S.slideshows.length
      ? (S.slideshows.length > 1 ? '<option value="">Let players choose…</option>' : '') + S.slideshows.map(s => html`<option value="${s.id}">${s.name} (${s.slideCount} slides)</option>`).join('')
      : '<option value="">No slideshows yet</option>';
    $('#play-slideshow').disabled = !S.slideshows.length;
  }

  $('#play-slideshow').onclick = async () => {
    const id = $('#slideshow-select').value || null;
    if (!(await confirm({ title: 'Play slideshow on player screens?', message: 'Player screens switch to the slideshow and return to the game screen when it ends.', confirmText: 'Play now' }))) return;
    socket.emit('start_slideshow', { roomId, slideshowId: id });
    const s = S.slideshows.find(x => x.id === id);
    logActivity('info', 'icon-presentation', `Started slideshow${s ? ` “${esc(s.name)}”` : ''}`);
  };
  $('#close-overlays').onclick = () => { socket.emit('close_overlays', { roomId }); toast('Closed pop-ups on screens', 'info', { timeout: 1500 }); };
  $('#reload-players').onclick = async () => {
    if (await confirm({ title: 'Reload all player screens?', message: 'Useful if a screen looks stuck. The game timer is not affected.', confirmText: 'Reload' })) socket.emit('reload_players', { roomId });
  };

  /* ================================================================ activity */
  const activity = [];
  function logActivity(level, icon, htmlText, at = new Date()) {
    activity.unshift({ level, icon, html: htmlText, at });
    if (activity.length > 80) activity.length = 80;
    const host = $('#activity');
    host.innerHTML = activity.map(a => `
      <div class="act-item ${a.level}"><i class="${a.icon}"></i><div class="grow">${a.html}</div>
      <span class="when">${a.at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span></div>`).join('');
  }

  function logFromAutomation(l) {
    const icons = { run: 'icon-zap', error: 'icon-circle-x', skip: 'icon-skip-forward', info: 'icon-info' };
    if (l.level === 'skip') return; // too noisy for live games
    logActivity(l.level, icons[l.level] || 'icon-info', html`${l.automation ? raw(html`<strong>${l.automation}</strong> · `) : ''}${l.message}`, new Date(l.at));
  }
  socket.on('automation_log', logFromAutomation);

  /* ==================================================================== notes */
  $('#notes-btn').onclick = () => {
    const p = $('#notes-panel');
    p.hidden = !p.hidden;
  };
  $('#close-notes').onclick = () => { $('#notes-panel').hidden = true; };

  /* ===================================================================== menu */
  $('#more-btn').onclick = (e) => menu(e.currentTarget, [
    { label: 'Room settings', icon: 'icon-settings-2', onClick: () => { location.href = '/#rooms'; } },
    { label: 'Slideshows', icon: 'icon-presentation', onClick: () => window.open(`/room/${roomId}/slideshows`, '_blank') },
    { label: 'Automations', icon: 'icon-zap', onClick: () => window.open(`/room/${roomId}/automations`, '_blank') },
    { label: 'Edit player theme', icon: 'icon-palette', onClick: () => window.open(`/theme-builder/${S.room ? S.room.theme : ''}?room=${roomId}`, '_blank') },
    'divider',
    { label: 'Sounds & room look', icon: 'icon-swatch-book', onClick: openSettings },
    { label: 'Keyboard shortcuts', icon: 'icon-keyboard', onClick: showShortcuts },
    { label: 'Toggle light / dark', icon: 'icon-sun-moon', onClick: QC.toggleUiTheme }
  ]);

  function showShortcuts() {
    modal({
      title: 'Keyboard shortcuts', size: 'sm', icon: 'icon-keyboard',
      body: `<dl class="kv">
        <dt><kbd>Space</kbd></dt><dd>Start / pause the game timer</dd>
        <dt><kbd>H</kbd></dt><dd>Write a hint</dd>
        <dt><kbd>M</kbd></dt><dd>Write a screen message</dd>
        <dt><kbd>C</kbd></dt><dd>Reply in chat</dd>
        <dt><kbd>+</kbd> / <kbd>-</kbd></dt><dd>Add / remove one minute</dd>
        <dt><kbd>N</kbd></dt><dd>Show GM notes</dd>
        <dt><kbd>Enter</kbd></dt><dd>Send (Shift+Enter for a new line)</dd>
      </dl>`
    });
  }

  QC.hotkeys({
    ' ': toggleMain,
    'h': () => { setMode('hint'); $('#composer').focus(); },
    'm': () => { setMode('message'); $('#composer').focus(); },
    'c': () => $('#chat-input').focus(),
    'n': () => $('#notes-btn').click(),
    '+': () => adjust('main', 60),
    'shift++': () => adjust('main', 60),
    '=': () => adjust('main', 60),
    '-': () => adjust('main', -60),
    '?': showShortcuts,
    'shift+?': showShortcuts
  });

  /* ================================================== settings (sounds/look) */
  const SOUND_TYPES = [
    ['player_hint_receive', 'Hint arrives on player screens'],
    ['player_chat_receive', 'GM chat reply on player screens'],
    ['player_chat_send', 'Player sends a chat message (player screen)'],
    ['player_media_received', 'Media shown on player screens'],
    ['gm_chat_receive', 'Player message arrives (this console)'],
    ['variable_trigger', 'A variable changes (player screens)']
  ];

  async function openSettings() {
    let audio = [], settings = [], custom = {};
    try {
      [audio, settings, custom] = await Promise.all([
        get(`/api/rooms/${roomId}/notifications/audio`).catch(() => []),
        get(`/api/rooms/${roomId}/notifications/settings`).catch(() => []),
        get(`/api/rooms/${roomId}/gm-customization`).catch(() => ({}))
      ]);
    } catch (err) { return error(err); }
    const byType = Object.fromEntries((settings || []).map(s => [s.setting_type, s]));
    let look = { ...(S.room.appearance || {}) };

    const body = document.createElement('div');
    body.className = 'stack-lg';
    function render() {
      body.innerHTML = html`
        <div>
          <div class="row mb-8"><h3 class="grow">Notification sounds</h3><button class="btn btn-sm" id="up-audio"><i class="icon-upload"></i>Upload sound</button></div>
          <div class="stack-sm">${raw(SOUND_TYPES.map(([type, label]) => {
            const s = byType[type] || { enabled: false, audio_id: '', settings: { volume: 0.7 } };
            return html`<div class="card" style="padding:10px 12px"><div class="row row-wrap">
              <label class="switch grow"><input type="checkbox" data-en="${type}" ${s.enabled ? 'checked' : ''}><span class="track"></span><span class="small">${label}</span></label>
              <select class="select input-sm" data-audio="${type}" style="width:170px"><option value="">No sound</option>${raw(audio.map(a => html`<option value="${a.id}" ${a.id === s.audio_id ? 'selected' : ''}>${a.original_name}</option>`).join(''))}</select>
              <input type="range" min="0" max="1" step="0.05" value="${(s.settings && s.settings.volume) ?? 0.7}" data-vol="${type}" style="width:90px" aria-label="Volume">
              <button class="btn btn-ghost btn-icon btn-xs" data-test="${type}" aria-label="Test"><i class="icon-play"></i></button>
            </div></div>`;
          }).join(''))}</div>
        </div>
        <div>
          <h3 class="mb-8">Room look</h3>
          <div data-look></div>
          <div class="field mt-16"><label>Background image <span class="faint">(optional, this console only)</span></label><div class="row"><button class="btn btn-sm" id="gm-bg">${custom.bg_image_data ? 'Change' : 'Choose'}</button>${custom.bg_image_data ? raw('<button class="btn btn-ghost btn-sm" id="gm-bg-clear">Remove</button>') : ''}</div></div>
        </div>`;
      body.querySelector('[data-look]').appendChild(QC.appearancePicker(look, (a) => {
        look = a;
        QC.applyRoomAppearance({ ...S.room, appearance: a });
      }, { room: S.room }));

      body.querySelector('#up-audio').onclick = async () => {
        const files = await QC.pickFiles({ accept: 'audio/*' });
        if (!files) return;
        const fd = new FormData();
        fd.append('audio', files[0]);
        try {
          await QC.api('POST', `/api/rooms/${roomId}/notifications/audio`, fd);
          audio = await get(`/api/rooms/${roomId}/notifications/audio`);
          render();
          toast('Sound uploaded', 'success');
        } catch (err) { error(err); }
      };
      body.querySelectorAll('[data-test]').forEach(b => b.onclick = () => {
        const sel = body.querySelector(`[data-audio="${b.dataset.test}"]`);
        const a = audio.find(x => x.id === sel.value);
        if (!a) return toast('Choose a sound first', 'warning');
        const el = new Audio(a.file_path.startsWith('/') ? a.file_path : `/${a.file_path}`);
        el.volume = Number(body.querySelector(`[data-vol="${b.dataset.test}"]`).value);
        el.play().catch(() => toast('Browser blocked playback – click the page first', 'warning'));
      });
      body.querySelector('#gm-bg').onclick = async () => {
        const files = await QC.pickFiles({ accept: 'image/*' });
        if (!files) return;
        if (files[0].size > 4 * 1024 * 1024) return toast('Please use an image under 4MB', 'warning');
        const reader = new FileReader();
        reader.onload = () => { custom.bg_image_data = reader.result; render(); };
        reader.readAsDataURL(files[0]);
      };
      const clr = body.querySelector('#gm-bg-clear');
      if (clr) clr.onclick = () => { custom.bg_image_data = null; render(); };
    }
    render();

    const saved = await modal({
      title: 'Sounds & room look', size: 'lg', icon: 'icon-swatch-book', body,
      actions: [{ label: 'Cancel', value: null }, {
        label: 'Save', variant: 'primary', onClick: async () => {
          const payload = SOUND_TYPES.map(([type]) => ({
            setting_type: type,
            enabled: body.querySelector(`[data-en="${type}"]`).checked,
            audio_id: body.querySelector(`[data-audio="${type}"]`).value,
            settings: { volume: Number(body.querySelector(`[data-vol="${type}"]`).value) }
          }));
          await QC.api('PUT', `/api/rooms/${roomId}/notifications/settings`, { settings: payload });
          await QC.api('PUT', `/api/rooms/${roomId}/gm-customization`, { ...custom, bg_image_data: custom.bg_image_data || null });
          S.room = await put(`/api/v2/rooms/${roomId}`, { appearance: look });
          return { bg: custom.bg_image_data };
        }
      }]
    });
    // Cancel/close restores the saved look; save applies the new one
    QC.applyRoomAppearance(S.room);
    if (saved) {
      applyAppearance({ bg_image_data: saved.bg });
      if (window.notificationManager) { window.notificationManager.isInitialized = false; window.notificationManager.initialize(roomId); }
      toast('Settings saved', 'success');
    }
  }

  function applyAppearance(c) {
    if (!c) return;
    // Accent/background colours now come from the room's appearance settings
    if (c.bg_image_data) {
      document.body.style.backgroundImage = `linear-gradient(color-mix(in srgb, var(--bg) 82%, transparent), color-mix(in srgb, var(--bg) 82%, transparent)), url("${c.bg_image_data}")`;
    } else {
      document.body.style.backgroundImage = '';
    }
  }

  /* ===================================================================== boot */
  async function loadRoom() {
    try {
      S.room = await get(`/api/v2/rooms/${roomId}`);
    } catch (err) {
      document.querySelector('.gm-grid').innerHTML = html`<div class="card" style="grid-column:1/-1"><div class="empty"><div class="empty-icon"><i class="icon-door-closed"></i></div><h3>Room not found</h3><p>${err.message}</p><a class="btn" href="/">Back to dashboard</a></div></div>`;
      return false;
    }
    const r = S.room;
    QC.applyRoomAppearance(r);
    $('#room-icon').innerHTML = QC.roomAvatar(r, { size: 32, radius: 9 });
    // Browser tab shows this room's icon (or its colour + initials) so GMs can tell tabs apart
    QC.setRoomFavicon(r);
    $('#room-name').textContent = r.name;
    $('#room-code').innerHTML = html`<i class="icon-link"></i>${r.shortcode}`;
    $('#room-code').onclick = () => copy(`${location.origin}/p/${r.shortcode}`, 'Player link copied');
    $('#open-player').href = `/room/${r.id}/player`;
    $('#edit-automations').href = `/room/${r.id}/automations`;
    $('#secondary-label').textContent = r.timer.secondaryLabel || 'Secondary timer';
    $('#secondary-timer-card').hidden = !r.timer.secondaryEnabled;
    $('#notes-text').textContent = r.gmNotes || 'No notes yet. Add a walkthrough, lock codes or a reset checklist in room settings.';
    $('#edit-notes').href = '/#rooms';
    S.variables = { ...r.variables, ...S.variables };
    drawVariables();
    drawPresets();
    drawHistory();
    setMode('hint');
    if (r.hints.type === 'chat') $('#chat-card').style.order = '-1';
    return true;
  }

  (async function boot() {
    setConn('connecting');
    if (!(await loadRoom())) return;
    loadMedia();
    loadAutomations();
    loadSlideshows();
    get(`/api/rooms/${roomId}/gm-customization`).then(applyAppearance).catch(() => {});
    get(`/api/v2/rooms/${roomId}/automations/logs`).then(logs => logs.slice(0, 20).reverse().forEach(logFromAutomation)).catch(() => {});
    if (window.notificationManager) window.notificationManager.initialize(roomId).catch(() => {});
    socket.on('room_updated', () => loadRoom());
  })();
})();
