/* Admin dashboard: rooms, themes, settings */
(function () {
  'use strict';
  const { html, raw, escape: esc, api, get, post, put, del, toast, error, confirm, prompt, modal, drawer, menu, formatTime, parseTime, copy, timeAgo } = QC;

  const view = document.getElementById('view');
  const title = document.getElementById('view-title');
  const topActions = document.getElementById('topbar-actions');

  const state = {
    rooms: [],
    themes: [],
    live: {},      // roomId -> { timer, players, gms }
    system: null,
    search: ''
  };

  const PALETTES = [
    ['#8b7cf6', '#5b8def'], ['#f5b942', '#f2555a'], ['#3ecf8e', '#2aa7c9'], ['#f2555a', '#b04ce0'],
    ['#4fb3f6', '#3ecf8e'], ['#e96bb0', '#8b7cf6'], ['#f59e42', '#e2c94a'], ['#38bdf8', '#6366f1']
  ];
  function palette(id) {
    let h = 0;
    for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return PALETTES[h % PALETTES.length];
  }
  function timerFontStyle(room) {
    const f = QC.timerFont(room.appearance && room.appearance.timerFont);
    return `font-family:${esc(f.family)};font-weight:${f.weight};letter-spacing:${f.tracking}`;
  }
  function origin() {
    return location.origin;
  }

  /* ------------------------------------------------------------- live socket */
  const socket = typeof io === 'function' ? io() : null;
  if (socket) {
    socket.on('connect', () => socket.emit('join_dashboard'));
    socket.on('dashboard_snapshot', (rows) => {
      rows.forEach(r => { state.live[r.roomId] = { ...(state.live[r.roomId] || {}), timer: r.timer, players: r.players, gms: r.gms }; });
      updateLiveAll();
    });
    socket.on('room_timer', (t) => {
      if (t.type !== 'main') return;
      state.live[t.roomId] = { ...(state.live[t.roomId] || {}), timer: t };
      updateLive(t.roomId);
    });
    socket.on('room_presence', (p) => {
      state.live[p.roomId] = { ...(state.live[p.roomId] || {}), players: p.players, gms: p.gms };
      updateLive(p.roomId);
    });
  }

  /* ----------------------------------------------------------------- routing */
  const routes = { rooms: renderRooms, themes: renderThemes, settings: renderSettings };
  function route() {
    const key = (location.hash || '#rooms').slice(1).split('/')[0];
    const fn = routes[key] || renderRooms;
    document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === (routes[key] ? key : 'rooms')));
    topActions.innerHTML = '';
    fn();
  }
  window.addEventListener('hashchange', route);

  async function loadRooms() {
    state.rooms = await get('/api/v2/rooms');
    state.rooms.forEach(r => {
      if (r.live && r.live.timer) state.live[r.id] = { ...(state.live[r.id] || {}), timer: r.live.timer };
    });
    document.querySelector('[data-count="rooms"]').textContent = state.rooms.length || '';
    renderQuickRooms();
  }

  async function loadThemes() {
    state.themes = await get('/api/v2/themes');
    document.querySelector('[data-count="themes"]').textContent = state.themes.length || '';
  }

  function renderQuickRooms() {
    const host = document.getElementById('quick-rooms');
    host.innerHTML = state.rooms.slice(0, 6).map(r => html`
      <a class="nav-item" href="/room/${r.id}/gm" title="Open GM for ${r.name}">${raw(QC.roomAvatar(r, { size: 20, radius: 6 }))}<span class="truncate">${r.name}</span></a>`).join('')
      || '<div class="faint small" style="padding:0 10px">No rooms yet</div>';
  }

  /* ================================================================== ROOMS */
  async function renderRooms() {
    title.textContent = 'Rooms';
    topActions.innerHTML = `
      <div class="input-affix search-wrap"><i class="icon-search"></i><input class="input input-sm" id="room-search" placeholder="Search rooms…" value="${esc(state.search)}"></div>
      <button class="btn btn-primary" id="new-room-btn"><i class="icon-plus"></i>New room</button>`;
    document.getElementById('new-room-btn').onclick = createRoom;
    document.getElementById('room-search').oninput = (e) => { state.search = e.target.value; drawRoomGrid(); };

    view.innerHTML = document.getElementById('tpl-loading').innerHTML;
    try {
      await Promise.all([loadRooms(), state.themes.length ? null : loadThemes()]);
    } catch (err) {
      view.innerHTML = html`<div class="empty"><div class="empty-icon"><i class="icon-wifi-off"></i></div><h3>Could not load rooms</h3><p>${err.message}</p><button class="btn" onclick="location.reload()">Retry</button></div>`;
      return;
    }
    drawRoomGrid();
  }

  function drawRoomGrid() {
    if ((location.hash || '#rooms') !== '#rooms' && location.hash !== '') return;
    const q = state.search.trim().toLowerCase();
    const rooms = state.rooms.filter(r => !q || r.name.toLowerCase().includes(q) || r.shortcode.toLowerCase().includes(q));

    if (state.rooms.length === 0) {
      view.innerHTML = `
        <div class="card"><div class="empty">
          <div class="empty-icon"><i class="icon-door-open"></i></div>
          <h3>Create your first room</h3>
          <p>A room holds the timer, hints, slideshows, automations and the player screen for one escape game.</p>
          <button class="btn btn-primary btn-lg mt-8" id="empty-create"><i class="icon-plus"></i>New room</button>
        </div></div>`;
      document.getElementById('empty-create').onclick = createRoom;
      return;
    }

    view.innerHTML = `
      <div class="page-head">
        <div class="titles"><p>${rooms.length} room${rooms.length === 1 ? '' : 's'} · Click a room to change its settings, or jump straight into the Game Master console.</p></div>
      </div>
      <div class="room-grid">
        ${rooms.map(roomCard).join('')}
        ${q ? '' : '<button class="new-room-card" data-new><i class="icon-plus"></i><strong>New room</strong><span class="small">Start from scratch or duplicate one</span></button>'}
      </div>
      ${rooms.length === 0 ? '<div class="empty"><p>No rooms match your search.</p></div>' : ''}`;

    view.querySelectorAll('[data-new]').forEach(b => b.onclick = createRoom);
    view.querySelectorAll('.room-card').forEach(card => {
      const room = state.rooms.find(r => r.id === card.dataset.id);
      card.querySelector('.rc-top').onclick = () => openRoomDrawer(room.id);
      card.querySelector('[data-more]').onclick = (e) => { e.stopPropagation(); roomMenu(e.currentTarget, room); };
      card.querySelector('[data-copy-code]').onclick = (e) => { e.stopPropagation(); copy(`${origin()}/p/${room.shortcode}`, 'Player link copied'); };
    });
    updateLiveAll();
  }

  function roomCard(r) {
    const accent = QC.roomAccent(r);
    const theme = state.themes.find(t => t.slug === r.theme);
    return html`
      <article class="card card-hover room-card" data-id="${r.id}" style="--room-accent:${accent};--room-accent-text:${QC.contrastText(accent)}">
        <div class="rc-top">
          ${raw(QC.roomAvatar(r, { size: 42, radius: 12, className: 'rc-avatar' }))}
          <div class="grow">
            <h3 class="truncate">${r.name}</h3>
            <div class="rc-meta">
              <button class="badge badge-accent mono" data-copy-code title="Copy player link" style="border:0;cursor:pointer"><i class="icon-link"></i>${r.shortcode}</button>
              <span class="badge"><i class="icon-palette"></i>${theme ? theme.displayName : r.theme}</span>
            </div>
          </div>
          <button class="btn btn-ghost btn-icon btn-sm" data-more aria-label="More actions"><i class="icon-ellipsis"></i></button>
        </div>
        <div class="rc-live">
          <div class="stack-sm grow" style="gap:8px">
            <div class="row" style="gap:12px">
              <span class="rc-timer" data-live-timer style="${raw(timerFontStyle(r))}">${formatTime(r.timer.duration)}</span>
              <div class="rc-progress"><div data-live-progress style="width:0%"></div></div>
            </div>
            <div class="rc-status" data-live-status><span class="dot"></span>Idle</div>
          </div>
        </div>
        <div class="rc-stats">
          <a href="/room/${r.id}/slideshows"><i class="icon-presentation"></i>${r.stats.slideshows} slideshow${r.stats.slideshows === 1 ? '' : 's'}</a>
          <a href="/room/${r.id}/automations"><i class="icon-zap"></i>${r.stats.automations} automation${r.stats.automations === 1 ? '' : 's'}</a>
          ${r.hints.type === 'chat' ? raw('<span class="row gap-4"><i class="icon-messages-square"></i>Chat</span>') : raw('<span class="row gap-4"><i class="icon-lightbulb"></i>Hints</span>')}
        </div>
        <div class="rc-actions">
          <a class="btn btn-primary" href="/room/${r.id}/gm"><i class="icon-gamepad-2"></i>Game Master</a>
          <a class="btn" href="/room/${r.id}/player" target="_blank" rel="noopener" data-tip="Open player screen"><i class="icon-monitor"></i></a>
          <a class="btn" href="/room/${r.id}/rules-slideshow" target="_blank" rel="noopener" data-tip="Play slideshow"><i class="icon-presentation"></i></a>
        </div>
      </article>`;
  }

  function updateLiveAll() {
    state.rooms.forEach(r => updateLive(r.id));
  }

  function updateLive(roomId) {
    const card = view.querySelector(`.room-card[data-id="${CSS.escape(roomId)}"]`);
    if (!card) return;
    const live = state.live[roomId] || {};
    const room = state.rooms.find(r => r.id === roomId);
    const t = live.timer;
    const timerEl = card.querySelector('[data-live-timer]');
    const statusEl = card.querySelector('[data-live-status]');
    const prog = card.querySelector('[data-live-progress]');
    const remaining = t ? t.remaining : room.timer.duration;
    const duration = t ? t.duration : room.timer.duration;
    timerEl.textContent = formatTime(remaining);
    const status = t ? (t.running ? 'running' : (t.status === 'complete' || (t.remaining === 0) ? 'complete' : (t.remaining < t.duration ? 'paused' : 'ready'))) : 'ready';
    timerEl.className = `rc-timer ${status}`;
    prog.style.width = `${duration ? Math.min(100, ((duration - remaining) / duration) * 100) : 0}%`;
    prog.style.background = status === 'paused' ? 'var(--warning)' : status === 'complete' ? 'var(--danger)' : 'var(--success)';

    const players = live.players || 0;
    const labels = { running: 'Game in progress', paused: 'Paused', complete: "Time's up", ready: 'Ready' };
    const dot = status === 'running' ? 'dot-success dot-pulse' : status === 'paused' ? 'dot-warning' : status === 'complete' ? 'dot-danger' : '';
    statusEl.innerHTML = `<span class="dot ${dot}"></span>${labels[status]}<span class="faint">·</span><i class="icon-monitor"></i>${players} screen${players === 1 ? '' : 's'}${live.gms ? ` <span class="faint">·</span> <i class="icon-headset"></i>${live.gms} GM` : ''}`;
  }

  function roomMenu(anchor, room) {
    menu(anchor, [
      { label: 'Room settings', icon: 'icon-settings-2', onClick: () => openRoomDrawer(room.id) },
      { label: 'Slideshows', icon: 'icon-presentation', onClick: () => { location.href = `/room/${room.id}/slideshows`; } },
      { label: 'Automations & integrations', icon: 'icon-zap', onClick: () => { location.href = `/room/${room.id}/automations`; } },
      { label: 'Edit player theme', icon: 'icon-palette', onClick: () => { location.href = `/theme-builder/${encodeURIComponent(room.theme)}?room=${room.id}`; } },
      'divider',
      { label: 'Copy player link', icon: 'icon-link', onClick: () => copy(`${origin()}/p/${room.shortcode}`, 'Player link copied') },
      { label: 'Duplicate room', icon: 'icon-copy', onClick: () => duplicateRoom(room) },
      'divider',
      { label: 'Delete room', icon: 'icon-trash-2', danger: true, onClick: () => deleteRoom(room) }
    ]);
  }

  async function createRoom() {
    if (!state.themes.length) await loadThemes().catch(() => {});
    const body = document.createElement('div');
    body.className = 'stack';
    body.innerHTML = html`
      <div class="field"><label for="nr-name">Room name</label><input class="input" id="nr-name" placeholder="e.g. The Alchemist's Lab" maxlength="100"></div>
      <div class="grid-2">
        <div class="field"><label for="nr-time">Game length</label><input class="input" id="nr-time" value="60:00" placeholder="60:00"><div class="hint">Minutes, or MM:SS</div></div>
        <div class="field"><label for="nr-theme">Player theme</label>
          <select class="select" id="nr-theme">${raw(state.themes.map(t => html`<option value="${t.slug}" ${t.slug === 'boilerplate' ? 'selected' : ''}>${t.displayName}</option>`).join(''))}</select></div>
      </div>
      <div class="field"><label>Hint style</label>
        <div class="segmented" id="nr-hints"><button type="button" class="active" data-v="broadcast"><i class="icon-lightbulb"></i>Hints on screen</button><button type="button" data-v="chat"><i class="icon-messages-square"></i>Two-way chat</button></div>
      </div>`;
    body.querySelectorAll('#nr-hints button').forEach(b => b.onclick = () => {
      body.querySelectorAll('#nr-hints button').forEach(x => x.classList.toggle('active', x === b));
    });

    const created = await modal({
      title: 'New room',
      icon: 'icon-door-open',
      body,
      actions: [
        { label: 'Cancel', value: null },
        {
          label: 'Create room', variant: 'primary', icon: 'icon-plus',
          onClick: async () => {
            const name = body.querySelector('#nr-name').value.trim();
            if (!name) { body.querySelector('#nr-name').classList.add('invalid'); body.querySelector('#nr-name').focus(); return false; }
            const secs = parseTime(body.querySelector('#nr-time').value);
            if (!Number.isFinite(secs) || secs <= 0) { toast('Enter a game length like 60:00', 'warning'); return false; }
            return post('/api/v2/rooms', {
              name,
              theme: body.querySelector('#nr-theme').value,
              timer: { duration: secs },
              hints: { type: body.querySelector('#nr-hints .active').dataset.v }
            });
          }
        }
      ]
    });
    if (created) {
      toast(`Created “${created.name}”`, 'success');
      await loadRooms();
      drawRoomGrid();
      openRoomDrawer(created.id);
    }
  }

  async function duplicateRoom(room) {
    const name = await prompt({ title: 'Duplicate room', label: 'Name for the copy', value: `${room.name} (copy)`, confirmText: 'Duplicate' });
    if (!name) return;
    try {
      const copyRoom = await post(`/api/v2/rooms/${room.id}/duplicate`, { name });
      toast(`Duplicated as “${copyRoom.name}”`, 'success');
      await loadRooms();
      drawRoomGrid();
    } catch (err) { error(err); }
  }

  async function deleteRoom(room) {
    const ok = await confirm({
      title: `Delete “${room.name}”?`,
      message: `This permanently removes the room with its <strong>${room.stats.slideshows} slideshow(s)</strong>, <strong>${room.stats.automations} automation(s)</strong>, variables and media list. Uploaded files stay on disk. This cannot be undone.`,
      confirmText: 'Delete room',
      danger: true
    });
    if (!ok) return;
    try {
      await del(`/api/v2/rooms/${room.id}`);
      toast('Room deleted', 'success');
      await loadRooms();
      drawRoomGrid();
    } catch (err) { error(err); }
  }

  /* --------------------------------------------------- room settings drawer */
  async function openRoomDrawer(roomId, tab = 'general') {
    let room;
    try {
      [room] = await Promise.all([get(`/api/v2/rooms/${roomId}`), state.themes.length ? null : loadThemes()]);
    } catch (err) { return error(err); }
    if (!state.system) state.system = await get('/api/v2/system/info').catch(() => null);

    const draft = JSON.parse(JSON.stringify(room));
    let dirty = false;
    const markDirty = () => { dirty = true; saveBtn.disabled = false; };

    const body = document.createElement('div');
    body.innerHTML = `
      <div class="tabs" style="margin:-20px -20px 20px;padding:0 12px">
        <button class="tab" data-tab="general"><i class="icon-sliders-horizontal"></i>General</button>
        <button class="tab" data-tab="appearance"><i class="icon-swatch-book"></i>Look</button>
        <button class="tab" data-tab="timers"><i class="icon-timer"></i>Timers</button>
        <button class="tab" data-tab="hints"><i class="icon-lightbulb"></i>Hints</button>
        <button class="tab" data-tab="variables"><i class="icon-variable"></i>Variables</button>
        <button class="tab" data-tab="notes"><i class="icon-notebook-pen"></i>GM notes</button>
        <button class="tab" data-tab="links"><i class="icon-link"></i>Links</button>
      </div>
      <div data-panel></div>`;
    const panel = body.querySelector('[data-panel]');

    const footer = document.createElement('div');
    footer.className = 'row';
    footer.style.width = '100%';
    footer.innerHTML = `
      <a class="btn btn-ghost" href="/room/${esc(room.id)}/gm"><i class="icon-gamepad-2"></i>Open GM</a>
      <div class="spacer"></div>
      <button class="btn" data-cancel>Close</button>
      <button class="btn btn-primary" data-save disabled><i class="icon-check"></i>Save changes</button>`;
    const saveBtn = footer.querySelector('[data-save]');

    const d = drawer({ title: room.name, body, footer, width: 640 });
    footer.querySelector('[data-cancel]').onclick = async () => {
      if (dirty && !(await confirm({ title: 'Discard changes?', message: 'You have unsaved changes to this room.', confirmText: 'Discard', danger: true }))) return;
      d.close();
    };

    saveBtn.onclick = async () => {
      saveBtn.classList.add('loading');
      try {
        const saved = await put(`/api/v2/rooms/${room.id}`, {
          name: draft.name,
          theme: draft.theme,
          description: draft.description,
          gmNotes: draft.gmNotes,
          appearance: draft.appearance,
          timer: draft.timer,
          hints: draft.hints
        });
        if (JSON.stringify(draft.variables) !== JSON.stringify(room.variables)) {
          await put(`/api/v2/rooms/${room.id}/variables`, { variables: draft.variables });
        }
        Object.assign(room, saved, { variables: draft.variables });
        dirty = false;
        saveBtn.disabled = true;
        d.el.querySelector('.drawer-head h2').textContent = saved.name;
        toast('Room saved', 'success');
        await loadRooms();
        drawRoomGrid();
      } catch (err) { error(err); }
      saveBtn.classList.remove('loading');
    };

    const tabs = {
      general() {
        panel.innerHTML = html`
          <div class="stack-lg">
            <div class="field"><label for="rs-name">Room name</label><input class="input" id="rs-name" value="${draft.name}" maxlength="100"></div>
            <div class="field"><label for="rs-desc">Description <span class="faint">(optional)</span></label><input class="input" id="rs-desc" value="${draft.description}" placeholder="Short note shown on the dashboard"></div>
            <div class="field">
              <label for="rs-theme">Player screen theme</label>
              <div class="row">
                <select class="select grow" id="rs-theme">${raw(state.themes.map(t => html`<option value="${t.slug}" ${t.slug === draft.theme ? 'selected' : ''}>${t.displayName}</option>`).join(''))}</select>
                <a class="btn" id="rs-edit-theme" href="#"><i class="icon-palette"></i>Edit theme</a>
              </div>
              <div class="hint">Players see this design on their screen. Changing it reloads connected screens.</div>
            </div>
            <div class="field">
              <label>Room code</label>
              <div class="row">
                <span class="badge badge-accent mono" style="height:30px;font-size:15px;padding:0 12px">${draft.shortcode}</span>
                <button class="btn btn-sm" id="rs-regen"><i class="icon-refresh-cw"></i>New code</button>
              </div>
              <div class="hint">Players can join at <code>/p/${draft.shortcode}</code>. Hardware URLs also accept this code.</div>
            </div>
          </div>`;
        panel.querySelector('#rs-name').oninput = (e) => { draft.name = e.target.value; markDirty(); };
        panel.querySelector('#rs-desc').oninput = (e) => { draft.description = e.target.value; markDirty(); };
        panel.querySelector('#rs-theme').onchange = (e) => { draft.theme = e.target.value; markDirty(); };
        panel.querySelector('#rs-edit-theme').onclick = (e) => { e.preventDefault(); location.href = `/theme-builder/${encodeURIComponent(draft.theme)}?room=${room.id}`; };
        panel.querySelector('#rs-regen').onclick = async () => {
          if (!(await confirm({ title: 'Generate a new room code?', message: 'Old player links and hardware URLs that use the current code will stop working.', confirmText: 'Generate' }))) return;
          try {
            const r = await post(`/api/v2/rooms/${room.id}/shortcode`);
            draft.shortcode = r.shortcode; room.shortcode = r.shortcode;
            tabs.general();
            toast(`New code: ${r.shortcode}`, 'success');
            loadRooms().then(drawRoomGrid);
          } catch (err) { error(err); }
        };
      },

      appearance() {
        panel.innerHTML = '';
        const intro = QC.el('<p class="muted small mb-16">Give each room its own icon and colour so Game Masters running several rooms always know which console they are looking at.</p>');
        const preview = QC.el('<div class="look-preview"><div class="lp-bar"></div><div class="lp-body"><span class="lp-icon"></span><span class="lp-name"></span><span class="lp-timer">45:00</span><span class="lp-btn">Start game</span></div></div>');
        function paintPreview() {
          const accent = QC.roomAccent({ id: room.id, appearance: draft.appearance });
          preview.querySelector('.lp-icon').innerHTML = QC.roomAvatar({ id: room.id, name: draft.name, appearance: draft.appearance }, { size: 34, radius: 9 });
          const font = QC.timerFont(draft.appearance.timerFont);
          const bg = draft.appearance.background || 'var(--bg)';
          preview.style.setProperty('--lp-accent', accent);
          preview.style.setProperty('--lp-bg', bg);
          preview.querySelector('.lp-name').textContent = draft.name;
          const t = preview.querySelector('.lp-timer');
          t.style.fontFamily = font.family; t.style.fontWeight = font.weight; t.style.letterSpacing = font.tracking;
          preview.querySelector('.lp-btn').style.color = QC.contrastText(accent);
        }
        const picker = QC.appearancePicker(draft.appearance, (a) => { draft.appearance = a; markDirty(); paintPreview(); }, { room });
        panel.append(intro, preview, picker);
        paintPreview();
      },

      timers() {
        panel.innerHTML = html`
          <div class="stack-lg">
            <div class="card"><div class="card-body stack">
              <div class="row"><i class="icon-timer" style="font-size:18px;color:var(--accent)"></i><h3 class="grow">Main game timer</h3></div>
              <div class="field"><label for="rs-dur">Game length</label>
                <input class="input" id="rs-dur" value="${formatTime(draft.timer.duration, { hours: 'auto' })}" style="max-width:180px">
                <div class="hint">e.g. <code>60:00</code> or <code>1:15:00</code>. Players see this counting down.</div></div>
            </div></div>
            <div class="card"><div class="card-body stack">
              <div class="row">
                <i class="icon-hourglass" style="font-size:18px;color:var(--warning)"></i>
                <h3 class="grow">Secondary timer</h3>
                <label class="switch"><input type="checkbox" id="rs-sec-on" ${draft.timer.secondaryEnabled ? 'checked' : ''}><span class="track"></span></label>
              </div>
              <p class="muted small">A second, independent countdown – for a bomb, a poison, a bonus round. Automations can start and stop it.</p>
              <div class="grid-2" id="rs-sec-fields" ${draft.timer.secondaryEnabled ? '' : 'hidden'}>
                <div class="field"><label for="rs-sec-label">Label</label><input class="input" id="rs-sec-label" value="${draft.timer.secondaryLabel}"></div>
                <div class="field"><label for="rs-sec-dur">Length</label><input class="input" id="rs-sec-dur" value="${formatTime(draft.timer.secondaryDuration || 300)}"></div>
              </div>
            </div></div>
          </div>`;
        const durInput = panel.querySelector('#rs-dur');
        durInput.oninput = () => {
          const s = parseTime(durInput.value);
          durInput.classList.toggle('invalid', !(s > 0));
          if (s > 0) { draft.timer.duration = s; markDirty(); }
        };
        panel.querySelector('#rs-sec-on').onchange = (e) => {
          draft.timer.secondaryEnabled = e.target.checked;
          if (e.target.checked && !draft.timer.secondaryDuration) draft.timer.secondaryDuration = 300;
          panel.querySelector('#rs-sec-fields').hidden = !e.target.checked;
          markDirty();
        };
        panel.querySelector('#rs-sec-label').oninput = (e) => { draft.timer.secondaryLabel = e.target.value; markDirty(); };
        const sec = panel.querySelector('#rs-sec-dur');
        sec.oninput = () => {
          const s = parseTime(sec.value);
          sec.classList.toggle('invalid', !(s > 0));
          if (s > 0) { draft.timer.secondaryDuration = s; markDirty(); }
        };
      },

      hints() {
        const presets = draft.hints.presets;
        panel.innerHTML = html`
          <div class="stack-lg">
            <div class="field"><label>How players get help</label>
              <div class="segmented" id="rs-hint-type">
                <button type="button" data-v="broadcast" class="${draft.hints.type === 'broadcast' ? 'active' : ''}"><i class="icon-lightbulb"></i>Hints on screen</button>
                <button type="button" data-v="chat" class="${draft.hints.type === 'chat' ? 'active' : ''}"><i class="icon-messages-square"></i>Two-way chat</button>
              </div>
              <div class="hint">Hints pop up full-screen for players. Chat lets players message the GM back.</div>
            </div>
            <div class="field" style="max-width:220px"><label for="rs-hint-limit">Hint limit <span class="faint">(0 = unlimited)</span></label>
              <input class="input" type="number" min="0" max="99" id="rs-hint-limit" value="${draft.hints.limit || 0}">
              <div class="hint">Shown to the GM as a counter; the GM can still send more.</div></div>
            <div class="card"><div class="card-body stack">
              <div class="row"><i class="icon-drama" style="font-size:18px;color:var(--accent)"></i><h3 class="grow">Wording players see</h3></div>
              <p class="muted small">Keep it in character. Leave a “cleared” message empty to clear the screen without any notice.</p>
              <div class="grid-2">
                <div class="field"><label for="rs-gm-name">GM's name in chat</label><input class="input" id="rs-gm-name" maxlength="40" placeholder="GM" value="${draft.hints.gmName === 'GM' ? '' : draft.hints.gmName}"></div>
                <div class="field"><label for="rs-player-name">Players' name in chat</label><input class="input" id="rs-player-name" maxlength="40" placeholder="Player" value="${draft.hints.playerName === 'Player' ? '' : draft.hints.playerName}"></div>
              </div>
              <div class="field"><label for="rs-hints-cleared">When the GM clears hints</label><input class="input" id="rs-hints-cleared" maxlength="200" value="${draft.hints.clearedMessage}" placeholder="(show nothing)"></div>
              <div class="field"><label for="rs-chat-cleared">When the GM clears the chat</label><input class="input" id="rs-chat-cleared" maxlength="200" value="${draft.hints.chatClearedMessage}" placeholder="(show nothing)"></div>
              <div class="field"><label>Preview</label><div class="chat-preview" id="rs-chat-preview"></div></div>
            </div></div>
            <div>
              <div class="row mb-8"><h3 class="grow">Saved hints</h3><button class="btn btn-sm" id="rs-add-preset"><i class="icon-plus"></i>Add hint</button></div>
              <p class="muted small mb-8">Pre-written hints appear as one-click buttons in the GM console. Group them by puzzle.</p>
              <div class="stack-sm" id="rs-presets"></div>
            </div>
          </div>`;
        panel.querySelectorAll('#rs-hint-type button').forEach(b => b.onclick = () => {
          draft.hints.type = b.dataset.v;
          panel.querySelectorAll('#rs-hint-type button').forEach(x => x.classList.toggle('active', x === b));
          markDirty();
        });
        panel.querySelector('#rs-hint-limit').oninput = (e) => { draft.hints.limit = parseInt(e.target.value, 10) || 0; markDirty(); };

        // Immersion wording + live preview of how chat looks on the player screen
        function drawChatPreview() {
          const t = new Date().toLocaleTimeString();
          const gm = draft.hints.gmName || 'GM';
          const pl = draft.hints.playerName || 'Player';
          panel.querySelector('#rs-chat-preview').innerHTML = html`
            <div>[${t}] ${pl}: We found the key, what now?</div>
            <div>[${t}] ${gm}: Try the lock on the old trunk.</div>
            ${draft.hints.chatClearedMessage.trim() ? raw(html`<div class="cleared">[${t}] ${draft.hints.chatClearedMessage}</div>`) : ''}
            ${draft.hints.clearedMessage.trim() ? raw(html`<div class="cleared-hint">Hint area after clearing: “${draft.hints.clearedMessage}”</div>`) : raw('<div class="cleared-hint">Hint area after clearing: empty</div>')}`;
        }
        [['#rs-gm-name', 'gmName', 'GM'], ['#rs-player-name', 'playerName', 'Player']].forEach(([sel, key, fallback]) => {
          panel.querySelector(sel).oninput = (e) => { draft.hints[key] = e.target.value.trim() || fallback; markDirty(); drawChatPreview(); };
        });
        [['#rs-hints-cleared', 'clearedMessage'], ['#rs-chat-cleared', 'chatClearedMessage']].forEach(([sel, key]) => {
          panel.querySelector(sel).oninput = (e) => { draft.hints[key] = e.target.value; markDirty(); drawChatPreview(); };
        });
        drawChatPreview();

        const list = panel.querySelector('#rs-presets');
        function drawPresets() {
          list.innerHTML = presets.length ? presets.map((p, i) => html`
            <div class="preset-row" data-id="${p.id || i}">
              <span class="drag-handle"><i class="icon-grip-vertical"></i></span>
              <input class="input input-sm preset-cat" placeholder="Puzzle / area" value="${p.category}" data-k="category" data-i="${i}">
              <input class="input input-sm" placeholder="Hint text" value="${p.text}" data-k="text" data-i="${i}">
              <button class="btn btn-ghost btn-icon btn-sm" data-del="${i}" aria-label="Remove"><i class="icon-trash-2"></i></button>
            </div>`).join('') : '<div class="faint small" style="padding:8px 0">No saved hints yet.</div>';
          list.querySelectorAll('input').forEach(inp => inp.oninput = () => { presets[+inp.dataset.i][inp.dataset.k] = inp.value; markDirty(); });
          list.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { presets.splice(+b.dataset.del, 1); drawPresets(); markDirty(); });
        }
        presets.forEach(p => { if (!p.id) p.id = QC.uid('h'); });
        QC.sortable(list, {
          items: '.preset-row', handle: '.drag-handle',
          onEnd: (ids) => {
            const reordered = ids.map(id => presets.find(p => p.id === id)).filter(Boolean);
            presets.splice(0, presets.length, ...reordered);
            drawPresets(); markDirty();
          }
        });
        panel.querySelector('#rs-add-preset').onclick = () => {
          const last = presets[presets.length - 1];
          presets.push({ id: QC.uid('h'), text: '', category: last ? last.category : '' });
          drawPresets();
          markDirty();
          const inputs = list.querySelectorAll('input[data-k="text"]');
          inputs[inputs.length - 1].focus();
        };
        drawPresets();
      },

      variables() {
        const vars = draft.variables;
        const typeOf = (v) => typeof v === 'boolean' ? 'boolean' : typeof v === 'number' ? 'number' : (v && typeof v === 'object') ? 'json' : 'text';
        panel.innerHTML = `
          <div class="stack">
            <div class="callout"><i class="icon-info"></i><div class="small">Variables hold game state – a door's status, a score, which puzzle is solved. Props and webhooks change them; <a href="/room/${esc(room.id)}/automations">automations</a> react to them. Timer variables (<code>timer_main_remaining</code> etc.) are built-in.</div></div>
            <div class="var-row head"><span>Name</span><span class="var-type">Type</span><span>Starting value</span><span></span></div>
            <div class="stack-sm" id="rs-vars"></div>
            <div><button class="btn btn-sm" id="rs-add-var"><i class="icon-plus"></i>Add variable</button></div>
          </div>`;
        const list = panel.querySelector('#rs-vars');
        let rows = Object.entries(vars).map(([k, v]) => ({ name: k, type: typeOf(v), value: typeof v === 'object' ? JSON.stringify(v) : String(v) }));
        function sync() {
          const next = {};
          let bad = false;
          rows.forEach(r => {
            if (!r.name.trim()) return;
            let v = r.value;
            if (r.type === 'number') { v = Number(r.value); if (Number.isNaN(v)) bad = true; }
            else if (r.type === 'boolean') v = r.value === 'true';
            else if (r.type === 'json') { try { v = JSON.parse(r.value || 'null'); } catch (_) { bad = true; } }
            next[r.name.trim()] = v;
          });
          if (!bad) { draft.variables = next; markDirty(); }
        }
        function draw() {
          list.innerHTML = rows.length ? rows.map((r, i) => html`
            <div class="var-row">
              <input class="input input-sm mono" value="${r.name}" data-i="${i}" data-k="name" placeholder="door_open">
              <select class="select input-sm var-type" data-i="${i}" data-k="type">
                ${raw(['text', 'number', 'boolean', 'json'].map(t => `<option ${t === r.type ? 'selected' : ''}>${t}</option>`).join(''))}
              </select>
              ${r.type === 'boolean'
                ? raw(`<select class="select input-sm" data-i="${i}" data-k="value"><option ${r.value === 'true' ? 'selected' : ''}>true</option><option ${r.value !== 'true' ? 'selected' : ''}>false</option></select>`)
                : raw(html`<input class="input input-sm mono" value="${r.value}" data-i="${i}" data-k="value">`)}
              <button class="btn btn-ghost btn-icon btn-sm" data-del="${i}" aria-label="Remove"><i class="icon-trash-2"></i></button>
            </div>`).join('') : '<div class="faint small">No variables yet.</div>';
          list.querySelectorAll('[data-k]').forEach(el => {
            const ev = el.tagName === 'SELECT' ? 'onchange' : 'oninput';
            el[ev] = () => {
              rows[+el.dataset.i][el.dataset.k] = el.value;
              if (el.dataset.k === 'name') el.value = el.value.replace(/[^\w.-]/g, '_');
              if (el.dataset.k === 'type') { if (el.value === 'boolean') rows[+el.dataset.i].value = 'false'; draw(); }
              sync();
            };
          });
          list.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { rows.splice(+b.dataset.del, 1); draw(); sync(); });
        }
        panel.querySelector('#rs-add-var').onclick = () => {
          rows.push({ name: '', type: 'text', value: '' });
          draw();
          list.querySelector(`input[data-i="${rows.length - 1}"][data-k="name"]`).focus();
        };
        draw();
      },

      notes() {
        panel.innerHTML = html`
          <div class="field">
            <label for="rs-notes">Game Master notes</label>
            <textarea class="textarea mono" id="rs-notes" rows="18" placeholder="Walkthrough, lock codes, reset checklist, things to watch for…">${draft.gmNotes}</textarea>
            <div class="hint">Only visible in the GM console – never on player screens.</div>
          </div>`;
        panel.querySelector('#rs-notes').oninput = (e) => { draft.gmNotes = e.target.value; markDirty(); };
      },

      links() {
        const base = origin();
        const lan = (state.system && state.system.lan) || [];
        const entries = [
          ['Player screen', `${base}/p/${draft.shortcode}`, 'icon-monitor'],
          ['Game Master', `${base}/room/${room.id}/gm`, 'icon-gamepad-2'],
          ['Slideshows', `${base}/s/${draft.shortcode}`, 'icon-presentation'],
          ['Automations', `${base}/room/${room.id}/automations`, 'icon-zap']
        ];
        panel.innerHTML = html`
          <div class="stack-lg">
            <div class="link-list">${raw(entries.map(([label, url, icon]) => html`
              <div class="link-item"><span class="label row gap-4"><i class="${icon}"></i>${label}</span>
                <div class="copy-field"><code>${url}</code>
                  <a class="btn btn-ghost btn-icon btn-xs" href="${url}" target="_blank" rel="noopener" aria-label="Open"><i class="icon-external-link"></i></a>
                  <button class="btn btn-ghost btn-icon btn-xs" data-copy="${url}" aria-label="Copy"><i class="icon-copy"></i></button></div></div>`).join(''))}</div>
            ${lan.length ? raw(html`<div><div class="section-title">On your local network</div>
              <p class="muted small mb-8">Use these addresses on TVs and tablets in the room.</p>
              <div class="link-list">${raw(lan.map(l => html`<div class="link-item"><span class="label faint">${l.interface}</span><div class="copy-field"><code>${l.url}/p/${draft.shortcode}</code><button class="btn btn-ghost btn-icon btn-xs" data-copy="${l.url}/p/${draft.shortcode}"><i class="icon-copy"></i></button></div></div>`).join(''))}</div></div>`) : ''}
            <div class="callout"><i class="icon-cpu"></i><div class="small">Connecting props or a Stream Deck? The <a href="/room/${room.id}/automations#integrations">Integrations tab</a> lists ready-to-copy URLs for variables, timers and webhooks.</div></div>
          </div>`;
        panel.querySelectorAll('[data-copy]').forEach(b => b.onclick = () => copy(b.dataset.copy));
      }
    };

    body.querySelectorAll('.tab').forEach(t => t.onclick = () => {
      body.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
      tabs[t.dataset.tab]();
    });
    body.querySelector(`.tab[data-tab="${tab}"]`).click();
  }

  /* ================================================================= THEMES */
  async function renderThemes() {
    title.textContent = 'Player themes';
    topActions.innerHTML = '<button class="btn btn-primary" id="new-theme-btn"><i class="icon-plus"></i>New theme</button>';
    document.getElementById('new-theme-btn').onclick = () => newTheme();
    view.innerHTML = document.getElementById('tpl-loading').innerHTML;
    try {
      await Promise.all([loadThemes(), state.rooms.length ? null : loadRooms()]);
    } catch (err) { return error(err); }
    const previewRoom = state.rooms[0];

    view.innerHTML = `
      <div class="page-head"><div class="titles"><p>Themes control how the player screen looks. Build them visually, edit the code, or describe what you want to the AI assistant.</p></div></div>
      <div class="theme-grid">
        ${state.themes.map(t => html`
          <article class="card card-hover theme-card" data-slug="${t.slug}">
            <div class="theme-thumb">
              ${previewRoom ? raw(html`<iframe loading="lazy" tabindex="-1" title="${t.displayName} preview" data-src="/api/v2/themes/${t.slug}"></iframe>`) : ''}
              <div class="swatches">${raw(t.colors.map(c => `<span style="background:${esc(c)}"></span>`).join(''))}</div>
            </div>
            <div class="tc-body">
              <div class="row"><h3 class="grow truncate">${t.displayName}</h3>${t.protected ? raw('<span class="badge"><i class="icon-lock"></i>Starter</span>') : ''}</div>
              <p>${t.description || 'No description'}</p>
              <div class="row mt-8 small faint gap-4"><i class="icon-door-open"></i>${t.rooms.length ? t.rooms.map(r => r.name).join(', ') : 'Not used by any room'}</div>
            </div>
            <div class="tc-actions">
              <a class="btn btn-primary btn-sm" href="/theme-builder/${t.slug}"><i class="icon-pencil-ruler"></i>${t.protected ? 'View' : 'Edit'}</a>
              <button class="btn btn-sm" data-dup><i class="icon-copy"></i>Duplicate</button>
              ${t.protected ? '' : raw('<button class="btn btn-ghost btn-icon btn-sm" data-del aria-label="Delete theme"><i class="icon-trash-2"></i></button>')}
            </div>
          </article>`).join('')}
      </div>`;

    // Live mini-previews rendered through the theme builder preview pipeline
    if (previewRoom) {
      view.querySelectorAll('.theme-card').forEach(async card => {
        const iframe = card.querySelector('iframe');
        if (!iframe) return;
        try {
          const t = await get(`/api/v2/themes/${card.dataset.slug}`);
          const { token } = await post('/api/v2/themes/preview', { slug: t.slug, html: t.html, css: t.css, js: '' });
          iframe.src = `/room/${previewRoom.id}/player?themePreview=${token}&demo=1`;
        } catch (_) { /* thumbnail is optional */ }
      });
    }

    view.querySelectorAll('.theme-card').forEach(card => {
      const t = state.themes.find(x => x.slug === card.dataset.slug);
      card.querySelector('[data-dup]').onclick = async () => {
        const name = await prompt({ title: 'Duplicate theme', label: 'New theme name', value: `${t.displayName} copy`, confirmText: 'Duplicate' });
        if (!name) return;
        try {
          const created = await post(`/api/v2/themes/${t.slug}/duplicate`, { name });
          toast('Theme duplicated', 'success', { action: { label: 'Edit', onClick: () => { location.href = `/theme-builder/${created.slug}`; } } });
          renderThemes();
        } catch (err) { error(err); }
      };
      const delBtn = card.querySelector('[data-del]');
      if (delBtn) delBtn.onclick = async () => {
        if (t.rooms.length) return toast(`Used by ${t.rooms.map(r => r.name).join(', ')} – switch those rooms first`, 'warning');
        if (!(await confirm({ title: `Delete “${t.displayName}”?`, message: 'The theme folder and its assets will be removed from the server. This cannot be undone.', confirmText: 'Delete theme', danger: true }))) return;
        try { await del(`/api/v2/themes/${t.slug}`); toast('Theme deleted', 'success'); renderThemes(); } catch (err) { error(err); }
      };
    });
  }

  async function newTheme() {
    if (!state.themes.length) await loadThemes().catch(() => {});
    let ai = { configured: false };
    try { ai = (await get('/api/v2/settings')).ai; } catch (_) { /* ignore */ }
    const body = document.createElement('div');
    body.className = 'stack';
    body.innerHTML = html`
      <div class="field"><label for="nt-name">Theme name</label><input class="input" id="nt-name" placeholder="e.g. Haunted Manor"></div>
      <div class="field"><label for="nt-from">Start from</label>
        <select class="select" id="nt-from"><option value="starter">Clean starter layout</option>${raw(state.themes.map(t => html`<option value="${t.slug}">Copy of ${t.displayName}</option>`).join(''))}</select></div>
      <div class="field"><label for="nt-ai">Describe the look <span class="faint">(optional, uses AI)</span></label>
        <textarea class="textarea" id="nt-ai" rows="3" placeholder="Victorian haunted house: candle-lit, aged paper texture, big gothic timer in blood red…" ${ai.configured ? '' : 'disabled'}></textarea>
        <div class="hint">${ai.configured ? 'The AI assistant will restyle the theme as soon as the builder opens.' : raw('Add an OpenRouter key in <a href="#settings">Settings</a> to enable AI.')}</div></div>`;
    const created = await modal({
      title: 'New theme', icon: 'icon-palette', body,
      actions: [
        { label: 'Cancel', value: null },
        {
          label: 'Create & open builder', variant: 'primary', icon: 'icon-wand-sparkles',
          onClick: async () => {
            const name = body.querySelector('#nt-name').value.trim();
            if (!name) { body.querySelector('#nt-name').classList.add('invalid'); return false; }
            const t = await post('/api/v2/themes', { name, from: body.querySelector('#nt-from').value });
            return { slug: t.slug, prompt: body.querySelector('#nt-ai').value.trim() };
          }
        }
      ]
    });
    if (created) {
      location.href = `/theme-builder/${created.slug}${created.prompt ? `?ai=${encodeURIComponent(created.prompt)}` : ''}`;
    }
  }

  /* =============================================================== SETTINGS */
  async function renderSettings() {
    title.textContent = 'Settings';
    view.innerHTML = '<div class="skeleton" style="height:300px;max-width:820px"></div>';
    let settings, system;
    try {
      [settings, system] = await Promise.all([get('/api/v2/settings'), get('/api/v2/system/info')]);
    } catch (err) { return error(err); }
    state.system = system;
    const ai = settings.ai;
    const autoClear = settings.autoClear || { enabled: true, minutes: 15 };

    view.innerHTML = html`
      <div class="settings-grid">
        <section class="card">
          <div class="card-head"><i class="icon-sparkles" style="color:var(--accent);font-size:18px"></i><div class="grow"><h2>AI theme assistant</h2><div class="sub">Powered by OpenRouter – your key stays on this server</div></div>
            ${ai.configured ? raw('<span class="badge badge-success"><i class="icon-check"></i>Connected</span>') : raw('<span class="badge">Not set up</span>')}</div>
          <div class="card-body stack-lg">
            <div class="field">
              <label for="st-key">OpenRouter API key</label>
              <div class="row">
                <input class="input mono grow" id="st-key" type="password" autocomplete="off" placeholder="${ai.configured ? ai.keyPreview : 'sk-or-v1-…'}">
                <button class="btn" id="st-test"><i class="icon-plug-zap"></i>Test</button>
              </div>
              <div class="hint">${ai.source === 'environment' ? 'Currently using OPENROUTER_API_KEY from the server environment. Saving a key here overrides it.' : raw('Create a key at <a href="https://openrouter.ai/keys" target="_blank" rel="noopener">openrouter.ai/keys</a>. Leave blank to keep the current key.')}</div>
            </div>
            <div class="field">
              <label for="st-model">Model</label>
              <div class="row">
                <select class="select grow" id="st-model"><option value="">Automatic (newest Claude Sonnet)</option>${ai.model ? raw(html`<option value="${ai.model}" selected>${ai.model}</option>`) : ''}</select>
                <button class="btn" id="st-load-models"><i class="icon-refresh-cw"></i>Load models</button>
              </div>
              <div class="hint" id="st-model-hint">Strong coding models give the best themes. Prices are per million tokens.</div>
            </div>
            <div class="row">
              ${ai.source === 'settings' ? raw('<button class="btn btn-ghost" id="st-remove"><i class="icon-trash-2"></i>Remove saved key</button>') : ''}
              <div class="spacer"></div>
              <button class="btn btn-primary" id="st-save-ai"><i class="icon-check"></i>Save</button>
            </div>
          </div>
        </section>

        <section class="card">
          <div class="card-head"><i class="icon-eraser" style="color:var(--success);font-size:18px"></i><div class="grow"><h2>Between games</h2><div class="sub">Keep the last group's hints off the next group's screen</div></div></div>
          <div class="card-body stack">
            <label class="switch"><input type="checkbox" id="st-autoclear" ${autoClear.enabled ? 'checked' : ''}><span class="track"></span>Automatically clear hints and chat when a room is idle</label>
            <div class="row row-wrap" id="st-autoclear-row" ${autoClear.enabled ? '' : 'hidden'}>
              <span class="small muted">Clear after</span>
              <input class="input input-sm" type="number" min="1" max="240" id="st-autoclear-min" value="${autoClear.minutes}" style="width:80px">
              <span class="small muted">minutes with the timer stopped or paused and nothing new sent</span>
            </div>
            <div class="hint">Player screens are wiped quietly (no “cleared” message) and pop-ups are closed. Nothing is cleared while a timer is running, and the Game Master console logs when it happens.</div>
          </div>
        </section>

        <section class="card">
          <div class="card-head"><i class="icon-server" style="color:var(--info);font-size:18px"></i><div class="grow"><h2>Server</h2><div class="sub">Version ${system.version} · Node ${system.node}</div></div></div>
          <div class="card-body stack">
            <div class="field"><label>This dashboard</label><div class="copy-field"><code>${system.origin}</code><button class="btn btn-ghost btn-icon btn-xs" data-copy="${system.origin}"><i class="icon-copy"></i></button></div></div>
            ${system.lan.length ? raw(html`<div class="field"><label>Local network addresses</label>${raw(system.lan.map(l => html`<div class="copy-field mb-8"><code>${l.url}</code><span class="faint small">${l.interface}</span><button class="btn btn-ghost btn-icon btn-xs" data-copy="${l.url}"><i class="icon-copy"></i></button></div>`).join(''))}<div class="hint">Open these on TVs and tablets on the same Wi-Fi.</div></div>`) : ''}
            <div class="callout ${system.adminProtected ? 'success' : 'warning'}"><i class="${system.adminProtected ? 'icon-shield-check' : 'icon-shield-alert'}"></i>
              <div class="small">${system.adminProtected
                ? 'Admin tools are password protected (ADMIN_PASSWORD is set). Player screens, slideshows and hardware URLs stay open.'
                : raw('Anyone on your network can open these admin tools. Start the server with <code>ADMIN_PASSWORD=yourpassword</code> to require a login (user <code>admin</code>). Player screens and hardware URLs stay open.')}</div></div>
          </div>
        </section>

        <section class="card">
          <div class="card-head"><i class="icon-sun-moon" style="color:var(--warning);font-size:18px"></i><h2 class="grow">Appearance</h2></div>
          <div class="card-body row">
            <div class="grow"><div style="font-weight:600">Operator interface theme</div><div class="muted small">Dark is easier on the eyes in a control room. Saved per browser.</div></div>
            <div class="segmented" id="st-mode"><button data-v="dark"><i class="icon-moon"></i>Dark</button><button data-v="light"><i class="icon-sun"></i>Light</button></div>
          </div>
        </section>
      </div>`;

    view.querySelectorAll('[data-copy]').forEach(b => b.onclick = () => copy(b.dataset.copy));

    const acToggle = view.querySelector('#st-autoclear');
    const acMinutes = view.querySelector('#st-autoclear-min');
    async function saveAutoClear() {
      const minutes = Number(acMinutes.value);
      if (!(minutes >= 1 && minutes <= 240)) { acMinutes.classList.add('invalid'); return toast('Choose between 1 and 240 minutes', 'warning'); }
      acMinutes.classList.remove('invalid');
      try {
        const res = await put('/api/v2/settings', { autoClear: { enabled: acToggle.checked, minutes } });
        toast(res.autoClear.enabled ? `Idle rooms will be cleared after ${res.autoClear.minutes} min` : 'Automatic clearing turned off', 'success', { timeout: 2200 });
      } catch (err) { error(err); }
    }
    acToggle.onchange = () => { view.querySelector('#st-autoclear-row').hidden = !acToggle.checked; saveAutoClear(); };
    acMinutes.onchange = saveAutoClear;
    const modeBtns = view.querySelectorAll('#st-mode button');
    const syncMode = () => modeBtns.forEach(b => b.classList.toggle('active', b.dataset.v === QC.uiTheme()));
    modeBtns.forEach(b => b.onclick = () => { if (QC.uiTheme() !== b.dataset.v) QC.toggleUiTheme(); syncMode(); });
    syncMode();

    const keyInput = view.querySelector('#st-key');
    const modelSel = view.querySelector('#st-model');

    view.querySelector('#st-test').onclick = async (e) => {
      const btn = e.currentTarget;
      btn.classList.add('loading');
      try {
        const info = await post('/api/v2/settings/ai/test', { apiKey: keyInput.value.trim() || undefined });
        toast(`Key works${info.label ? ` (${info.label})` : ''}${info.limit ? ` · limit $${info.limit}` : ''}`, 'success');
      } catch (err) { error(err); }
      btn.classList.remove('loading');
    };

    view.querySelector('#st-load-models').onclick = async (e) => {
      const btn = e.currentTarget;
      btn.classList.add('loading');
      try {
        const { models, recommended } = await get('/api/v2/ai/models');
        const current = modelSel.value;
        const ranked = models.slice().sort((a, b) => {
          const pa = /^anthropic\//.test(a.id) ? 0 : /^(openai|google)\//.test(a.id) ? 1 : 2;
          const pb = /^anthropic\//.test(b.id) ? 0 : /^(openai|google)\//.test(b.id) ? 1 : 2;
          return pa - pb || a.name.localeCompare(b.name);
        });
        const price = (m) => m.promptPrice != null ? ` – $${m.promptPrice.toFixed(2)} / $${(m.completionPrice || 0).toFixed(2)}` : '';
        modelSel.innerHTML = `<option value="">Automatic (${esc(recommended)})</option>` +
          ranked.map(m => `<option value="${esc(m.id)}" ${m.id === current ? 'selected' : ''}>${esc(m.name)}${esc(price(m))}</option>`).join('');
        view.querySelector('#st-model-hint').textContent = `${models.length} models available. Recommended: ${recommended}`;
      } catch (err) { error(err); }
      btn.classList.remove('loading');
    };

    view.querySelector('#st-save-ai').onclick = async (e) => {
      const btn = e.currentTarget;
      btn.classList.add('loading');
      const payload = { ai: { model: modelSel.value } };
      if (keyInput.value.trim()) payload.ai.apiKey = keyInput.value.trim();
      try {
        await put('/api/v2/settings', payload);
        toast('AI settings saved', 'success');
        renderSettings();
      } catch (err) { error(err); btn.classList.remove('loading'); }
    };

    const removeBtn = view.querySelector('#st-remove');
    if (removeBtn) removeBtn.onclick = async () => {
      if (!(await confirm({ title: 'Remove the saved API key?', message: 'The AI assistant will stop working until a new key is added.', confirmText: 'Remove', danger: true }))) return;
      try { await put('/api/v2/settings', { ai: { apiKey: '' } }); toast('Key removed', 'success'); renderSettings(); } catch (err) { error(err); }
    };
  }

  /* ------------------------------------------------------------------- boot */
  QC.hotkeys({ 'n': () => { if ((location.hash || '#rooms') === '#rooms') createRoom(); } });
  loadThemes().catch(() => {});
  route();
})();
