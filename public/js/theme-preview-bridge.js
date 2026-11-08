/* Runs INSIDE the theme builder's preview iframe.
   - highlights / selects source elements (anything with data-qb)
   - shows an element toolbar (parent, move, duplicate, delete)
   - computes drop positions for palette drags and element moves
   - applies CSS instantly when the builder sends it
   Talks to the parent window with postMessage ({ source: 'qb', type, ... }). */
(function () {
  'use strict';
  if (window.__qbBridge) return;
  window.__qbBridge = true;

  const parentWin = window.parent;
  const origin = location.origin;
  let mode = 'visual';
  let selectedId = null;
  let moving = null;
  let lastDrop = null;

  function post(type, data = {}) {
    parentWin.postMessage({ source: 'qb', type, ...data }, origin);
  }

  /* ------------------------------------------------------------- overlay UI */
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646;';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      .box { position: fixed; pointer-events: none; border-radius: 3px; transition: all .05s; display: none; }
      .hover { outline: 2px dashed rgba(139,124,246,.9); outline-offset: -1px; }
      .sel { outline: 2px solid #8b7cf6; outline-offset: -1px; box-shadow: 0 0 0 9999px rgba(10,10,20,.12); }
      .label { position: fixed; display: none; font: 600 11px/1 system-ui, sans-serif; color: #fff; background: #8b7cf6; padding: 4px 6px; border-radius: 4px; pointer-events: none; white-space: nowrap; }
      .tools { position: fixed; display: none; gap: 2px; background: #1d222d; border: 1px solid #353d4e; border-radius: 7px; padding: 3px; pointer-events: auto; box-shadow: 0 6px 20px rgba(0,0,0,.4); }
      .tools button { width: 26px; height: 26px; border: 0; border-radius: 5px; background: none; color: #e9ebf1; cursor: pointer; font: 14px/1 system-ui, sans-serif; display: grid; place-items: center; }
      .tools button:hover { background: #8b7cf6; }
      .tools button.danger:hover { background: #f2555a; }
      .tools .grip { cursor: grab; }
      .drop { position: fixed; display: none; pointer-events: none; background: #3ecf8e; border-radius: 3px; box-shadow: 0 0 0 2px rgba(62,207,142,.35); }
      .drop.inside { background: rgba(62,207,142,.18); outline: 2px dashed #3ecf8e; box-shadow: none; }
      svg { width: 15px; height: 15px; stroke: currentColor; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    </style>
    <div class="box hover"></div>
    <div class="box sel"></div>
    <div class="label"></div>
    <div class="drop"></div>
    <div class="tools">
      <button class="grip" data-a="move" title="Drag to move"><svg viewBox="0 0 24 24"><circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/></svg></button>
      <button data-a="parent" title="Select parent"><svg viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"/></svg></button>
      <button data-a="up" title="Move earlier"><svg viewBox="0 0 24 24"><path d="m18 15-6-6-6 6"/></svg></button>
      <button data-a="down" title="Move later"><svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg></button>
      <button data-a="duplicate" title="Duplicate"><svg viewBox="0 0 24 24"><rect x="8" y="8" width="13" height="13" rx="2"/><path d="M4 16V4a2 2 0 0 1 2-2h12"/></svg></button>
      <button class="danger" data-a="delete" title="Delete"><svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg></button>
    </div>`;
  const $ = (s) => shadow.querySelector(s);
  const hoverBox = $('.hover');
  const selBox = $('.sel');
  const label = $('.label');
  const tools = $('.tools');
  const dropBox = $('.drop');

  function attach() { if (!host.isConnected) document.documentElement.appendChild(host); }
  if (document.body) attach(); else document.addEventListener('DOMContentLoaded', attach);

  function byId(id) { return id ? document.querySelector(`[data-qb="${CSS.escape(id)}"]`) : null; }
  function qbOf(el) {
    while (el && el.nodeType === 1) {
      if (el.dataset && el.dataset.qb && el !== document.body) return el;
      el = el.parentElement;
    }
    return null;
  }

  function place(box, el) {
    if (!el) { box.style.display = 'none'; return; }
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { display: 'block', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  }

  function describe(el) {
    const cls = Array.from(el.classList).filter(c => !c.startsWith('qb-')).slice(0, 2);
    const comp = componentOf(el);
    return comp ? comp.label : `${el.tagName.toLowerCase()}${cls.length ? '.' + cls.join('.') : ''}`;
  }

  const COMPONENTS = [
    ['.timer-component', 'Timer'], ['.secondary-timer-component', 'Secondary timer'], ['.hints-component', 'Hints'],
    ['.chat-component', 'Chat'], ['.media-component', 'Media lightbox'], ['.variables-component', 'Variables'],
    ['.room-info-component', 'Room info'], ['.game-state-component', 'Game state'], ['.notifications-component', 'Notifications']
  ];
  function componentOf(el) {
    // A source element that only wraps a shortcode component
    const children = Array.from(el.children).filter(c => !c.dataset.qb);
    for (const [sel, name] of COMPONENTS) {
      if (el.matches(sel) || (children.length && children.every(c => c.matches(sel) || c.tagName === 'SCRIPT' || c.style.display === 'none') && el.querySelector(sel))) {
        return { selector: sel, label: name };
      }
    }
    return null;
  }

  function refresh() {
    const sel = byId(selectedId);
    place(selBox, sel);
    if (sel && mode === 'visual') {
      const r = sel.getBoundingClientRect();
      label.textContent = describe(sel);
      label.style.display = 'block';
      label.style.left = `${Math.max(2, r.left)}px`;
      label.style.top = `${r.top > 24 ? r.top - 22 : r.bottom + 4}px`;
      tools.style.display = 'flex';
      const tw = 180;
      tools.style.left = `${Math.max(2, Math.min(innerWidth - tw, r.right - tw))}px`;
      tools.style.top = `${r.top > 34 ? r.top - 34 : Math.min(innerHeight - 34, r.bottom + 4)}px`;
    } else {
      label.style.display = 'none';
      tools.style.display = 'none';
    }
  }

  function info(el) {
    const cs = getComputedStyle(el);
    const pick = ['color', 'background-color', 'font-family', 'font-size', 'font-weight', 'text-align', 'line-height', 'letter-spacing',
      'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'margin-top', 'margin-bottom', 'display', 'flex-direction',
      'justify-content', 'align-items', 'gap', 'width', 'height', 'border-radius', 'border-top-width', 'border-top-color', 'opacity', 'text-transform'];
    const computed = {};
    pick.forEach(p => { computed[p] = cs.getPropertyValue(p); });
    const r = el.getBoundingClientRect();
    return { id: el.dataset.qb, tag: el.tagName.toLowerCase(), label: describe(el), component: componentOf(el), computed, rect: { w: Math.round(r.width), h: Math.round(r.height) } };
  }

  function select(id, { notify = true, scroll = false } = {}) {
    selectedId = id;
    const el = byId(id);
    if (el && scroll) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    refresh();
    if (notify) post('select', el ? info(el) : { id: null });
  }

  /* ----------------------------------------------------------- interaction */
  document.addEventListener('mousemove', (e) => {
    if (mode !== 'visual' || moving) return;
    const el = qbOf(e.target);
    place(hoverBox, el && el.dataset.qb !== selectedId ? el : null);
  }, true);
  document.addEventListener('mouseleave', () => place(hoverBox, null));

  document.addEventListener('click', (e) => {
    if (mode !== 'visual') return;
    if (e.composedPath().includes(host)) return;
    e.preventDefault();
    e.stopPropagation();
    const el = qbOf(e.target);
    select(el ? el.dataset.qb : null);
  }, true);

  // Block form submits / typing in theme inputs while editing visually
  ['submit', 'keypress'].forEach(t => document.addEventListener(t, (e) => { if (mode === 'visual' && !e.composedPath().includes(host)) e.stopPropagation(); }, true));

  document.addEventListener('keydown', (e) => {
    if (mode !== 'visual') return;
    if (e.key === 'Escape') { select(null); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) { e.preventDefault(); post('action', { action: 'delete', id: selectedId }); return; }
    if ((e.ctrlKey || e.metaKey) && ['z', 'y', 's', 'd'].includes(e.key.toLowerCase())) {
      e.preventDefault();
      post('key', { key: e.key.toLowerCase(), shift: e.shiftKey });
    }
  }, true);

  tools.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.dataset.a === 'move') return;
    if (b.dataset.a === 'parent') {
      const el = byId(selectedId);
      const p = el && qbOf(el.parentElement);
      if (p) select(p.dataset.qb);
      return;
    }
    post('action', { action: b.dataset.a, id: selectedId });
  });

  window.addEventListener('scroll', refresh, true);
  window.addEventListener('resize', refresh);
  setInterval(() => { if (selectedId) refresh(); }, 500); // timer text etc. can change layout

  /* ------------------------------------------------------- drop targeting */
  const CONTAINER_TAGS = new Set(['DIV', 'SECTION', 'MAIN', 'HEADER', 'FOOTER', 'ASIDE', 'NAV', 'ARTICLE', 'BODY']);

  function dropTarget(x, y, exclude) {
    host.style.display = 'none';
    let el = document.elementFromPoint(x, y);
    host.style.display = '';
    el = qbOf(el) || (el && el.closest('body') ? document.body : null);
    if (exclude) {
      while (el && (el === exclude || exclude.contains(el))) el = qbOf(el.parentElement) || null;
    }
    if (!el) return null;
    if (el === document.body) return { el, id: '__body__', position: 'inside' };
    const r = el.getBoundingClientRect();
    const isContainer = CONTAINER_TAGS.has(el.tagName) && !componentOf(el);
    const horizontal = (() => {
      const p = el.parentElement && getComputedStyle(el.parentElement);
      return p && ((p.display.includes('flex') && !p.flexDirection.startsWith('column')) || p.display.includes('grid'));
    })();
    const rel = horizontal ? (x - r.left) / r.width : (y - r.top) / r.height;
    let position;
    if (isContainer && rel > 0.25 && rel < 0.75) position = 'inside';
    else position = rel < 0.5 ? 'before' : 'after';
    return { el, id: el.dataset.qb, position, horizontal };
  }

  function showDrop(t) {
    if (!t) { dropBox.style.display = 'none'; return; }
    const r = t.el.getBoundingClientRect();
    dropBox.className = `drop ${t.position === 'inside' ? 'inside' : ''}`;
    dropBox.style.display = 'block';
    if (t.position === 'inside') {
      Object.assign(dropBox.style, { left: `${r.left + 3}px`, top: `${r.top + 3}px`, width: `${r.width - 6}px`, height: `${r.height - 6}px` });
    } else if (t.horizontal) {
      const x = t.position === 'before' ? r.left - 2 : r.right - 2;
      Object.assign(dropBox.style, { left: `${x}px`, top: `${r.top}px`, width: '4px', height: `${r.height}px` });
    } else {
      const y = t.position === 'before' ? r.top - 2 : r.bottom - 2;
      Object.assign(dropBox.style, { left: `${r.left}px`, top: `${y}px`, width: `${r.width}px`, height: '4px' });
    }
  }

  // Palette drags come from the parent document (HTML5 DnD)
  document.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('text/qb-new')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    lastDrop = dropTarget(e.clientX, e.clientY);
    showDrop(lastDrop);
  });
  document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) showDrop(null); });
  document.addEventListener('drop', (e) => {
    const kind = e.dataTransfer.getData('text/qb-new');
    if (!kind) return;
    e.preventDefault();
    showDrop(null);
    const t = dropTarget(e.clientX, e.clientY) || lastDrop;
    if (t) post('drop', { kind, targetId: t.id, position: t.position });
  });

  // Moving an existing element with the toolbar grip
  tools.querySelector('[data-a="move"]').addEventListener('pointerdown', (e) => {
    const el = byId(selectedId);
    if (!el) return;
    e.preventDefault();
    moving = el;
    el.style.opacity = '0.35';
    tools.style.display = 'none';
    label.style.display = 'none';
    const onMove = (ev) => { lastDrop = dropTarget(ev.clientX, ev.clientY, el); showDrop(lastDrop); };
    const onUp = (ev) => {
      document.removeEventListener('pointermove', onMove, true);
      document.removeEventListener('pointerup', onUp, true);
      el.style.opacity = '';
      showDrop(null);
      const t = dropTarget(ev.clientX, ev.clientY, el);
      moving = null;
      if (t && t.id !== selectedId) post('move', { id: selectedId, targetId: t.id, position: t.position });
      else refresh();
    };
    document.addEventListener('pointermove', onMove, true);
    document.addEventListener('pointerup', onUp, true);
  });

  /* ---------------------------------------------------- messages from parent */
  window.addEventListener('message', (e) => {
    if (e.origin !== origin || !e.data || e.data.source !== 'qb-parent') return;
    const d = e.data;
    switch (d.type) {
      case 'css': {
        let style = document.getElementById('qb-theme-css');
        if (!style) { style = document.createElement('style'); style.id = 'qb-theme-css'; document.head.appendChild(style); }
        style.textContent = d.css;
        requestAnimationFrame(refresh);
        break;
      }
      case 'select': select(d.id, { notify: d.notify !== false, scroll: true }); break;
      case 'mode':
        mode = d.mode;
        if (mode !== 'visual') { place(hoverBox, null); }
        refresh();
        break;
      case 'class': {
        const el = byId(d.id);
        if (el) { if (d.add) el.classList.add(d.add); if (d.remove) el.classList.remove(d.remove); }
        break;
      }
      case 'text': {
        const el = byId(d.id);
        if (el) { el.textContent = d.text; refresh(); }
        break;
      }
      case 'attr': {
        const el = byId(d.id);
        if (el) { if (d.value === null) el.removeAttribute(d.name); else el.setAttribute(d.name, d.value); refresh(); }
        break;
      }
      case 'info': {
        const el = byId(d.id);
        if (el) post('select', info(el));
        break;
      }
    }
  });

  window.addEventListener('load', () => {
    post('ready', { scrollHeight: document.documentElement.scrollHeight });
  });
})();
