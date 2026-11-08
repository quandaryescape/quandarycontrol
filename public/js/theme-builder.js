/* Theme Builder: Visual (drag & drop) · Code (HTML/CSS/JS) · AI assistant.
   All three modes edit one draft { html, css, js } with shared undo/redo and a
   live preview rendered by the real player pipeline. */
(function () {
  'use strict';
  const { html, raw, escape: esc, get, post, put, toast, error, confirm, prompt, modal, menu, $, $$ } = QC;
  const E = window.TBElements;

  const params = new URLSearchParams(location.search);
  const slug = decodeURIComponent(location.pathname.split('/').filter(Boolean)[1] || '');

  const T = {
    slug,
    protected: false,
    config: {},
    draft: { html: '', css: '', js: '' },
    saved: '',
    doc: null,
    mode: 'visual',
    selectedId: null,
    selInfo: null,
    rooms: [],
    roomId: params.get('room') || null,
    device: 'tv',
    demo: true,
    token: null,
    history: [],
    future: [],
    nextId: 1,
    editors: {},
    codeFile: 'css',
    ai: { configured: false, model: '', messages: [], busy: false }
  };

  const DEVICES = { tv: [1920, 1080], laptop: [1366, 768], tablet: [1024, 768], phone: [390, 844] };
  const iframe = $('#preview');

  /* ================================================================ helpers */
  const snapshot = () => ({ html: T.draft.html, css: T.draft.css, js: T.draft.js });
  const isDirty = () => JSON.stringify(snapshot()) !== T.saved;
  const stripIds = (h) => h.replace(/\sdata-qb="[^"]*"/g, '');

  function setStatus(text, kind) {
    const el = $('#status');
    el.innerHTML = text;
    el.style.color = kind === 'warn' ? 'var(--warning)' : '';
  }
  function updateStatus() {
    if (T.protected) return setStatus('Read-only starter');
    setStatus(isDirty() ? '<span style="color:var(--warning)">●</span> Unsaved changes' : '<i class="icon-check"></i> Saved');
  }
  function updateUndo() {
    $('#undo').disabled = T.history.length < 2;
    $('#redo').disabled = !T.future.length;
  }

  /* ============================================================ document */
  function ensureDoc() {
    if (T.doc) return T.doc;
    T.doc = new DOMParser().parseFromString(T.draft.html || '<!DOCTYPE html><html><head></head><body></body></html>', 'text/html');
    assignIds(T.doc.body);
    return T.doc;
  }
  function assignIds(root) {
    root.querySelectorAll('*').forEach(el => {
      if (['SCRIPT', 'STYLE', 'LINK', 'META', 'TEMPLATE', 'BR'].includes(el.tagName)) return;
      if (!el.dataset.qb) el.dataset.qb = `n${T.nextId++}`;
    });
  }
  function serializeDoc() {
    return `<!DOCTYPE html>\n${T.doc.documentElement.outerHTML}\n`;
  }
  function node(id) {
    const d = ensureDoc();
    if (!id || id === '__body__') return d.body;
    return d.querySelector(`[data-qb="${CSS.escape(id)}"]`);
  }
  function previewHtml() {
    // Visual mode sends ids so clicks in the preview map back to source nodes
    if (T.mode === 'visual') { ensureDoc(); return serializeDoc(); }
    return T.draft.html;
  }
  /** Commit doc → draft.html */
  function docChanged() {
    T.draft.html = stripIds(serializeDoc());
  }

  /* ============================================================= history */
  function commit(label) {
    const snap = snapshot();
    const last = T.history[T.history.length - 1];
    if (last && last.html === snap.html && last.css === snap.css && last.js === snap.js) return;
    T.history.push({ ...snap, label });
    if (T.history.length > 120) T.history.shift();
    T.future = [];
    updateUndo();
    updateStatus();
  }
  const commitSoon = QC.debounce((label) => commit(label), 700);

  function restore(snap) {
    T.draft = { html: snap.html, css: snap.css, js: snap.js };
    T.doc = null;
    syncEditors();
    renderLeft();
    reloadPreview();
    updateUndo();
    updateStatus();
  }
  function undo() {
    commitSoon.flush('Edit'); // capture an in-progress edit so it can be undone too
    if (T.history.length < 2) return;
    T.future.push(T.history.pop());
    restore(T.history[T.history.length - 1]);
    toast('Undone', 'info', { timeout: 1200 });
  }
  function redo() {
    if (!T.future.length) return;
    const s = T.future.pop();
    T.history.push(s);
    restore(s);
  }
  $('#undo').onclick = undo;
  $('#redo').onclick = redo;

  /* ============================================================= preview */
  let reloadTimer = null;
  function reloadPreview(delay = 200) {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(doReload, delay);
  }
  async function doReload() {
    if (!T.roomId) return;
    $('#preview-stage').classList.add('loading');
    try {
      const { token } = await post('/api/v2/themes/preview', { slug: T.slug, html: previewHtml(), css: T.draft.css, js: T.draft.js, token: T.token });
      T.token = token;
      const url = `/room/${encodeURIComponent(T.roomId)}/player?themePreview=${token}&demo=${T.demo ? 1 : 0}&editor=1`;
      $('#open-preview').href = url.replace('&editor=1', '');
      iframe.src = `${url}&_=${Date.now()}`;
    } catch (err) {
      $('#preview-stage').classList.remove('loading');
      error(err);
    }
  }
  // Keep the server copy fresh (for "open in new tab") without reloading the iframe
  const syncDraft = QC.debounce(async () => {
    if (!T.token) return;
    try { await post('/api/v2/themes/preview', { slug: T.slug, html: previewHtml(), css: T.draft.css, js: T.draft.js, token: T.token }); } catch (_) { /* ignore */ }
  }, 1000);

  function send(type, data = {}) {
    if (iframe.contentWindow) iframe.contentWindow.postMessage({ source: 'qb-parent', type, ...data }, location.origin);
  }
  function pushCss() {
    send('css', { css: T.draft.css });
    syncDraft();
  }

  iframe.addEventListener('load', () => {
    $('#preview-stage').classList.remove('loading');
    send('mode', { mode: T.mode });
    if (T.selectedId && T.mode === 'visual') send('select', { id: T.selectedId, notify: true });
  });

  function fitDevice() {
    const [w, h] = DEVICES[T.device];
    const stage = $('#preview-stage');
    const pad = 28;
    const scale = Math.min((stage.clientWidth - pad) / w, (stage.clientHeight - pad) / h, 1);
    const dev = $('#preview-device');
    dev.style.width = `${w}px`;
    dev.style.height = `${h}px`;
    dev.style.transform = `translate(-50%, -50%) scale(${scale})`;
  }
  new ResizeObserver(fitDevice).observe($('#preview-stage'));
  $$('#devices button').forEach(b => b.onclick = () => {
    T.device = b.dataset.device;
    $$('#devices button').forEach(x => x.classList.toggle('active', x === b));
    fitDevice();
  });
  $('#demo-toggle').onchange = (e) => { T.demo = e.target.checked; reloadPreview(0); };
  $('#reload-preview').onclick = () => reloadPreview(0);
  $('#preview-room').onchange = (e) => { T.roomId = e.target.value; reloadPreview(0); };

  /* ======================================================= iframe messages */
  window.addEventListener('message', async (e) => {
    if (e.origin !== location.origin || !e.data || e.data.source !== 'qb') return;
    const d = e.data;
    switch (d.type) {
      case 'select':
        T.selectedId = d.id || null;
        T.selInfo = d.id ? d : null;
        renderInspector();
        highlightLayer();
        updateAiContext();
        break;
      case 'action':
        if (d.action === 'delete') removeNode(d.id);
        else if (d.action === 'duplicate') duplicateNode(d.id);
        else if (d.action === 'up' || d.action === 'down') nudge(d.id, d.action);
        break;
      case 'drop': await insertItem(d.kind, d.targetId, d.position); break;
      case 'move': moveNode(d.id, d.targetId, d.position); break;
      case 'key':
        if (d.key === 'z' && !d.shift) undo();
        else if (d.key === 'y' || (d.key === 'z' && d.shift)) redo();
        else if (d.key === 's') save();
        else if (d.key === 'd' && T.selectedId) duplicateNode(T.selectedId);
        break;
    }
  });

  /* ===================================================== structural edits */
  function structural(label, selectId) {
    docChanged();
    commit(label);
    if (selectId !== undefined) T.selectedId = selectId;
    renderLayers();
    renderInspector();
    reloadPreview(0);
  }

  function placeNodes(nodes, target, position) {
    const parent = position === 'inside' ? target : target.parentNode;
    if (!parent) return false;
    nodes.forEach(n => {
      if (position === 'inside') target.appendChild(n);
      else if (position === 'before') parent.insertBefore(n, target);
      else parent.insertBefore(n, target.nextSibling);
    });
    // keep a little whitespace so the HTML stays readable
    nodes.forEach(n => { if (n.parentNode) n.parentNode.insertBefore(T.doc.createTextNode('\n'), n); });
    return true;
  }

  function defaultTarget() {
    const d = ensureDoc();
    const sel = T.selectedId && node(T.selectedId);
    if (sel && sel !== d.body) {
      const container = ['DIV', 'SECTION', 'MAIN', 'HEADER', 'FOOTER', 'ASIDE', 'ARTICLE'].includes(sel.tagName) && !E.parseShortcode(sel.textContent);
      return { target: sel, position: container ? 'inside' : 'after' };
    }
    const main = d.querySelector('main') || d.body.firstElementChild || d.body;
    return { target: main, position: main === d.body ? 'inside' : 'inside' };
  }

  async function insertItem(kind, targetId, position) {
    const item = E.ITEMS[kind];
    if (!item) return;
    if (T.mode !== 'visual') setMode('visual');
    ensureDoc();
    if (item.single && T.draft.html.includes(item.single)) {
      return toast(`This theme already has a ${item.label.toLowerCase()} – there can only be one.`, 'warning');
    }
    let built;
    if (item.needsMedia) {
      const picked = await QC.pickMedia({ roomId: T.roomId, accept: `${item.needsMedia}/*`, types: [item.needsMedia], title: `Choose ${item.needsMedia === 'image' ? 'an image' : 'a video'}` });
      if (!picked) return;
      built = item.build(picked.url);
    } else {
      built = item.build();
    }
    let target, pos;
    if (targetId) { target = node(targetId); pos = position; }
    if (!target) ({ target, position: pos } = defaultTarget());

    const tpl = T.doc.createElement('template');
    tpl.innerHTML = built.html;
    const nodes = Array.from(tpl.content.children);
    nodes.forEach(n => { if (!n.dataset.qb) n.dataset.qb = `n${T.nextId++}`; assignIds(n); });
    if (!placeNodes(nodes, target, pos)) return;

    if (Object.keys(built.styles).length) {
      const parsed = E.parseManaged(T.draft.css);
      for (const [cls, props] of Object.entries(built.styles)) parsed.rules.set(cls, new Map(Object.entries(props)));
      T.draft.css = E.serializeManaged(parsed);
    }
    structural(`Add ${item.label}`, nodes[0].dataset.qb);
  }

  function qbClassesIn(el) {
    const list = [];
    [el, ...el.querySelectorAll('*')].forEach(n => n.classList && n.classList.forEach(c => { if (c.startsWith('qb-')) list.push(c); }));
    return list;
  }

  function removeNode(id) {
    const n = node(id);
    if (!n || n === T.doc.body) return;
    const classes = qbClassesIn(n);
    const parentId = n.parentElement && n.parentElement !== T.doc.body ? n.parentElement.dataset.qb : null;
    if (n.previousSibling && n.previousSibling.nodeType === 3 && !n.previousSibling.textContent.trim()) n.previousSibling.remove();
    n.remove();
    // drop managed styles nobody uses any more
    const parsed = E.parseManaged(T.draft.css);
    let touched = false;
    classes.forEach(c => { if (!T.doc.querySelector(`.${CSS.escape(c)}`) && parsed.rules.delete(c)) touched = true; });
    if (touched) T.draft.css = E.serializeManaged(parsed);
    structural('Delete element', parentId);
    toast('Element deleted', 'info', { timeout: 4000, action: { label: 'Undo', onClick: undo } });
  }

  function duplicateNode(id) {
    const n = node(id);
    if (!n || n === T.doc.body) return;
    const clone = n.cloneNode(true);
    [clone, ...clone.querySelectorAll('[data-qb]')].forEach(x => { delete x.dataset.qb; });
    clone.dataset.qb = `n${T.nextId++}`;
    assignIds(clone);
    // give the copy its own visual classes so restyling one doesn't change the other
    const parsed = E.parseManaged(T.draft.css);
    [clone, ...clone.querySelectorAll('*')].forEach(x => {
      Array.from(x.classList || []).forEach(c => {
        if (!c.startsWith('qb-')) return;
        const fresh = E.qbClass();
        x.classList.replace(c, fresh);
        if (parsed.rules.has(c)) parsed.rules.set(fresh, new Map(parsed.rules.get(c)));
      });
    });
    T.draft.css = E.serializeManaged(parsed);
    placeNodes([clone], n, 'after');
    structural('Duplicate element', clone.dataset.qb);
  }

  function nudge(id, dir) {
    const n = node(id);
    if (!n) return;
    const sib = dir === 'up' ? n.previousElementSibling : n.nextElementSibling;
    if (!sib) return toast(dir === 'up' ? 'Already first' : 'Already last', 'info', { timeout: 1200 });
    if (dir === 'up') n.parentNode.insertBefore(n, sib);
    else n.parentNode.insertBefore(n, sib.nextSibling);
    structural('Move element', id);
  }

  function moveNode(id, targetId, position) {
    const n = node(id);
    const target = node(targetId);
    if (!n || !target || n === target || n.contains(target)) return;
    if (n.previousSibling && n.previousSibling.nodeType === 3 && !n.previousSibling.textContent.trim()) n.previousSibling.remove();
    placeNodes([n], target, position);
    structural('Move element', id);
  }

  /* ========================================================= style edits */
  function ensureQbClass(id) {
    const n = node(id);
    if (!n) return null;
    let cls = Array.from(n.classList).find(c => c.startsWith('qb-'));
    if (!cls) {
      cls = E.qbClass();
      n.classList.add(cls);
      docChanged();
      send('class', { id, add: cls });
    }
    return cls;
  }

  function getRule(id) {
    const n = node(id);
    if (!n) return new Map();
    const cls = Array.from(n.classList).find(c => c.startsWith('qb-'));
    return (cls && E.parseManaged(T.draft.css).rules.get(cls)) || new Map();
  }

  const LENGTH_PROPS = /^(font-size|letter-spacing|width|height|min-height|max-width|max-height|gap|border-radius|padding|margin|border-width|top|left|right|bottom)/;
  function normalizeValue(prop, value) {
    const v = String(value ?? '').trim();
    if (v && LENGTH_PROPS.test(prop) && /^-?\d+(\.\d+)?$/.test(v) && v !== '0') return `${v}px`;
    return v;
  }

  function setStyle(id, prop, value, { live = true } = {}) {
    const cls = ensureQbClass(id);
    if (!cls) return;
    const parsed = E.parseManaged(T.draft.css);
    const rule = parsed.rules.get(cls) || new Map();
    const v = normalizeValue(prop, value);
    if (v === '') rule.delete(prop); else rule.set(prop, v);
    parsed.rules.set(cls, rule);
    T.draft.css = E.serializeManaged(parsed);
    if (prop === 'font-family' && /Inter Variable|Oswald|Bebas|Rajdhani|Orbitron|JetBrains/.test(v) && !T.draft.css.includes('/css/fonts.css')) {
      T.draft.css = `@import url("/css/fonts.css");\n${T.draft.css}`;
    }
    if (live) pushCss();
    commitSoon('Change style');
    updateStatus();
  }

  function clearStyles(id) {
    const n = node(id);
    const cls = n && Array.from(n.classList).find(c => c.startsWith('qb-'));
    if (!cls) return;
    const parsed = E.parseManaged(T.draft.css);
    parsed.rules.delete(cls);
    T.draft.css = E.serializeManaged(parsed);
    pushCss();
    commit('Reset styles');
    renderInspector();
  }

  /* =============================================================== modes */
  function setMode(mode) {
    if (T.mode === mode) return;
    if (T.mode === 'code') flushEditors();
    T.mode = mode;
    $$('#modes button').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
    $('#tb').className = `tb mode-${mode}`;
    renderLeft();
    renderInspector();
    setTimeout(fitDevice, 0);
    // visual mode needs ids in the preview; other modes show exactly what will be saved
    reloadPreview(0);
    history.replaceState(null, '', `${location.pathname}${location.search}#${mode}`);
  }
  $$('#modes button').forEach(b => b.onclick = () => setMode(b.dataset.mode));

  function renderLeft() {
    const left = $('#left');
    if (T.mode === 'visual') renderVisualLeft(left);
    else if (T.mode === 'code') renderCodeLeft(left);
    else renderAiLeft(left);
  }

  /* ============================================================ visual UI */
  function renderVisualLeft(left) {
    ensureDoc();
    left.innerHTML = `
      <div class="panel">
        <div class="panel-head"><i class="icon-plus"></i>Add elements<span class="spacer"></span><span class="tiny faint" style="text-transform:none;letter-spacing:0;font-weight:500">drag or click</span></div>
        <div class="panel-body">${E.PALETTE.map(g => `
          <div class="pal-group">${esc(g.group)}</div>
          <div class="palette">${g.items.map(i => `<div class="pal-item ${i.component ? 'component' : ''}" draggable="true" data-kind="${i.kind}" title="${esc(i.label)}"><i class="${i.icon}"></i>${esc(i.label)}</div>`).join('')}</div>`).join('')}
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><i class="icon-palette"></i>Theme colours<span class="spacer"></span></div>
        <div class="panel-body" id="theme-vars"></div>
      </div>
      <div class="panel" style="border-bottom:0">
        <div class="panel-head"><i class="icon-layers"></i>Layers</div>
        <div class="layers" id="layers"></div>
      </div>`;

    left.querySelectorAll('.pal-item').forEach(p => {
      p.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/qb-new', p.dataset.kind);
        e.dataTransfer.effectAllowed = 'copy';
      });
      p.addEventListener('click', () => insertItem(p.dataset.kind));
    });
    renderThemeVars();
    renderLayers();
  }

  function renderThemeVars() {
    const host = $('#theme-vars');
    if (!host) return;
    const vars = E.rootVariables(T.draft.css);
    if (!vars.length) {
      host.innerHTML = '<div class="small faint">This theme has no <code>:root</code> variables. Add some in Code mode (e.g. <code>--accent: #f5b942;</code>) to tweak colours here.</div>';
      return;
    }
    host.innerHTML = vars.slice(0, 24).map(v => {
      const isColor = /^(#[0-9a-f]{3,8}|rgb|hsl)/i.test(v.value);
      const hex = /^#[0-9a-f]{6}$/i.test(v.value) ? v.value : (/^#[0-9a-f]{3}$/i.test(v.value) ? `#${v.value.slice(1).split('').map(c => c + c).join('')}` : '#000000');
      return `<div class="var-row">${isColor ? `<input type="color" value="${hex}" data-var="${esc(v.name)}">` : ''}<span class="vn" title="${esc(v.name)}">${esc(v.name.replace(/^--/, ''))}</span><input class="input input-sm" value="${esc(v.value)}" data-var-text="${esc(v.name)}"></div>`;
    }).join('');
    host.querySelectorAll('[data-var]').forEach(i => i.oninput = () => {
      T.draft.css = E.setRootVariable(T.draft.css, i.dataset.var, i.value);
      host.querySelector(`[data-var-text="${CSS.escape(i.dataset.var)}"]`).value = i.value;
      pushCss();
      commitSoon('Theme colour');
      updateStatus();
    });
    host.querySelectorAll('[data-var-text]').forEach(i => i.onchange = () => {
      T.draft.css = E.setRootVariable(T.draft.css, i.dataset.varText, i.value);
      pushCss();
      commit('Theme variable');
      renderThemeVars();
    });
  }

  function layerLabel(el) {
    const sc = E.parseShortcode(Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent).join(' '));
    if (sc) return { component: true, text: E.SHORTCODES[sc.name].label };
    const cls = Array.from(el.classList).filter(c => !c.startsWith('qb-'))[0];
    const txt = el.children.length === 0 ? el.textContent.trim().slice(0, 24) : '';
    return { component: false, text: el.tagName.toLowerCase(), cls: cls ? `.${cls}` : '', txt };
  }

  function renderLayers() {
    const host = $('#layers');
    if (!host) return;
    ensureDoc();
    const rows = [];
    const walk = (el, depth) => {
      Array.from(el.children).forEach(c => {
        if (!c.dataset.qb || ['SCRIPT', 'STYLE'].includes(c.tagName)) return;
        if (c.style && c.style.display === 'none' && c.querySelector('#start-rules-button')) return;
        const l = layerLabel(c);
        rows.push(`<div class="layer ${l.component ? 'component' : ''} ${c.dataset.qb === T.selectedId ? 'sel' : ''}" data-id="${c.dataset.qb}" style="padding-left:${8 + depth * 14}px">
          <i class="${l.component ? 'icon-puzzle' : c.children.length ? 'icon-chevron-down' : 'icon-dot'}"></i>
          <span class="tag">${esc(l.text)}</span>${l.cls ? `<span class="cls">${esc(l.cls)}</span>` : ''}${l.txt ? `<span class="cls">“${esc(l.txt)}”</span>` : ''}</div>`);
        if (!l.component && depth < 8) walk(c, depth + 1);
      });
    };
    walk(T.doc.body, 0);
    host.innerHTML = rows.join('') || '<div class="small faint" style="padding:8px">Empty page – add elements above.</div>';
    host.querySelectorAll('.layer').forEach(l => l.onclick = () => {
      T.selectedId = l.dataset.id;
      send('select', { id: l.dataset.id, notify: true });
      highlightLayer();
    });
  }

  function highlightLayer() {
    $$('#layers .layer').forEach(l => l.classList.toggle('sel', l.dataset.id === T.selectedId));
    const sel = document.querySelector('#layers .layer.sel');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  }

  /* ----------------------------------------------------------- inspector */
  function renderInspector() {
    const right = $('#right');
    if (T.mode !== 'visual') { right.innerHTML = ''; return; }
    const n = T.selectedId && node(T.selectedId);
    if (!n || n === ensureDoc().body) {
      right.innerHTML = `<div class="insp-empty"><i class="icon-mouse-pointer-click"></i>Click anything in the preview to edit it.<br><br>Drag elements from the left onto the page, or use the toolbar above a selection to move, duplicate or delete.</div>`;
      return;
    }
    const rule = getRule(T.selectedId);
    const comp = T.selInfo && T.selInfo.computed ? T.selInfo.computed : {};
    const val = (p) => rule.get(p) || '';
    const ph = (p) => esc(comp[p] || '');
    const tag = n.tagName.toLowerCase();
    const directText = Array.from(n.childNodes).filter(c => c.nodeType === 3).map(c => c.textContent).join(' ');
    const sc = E.parseShortcode(directText);
    const isLeafText = !sc && n.children.length === 0 && !['img', 'video', 'hr', 'iframe'].includes(tag);
    const isContainer = ['div', 'section', 'main', 'header', 'footer', 'aside', 'article', 'nav', 'body'].includes(tag);
    const otherClasses = Array.from(n.classList).filter(c => !c.startsWith('qb-')).join(' ');

    const colorInput = (prop) => {
      const v = val(prop);
      const hex = /^#[0-9a-f]{6}$/i.test(v) ? v : '#000000';
      return `<div class="row gap-4"><input type="color" data-color="${prop}" value="${hex}"><input class="input input-sm" data-prop="${prop}" value="${esc(v)}" placeholder="${ph(prop)}"></div>`;
    };
    const text = (prop, placeholder) => `<input class="input input-sm" data-prop="${prop}" value="${esc(val(prop))}" placeholder="${esc(placeholder || comp[prop] || '')}">`;
    const select = (prop, options) => `<select class="select input-sm" data-prop="${prop}">${options.map(([v, l]) => `<option value="${esc(v)}" ${val(prop) === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
    const segment = (prop, options) => `<div class="segmented icon-seg" data-seg="${prop}">${options.map(([v, icon, tip]) => `<button type="button" data-v="${esc(v)}" class="${val(prop) === v ? 'active' : ''}" title="${esc(tip)}">${icon.startsWith('icon-') ? `<i class="${icon}"></i>` : esc(icon)}</button>`).join('')}</div>`;

    let content = '';
    if (sc) {
      const schema = E.SHORTCODES[sc.name];
      content = `<div class="insp-section"><div class="insp-title"><i class="icon-puzzle"></i>${esc(schema.label)} settings</div>
        ${schema.attrs.length ? schema.attrs.map(a => {
          const cur = sc.attrs[a.name] ?? a.default;
          if (a.type === 'bool') return `<label class="switch small"><input type="checkbox" data-sc="${a.name}" ${cur !== 'false' ? 'checked' : ''}><span class="track"></span>${esc(a.label)}</label>`;
          if (a.type === 'select') return `<div class="prop"><label>${esc(a.label)}</label><select class="select input-sm" data-sc="${a.name}">${a.options.map(([v, l]) => `<option value="${esc(v)}" ${cur === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>`;
          return `<div class="prop"><label>${esc(a.label)}</label><input class="input input-sm" type="${a.type === 'number' ? 'number' : 'text'}" data-sc="${a.name}" value="${esc(cur)}"></div>`;
        }).join('') : '<div class="small faint">This component has no options – style it below.</div>'}
        <div class="text-help small faint">Live data appears here on the real player screen.</div></div>`;
    } else if (isLeafText) {
      content = `<div class="insp-section"><div class="insp-title"><i class="icon-type"></i>Text</div>
        <textarea class="textarea" id="in-text" rows="3">${esc(n.textContent)}</textarea>
        <div class="tiny faint">You can type shortcodes too, e.g. <code>[room-info field="name"]</code>.</div></div>`;
    } else if (tag === 'img' || tag === 'video') {
      content = `<div class="insp-section"><div class="insp-title"><i class="${tag === 'img' ? 'icon-image' : 'icon-video'}"></i>${tag === 'img' ? 'Image' : 'Video'}</div>
        <div class="row"><input class="input input-sm grow mono" id="in-src" value="${esc(n.getAttribute('src') || '')}"><button class="btn btn-sm" id="in-pick"><i class="icon-folder-open"></i></button></div>
        ${tag === 'img' ? `<div class="prop"><label>Alt text</label><input class="input input-sm" id="in-alt" value="${esc(n.getAttribute('alt') || '')}"></div>` : ''}</div>`;
    }

    right.innerHTML = `
      <div class="insp-head">
        <div class="grow"><div class="el-name">${esc(T.selInfo && T.selInfo.label || tag)}</div><div class="el-tag">&lt;${tag}&gt;${T.selInfo && T.selInfo.rect ? ` · ${T.selInfo.rect.w}×${T.selInfo.rect.h}` : ''}</div></div>
        <button class="btn btn-ghost btn-icon btn-xs" id="in-parent" data-tip="Select parent"><i class="icon-arrow-up-to-line"></i></button>
        <button class="btn btn-ghost btn-icon btn-xs" id="in-html" data-tip="Edit HTML"><i class="icon-code"></i></button>
        <button class="btn btn-ghost btn-icon btn-xs" id="in-dup" data-tip="Duplicate"><i class="icon-copy"></i></button>
        <button class="btn btn-ghost btn-icon btn-xs" id="in-del" data-tip="Delete"><i class="icon-trash-2"></i></button>
      </div>
      ${content}
      <div class="insp-section">
        <div class="insp-title"><i class="icon-type"></i>Typography</div>
        <div class="prop full"><label>Font</label>${select('font-family', E.FONT_OPTIONS.map(([v, l]) => [v, l]))}</div>
        <div class="prop-grid">
          <div class="prop"><label>Size</label>${text('font-size')}</div>
          <div class="prop"><label>Weight</label>${select('font-weight', [['', 'Default'], ['300', 'Light'], ['400', 'Regular'], ['500', 'Medium'], ['600', 'Semibold'], ['700', 'Bold'], ['800', 'Extra bold'], ['900', 'Black']])}</div>
          <div class="prop full"><label>Colour</label>${colorInput('color')}</div>
          <div class="prop"><label>Align</label>${segment('text-align', [['left', 'icon-align-left', 'Left'], ['center', 'icon-align-center', 'Center'], ['right', 'icon-align-right', 'Right']])}</div>
          <div class="prop"><label>Case</label>${select('text-transform', [['', 'Normal'], ['uppercase', 'UPPERCASE'], ['lowercase', 'lowercase'], ['capitalize', 'Title Case']])}</div>
          <div class="prop"><label>Line height</label>${text('line-height')}</div>
          <div class="prop"><label>Letter spacing</label>${text('letter-spacing')}</div>
          <div class="prop full"><label>Text effect</label>${select('text-shadow', [['', 'None'], ['0 2px 8px rgba(0,0,0,.6)', 'Soft shadow'], ['0 0 12px currentColor, 0 0 32px currentColor', 'Neon glow'], ['2px 2px 0 #000', 'Hard drop'], ['0 0 2px #000, 0 0 2px #000, 0 0 2px #000', 'Outline']])}</div>
        </div>
      </div>
      <div class="insp-section">
        <div class="insp-title"><i class="icon-paint-bucket"></i>Background</div>
        <div class="prop full"><label>Colour</label>${colorInput('background-color')}</div>
        <div class="prop full"><label>Image</label><div class="row">
          <input class="input input-sm grow mono" data-prop="background-image" value="${esc(val('background-image'))}" placeholder="none">
          <button class="btn btn-sm" id="in-bgimg"><i class="icon-image"></i></button></div></div>
        <div class="prop-grid">
          <div class="prop"><label>Fit</label>${select('background-size', [['', 'Default'], ['cover', 'Cover'], ['contain', 'Contain'], ['auto', 'Tile']])}</div>
          <div class="prop"><label>Position</label>${select('background-position', [['', 'Default'], ['center', 'Center'], ['top', 'Top'], ['bottom', 'Bottom']])}</div>
        </div>
        <div class="prop full"><label>Presets</label>${select('background', [['', '—'], ['linear-gradient(135deg, #1e1b4b, #4c1d95)', 'Deep violet'], ['linear-gradient(135deg, #0f172a, #134e4a)', 'Night teal'], ['linear-gradient(180deg, #3b0a0a, #120202)', 'Blood'], ['radial-gradient(circle at 50% 30%, #3a2e1f, #120d07)', 'Candlelight'], ['rgba(255,255,255,0.06)', 'Glass'], ['rgba(0,0,0,0.55)', 'Dark veil']])}</div>
      </div>
      ${isContainer ? `<div class="insp-section">
        <div class="insp-title"><i class="icon-layout-dashboard"></i>Layout</div>
        <div class="prop-grid">
          <div class="prop"><label>Display</label>${select('display', [['', 'Default'], ['block', 'Block'], ['flex', 'Flex (row/column)'], ['grid', 'Grid'], ['none', 'Hidden']])}</div>
          <div class="prop"><label>Gap</label>${text('gap')}</div>
          <div class="prop"><label>Direction</label>${segment('flex-direction', [['row', 'icon-arrow-right', 'Row'], ['column', 'icon-arrow-down', 'Column']])}</div>
          <div class="prop"><label>Columns</label>${select('grid-template-columns', [['', 'Default'], ['1fr', '1'], ['1fr 1fr', '2 equal'], ['2fr 1fr', 'Wide + narrow'], ['1fr 2fr', 'Narrow + wide'], ['1fr 1fr 1fr', '3 equal'], ['repeat(4, 1fr)', '4 equal']])}</div>
          <div class="prop"><label>Justify</label>${select('justify-content', [['', 'Default'], ['flex-start', 'Start'], ['center', 'Center'], ['flex-end', 'End'], ['space-between', 'Space between'], ['space-around', 'Space around']])}</div>
          <div class="prop"><label>Align</label>${select('align-items', [['', 'Default'], ['stretch', 'Stretch'], ['flex-start', 'Start'], ['center', 'Center'], ['flex-end', 'End']])}</div>
        </div></div>` : ''}
      <div class="insp-section">
        <div class="insp-title"><i class="icon-box-select"></i>Spacing & size</div>
        <div class="prop full"><label>Padding (top · right · bottom · left)</label><div class="spacing-box">${['top', 'right', 'bottom', 'left'].map(s => `<input class="input input-sm" data-prop="padding-${s}" value="${esc(val(`padding-${s}`))}" placeholder="${ph(`padding-${s}`)}">`).join('')}</div></div>
        <div class="prop full"><label>Margin (top · right · bottom · left)</label><div class="spacing-box">${['top', 'right', 'bottom', 'left'].map(s => `<input class="input input-sm" data-prop="margin-${s}" value="${esc(val(`margin-${s}`))}" placeholder="${ph(`margin-${s}`)}">`).join('')}</div></div>
        <div class="prop-grid">
          <div class="prop"><label>Width</label>${text('width', 'auto')}</div>
          <div class="prop"><label>Height</label>${text('height', 'auto')}</div>
          <div class="prop"><label>Min height</label>${text('min-height', '')}</div>
          <div class="prop"><label>Max width</label>${text('max-width', '')}</div>
        </div>
      </div>
      <div class="insp-section">
        <div class="insp-title"><i class="icon-sparkles"></i>Border & effects</div>
        <div class="prop-grid">
          <div class="prop"><label>Corner radius</label>${text('border-radius')}</div>
          <div class="prop"><label>Opacity</label><input type="range" min="0" max="1" step="0.05" data-range="opacity" value="${esc(val('opacity') || comp.opacity || 1)}"></div>
          <div class="prop full"><label>Border</label>${text('border', 'e.g. 2px solid #f5b942')}</div>
          <div class="prop full"><label>Shadow</label>${select('box-shadow', [['', 'None'], ['0 8px 24px rgba(0,0,0,.35)', 'Soft'], ['0 20px 60px rgba(0,0,0,.6)', 'Deep'], ['0 0 30px var(--accent, #f5b942)', 'Glow (accent)'], ['inset 0 0 40px rgba(0,0,0,.6)', 'Inner vignette']])}</div>
        </div>
      </div>
      <div class="insp-section">
        <div class="prop full"><label>Extra CSS classes</label><input class="input input-sm mono" id="in-classes" value="${esc(otherClasses)}" placeholder="class-name another"></div>
        <button class="prop-reset" id="in-reset"><i class="icon-rotate-ccw"></i> Reset visual styles for this element</button>
      </div>`;

    wireInspector(n, sc);
  }

  function wireInspector(n, sc) {
    const right = $('#right');
    const id = T.selectedId;
    right.querySelectorAll('[data-prop]').forEach(el => {
      const ev = el.tagName === 'SELECT' ? 'change' : 'input';
      el.addEventListener(ev, () => {
        setStyle(id, el.dataset.prop, el.value);
        const picker = right.querySelector(`[data-color="${el.dataset.prop}"]`);
        if (picker && /^#[0-9a-f]{6}$/i.test(el.value)) picker.value = el.value;
      });
    });
    right.querySelectorAll('[data-color]').forEach(el => el.addEventListener('input', () => {
      setStyle(id, el.dataset.color, el.value);
      const txt = right.querySelector(`[data-prop="${el.dataset.color}"]`);
      if (txt) txt.value = el.value;
    }));
    right.querySelectorAll('[data-seg]').forEach(group => group.querySelectorAll('button').forEach(b => b.onclick = () => {
      const active = b.classList.contains('active');
      setStyle(id, group.dataset.seg, active ? '' : b.dataset.v);
      group.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b && !active));
    }));
    right.querySelectorAll('[data-range]').forEach(el => el.addEventListener('input', () => setStyle(id, el.dataset.range, el.value === '1' ? '' : el.value)));

    // content
    const txt = right.querySelector('#in-text');
    if (txt) {
      txt.addEventListener('input', () => {
        n.textContent = txt.value;
        docChanged();
        send('text', { id, text: txt.value });
        commitSoon('Edit text');
        updateStatus();
      });
      txt.addEventListener('change', () => { if (E.parseShortcode(txt.value)) reloadPreview(0); renderLayers(); });
    }
    if (sc) {
      right.querySelectorAll('[data-sc]').forEach(el => el.addEventListener('change', () => {
        const attrs = { ...sc.attrs };
        attrs[el.dataset.sc] = el.type === 'checkbox' ? String(el.checked) : el.value;
        const textNode = Array.from(n.childNodes).find(c => c.nodeType === 3 && c.textContent.includes(sc.raw));
        if (!textNode) return;
        const updated = E.buildShortcode(sc.name, attrs);
        textNode.textContent = textNode.textContent.replace(sc.raw, updated);
        sc.raw = updated;
        sc.attrs = attrs;
        docChanged();
        commit('Component setting');
        reloadPreview(0);
      }));
    }
    const src = right.querySelector('#in-src');
    if (src) src.addEventListener('change', () => { n.setAttribute('src', src.value); docChanged(); send('attr', { id, name: 'src', value: src.value }); commit('Change media'); });
    const alt = right.querySelector('#in-alt');
    if (alt) alt.addEventListener('change', () => { n.setAttribute('alt', alt.value); docChanged(); commit('Alt text'); });
    const pick = right.querySelector('#in-pick');
    if (pick) pick.onclick = async () => {
      const type = n.tagName === 'VIDEO' ? 'video' : 'image';
      const picked = await QC.pickMedia({ roomId: T.roomId, accept: `${type}/*`, types: [type] });
      if (!picked) return;
      n.setAttribute('src', picked.url);
      docChanged();
      send('attr', { id, name: 'src', value: picked.url });
      commit('Change media');
      renderInspector();
    };
    right.querySelector('#in-bgimg').onclick = async () => {
      const picked = await QC.pickMedia({ roomId: T.roomId, accept: 'image/*', types: ['image'], title: 'Background image' });
      if (!picked) return;
      setStyle(id, 'background-image', `url("${picked.url}")`);
      if (!getRule(id).get('background-size')) setStyle(id, 'background-size', 'cover');
      renderInspector();
    };
    right.querySelector('#in-classes').addEventListener('change', (e) => {
      const keep = Array.from(n.classList).filter(c => c.startsWith('qb-'));
      n.className = [...keep, ...e.target.value.split(/\s+/).filter(Boolean)].join(' ');
      docChanged();
      commit('Change classes');
      reloadPreview(0);
    });
    right.querySelector('#in-reset').onclick = () => clearStyles(id);
    right.querySelector('#in-dup').onclick = () => duplicateNode(id);
    right.querySelector('#in-del').onclick = () => removeNode(id);
    right.querySelector('#in-parent').onclick = () => {
      const p = n.parentElement;
      if (p && p !== T.doc.body && p.dataset.qb) { T.selectedId = p.dataset.qb; send('select', { id: p.dataset.qb }); }
    };
    right.querySelector('#in-html').onclick = async () => {
      const body = document.createElement('div');
      body.innerHTML = `<textarea class="textarea mono" rows="14" style="font-size:12.5px">${esc(stripIds(n.outerHTML))}</textarea><div class="hint mt-8">Edit this element's HTML directly. Shortcodes like <code>[timer]</code> are allowed.</div>`;
      const value = await modal({ title: 'Edit element HTML', size: 'lg', icon: 'icon-code', body, actions: [{ label: 'Cancel', value: null }, { label: 'Apply', variant: 'primary', onClick: () => body.querySelector('textarea').value }] });
      if (value === null || value === undefined) return;
      const tpl = T.doc.createElement('template');
      tpl.innerHTML = value.trim();
      const nodes = Array.from(tpl.content.childNodes);
      if (!nodes.length) return removeNode(id);
      nodes.forEach(x => { if (x.nodeType === 1) { assignIds(x); if (!x.dataset.qb) x.dataset.qb = `n${T.nextId++}`; } });
      const first = nodes.find(x => x.nodeType === 1);
      n.replaceWith(...nodes);
      structural('Edit HTML', first ? first.dataset.qb : null);
    };
  }

  /* ============================================================ code mode */
  function renderCodeLeft(left) {
    left.innerHTML = `
      <div class="code-panel">
        <div class="code-tabs">
          <button class="code-tab" data-file="html"><i class="icon-file-code"></i>index.html<span class="dot-mod"></span></button>
          <button class="code-tab" data-file="css"><i class="icon-paintbrush"></i>style.css<span class="dot-mod"></span></button>
          <button class="code-tab" data-file="js"><i class="icon-braces"></i>script.js<span class="dot-mod"></span></button>
        </div>
        <div class="code-host" id="code-host"></div>
        <div class="code-foot" id="code-foot"></div>
      </div>`;
    left.querySelectorAll('.code-tab').forEach(b => b.onclick = () => showFile(b.dataset.file));
    T.editors = {};
    showFile(T.codeFile);
  }

  function makeEditor(file) {
    const host = $('#code-host');
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:absolute;inset:0;';
    wrap.dataset.file = file;
    host.appendChild(wrap);
    const cm = CodeMirror(wrap, {
      value: T.draft[file] || '',
      mode: file === 'html' ? 'htmlmixed' : file === 'css' ? 'css' : 'javascript',
      theme: QC.uiTheme() === 'light' ? 'default' : 'material-darker',
      lineNumbers: true,
      lineWrapping: true,
      indentUnit: file === 'html' ? 4 : 2,
      tabSize: 4,
      autoCloseTags: file === 'html',
      autoCloseBrackets: true,
      matchBrackets: true,
      matchTags: file === 'html' ? { bothTags: true } : false,
      styleActiveLine: true,
      readOnly: T.protected ? 'nocursor' : false,
      extraKeys: {
        'Ctrl-S': () => save(), 'Cmd-S': () => save(),
        Tab: (c) => c.somethingSelected() ? c.indentSelection('add') : c.replaceSelection(' '.repeat(c.getOption('indentUnit')), 'end')
      }
    });
    cm.on('change', (inst, change) => {
      if (change.origin === 'setValue') return;
      T.draft[file] = inst.getValue();
      if (file === 'html') T.doc = null;
      if (file === 'css') pushCss(); else reloadPreview(700);
      commitSoon(`Edit ${file === 'html' ? 'index.html' : file === 'css' ? 'style.css' : 'script.js'}`);
      markModified();
      updateStatus();
    });
    T.editors[file] = { cm, wrap };
    return T.editors[file];
  }

  function showFile(file) {
    T.codeFile = file;
    $$('.code-tab').forEach(b => b.classList.toggle('active', b.dataset.file === file));
    Object.values(T.editors).forEach(ed => { ed.wrap.style.display = 'none'; });
    const ed = T.editors[file] || makeEditor(file);
    ed.wrap.style.display = '';
    ed.cm.refresh();
    ed.cm.focus();
    renderCodeFoot();
    markModified();
  }

  function markModified() {
    let saved = {};
    try { saved = JSON.parse(T.saved); } catch (_) { /* ignore */ }
    $$('.code-tab').forEach(b => b.classList.toggle('modified', T.draft[b.dataset.file] !== saved[b.dataset.file]));
  }

  function renderCodeFoot() {
    const foot = $('#code-foot');
    if (!foot) return;
    if (T.codeFile === 'html') {
      const codes = ['[timer showControls="false"]', '[secondary-timer]', '[hints]', '[chat]', '[media]', '[variables]', '[room-info field="name"]', '[room-info field="shortcode"]', '[notifications]'];
      foot.innerHTML = `<span class="tiny faint">Insert:</span>${codes.map(c => `<button class="chip" data-ins="${esc(c)}">${esc(c)}</button>`).join('')}`;
    } else if (T.codeFile === 'css') {
      const sels = ['.timer-display', '.hint-card', '.hint-overlay', '.chat-log', '.chat-input', '.lightbox', '.qc-overlay-card', ':root'];
      foot.innerHTML = `<span class="tiny faint">Selectors:</span>${sels.map(c => `<button class="chip" data-ins="${esc(c)} {\n  \n}\n">${esc(c)}</button>`).join('')}`;
    } else {
      foot.innerHTML = '<span class="tiny faint">Optional decorative scripts. <code>window.socket</code> is the live room connection; <code>window.playerApp</code> exposes room state.</span>';
    }
    foot.querySelectorAll('[data-ins]').forEach(b => b.onclick = () => {
      const ed = T.editors[T.codeFile];
      if (!ed || T.protected) return;
      ed.cm.replaceSelection(b.dataset.ins);
      ed.cm.focus();
    });
  }

  function syncEditors() {
    Object.entries(T.editors).forEach(([file, ed]) => {
      if (ed.cm.getValue() !== (T.draft[file] || '')) {
        const cur = ed.cm.getCursor();
        ed.cm.setValue(T.draft[file] || '');
        ed.cm.setCursor(cur);
      }
    });
    markModified();
  }
  function flushEditors() {
    Object.entries(T.editors).forEach(([file, ed]) => { T.draft[file] = ed.cm.getValue(); });
    T.doc = null;
    commitSoon.flush && commitSoon.flush('Edit code');
  }

  /* ============================================================== AI mode */
  const AI_SUGGESTIONS = [
    'Give this a 1920s detective noir look: sepia tones, typewriter font, film grain',
    'Make the timer huge and glowing neon red, centred at the top',
    'Put hints in a big card on the left and chat on the right',
    'Sci-fi spaceship control panel with cyan accents and scanlines',
    'Haunted Victorian manor: dark wood, candlelight glow, gothic headings',
    'Make everything easier to read from across the room'
  ];

  function renderAiLeft(left) {
    left.innerHTML = `
      <div class="ai-panel">
        <div class="ai-log" id="ai-log"></div>
        <div class="ai-input">
          <div class="ai-context" id="ai-context"></div>
          <textarea class="textarea" id="ai-text" rows="3" placeholder="Describe a change… e.g. “make the hints panel look like an old parchment scroll”" ${T.ai.configured ? '' : 'disabled'}></textarea>
          <div class="row">
            <span class="tiny faint grow" id="ai-model">${T.ai.configured ? esc(T.ai.model ? `Model: ${T.ai.model}` : 'Model: automatic') : ''}</span>
            <button class="btn btn-primary btn-sm" id="ai-send" ${T.ai.configured ? '' : 'disabled'}><i class="icon-sparkles"></i>Generate</button>
          </div>
        </div>
      </div>`;
    const ta = $('#ai-text');
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); askAi(); } });
    $('#ai-send').onclick = () => askAi();
    renderAiLog();
    updateAiContext();
  }

  function updateAiContext() {
    const host = $('#ai-context');
    if (!host) return;
    if (T.selectedId && T.selInfo) {
      host.innerHTML = `<i class="icon-crosshair"></i>Focused on <span class="badge badge-accent">${esc(T.selInfo.label)}</span><button class="btn btn-ghost btn-xs" id="ai-clear-ctx">clear</button>`;
      $('#ai-clear-ctx').onclick = () => { T.selectedId = null; T.selInfo = null; send('select', { id: null }); updateAiContext(); };
    } else {
      host.innerHTML = '<span class="tiny faint">Tip: select an element in Visual mode to focus the AI on it.</span>';
    }
  }

  function renderAiLog() {
    const log = $('#ai-log');
    if (!log) return;
    if (!T.ai.configured) {
      log.innerHTML = `
        <div class="ai-intro"><div class="big"><i class="icon-sparkles"></i></div><h3>AI theme assistant</h3>
          <p class="small mt-8">Describe the look you want and the assistant rewrites the theme's HTML and CSS for you. It uses OpenRouter – paste your API key to switch it on.</p></div>
        <div class="field"><label>OpenRouter API key</label><input class="input mono" id="ai-key" type="password" placeholder="sk-or-v1-…"><div class="hint">Stored on this server only. Get one at <a href="https://openrouter.ai/keys" target="_blank" rel="noopener">openrouter.ai/keys</a>.</div></div>
        <button class="btn btn-primary" id="ai-save-key"><i class="icon-key-round"></i>Save key</button>`;
      $('#ai-save-key').onclick = async (e) => {
        const key = $('#ai-key').value.trim();
        if (!key) return;
        e.currentTarget.classList.add('loading');
        try {
          await post('/api/v2/settings/ai/test', { apiKey: key });
          const s = await put('/api/v2/settings', { ai: { apiKey: key } });
          T.ai.configured = s.ai.configured;
          T.ai.model = s.ai.model;
          toast('AI assistant connected', 'success');
          renderLeft();
        } catch (err) { error(err); e.currentTarget.classList.remove('loading'); }
      };
      return;
    }
    if (!T.ai.messages.length) {
      log.innerHTML = `<div class="ai-intro"><div class="big"><i class="icon-sparkles"></i></div><h3>What should we change?</h3>
        <p class="small mt-8">Every result can be undone. Try one of these:</p>
        <div class="ai-suggestions">${AI_SUGGESTIONS.map(s => `<button data-sug="${esc(s)}">${esc(s)}</button>`).join('')}</div></div>`;
      log.querySelectorAll('[data-sug]').forEach(b => b.onclick = () => { $('#ai-text').value = b.dataset.sug; askAi(); });
      return;
    }
    log.innerHTML = T.ai.messages.map((m, i) => {
      if (m.role === 'user') return `<div class="ai-msg user">${esc(m.text)}</div>`;
      if (m.role === 'error') return `<div class="ai-msg error"><i class="icon-circle-x"></i> ${esc(m.text)}</div>`;
      if (m.role === 'thinking') return `<div class="ai-thinking"><span class="dots"><span></span><span></span><span></span></span>Designing… <span id="ai-elapsed">0s</span></div>`;
      const files = Object.keys(m.files || {});
      return `<div class="ai-msg assistant">${esc(m.text || 'Done.')}
        ${files.length ? `<div class="files">${files.map(f => `<span class="badge">${f === 'html' ? 'index.html' : f === 'css' ? 'style.css' : 'script.js'}</span>`).join('')}</div>` : '<div class="files"><span class="badge">No file changes</span></div>'}
        <div class="meta">${m.model ? `<span>${esc(m.model)}</span>` : ''}${m.ms ? `<span>${(m.ms / 1000).toFixed(1)}s</span>` : ''}${m.truncated ? '<span style="color:var(--warning)">Response was cut short – check the result</span>' : ''}
        ${m.before !== undefined ? `<button class="btn btn-ghost btn-xs" data-revert="${i}"><i class="icon-undo-2"></i>Undo this</button>` : ''}</div></div>`;
    }).join('');
    log.querySelectorAll('[data-revert]').forEach(b => b.onclick = () => {
      const m = T.ai.messages[+b.dataset.revert];
      restore(m.before);
      commit('Revert AI change');
      toast('Reverted to before that change', 'info');
    });
    log.scrollTop = log.scrollHeight;
  }

  async function askAi(textOverride) {
    if (T.ai.busy) return;
    const ta = $('#ai-text');
    const instruction = (textOverride || (ta && ta.value) || '').trim();
    if (!instruction) return;
    if (T.protected) return toast('Duplicate this starter theme before changing it (press Save)', 'warning');
    if (ta) ta.value = '';
    T.ai.busy = true;
    T.ai.messages.push({ role: 'user', text: instruction });
    T.ai.messages.push({ role: 'thinking' });
    renderAiLog();
    const started = Date.now();
    const tick = setInterval(() => { const el = $('#ai-elapsed'); if (el) el.textContent = `${Math.round((Date.now() - started) / 1000)}s`; }, 1000);
    const btn = $('#ai-send');
    if (btn) btn.classList.add('loading');

    let selection = null;
    if (T.selectedId) {
      const n = node(T.selectedId);
      if (n) {
        const cls = Array.from(n.classList).join('.');
        selection = { selector: `${T.selInfo ? T.selInfo.label : n.tagName.toLowerCase()} (${n.tagName.toLowerCase()}${cls ? '.' + cls : ''})`, snippet: stripIds(n.outerHTML).slice(0, 1500) };
      }
    }
    const history = T.ai.messages.filter(m => m.role === 'user' || m.role === 'assistant').slice(-7, -1).map(m => ({ role: m.role, content: m.role === 'user' ? m.text : (m.text || 'Done.') }));
    const before = snapshot();
    try {
      const room = T.rooms.find(r => r.id === T.roomId);
      const res = await post('/api/v2/ai/theme', { instruction, html: T.draft.html, css: T.draft.css, js: T.draft.js, history, selection, roomName: room && room.name });
      T.ai.messages.pop();
      const changedFiles = Object.keys(res.files || {});
      if (changedFiles.length) {
        changedFiles.forEach(k => { T.draft[k] = res.files[k]; });
        T.doc = null;
        commit(`AI: ${instruction.slice(0, 40)}`);
        syncEditors();
        reloadPreview(0);
      }
      T.ai.messages.push({ role: 'assistant', text: res.summary, files: res.files, model: res.model, ms: res.ms, truncated: res.truncated, before: changedFiles.length ? before : undefined });
    } catch (err) {
      T.ai.messages.pop();
      T.ai.messages.push({ role: 'error', text: err.message });
    }
    clearInterval(tick);
    T.ai.busy = false;
    renderAiLog();
    if ($('#ai-send')) $('#ai-send').classList.remove('loading');
    updateStatus();
  }

  /* =============================================================== saving */
  async function save() {
    if (T.mode === 'code') flushEditors();
    if (T.protected) return saveAsCopy();
    const btn = $('#save-btn');
    btn.classList.add('loading');
    setStatus('Saving…');
    try {
      const name = $('#theme-name').value.trim() || T.slug;
      await put(`/api/v2/themes/${T.slug}`, { html: T.draft.html, css: T.draft.css, js: T.draft.js, config: { name } });
      T.saved = JSON.stringify(snapshot());
      T.config.name = name;
      markModified();
      updateStatus();
      toast('Theme saved – player screens using it are refreshing', 'success');
    } catch (err) {
      error(err);
      updateStatus();
    }
    btn.classList.remove('loading');
  }

  async function saveAsCopy() {
    const name = await prompt({ title: 'Save as a new theme', label: 'The starter theme is read-only. Name your copy:', value: `${T.config.name || T.slug} custom`, confirmText: 'Create copy' });
    if (!name) return;
    try {
      const created = await post(`/api/v2/themes/${T.slug}/duplicate`, { name });
      await put(`/api/v2/themes/${created.slug}`, { html: T.draft.html, css: T.draft.css, js: T.draft.js });
      T.saved = JSON.stringify(snapshot());
      location.replace(`/theme-builder/${created.slug}${T.roomId ? `?room=${T.roomId}` : ''}#${T.mode}`);
    } catch (err) { error(err); }
  }

  $('#save-btn').onclick = save;
  $('#theme-name').addEventListener('change', () => { if (!T.protected) save(); });

  $('#apply-btn').onclick = (e) => {
    if (!T.rooms.length) return toast('Create a room first', 'warning');
    menu(e.currentTarget, T.rooms.map(r => ({
      label: `${r.name}${r.theme === T.slug ? ' ✓' : ''}`,
      icon: 'icon-door-open',
      onClick: async () => {
        if (T.protected && T.slug !== 'boilerplate') return;
        if (isDirty() && !T.protected) await save();
        try {
          await put(`/api/v2/rooms/${r.id}`, { theme: T.slug });
          r.theme = T.slug;
          toast(`“${r.name}” now uses this theme`, 'success');
        } catch (err) { error(err); }
      }
    })));
  };

  window.addEventListener('beforeunload', (e) => { if (isDirty()) { e.preventDefault(); e.returnValue = ''; } });

  QC.hotkeys({
    'mod+s': save,
    'mod+z': () => { if (T.mode !== 'code') undo(); },
    'mod+shift+z': () => { if (T.mode !== 'code') redo(); },
    'mod+y': () => { if (T.mode !== 'code') redo(); },
    'delete': () => { if (T.mode === 'visual' && T.selectedId) removeNode(T.selectedId); },
    'escape': () => { if (T.mode === 'visual') { T.selectedId = null; send('select', { id: null }); } }
  });

  /* ================================================================= boot */
  (async function boot() {
    let theme;
    try {
      [theme, T.rooms] = await Promise.all([get(`/api/v2/themes/${encodeURIComponent(T.slug)}`), get('/api/v2/rooms')]);
    } catch (err) {
      document.querySelector('.tb').innerHTML = `<div class="empty" style="grid-column:1/-1"><div class="empty-icon"><i class="icon-palette"></i></div><h3>Theme not found</h3><p>${esc(err.message)}</p><a class="btn" href="/#themes">Back to themes</a></div>`;
      return;
    }
    try {
      const s = await get('/api/v2/settings');
      T.ai.configured = s.ai.configured;
      T.ai.model = s.ai.model;
    } catch (_) { /* ignore */ }

    T.protected = !!theme.protected;
    T.config = theme.config || {};
    T.draft = { html: theme.html, css: theme.css, js: theme.js };
    T.saved = JSON.stringify(snapshot());
    T.history = [{ ...snapshot(), label: 'Opened' }];
    document.title = `${T.config.name || T.slug} · Theme Builder`;
    $('#theme-name').value = T.config.name || T.slug;
    $('#theme-name').readOnly = T.protected;
    $('#theme-badge').hidden = !T.protected;
    if (T.protected) $('#save-btn').innerHTML = '<i class="icon-copy"></i>Save as copy';

    const usingRoom = T.rooms.find(r => r.theme === T.slug);
    if (!T.roomId || !T.rooms.some(r => r.id === T.roomId)) T.roomId = (usingRoom || T.rooms[0] || {}).id || null;
    const roomSel = $('#preview-room');
    roomSel.innerHTML = T.rooms.length
      ? T.rooms.map(r => `<option value="${esc(r.id)}" ${r.id === T.roomId ? 'selected' : ''}>Preview: ${esc(r.name)}</option>`).join('')
      : '<option value="">Create a room to preview</option>';
    if (!T.roomId) {
      $('#preview-stage').insertAdjacentHTML('beforeend', '<div class="empty" style="position:absolute;inset:0"><p>Previews use a room\'s live data. <a href="/">Create a room</a> first.</p></div>');
    }

    const startMode = ['visual', 'code', 'ai'].includes(location.hash.slice(1)) ? location.hash.slice(1) : (params.get('ai') ? 'ai' : 'visual');
    T.mode = '';
    setMode(startMode);
    fitDevice();
    updateStatus();
    updateUndo();

    if (params.get('ai') && T.ai.configured) {
      const prompt0 = params.get('ai');
      history.replaceState(null, '', location.pathname + (T.roomId ? `?room=${T.roomId}` : '') + '#ai');
      setTimeout(() => askAi(`Restyle this theme: ${prompt0}`), 400);
    }
  })();
})();
