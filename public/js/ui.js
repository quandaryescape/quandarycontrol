/* ==========================================================================
   Quandary Control – shared UI helpers (window.QC)
   No build step, no framework: small helpers used by every operator page.
   ========================================================================== */
(function () {
  'use strict';

  const QC = {};

  /* ------------------------------------------------------------- theme mode */
  const THEME_KEY = 'qc-ui-theme';
  function applyUiTheme(mode) {
    const m = mode || (function () { try { return localStorage.getItem(THEME_KEY); } catch (_) { return null; } })() || 'dark';
    document.documentElement.setAttribute('data-theme', m);
    return m;
  }
  applyUiTheme();
  QC.toggleUiTheme = function () {
    const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    try { localStorage.setItem(THEME_KEY, next); } catch (_) { /* private mode */ }
    applyUiTheme(next);
    document.querySelectorAll('[data-theme-icon]').forEach(el => {
      el.className = next === 'light' ? 'icon-moon' : 'icon-sun';
    });
    return next;
  };
  QC.uiTheme = () => document.documentElement.getAttribute('data-theme') || 'dark';

  /* ---------------------------------------------------------------- helpers */
  QC.escape = function (value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };
  const esc = QC.escape;

  /** Tagged template that escapes interpolations unless wrapped with QC.raw() */
  class Raw { constructor(v) { this.v = v; } }
  QC.raw = (v) => new Raw(v);
  QC.html = function (strings, ...values) {
    return strings.reduce((out, str, i) => {
      if (i === 0) return str;
      const v = values[i - 1];
      let rendered;
      if (v instanceof Raw) rendered = v.v;
      else if (Array.isArray(v)) rendered = v.map(x => (x instanceof Raw ? x.v : esc(x))).join('');
      else if (v === null || v === undefined || v === false) rendered = '';
      else rendered = esc(v);
      return out + rendered + str;
    }, '');
  };

  QC.el = function (html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  };

  QC.$ = (sel, root = document) => root.querySelector(sel);
  QC.$$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  QC.formatTime = function (total, { hours = 'auto' } = {}) {
    const t = Math.max(0, Math.floor(Number(total) || 0));
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = t % 60;
    const pad = (n) => String(n).padStart(2, '0');
    if (hours === true || (hours === 'auto' && h > 0)) return `${h}:${pad(m)}:${pad(s)}`;
    return `${pad(m + h * 60)}:${pad(s)}`;
  };

  /** Accepts "45", "45:00", "1:05:00", "90s", "2m" → seconds */
  QC.parseTime = function (input) {
    const s = String(input ?? '').trim().toLowerCase();
    if (!s) return 0;
    if (/^\d+(\.\d+)?s$/.test(s)) return Math.round(parseFloat(s));
    if (/^\d+(\.\d+)?m$/.test(s)) return Math.round(parseFloat(s) * 60);
    if (/^\d+(\.\d+)?h$/.test(s)) return Math.round(parseFloat(s) * 3600);
    const parts = s.split(':').map(p => parseInt(p, 10));
    if (parts.some(n => Number.isNaN(n))) return NaN;
    if (parts.length === 1) return parts[0] * 60; // plain number = minutes
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return NaN;
  };

  QC.timeAgo = function (date) {
    if (!date) return 'never';
    const d = typeof date === 'string' && !date.includes('T') ? new Date(date.replace(' ', 'T') + 'Z') : new Date(date);
    const sec = Math.round((Date.now() - d.getTime()) / 1000);
    if (sec < 10) return 'just now';
    if (sec < 60) return `${sec}s ago`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
    if (sec < 86400 * 30) return `${Math.floor(sec / 86400)}d ago`;
    return d.toLocaleDateString();
  };

  QC.debounce = function (fn, ms = 300) {
    let t;
    const wrapped = function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
    wrapped.flush = function (...args) { clearTimeout(t); return fn.apply(this, args); };
    wrapped.cancel = () => clearTimeout(t);
    return wrapped;
  };

  QC.uid = (prefix = 'id') => `${prefix}-${Math.random().toString(36).slice(2, 9)}`;

  QC.copy = async function (text, label = 'Copied to clipboard') {
    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch (_) { /* ignore */ }
      ta.remove();
    }
    QC.toast(label, 'success');
  };

  QC.roomIdFromPath = function () {
    const parts = location.pathname.split('/').filter(Boolean);
    const i = parts.indexOf('room');
    return i >= 0 ? decodeURIComponent(parts[i + 1] || '') : null;
  };

  /* -------------------------------------------------------------------- API */
  QC.api = async function (method, url, body, { raw = false } = {}) {
    const init = { method, headers: {} };
    if (body instanceof FormData) {
      init.body = body;
    } else if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(url, init);
    } catch (err) {
      throw new Error('Cannot reach the Quandary server. Check that it is running.');
    }
    if (raw) return res;
    let json = null;
    try { json = await res.json(); } catch (_) { /* non-JSON */ }
    if (!res.ok || (json && json.success === false)) {
      const msg = (json && (json.error || json.message)) || `Request failed (HTTP ${res.status})`;
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return json && 'data' in json ? json.data : json;
  };
  QC.get = (url) => QC.api('GET', url);
  QC.post = (url, body) => QC.api('POST', url, body ?? {});
  QC.put = (url, body) => QC.api('PUT', url, body ?? {});
  QC.del = (url) => QC.api('DELETE', url);

  /**
   * Upload files with progress. Returns [{url, type, name, size, mediaId?}]
   */
  QC.upload = function (files, { roomId, category, url = '/api/v2/uploads', onProgress } = {}) {
    return new Promise((resolve, reject) => {
      const fd = new FormData();
      Array.from(files).forEach(f => fd.append('files', f));
      if (roomId) fd.append('roomId', roomId);
      if (category) fd.append('category', category);
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
      xhr.onload = () => {
        let json = null;
        try { json = JSON.parse(xhr.responseText); } catch (_) { /* ignore */ }
        if (xhr.status >= 200 && xhr.status < 300 && json && json.success) resolve(json.data);
        else reject(new Error((json && json.error) || `Upload failed (HTTP ${xhr.status})`));
      };
      xhr.onerror = () => reject(new Error('Upload failed – network error'));
      xhr.send(fd);
    });
  };

  /* ----------------------------------------------------------------- toasts */
  function toastHost() {
    let host = document.querySelector('.toasts');
    if (!host) {
      host = document.createElement('div');
      host.className = 'toasts';
      host.setAttribute('role', 'status');
      host.setAttribute('aria-live', 'polite');
      document.body.appendChild(host);
    }
    return host;
  }
  const TOAST_ICONS = { success: 'icon-circle-check', error: 'icon-circle-x', warning: 'icon-triangle-alert', info: 'icon-info' };
  QC.toast = function (message, type = 'info', { timeout = 3500, action } = {}) {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<i class="${TOAST_ICONS[type] || TOAST_ICONS.info}"></i><span class="toast-msg">${esc(message)}</span>`;
    if (action) {
      const b = document.createElement('button');
      b.className = 'btn btn-sm btn-ghost';
      b.textContent = action.label;
      b.onclick = () => { action.onClick(); dismiss(); };
      el.appendChild(b);
    }
    toastHost().appendChild(el);
    let gone = false;
    function dismiss() {
      if (gone) return;
      gone = true;
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 200);
    }
    if (timeout) setTimeout(dismiss, type === 'error' ? Math.max(timeout, 6000) : timeout);
    el.addEventListener('click', (e) => { if (e.target.tagName !== 'BUTTON') dismiss(); });
    return dismiss;
  };
  QC.error = (err) => QC.toast(err && err.message ? err.message : String(err), 'error');

  /* --------------------------------------------------------- room appearance */
  QC.ROOM_COLORS = ['#8b7cf6', '#4f8ff7', '#22b8cf', '#3ecf8e', '#a3d94b', '#f5b942', '#f59e42', '#f2555a', '#e96bb0', '#c084fc', '#94a3b8', '#f8fafc'];
  QC.ROOM_BACKGROUNDS = [
    { v: '', label: 'Default' },
    { v: '#150f24', label: 'Midnight purple' },
    { v: '#0b1626', label: 'Deep navy' },
    { v: '#0b1d1a', label: 'Teal forest' },
    { v: '#0e1b10', label: 'Moss' },
    { v: '#21100f', label: 'Blood red' },
    { v: '#22170a', label: 'Amber glow' },
    { v: '#1f0f1a', label: 'Plum' },
    { v: '#16181d', label: 'Graphite' },
    { v: '#000000', label: 'Black' }
  ];
  QC.TIMER_FONTS = [
    { v: 'inter', label: 'Clean', family: '"Inter Variable", system-ui, sans-serif', weight: 700, tracking: '-0.03em' },
    { v: 'oswald', label: 'Condensed', family: '"Oswald", "Arial Narrow", sans-serif', weight: 700, tracking: '0' },
    { v: 'bebas', label: 'Poster', family: '"Bebas Neue", "Arial Narrow", sans-serif', weight: 400, tracking: '0.02em' },
    { v: 'rajdhani', label: 'Tech', family: '"Rajdhani", system-ui, sans-serif', weight: 700, tracking: '0' },
    { v: 'orbitron', label: 'Sci-fi', family: '"Orbitron", system-ui, sans-serif', weight: 700, tracking: '0.02em' },
    { v: 'jetbrains', label: 'Monospace', family: '"JetBrains Mono", ui-monospace, monospace', weight: 700, tracking: '-0.02em' },
    { v: 'system', label: 'System', family: 'system-ui, "Segoe UI", sans-serif', weight: 700, tracking: '-0.02em' }
  ];

  /** The room's highlight colour (chosen, or a stable automatic one). */
  QC.roomAccent = function (room) {
    if (room && room.appearance && room.appearance.accent) return room.appearance.accent;
    const palette = ['#8b7cf6', '#4f8ff7', '#3ecf8e', '#f5b942', '#f2555a', '#e96bb0', '#22b8cf', '#f59e42'];
    let h = 0;
    for (const c of String((room && room.id) || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return palette[h % palette.length];
  };

  QC.roomInitials = function (name) {
    return String(name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';
  };

  /** Room icon: the uploaded image if there is one, otherwise initials on the room colour. */
  QC.roomAvatar = function (room, { size = 42, radius = 12, className = '' } = {}) {
    const accent = QC.roomAccent(room);
    const icon = room && room.appearance && room.appearance.icon;
    const base = `width:${size}px;height:${size}px;border-radius:${radius}px;--ra:${accent};`;
    if (icon) {
      return `<span class="room-avatar has-img ${esc(className)}" style="${base}"><img src="${esc(icon)}" alt="" loading="lazy" decoding="async"></span>`;
    }
    return `<span class="room-avatar ${esc(className)}" style="${base}background:${accent};color:${QC.contrastText(accent)};font-size:${Math.round(size * 0.4)}px">${esc(QC.roomInitials(room && room.name))}</span>`;
  };

  /* ---------------------------------------------------------- room favicon */
  QC.setFavicon = function (href) {
    let link = document.querySelector('link[rel~="icon"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    link.type = href.startsWith('data:image/svg') ? 'image/svg+xml' : 'image/png';
    link.href = href;
  };

  /** Rounded square in the room colour with the room's initials. */
  QC.roomFaviconSvg = function (room) {
    const accent = QC.roomAccent(room);
    const initials = QC.roomInitials(room && room.name).replace(/[&<>"']/g, '');
    const size = initials.length > 1 ? 27 : 34;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${accent}"/>` +
      `<text x="32" y="${initials.length > 1 ? 42 : 44}" font-size="${size}" font-family="Arial, Helvetica, sans-serif" font-weight="700" text-anchor="middle" fill="${QC.contrastText(accent)}">${initials}</text></svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
  };

  /**
   * Browser-tab icon for a room: its uploaded icon (cropped square, ringed in the
   * room colour, like the dashboard) or coloured initials when it has none.
   */
  QC.setRoomFavicon = async function (room) {
    const icon = room && room.appearance && room.appearance.icon;
    if (!icon) { QC.setFavicon(QC.roomFaviconSvg(room)); return; }
    try {
      const img = new Image();
      img.src = icon;
      await img.decode();
      const S = 64, R = 14, ring = 5;
      const c = document.createElement('canvas');
      c.width = S; c.height = S;
      const ctx = c.getContext('2d');
      const rounded = (inset) => {
        const x = inset, y = inset, w = S - inset * 2, r = R - inset / 2;
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + w, r);
        ctx.arcTo(x + w, y + w, x, y + w, r);
        ctx.arcTo(x, y + w, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
      };
      ctx.save();
      rounded(0);
      ctx.clip();
      ctx.fillStyle = '#1d222d';
      ctx.fillRect(0, 0, S, S);
      // cover-crop the image into the square (SVGs without a size report 0)
      const iw = img.naturalWidth || S, ih = img.naturalHeight || S;
      const scale = Math.max(S / iw, S / ih);
      ctx.drawImage(img, (S - iw * scale) / 2, (S - ih * scale) / 2, iw * scale, ih * scale);
      ctx.restore();
      rounded(ring / 2);
      ctx.lineWidth = ring;
      ctx.strokeStyle = QC.roomAccent(room);
      ctx.stroke();
      QC.setFavicon(c.toDataURL('image/png'));
    } catch (_) {
      QC.setFavicon(QC.roomFaviconSvg(room));
    }
  };

  QC.timerFont = function (key) {
    return QC.TIMER_FONTS.find(f => f.v === key) || QC.TIMER_FONTS[0];
  };

  /** Readable text colour on top of a hex background. */
  QC.contrastText = function (hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return '#ffffff';
    const n = parseInt(m[1], 16);
    const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
    return lum > 0.62 ? '#111318' : '#ffffff';
  };

  /**
   * Apply a room's accent, background tint and timer font to the current page.
   * Pass { background: false } to keep the default page background.
   */
  QC.applyRoomAppearance = function (room, { background = true } = {}) {
    const root = document.documentElement.style;
    const accent = QC.roomAccent(room);
    root.setProperty('--accent', accent);
    root.setProperty('--accent-hover', `color-mix(in srgb, ${accent} 85%, white)`);
    root.setProperty('--accent-soft', `color-mix(in srgb, ${accent} 16%, transparent)`);
    root.setProperty('--accent-ring', `color-mix(in srgb, ${accent} 45%, transparent)`);
    root.setProperty('--accent-text', QC.contrastText(accent));
    root.setProperty('--room-accent', accent);

    const bg = room && room.appearance && room.appearance.background;
    ['--bg', '--bg-elev', '--surface', '--surface-2', '--surface-3', '--border', '--border-strong'].forEach(p => root.removeProperty(p));
    if (background && bg) {
      if (QC.uiTheme() === 'light') {
        root.setProperty('--bg', `color-mix(in srgb, ${bg} 10%, #f4f5f8)`);
        root.setProperty('--bg-elev', `color-mix(in srgb, ${bg} 5%, #ffffff)`);
      } else {
        const mix = (pct) => `color-mix(in srgb, ${bg}, #ffffff ${pct}%)`;
        root.setProperty('--bg', bg);
        root.setProperty('--bg-elev', mix(3));
        root.setProperty('--surface', mix(5));
        root.setProperty('--surface-2', mix(8));
        root.setProperty('--surface-3', mix(12));
        root.setProperty('--border', mix(13));
        root.setProperty('--border-strong', mix(19));
      }
    }

    const font = QC.timerFont(room && room.appearance && room.appearance.timerFont);
    root.setProperty('--timer-font', font.family);
    root.setProperty('--timer-weight', String(font.weight));
    root.setProperty('--timer-tracking', font.tracking);
    QC._appliedRoom = room;
  };

  /**
   * Appearance picker (accent swatches, background swatches, timer font) used in
   * room settings and the GM console. onChange receives the full appearance object.
   */
  QC.appearancePicker = function (appearance, onChange, { room } = {}) {
    const a = { accent: null, background: null, timerFont: 'inter', ...(appearance || {}) };
    const wrap = document.createElement('div');
    wrap.className = 'stack-lg appearance-picker';
    function draw() {
      const accent = a.accent || QC.roomAccent({ id: room && room.id });
      const bgLabel = (QC.ROOM_BACKGROUNDS.find(b => b.v === (a.background || '')) || { label: 'Custom' }).label;
      wrap.innerHTML = `
        <div class="field">
          <label>Room icon <span class="faint">– shown next to the room name on the dashboard and GM console</span></label>
          <div class="row">
            ${QC.roomAvatar({ id: room && room.id, name: room && room.name, appearance: a }, { size: 52, radius: 14 })}
            <button type="button" class="btn btn-sm" data-icon-pick><i class="icon-image-up"></i>${a.icon ? 'Change image' : 'Upload image'}</button>
            ${a.icon ? '<button type="button" class="btn btn-ghost btn-sm" data-icon-clear>Use initials instead</button>' : '<span class="faint small">Square images work best (PNG, JPG, SVG…)</span>'}
          </div>
        </div>
        <div class="field">
          <label>Room colour <span class="faint">– highlights, buttons and the room badge</span></label>
          <div class="swatch-row">
            ${QC.ROOM_COLORS.map(c => `<button type="button" class="swatch ${a.accent === c ? 'active' : ''}" style="--sw:${c}" data-accent="${c}" aria-label="${c}"></button>`).join('')}
            <label class="swatch swatch-custom ${a.accent && !QC.ROOM_COLORS.includes(a.accent) ? 'active' : ''}" style="--sw:${a.accent && !QC.ROOM_COLORS.includes(a.accent) ? a.accent : 'transparent'}" title="Custom colour"><i class="icon-pipette"></i><input type="color" value="${accent}" data-accent-custom></label>
            ${a.accent ? '<button type="button" class="btn btn-ghost btn-xs" data-accent-auto>Automatic</button>' : '<span class="faint small">Automatic</span>'}
          </div>
        </div>
        <div class="field">
          <label>Background <span class="faint">– tints the GM console so you always know which room you're in</span></label>
          <div class="swatch-row">
            ${QC.ROOM_BACKGROUNDS.map(b => `<button type="button" class="swatch swatch-bg ${(a.background || '') === b.v ? 'active' : ''}" style="--sw:${b.v || 'var(--bg)'}" data-bg="${b.v}" title="${b.label}" aria-label="${b.label}">${b.v ? '' : '<i class="icon-ban"></i>'}</button>`).join('')}
            <label class="swatch swatch-custom swatch-bg ${a.background && !QC.ROOM_BACKGROUNDS.some(b => b.v === a.background) ? 'active' : ''}" style="--sw:${a.background && !QC.ROOM_BACKGROUNDS.some(b => b.v === a.background) ? a.background : 'transparent'}" title="Custom background"><i class="icon-pipette"></i><input type="color" value="${a.background || '#16181d'}" data-bg-custom></label>
            <span class="faint small">${QC.escape(bgLabel)}</span>
          </div>
        </div>
        <div class="field">
          <label>Timer font</label>
          <div class="font-row">
            ${QC.TIMER_FONTS.map(f => `<button type="button" class="font-opt ${a.timerFont === f.v ? 'active' : ''}" data-font="${f.v}">
              <span class="font-sample" style="font-family:${f.family.replace(/"/g, '&quot;')};font-weight:${f.weight};letter-spacing:${f.tracking}">45:00</span>
              <span class="font-name">${f.label}</span></button>`).join('')}
          </div>
        </div>`;
      wrap.querySelector('[data-icon-pick]').onclick = async () => {
        const picked = await QC.pickMedia({ roomId: room && room.id, accept: 'image/*', types: ['image'], category: 'icon', title: 'Room icon' });
        if (!picked) return;
        a.icon = picked.url;
        changed();
      };
      const iconClear = wrap.querySelector('[data-icon-clear]');
      if (iconClear) iconClear.onclick = () => { a.icon = null; changed(); };
      wrap.querySelectorAll('[data-accent]').forEach(b => b.onclick = () => { a.accent = b.dataset.accent; changed(); });
      wrap.querySelector('[data-accent-custom]').oninput = (e) => { a.accent = e.target.value; changed(false); };
      wrap.querySelector('[data-accent-custom]').onchange = () => draw();
      const auto = wrap.querySelector('[data-accent-auto]');
      if (auto) auto.onclick = () => { a.accent = null; changed(); };
      wrap.querySelectorAll('[data-bg]').forEach(b => b.onclick = () => { a.background = b.dataset.bg || null; changed(); });
      wrap.querySelector('[data-bg-custom]').oninput = (e) => { a.background = e.target.value; changed(false); };
      wrap.querySelector('[data-bg-custom]').onchange = () => draw();
      wrap.querySelectorAll('[data-font]').forEach(b => b.onclick = () => { a.timerFont = b.dataset.font; changed(); });
    }
    function changed(redraw = true) {
      onChange({ ...a });
      if (redraw) draw();
    }
    draw();
    return wrap;
  };

  /* ----------------------------------------------------------------- dialogs */
  /**
   * QC.modal({ title, body (html|Element), size, actions: [{label, variant, value, icon}], onOpen })
   * Resolves with the clicked action's value (or null on dismiss).
   */
  QC.modal = function ({ title = '', body = '', size = '', actions = [], onOpen, dismissible = true, icon } = {}) {
    return new Promise((resolve) => {
      const dlg = document.createElement('dialog');
      dlg.className = `modal ${size ? `modal-${size}` : ''}`;
      dlg.innerHTML = `
        <div class="modal-head">
          ${icon ? `<i class="${esc(icon)}" style="font-size:18px;color:var(--accent)"></i>` : ''}
          <h2>${esc(title)}</h2>
          ${dismissible ? '<button class="btn btn-ghost btn-icon btn-sm" data-close aria-label="Close"><i class="icon-x"></i></button>' : ''}
        </div>
        <div class="modal-body"></div>
        ${actions.length ? '<div class="modal-foot"></div>' : ''}`;
      const bodyEl = dlg.querySelector('.modal-body');
      if (body instanceof Element) bodyEl.appendChild(body); else bodyEl.innerHTML = body;
      const foot = dlg.querySelector('.modal-foot');
      let result = null;
      const close = (value = null) => { result = value; dlg.close(); };
      actions.forEach(a => {
        const b = document.createElement('button');
        b.className = `btn ${a.variant ? `btn-${a.variant}` : ''}`;
        b.innerHTML = `${a.icon ? `<i class="${esc(a.icon)}"></i>` : ''}${esc(a.label)}`;
        b.type = 'button';
        b.addEventListener('click', async () => {
          if (a.onClick) {
            b.classList.add('loading');
            try {
              const r = await a.onClick({ dialog: dlg, body: bodyEl, close });
              if (r === false) { b.classList.remove('loading'); return; }
              close(r !== undefined ? r : a.value);
            } catch (err) {
              b.classList.remove('loading');
              QC.error(err);
            }
          } else {
            close(a.value);
          }
        });
        foot.appendChild(b);
      });
      dlg.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => close(null)));
      dlg.addEventListener('cancel', (e) => { if (!dismissible) e.preventDefault(); });
      dlg.addEventListener('click', (e) => { if (e.target === dlg && dismissible) close(null); });
      dlg.addEventListener('close', () => { dlg.remove(); resolve(result); });
      document.body.appendChild(dlg);
      dlg.showModal();
      const focusable = bodyEl.querySelector('input, textarea, select');
      if (focusable) setTimeout(() => focusable.focus(), 30);
      if (onOpen) onOpen({ dialog: dlg, body: bodyEl, close });
      // Enter submits single-input dialogs
      bodyEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target.tagName === 'INPUT' && actions.length) {
          e.preventDefault();
          foot.lastElementChild.click();
        }
      });
    });
  };

  QC.confirm = function ({ title = 'Are you sure?', message = '', confirmText = 'Confirm', danger = false, icon } = {}) {
    return QC.modal({
      title,
      size: 'sm',
      icon: icon || (danger ? 'icon-triangle-alert' : 'icon-circle-help'),
      body: `<p class="muted">${message}</p>`,
      actions: [
        { label: 'Cancel', value: false },
        { label: confirmText, variant: danger ? 'danger-solid' : 'primary', value: true }
      ]
    }).then(Boolean);
  };

  QC.prompt = function ({ title = '', label = '', value = '', placeholder = '', confirmText = 'Save', hint = '' } = {}) {
    const id = QC.uid('prompt');
    return QC.modal({
      title,
      size: 'sm',
      body: `<div class="field"><label for="${id}">${esc(label)}</label><input class="input" id="${id}" value="${esc(value)}" placeholder="${esc(placeholder)}">${hint ? `<div class="hint">${esc(hint)}</div>` : ''}</div>`,
      actions: [
        { label: 'Cancel', value: null },
        { label: confirmText, variant: 'primary', onClick: ({ body }) => body.querySelector('input').value }
      ]
    });
  };

  /* ------------------------------------------------------------------ drawer */
  QC.drawer = function ({ title = '', body = '', footer = '', width, onClose } = {}) {
    const backdrop = document.createElement('div');
    backdrop.className = 'drawer-backdrop';
    const d = document.createElement('aside');
    d.className = 'drawer';
    if (width) d.style.width = `min(${width}px, 100vw)`;
    d.setAttribute('role', 'dialog');
    d.innerHTML = `
      <div class="drawer-head"><h2>${esc(title)}</h2><button class="btn btn-ghost btn-icon btn-sm" data-close aria-label="Close"><i class="icon-x"></i></button></div>
      <div class="drawer-body"></div>
      ${footer ? '<div class="drawer-foot"></div>' : ''}`;
    const bodyEl = d.querySelector('.drawer-body');
    if (body instanceof Element) bodyEl.appendChild(body); else bodyEl.innerHTML = body;
    const footEl = d.querySelector('.drawer-foot');
    if (footEl) { if (footer instanceof Element) footEl.appendChild(footer); else footEl.innerHTML = footer; }
    function close() {
      backdrop.remove(); d.remove();
      document.removeEventListener('keydown', onKey);
      if (onClose) onClose();
    }
    function onKey(e) { if (e.key === 'Escape' && !document.querySelector('dialog[open]')) close(); }
    backdrop.addEventListener('click', close);
    d.querySelector('[data-close]').addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    document.body.append(backdrop, d);
    return { el: d, body: bodyEl, footer: footEl, close };
  };

  /* -------------------------------------------------------------------- menu */
  /**
   * QC.menu(anchorEl, [{label, icon, onClick, danger} | 'divider'])
   */
  QC.menu = function (anchor, items) {
    document.querySelectorAll('.menu').forEach(m => m.remove());
    const m = document.createElement('div');
    m.className = 'menu';
    m.setAttribute('role', 'menu');
    items.forEach(item => {
      if (item === 'divider') { m.appendChild(document.createElement('hr')); return; }
      if (!item) return;
      const b = document.createElement('button');
      b.setAttribute('role', 'menuitem');
      if (item.danger) b.className = 'danger';
      b.innerHTML = `${item.icon ? `<i class="${esc(item.icon)}"></i>` : '<i></i>'}<span>${esc(item.label)}</span>`;
      b.addEventListener('click', () => { m.remove(); item.onClick && item.onClick(); });
      m.appendChild(b);
    });
    document.body.appendChild(m);
    const r = anchor.getBoundingClientRect();
    const mw = m.offsetWidth, mh = m.offsetHeight;
    let left = r.right - mw;
    if (left < 8) left = r.left;
    let top = r.bottom + 4;
    if (top + mh > innerHeight - 8) top = r.top - mh - 4;
    m.style.left = `${Math.max(8, left)}px`;
    m.style.top = `${Math.max(8, top)}px`;
    setTimeout(() => {
      const off = (e) => { if (!m.contains(e.target)) { m.remove(); document.removeEventListener('mousedown', off); } };
      document.addEventListener('mousedown', off);
    });
    return m;
  };

  /* ---------------------------------------------------------------- sortable */
  /**
   * Pointer-based drag reordering for vertical/horizontal lists.
   * QC.sortable(container, { items: '.item', handle: '.drag-handle', axis: 'y', onEnd(ids) })
   */
  QC.sortable = function (container, { items = ':scope > *', handle = null, axis = 'y', onEnd } = {}) {
    let dragEl = null, placeholder = null, startPos = 0, offset = 0;

    function onDown(e) {
      if (e.button !== 0) return;
      const item = e.target.closest(items);
      if (!item || !container.contains(item)) return;
      if (handle && !e.target.closest(handle)) return;
      if (e.target.closest('input, textarea, select, [contenteditable="true"]') && !e.target.closest(handle || '__none__')) return;
      e.preventDefault();
      dragEl = item;
      const rect = item.getBoundingClientRect();
      startPos = axis === 'y' ? e.clientY : e.clientX;
      offset = axis === 'y' ? e.clientY - rect.top : e.clientX - rect.left;
      placeholder = item.cloneNode(false);
      placeholder.style.height = `${rect.height}px`;
      placeholder.style.width = `${rect.width}px`;
      placeholder.style.visibility = 'hidden';
      placeholder.classList.add('sortable-placeholder');
      item.parentNode.insertBefore(placeholder, item.nextSibling);
      Object.assign(item.style, {
        position: 'fixed', zIndex: 1000, width: `${rect.width}px`, height: `${rect.height}px`,
        left: `${rect.left}px`, top: `${rect.top}px`, pointerEvents: 'none', boxShadow: 'var(--shadow-lg)', opacity: '0.95'
      });
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp, { once: true });
    }

    function onMove(e) {
      if (!dragEl) return;
      if (axis === 'y') dragEl.style.top = `${e.clientY - offset}px`; else dragEl.style.left = `${e.clientX - offset}px`;
      const siblings = Array.from(container.querySelectorAll(items)).filter(el => el !== dragEl && el !== placeholder);
      const pos = axis === 'y' ? e.clientY : e.clientX;
      let before = null;
      for (const s of siblings) {
        const r = s.getBoundingClientRect();
        const mid = axis === 'y' ? r.top + r.height / 2 : r.left + r.width / 2;
        if (pos < mid) { before = s; break; }
      }
      if (before) before.parentNode.insertBefore(placeholder, before);
      else if (siblings.length) siblings[siblings.length - 1].parentNode.insertBefore(placeholder, siblings[siblings.length - 1].nextSibling);
    }

    function onUp(e) {
      document.removeEventListener('pointermove', onMove);
      if (!dragEl) return;
      const moved = Math.abs((axis === 'y' ? e.clientY : e.clientX) - startPos) > 3;
      placeholder.parentNode.insertBefore(dragEl, placeholder);
      placeholder.remove();
      dragEl.removeAttribute('style');
      const el = dragEl;
      dragEl = null;
      if (moved && onEnd) {
        const ids = Array.from(container.querySelectorAll(items)).map(x => x.dataset.id);
        onEnd(ids, el);
      }
    }

    container.addEventListener('pointerdown', onDown);
    return { destroy: () => container.removeEventListener('pointerdown', onDown) };
  };

  /* --------------------------------------------------------------- dropzone */
  QC.dropzone = function (el, { accept = '', multiple = true, onFiles }) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.hidden = true;
    el.appendChild(input);
    el.addEventListener('click', (e) => { if (e.target === input) return; input.click(); });
    input.addEventListener('change', () => { if (input.files.length) onFiles(input.files); input.value = ''; });
    el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('over'); });
    el.addEventListener('dragleave', () => el.classList.remove('over'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('over');
      if (e.dataTransfer.files.length) onFiles(e.dataTransfer.files);
    });
    return input;
  };

  QC.pickFiles = function ({ accept = '', multiple = false } = {}) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = accept;
      input.multiple = multiple;
      input.addEventListener('change', () => resolve(input.files.length ? input.files : null));
      input.click();
    });
  };

  /* ------------------------------------------------------- media library pick */
  /**
   * Let the user choose an uploaded file from the room library or upload a new one.
   * Resolves with { url, type, name } or null.
   */
  QC.pickMedia = async function ({ roomId, accept = 'image/*,video/*', title = 'Choose media', types, category } = {}) {
    let items = [];
    if (roomId) {
      try { items = await QC.get(`/api/v2/rooms/${encodeURIComponent(roomId)}/media`); } catch (_) { items = []; }
    }
    const allowed = types || accept.split(',').map(a => a.trim().replace('/*', ''));
    items = items.filter(m => allowed.includes(m.type));
    const body = document.createElement('div');
    body.className = 'stack';
    body.innerHTML = `
      <div class="dropzone" data-drop><i class="icon-upload"></i><strong>Drop files here</strong> or click to upload</div>
      <div class="progress hidden" data-progress><div style="width:0"></div></div>
      ${items.length ? `<div class="section-title">Room library</div>
      <div class="media-pick-grid">${items.map(m => `
        <button type="button" class="media-pick" data-url="${esc(m.url)}" data-type="${esc(m.type)}" data-name="${esc(m.title || '')}">
          ${m.type === 'image' ? `<img src="${esc(m.url)}" loading="lazy" alt="">` : m.type === 'video' ? `<video src="${esc(m.url)}#t=0.5" muted preload="metadata"></video>` : `<i class="icon-music"></i>`}
          <span class="truncate">${esc(m.title || m.url.split('/').pop())}</span>
        </button>`).join('')}</div>` : ''}`;
    return QC.modal({
      title,
      size: 'lg',
      icon: 'icon-image',
      body,
      onOpen: ({ close }) => {
        body.querySelectorAll('.media-pick').forEach(b => b.addEventListener('click', () => close({ url: b.dataset.url, type: b.dataset.type, name: b.dataset.name })));
        const prog = body.querySelector('[data-progress]');
        QC.dropzone(body.querySelector('[data-drop]'), {
          accept,
          multiple: false,
          onFiles: async (files) => {
            prog.classList.remove('hidden');
            try {
              const [up] = await QC.upload(files, { roomId, category, onProgress: p => { prog.firstElementChild.style.width = `${Math.round(p * 100)}%`; } });
              close({ url: up.url, type: up.type, name: up.name });
            } catch (err) {
              QC.error(err);
              prog.classList.add('hidden');
            }
          }
        });
      }
    });
  };

  /* -------------------------------------------------------------- shortcuts */
  QC.hotkeys = function (map) {
    document.addEventListener('keydown', (e) => {
      const inField = e.target.closest('input, textarea, select, [contenteditable="true"], .CodeMirror');
      const key = [(e.ctrlKey || e.metaKey) ? 'mod' : '', e.shiftKey ? 'shift' : '', e.altKey ? 'alt' : '', e.key.toLowerCase()].filter(Boolean).join('+');
      const handler = map[key];
      if (!handler) return;
      if (inField && !key.startsWith('mod+')) return;
      e.preventDefault();
      handler(e);
    });
  };

  /* ------------------------------------------------------- sidebar (mobile) */
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-toggle-sidebar]');
    const sidebar = document.querySelector('.sidebar');
    if (btn && sidebar) { sidebar.classList.toggle('open'); return; }
    if (sidebar && sidebar.classList.contains('open') && !e.target.closest('.sidebar')) sidebar.classList.remove('open');
  });

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-theme-icon]').forEach(el => {
      el.className = QC.uiTheme() === 'light' ? 'icon-moon' : 'icon-sun';
    });
    document.querySelectorAll('[data-action="toggle-ui-theme"]').forEach(b => b.addEventListener('click', QC.toggleUiTheme));
  });

  window.QC = QC;
})();
