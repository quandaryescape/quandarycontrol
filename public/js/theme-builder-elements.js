/* Theme Builder building blocks: palette items, shortcode schemas, and the
   visual-editor managed CSS block. */
(function () {
  'use strict';

  const MANAGED_START = '/* === qb:visual-start === */';
  const MANAGED_END = '/* === qb:visual-end === */';

  function qbClass() {
    return `qb-${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * Each palette item returns { html, styles: { [className]: {prop: value} } }.
   * Classes beginning with qb- carry the visual editor's styles.
   */
  const PALETTE = [
    { group: 'Layout', items: [
      { kind: 'section', label: 'Section', icon: 'icon-square', build() { const c = qbClass(); return { html: `<section class="${c}"></section>`, styles: { [c]: { display: 'flex', 'flex-direction': 'column', gap: '16px', padding: '24px', 'min-height': '80px' } } }; } },
      { kind: 'row', label: 'Row', icon: 'icon-columns-3', build() { const c = qbClass(); return { html: `<div class="${c}"></div>`, styles: { [c]: { display: 'flex', gap: '16px', 'align-items': 'center', 'min-height': '60px' } } }; } },
      { kind: 'cols2', label: '2 columns', icon: 'icon-columns-2', build() {
        const c = qbClass(), a = qbClass(), b = qbClass();
        return { html: `<div class="${c}">\n  <div class="${a}"></div>\n  <div class="${b}"></div>\n</div>`, styles: { [c]: { display: 'grid', 'grid-template-columns': '1fr 1fr', gap: '24px' }, [a]: { 'min-height': '80px' }, [b]: { 'min-height': '80px' } } };
      } },
      { kind: 'cols3', label: '3 columns', icon: 'icon-layout-grid', build() {
        const c = qbClass(), a = qbClass(), b = qbClass(), d = qbClass();
        return { html: `<div class="${c}">\n  <div class="${a}"></div>\n  <div class="${b}"></div>\n  <div class="${d}"></div>\n</div>`, styles: { [c]: { display: 'grid', 'grid-template-columns': '1fr 1fr 1fr', gap: '24px' }, [a]: { 'min-height': '80px' }, [b]: { 'min-height': '80px' }, [d]: { 'min-height': '80px' } } };
      } },
      { kind: 'card', label: 'Card', icon: 'icon-panel-top', build() { const c = qbClass(); return { html: `<div class="${c}"></div>`, styles: { [c]: { padding: '24px', 'border-radius': '18px', 'background-color': 'rgba(255, 255, 255, 0.06)', border: '1px solid rgba(255, 255, 255, 0.12)', 'min-height': '80px' } } }; } },
      { kind: 'spacer', label: 'Spacer', icon: 'icon-move-vertical', build() { const c = qbClass(); return { html: `<div class="${c}"></div>`, styles: { [c]: { height: '40px' } } }; } },
      { kind: 'divider', label: 'Divider', icon: 'icon-minus', build() { const c = qbClass(); return { html: `<hr class="${c}">`, styles: { [c]: { border: '0', 'border-top': '2px solid currentColor', opacity: '0.25', margin: '16px 0' } } }; } }
    ] },
    { group: 'Content', items: [
      { kind: 'heading', label: 'Heading', icon: 'icon-heading', build() { const c = qbClass(); return { html: `<h2 class="${c}">Your heading</h2>`, styles: { [c]: { margin: '0', 'font-size': '48px', 'font-weight': '800' } } }; } },
      { kind: 'text', label: 'Text', icon: 'icon-text', build() { const c = qbClass(); return { html: `<p class="${c}">Write something for your players here.</p>`, styles: { [c]: { margin: '0', 'font-size': '22px', 'line-height': '1.5' } } }; } },
      { kind: 'image', label: 'Image', icon: 'icon-image', needsMedia: 'image', build(url) { const c = qbClass(); return { html: `<img class="${c}" src="${url}" alt="">`, styles: { [c]: { 'max-width': '100%', height: 'auto', display: 'block' } } }; } },
      { kind: 'video', label: 'Video', icon: 'icon-video', needsMedia: 'video', build(url) { const c = qbClass(); return { html: `<video class="${c}" src="${url}" autoplay muted loop playsinline></video>`, styles: { [c]: { width: '100%', display: 'block', 'border-radius': '12px' } } }; } },
      { kind: 'roomName', label: 'Room name', icon: 'icon-type', build() { const c = qbClass(); return { html: `<h1 class="${c}">[room-info field="name"]</h1>`, styles: { [c]: { margin: '0', 'font-size': '56px', 'text-align': 'center' } } }; } },
      { kind: 'roomCode', label: 'Room code', icon: 'icon-hash', build() { const c = qbClass(); return { html: `<div class="${c}">Join code: [room-info field="shortcode"]</div>`, styles: { [c]: { 'font-size': '20px', opacity: '0.7' } } }; } }
    ] },
    { group: 'Live components', items: [
      { kind: 'timer', label: 'Timer', icon: 'icon-timer', component: true, build() { const c = qbClass(); return { html: `<div class="${c}">[timer showControls="false" connection_status="false"]</div>`, styles: { [c]: { 'text-align': 'center', 'font-size': '120px', 'font-weight': '800' } } }; } },
      { kind: 'secondaryTimer', label: '2nd timer', icon: 'icon-hourglass', component: true, build() { const c = qbClass(); return { html: `<div class="${c}">[secondary-timer]</div>`, styles: { [c]: { 'text-align': 'center', 'font-size': '56px' } } }; } },
      { kind: 'hints', label: 'Hints', icon: 'icon-lightbulb', component: true, build() { const c = qbClass(); return { html: `<div class="${c}">[hints maxHints="10"]</div>`, styles: { [c]: { 'font-size': '26px' } } }; } },
      { kind: 'chat', label: 'Chat', icon: 'icon-messages-square', component: true, build() { const c = qbClass(); return { html: `<div class="${c}">[chat]</div>`, styles: { [c]: { 'min-height': '200px' } } }; } },
      { kind: 'variables', label: 'Variables', icon: 'icon-variable', component: true, build() { const c = qbClass(); return { html: `<div class="${c}">[variables]</div>`, styles: {} }; } },
      { kind: 'media', label: 'Media pop-up', icon: 'icon-monitor-play', component: true, single: '[media', build() { const c = qbClass(); return { html: `<div class="${c}">[media]</div>`, styles: {} }; } },
      { kind: 'notifications', label: 'Sound toggle', icon: 'icon-volume-2', component: true, build() { const c = qbClass(); return { html: `<div class="${c}">[notifications showControls="true" showStatus="false"]</div>`, styles: {} }; } }
    ] }
  ];

  const ITEMS = {};
  PALETTE.forEach(g => g.items.forEach(i => { ITEMS[i.kind] = i; }));

  /** Editable shortcode attributes. */
  const SHORTCODES = {
    timer: { label: 'Timer', attrs: [
      { name: 'showControls', label: 'Show controls', type: 'bool', default: 'true' },
      { name: 'connection_status', label: 'Show status badge', type: 'bool', default: 'true' }
    ] },
    'secondary-timer': { label: 'Secondary timer', attrs: [] },
    hints: { label: 'Hints', attrs: [
      { name: 'maxHints', label: 'Hints kept', type: 'number', default: '10' },
      { name: 'display', label: 'Style', type: 'select', options: [['default', 'Card'], ['ticker', 'News ticker']], default: 'default' },
      { name: 'hints_header', label: 'Show “Hints” heading', type: 'bool', default: 'true' }
    ] },
    chat: { label: 'Chat', attrs: [
      { name: 'maxMessages', label: 'Messages kept', type: 'number', default: '50' },
      { name: 'allowUserInput', label: 'Players can reply', type: 'bool', default: 'true' },
      { name: 'showTimestamps', label: 'Timestamps', type: 'bool', default: 'true' }
    ] },
    'room-info': { label: 'Room info', attrs: [
      { name: 'field', label: 'Show', type: 'select', options: [['', 'Name + code block'], ['name', 'Room name only'], ['shortcode', 'Room code only']], default: '' }
    ] },
    notifications: { label: 'Sound toggle', attrs: [
      { name: 'showControls', label: 'Show buttons', type: 'bool', default: 'true' },
      { name: 'showStatus', label: 'Show status text', type: 'bool', default: 'true' }
    ] },
    media: { label: 'Media pop-up', attrs: [] },
    variables: { label: 'Variables', attrs: [] },
    'game-state': { label: 'Game state', attrs: [] }
  };

  const SHORTCODE_RX = /\[([a-z]+(?:-[a-z]+)*)((?:\s+[\w-]+=["'][^"']*["'])*)\s*\]/;

  function parseShortcode(text) {
    const m = SHORTCODE_RX.exec(text || '');
    if (!m || !SHORTCODES[m[1]]) return null;
    const attrs = {};
    const rx = /([\w-]+)=["']([^"']*)["']/g;
    let a;
    while ((a = rx.exec(m[2])) !== null) attrs[a[1]] = a[2];
    return { name: m[1], attrs, raw: m[0] };
  }

  function buildShortcode(name, attrs) {
    const parts = Object.entries(attrs).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${k}="${String(v).replace(/"/g, '')}"`);
    return `[${name}${parts.length ? ' ' + parts.join(' ') : ''}]`;
  }

  /* --------------------------------------------------- managed CSS block */
  function parseManaged(css) {
    css = css || '';
    const s = css.indexOf(MANAGED_START);
    const e = css.indexOf(MANAGED_END);
    const rules = new Map();
    if (s === -1 || e === -1 || e < s) return { before: css, after: '', rules, has: false };
    const body = css.slice(s + MANAGED_START.length, e);
    const rx = /\.(qb-[a-z0-9]+)\s*\{([^}]*)\}/g;
    let m;
    while ((m = rx.exec(body)) !== null) {
      const props = new Map();
      m[2].split(';').forEach(decl => {
        const i = decl.indexOf(':');
        if (i === -1) return;
        const k = decl.slice(0, i).trim();
        const v = decl.slice(i + 1).trim();
        if (k && v) props.set(k, v);
      });
      rules.set(m[1], props);
    }
    return { before: css.slice(0, s), after: css.slice(e + MANAGED_END.length), rules, has: true };
  }

  function serializeManaged(parsed) {
    const blocks = [];
    for (const [cls, props] of parsed.rules) {
      if (!props.size) continue;
      blocks.push(`.${cls} {\n${[...props].map(([k, v]) => `  ${k}: ${v};`).join('\n')}\n}`);
    }
    const managed = `${MANAGED_START}\n/* Styles set in the Visual editor. Safe to edit by hand. */\n${blocks.join('\n\n')}\n${MANAGED_END}`;
    if (parsed.has) return `${parsed.before}${managed}${parsed.after}`;
    const before = parsed.before.replace(/\s*$/, '');
    return `${before}${before ? '\n\n' : ''}${managed}\n`;
  }

  /** Top-level :root custom properties (theme variables) outside the managed block. */
  function rootVariables(css) {
    const vars = [];
    const rootRx = /:root\s*\{([^}]*)\}/g;
    let m;
    while ((m = rootRx.exec(css || '')) !== null) {
      const declRx = /(--[\w-]+)\s*:\s*([^;]+);/g;
      let d;
      while ((d = declRx.exec(m[1])) !== null) {
        if (!vars.some(v => v.name === d[1])) vars.push({ name: d[1], value: d[2].trim() });
      }
    }
    return vars;
  }

  function setRootVariable(css, name, value) {
    const rx = new RegExp(`(${name.replace(/[-]/g, '\\-')}\\s*:\\s*)([^;]+)(;)`);
    return rx.test(css) ? css.replace(rx, `$1${value}$3`) : css;
  }

  const FONT_OPTIONS = [
    ['', 'Theme default'],
    ['"Inter Variable", system-ui, sans-serif', 'Inter (clean)', true],
    ['"Oswald", "Arial Narrow", sans-serif', 'Oswald (condensed)', true],
    ['"Bebas Neue", "Arial Narrow", sans-serif', 'Bebas Neue (poster)', true],
    ['"Rajdhani", system-ui, sans-serif', 'Rajdhani (tech)', true],
    ['"Orbitron", system-ui, sans-serif', 'Orbitron (sci-fi)', true],
    ['"JetBrains Mono", monospace', 'JetBrains Mono', true],
    ['Georgia, "Times New Roman", serif', 'Georgia (serif)'],
    ['"Courier New", monospace', 'Courier (typewriter)'],
    ['Impact, "Arial Black", sans-serif', 'Impact'],
    ['system-ui, "Segoe UI", sans-serif', 'System']
  ];

  window.TBElements = {
    PALETTE, ITEMS, SHORTCODES, MANAGED_START, MANAGED_END, FONT_OPTIONS,
    qbClass, parseShortcode, buildShortcode, parseManaged, serializeManaged, rootVariables, setRootVariable
  };
})();
