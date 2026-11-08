/* Visual automation builder + integrations + activity log */
(function () {
  'use strict';
  const { html, raw, escape: esc, get, post, put, del, toast, error, confirm, modal, menu, formatTime, parseTime, copy, $, $$ } = QC;
  const C = window.AutomationCatalog;

  const roomId = QC.roomIdFromPath();
  const S = {
    room: null,
    automations: [],
    current: null,       // working copy being edited
    original: null,      // JSON snapshot for dirty check
    media: [],
    audio: [],
    slideshows: [],
    logs: [],
    filter: '',
    unseen: 0,
    view: 'automations'
  };

  const socket = io();
  socket.on('connect', () => socket.emit('join_admin', { roomId }));
  socket.on('automation_log', (entry) => {
    S.logs.unshift(entry);
    S.logs = S.logs.slice(0, 200);
    if (S.view === 'activity') drawActivity();
    else {
      S.unseen += 1;
      const b = $('#activity-count');
      b.hidden = false;
      b.textContent = S.unseen;
    }
    // Live run counts in the list
    if (entry.level === 'run' && entry.automationId) {
      const a = S.automations.find(x => x.id === entry.automationId);
      if (a) { a.run_count = (a.run_count || 0) + 1; a.last_run_at = entry.at; drawList(); }
    }
  });

  const ctx = () => ({
    secondaryLabel: S.room && S.room.timer.secondaryLabel,
    slideshows: S.slideshows,
    automations: S.automations
  });
  const isDirty = () => S.current && JSON.stringify(S.current) !== S.original;

  /* ================================================================ views */
  function setView(v) {
    S.view = v;
    $$('.page-tabs .tab').forEach(t => t.classList.toggle('active', t.dataset.view === v));
    $('#view-automations').hidden = v !== 'automations';
    $('#view-integrations').hidden = v !== 'integrations';
    $('#view-activity').hidden = v !== 'activity';
    if (v === 'integrations') drawIntegrations();
    if (v === 'activity') { S.unseen = 0; $('#activity-count').hidden = true; drawActivity(); }
    history.replaceState(null, '', v === 'automations' ? location.pathname + (S.current && S.current.id ? `#${S.current.id}` : '') : `${location.pathname}#${v}`);
  }
  $$('.page-tabs .tab').forEach(t => t.onclick = () => setView(t.dataset.view));

  /* ================================================================= list */
  function drawList() {
    const host = $('#auto-items');
    const q = S.filter.trim().toLowerCase();
    const items = S.automations.filter(a => !q || a.name.toLowerCase().includes(q) || C.describeTrigger(a.trigger, ctx()).toLowerCase().includes(q));
    if (!S.automations.length) {
      host.innerHTML = '<div class="empty" style="padding:30px 10px"><p class="small">No automations yet.</p></div>';
      return;
    }
    host.innerHTML = items.map(a => {
      const t = C.TRIGGERS[a.trigger.type] || C.TRIGGERS.variable;
      const active = S.current && S.current.id === a.id;
      return html`
        <button class="auto-item ${active ? 'active' : ''} ${a.enabled ? '' : 'disabled'}" data-id="${a.id}">
          <span class="ai-icon tone-${t.tone}"><i class="${t.icon}"></i></span>
          <span class="grow">
            <div class="ai-name">${a.name}</div>
            <div class="ai-desc">${C.describeTrigger(a.trigger, ctx())} → ${a.actions.length ? a.actions.map(x => C.describeAction(x, ctx())).slice(0, 2).join(', ') : 'no actions'}${a.actions.length > 2 ? '…' : ''}</div>
            <div class="ai-meta">${a.enabled ? '' : raw('<span>Off</span>')}<span>${a.run_count ? `Ran ${a.run_count}×` : 'Never run'}</span>${a.last_run_at ? raw(html`<span>${QC.timeAgo(a.last_run_at)}</span>`) : ''}</div>
          </span>
        </button>`;
    }).join('');
    host.querySelectorAll('.auto-item').forEach(b => b.onclick = () => select(b.dataset.id));
  }
  $('#auto-search').oninput = (e) => { S.filter = e.target.value; drawList(); };

  async function select(id) {
    if (S.current && S.current.id === id) return;
    if (isDirty() && !(await confirm({ title: 'Discard unsaved changes?', message: `“${esc(S.current.name)}” has changes that haven't been saved.`, confirmText: 'Discard', danger: true }))) return;
    const a = S.automations.find(x => x.id === id);
    if (!a) return;
    S.current = JSON.parse(JSON.stringify(a));
    S.original = JSON.stringify(S.current);
    history.replaceState(null, '', `${location.pathname}#${id}`);
    drawList();
    drawEditor();
  }

  /* ============================================================== recipes */
  async function newAutomation() {
    if (isDirty() && !(await confirm({ title: 'Discard unsaved changes?', message: 'The automation you are editing has unsaved changes.', confirmText: 'Discard', danger: true }))) return;
    const body = document.createElement('div');
    body.innerHTML = html`<p class="muted mb-16">Pick a starting point – everything can be changed afterwards.</p>
      <div class="recipes">${raw(C.RECIPES.map(r => html`
        <button class="recipe" data-r="${r.id}"><span class="r-icon tone-${r.tone}"><i class="${r.icon}"></i></span><strong>${r.title}</strong><span>${r.text}</span></button>`).join(''))}</div>`;
    const chosen = await modal({
      title: 'New automation', size: 'lg', icon: 'icon-zap', body,
      onOpen: ({ close }) => body.querySelectorAll('[data-r]').forEach(b => b.onclick = () => close(b.dataset.r))
    });
    if (!chosen) return;
    const recipe = C.RECIPES.find(r => r.id === chosen);
    S.current = { id: null, enabled: true, cooldown_seconds: 0, conditions: { mode: 'all', rules: [] }, ...recipe.build() };
    S.original = '';
    drawList();
    drawEditor();
    setTimeout(() => { const n = $('.name-input'); if (n) { n.focus(); n.select(); } }, 50);
  }
  $('#new-auto').onclick = newAutomation;

  /* =============================================================== editor */
  function variableNames() {
    const names = new Set(Object.keys((S.room && S.room.variables) || {}));
    ['timer_main', 'timer_main_remaining', 'timer_secondary', 'timer_secondary_remaining'].forEach(n => names.add(n));
    S.automations.forEach(a => {
      if (a.trigger && a.trigger.variable) names.add(a.trigger.variable);
      (a.actions || []).forEach(x => { if (x.variable) names.add(x.variable); });
    });
    return [...names].filter(Boolean).sort();
  }

  function varDatalist() {
    return `<datalist id="var-names">${variableNames().map(n => `<option value="${esc(n)}">`).join('')}</datalist>`;
  }

  function templateChips(targetSelector) {
    const vars = variableNames().filter(n => !n.startsWith('timer_')).slice(0, 8).map(n => `{{${n}}}`);
    const chips = ['{{room.name}}', '{{timer.remaining_formatted}}', '{{timer.elapsed_formatted}}', ...vars];
    if (S.current && S.current.trigger.type === 'webhook') chips.push('{{payload.value}}');
    if (S.current && S.current.trigger.type === 'event') chips.push('{{payload.message}}');
    return `<div class="var-chips" data-chips-for="${esc(targetSelector)}"><span class="faint tiny" style="margin-right:4px">Insert:</span>${chips.map(c => `<button type="button" data-chip="${esc(c)}">${esc(c)}</button>`).join('')}</div>`;
  }

  function wireChips(root) {
    root.querySelectorAll('[data-chips-for]').forEach(group => {
      group.querySelectorAll('[data-chip]').forEach(b => b.onclick = () => {
        const target = root.querySelector(group.dataset.chipsFor);
        if (!target) return;
        const start = target.selectionStart ?? target.value.length;
        const end = target.selectionEnd ?? target.value.length;
        target.value = target.value.slice(0, start) + b.dataset.chip + target.value.slice(end);
        target.dispatchEvent(new Event('input', { bubbles: true }));
        target.focus();
        target.selectionStart = target.selectionEnd = start + b.dataset.chip.length;
      });
    });
  }

  function drawEditor() {
    const host = $('#editor');
    const a = S.current;
    if (!a) {
      host.innerHTML = `
        <div class="editor-inner">
          <div class="empty">
            <div class="empty-icon"><i class="icon-workflow"></i></div>
            <h3>${S.automations.length ? 'Select an automation' : 'Make your room react automatically'}</h3>
            <p>Automations follow a simple pattern: <strong>when</strong> something happens, <strong>if</strong> the game is in the right state, <strong>then</strong> do one or more things – show a message, play a sound, open a maglock, start a slideshow.</p>
            <button class="btn btn-primary btn-lg mt-8" id="empty-new"><i class="icon-plus"></i>New automation</button>
          </div>
        </div>`;
      $('#empty-new').onclick = newAutomation;
      return;
    }

    host.innerHTML = html`
      <div class="editor-inner">
        <div class="editor-top">
          <input class="input name-input" id="ed-name" value="${a.name}" aria-label="Automation name" maxlength="120">
          <label class="switch" data-tip="${a.enabled ? 'Enabled' : 'Disabled'}"><input type="checkbox" id="ed-enabled" ${a.enabled ? 'checked' : ''}><span class="track"></span><span class="small">${a.enabled ? 'On' : 'Off'}</span></label>
          ${a.id ? raw('<button class="btn btn-ghost btn-icon btn-sm" id="ed-more" aria-label="More"><i class="icon-ellipsis"></i></button>') : ''}
        </div>

        <div class="flow">
          <div class="flow-step">
            <div class="flow-label when"><span class="pill">When</span><span class="sub">what starts this automation</span></div>
            <div class="block" id="trigger-block"></div>
          </div>
          <div class="connector"></div>
          <div class="flow-step">
            <div class="flow-label if"><span class="pill">Only if</span><span class="sub">optional – extra checks against the game state</span></div>
            <div class="block" id="cond-block"></div>
          </div>
          <div class="connector"></div>
          <div class="flow-step">
            <div class="flow-label then"><span class="pill">Then</span><span class="sub">steps run in order, top to bottom</span></div>
            <div class="action-list" id="action-list"></div>
            <button class="btn mt-8" id="add-action"><i class="icon-plus"></i>Add a step</button>
          </div>
        </div>

        <details class="mt-24"><summary class="muted small" style="cursor:pointer">Advanced</summary>
          <div class="card mt-8"><div class="card-body row row-wrap">
            <div class="field" style="max-width:240px"><label>Cooldown</label>
              <input class="input input-sm" id="ed-cooldown" value="${a.cooldown_seconds ? formatTime(a.cooldown_seconds) : ''}" placeholder="0:00 (none)">
              <div class="hint">Ignore repeat triggers within this time (stops button mashing or noisy sensors).</div></div>
          </div></div>
        </details>
      </div>
      <div class="editor-bar">
        <span class="small muted" id="dirty-state"></span>
        <div class="spacer"></div>
        ${a.id ? raw('<button class="btn" id="ed-test"><i class="icon-flask-conical"></i>Test now</button>') : ''}
        <button class="btn btn-primary" id="ed-save"><i class="icon-check"></i>${a.id ? 'Save' : 'Create automation'}</button>
      </div>
      ${raw(varDatalist())}`;

    $('#ed-name').oninput = (e) => { a.name = e.target.value; markDirty(); };
    $('#ed-enabled').onchange = (e) => { a.enabled = e.target.checked; drawEditor(); markDirty(); };
    $('#ed-cooldown').oninput = (e) => { const s = parseTime(e.target.value); a.cooldown_seconds = Number.isFinite(s) ? s : 0; markDirty(); };
    $('#ed-save').onclick = save;
    const testBtn = $('#ed-test');
    if (testBtn) testBtn.onclick = testRun;
    const moreBtn = $('#ed-more');
    if (moreBtn) moreBtn.onclick = (e) => menu(e.currentTarget, [
      { label: 'Duplicate', icon: 'icon-copy', onClick: duplicate },
      'divider',
      { label: 'Delete automation', icon: 'icon-trash-2', danger: true, onClick: remove }
    ]);
    $('#add-action').onclick = () => addAction(a.actions.length);

    drawTrigger();
    drawConditions();
    drawActions();
    markDirty(true);
  }

  function markDirty(silent) {
    const el = $('#dirty-state');
    if (!el) return;
    if (!S.current.id) el.innerHTML = '<span class="unsaved-dot"></span> Not created yet';
    else el.innerHTML = isDirty() ? '<span class="unsaved-dot"></span> Unsaved changes' : '<i class="icon-check"></i> Saved';
    if (!silent) drawListPreview();
  }

  const drawListPreview = QC.debounce(() => {
    // reflect name/trigger edits in the list without saving
    const item = document.querySelector(`.auto-item[data-id="${CSS.escape(S.current.id || '')}"]`);
    if (item) {
      item.querySelector('.ai-name').textContent = S.current.name;
      item.querySelector('.ai-desc').textContent = `${C.describeTrigger(S.current.trigger, ctx())} → ${S.current.actions.map(x => C.describeAction(x, ctx())).slice(0, 2).join(', ') || 'no actions'}`;
    }
  }, 150);

  /* -------------------------------------------------------------- trigger */
  function drawTrigger() {
    const a = S.current;
    const t = a.trigger;
    const def = C.TRIGGERS[t.type] || C.TRIGGERS.variable;
    const block = $('#trigger-block');
    block.innerHTML = html`
      <div class="block-head">
        <span class="b-icon tone-${def.tone}"><i class="${def.icon}"></i></span>
        <div class="grow"><div class="b-title">${C.describeTrigger(t, ctx())}</div><div class="b-sum">${def.help}</div></div>
      </div>
      <div class="type-picker">${raw(Object.entries(C.TRIGGERS).map(([k, d]) => html`<button class="type-opt ${k === t.type ? 'active' : ''}" data-type="${k}"><i class="${d.icon}"></i>${d.label}</button>`).join(''))}</div>
      <div class="block-body" id="trigger-fields"></div>`;
    block.querySelectorAll('[data-type]').forEach(b => b.onclick = () => {
      if (b.dataset.type === t.type) return;
      const defaults = {
        variable: { type: 'variable', variable: '', operator: 'equals', value: '' },
        timer: { type: 'timer', timer: 'main', event: 'remaining', seconds: 300 },
        webhook: { type: 'webhook' },
        manual: { type: 'manual', label: a.name || 'Run', color: C.COLORS[0], icon: 'zap' },
        event: { type: 'event', event: 'player_connected' }
      };
      a.trigger = defaults[b.dataset.type];
      drawTrigger();
      markDirty();
    });

    const f = block.querySelector('#trigger-fields');
    const refreshTitle = () => { block.querySelector('.b-title').textContent = C.describeTrigger(a.trigger, ctx()); markDirty(); };

    switch (t.type) {
      case 'variable': {
        const op = C.OPERATORS.find(o => o.v === (t.operator || 'equals')) || C.OPERATORS[0];
        f.innerHTML = html`
          <div class="sentence">
            <span>When</span>
            <input class="input input-sm mono" list="var-names" id="tr-var" value="${t.variable || ''}" placeholder="variable_name">
            <select class="select input-sm" id="tr-op">${raw(C.OPERATORS.map(o => html`<option value="${o.v}" ${o.v === op.v ? 'selected' : ''}>${o.label}</option>`).join(''))}</select>
            ${op.needsValue ? raw(html`<input class="input input-sm w-sm" id="tr-val" value="${t.value ?? ''}" placeholder="value">`) : ''}
          </div>
          <div class="hint small faint">Fires once each time the condition <em>becomes</em> true – not repeatedly while it stays true.</div>`;
        f.querySelector('#tr-var').oninput = (e) => { t.variable = e.target.value.trim(); refreshTitle(); };
        f.querySelector('#tr-op').onchange = (e) => { t.operator = e.target.value; drawTrigger(); markDirty(); };
        const v = f.querySelector('#tr-val');
        if (v) v.oninput = (e) => { t.value = e.target.value; refreshTitle(); };
        break;
      }
      case 'timer': {
        const ev = C.TIMER_EVENTS.find(e => e.v === (t.event || 'remaining')) || C.TIMER_EVENTS[0];
        f.innerHTML = html`
          <div class="sentence">
            <span>When</span>
            <select class="select input-sm" id="tr-timer">
              <option value="main" ${t.timer !== 'secondary' ? 'selected' : ''}>the game timer</option>
              <option value="secondary" ${t.timer === 'secondary' ? 'selected' : ''}>${S.room ? S.room.timer.secondaryLabel : 'the secondary timer'}</option>
            </select>
            <select class="select input-sm" id="tr-event">${raw(C.TIMER_EVENTS.map(e => html`<option value="${e.v}" ${e.v === ev.v ? 'selected' : ''}>${e.label}</option>`).join(''))}</select>
            ${ev.needsSeconds ? raw(html`<input class="input input-sm w-sm" id="tr-secs" value="${formatTime(t.seconds || 0)}" placeholder="10:00">`) : ''}
          </div>
          ${t.timer === 'secondary' && S.room && !S.room.timer.secondaryEnabled ? raw('<div class="callout warning"><i class="icon-triangle-alert"></i><div class="small">The secondary timer is turned off for this room. Enable it in room settings → Timers.</div></div>') : ''}`;
        f.querySelector('#tr-timer').onchange = (e) => { t.timer = e.target.value; drawTrigger(); markDirty(); };
        f.querySelector('#tr-event').onchange = (e) => { t.event = e.target.value; drawTrigger(); markDirty(); };
        const s = f.querySelector('#tr-secs');
        if (s) s.oninput = () => { const v = parseTime(s.value); s.classList.toggle('invalid', !Number.isFinite(v)); if (Number.isFinite(v)) { t.seconds = v; refreshTitle(); } };
        break;
      }
      case 'webhook': {
        const url = a.webhookUrl;
        f.innerHTML = url ? html`
          <div class="webhook-box">
            <div class="label">Your webhook URL – call it with GET or POST</div>
            <div class="copy-field"><code>${url}</code><button class="btn btn-ghost btn-icon btn-xs" data-copy="${url}" aria-label="Copy"><i class="icon-copy"></i></button></div>
            <div class="small faint">Anything in the query string or JSON body is available to steps as <code>{{payload.name}}</code>, e.g. <code>${url}?code=1234</code> → <code>{{payload.code}}</code>.</div>
            <div class="row"><button class="btn btn-sm" id="hook-test"><i class="icon-send"></i>Send a test request</button><button class="btn btn-ghost btn-sm" id="hook-regen"><i class="icon-refresh-cw"></i>New URL</button>
            <div class="spacer"></div><button class="btn btn-ghost btn-sm" id="hook-snippets"><i class="icon-code"></i>Code for your device</button></div>
          </div>` : '<div class="callout"><i class="icon-info"></i><div class="small">A unique, secret URL is created when you save. Give it to your prop controller, Raspberry Pi, Home Assistant or any service that can call a URL.</div></div>';
        if (url) {
          f.querySelector('[data-copy]').onclick = () => copy(url, 'Webhook URL copied');
          f.querySelector('#hook-test').onclick = async () => {
            try {
              const res = await fetch(`${url}?test=1`, { method: 'POST' });
              const j = await res.json();
              toast(j.ran ? 'Webhook received – automation ran' : `Webhook received – skipped (${j.reason || j.error})`, j.ran ? 'success' : 'warning');
            } catch (err) { error(err); }
          };
          f.querySelector('#hook-regen').onclick = async () => {
            if (!(await confirm({ title: 'Generate a new webhook URL?', message: 'Devices using the current URL will stop working until you update them.', confirmText: 'Generate' }))) return;
            try {
              const updated = await post(`/api/v2/automations/${a.id}/regenerate-hook`);
              a.hook_key = updated.hook_key; a.webhookUrl = updated.webhookUrl;
              replaceInList(updated);
              S.original = JSON.stringify(S.current);
              drawTrigger();
            } catch (err) { error(err); }
          };
          f.querySelector('#hook-snippets').onclick = () => showSnippets({ title: 'Call this webhook', url, method: 'POST', body: '{"code": "1234"}' });
        }
        break;
      }
      case 'manual': {
        f.innerHTML = html`
          <div class="grid-2">
            <div class="field"><label>Button text</label><input class="input input-sm" id="tr-label" value="${t.label || ''}" placeholder="Lights out" maxlength="40"></div>
            <div class="field"><label>Icon</label><select class="select input-sm" id="tr-icon">${raw(C.BUTTON_ICONS.map(i => html`<option value="${i}" ${i === (t.icon || 'zap') ? 'selected' : ''}>${i.replace(/-/g, ' ')}</option>`).join(''))}</select></div>
          </div>
          <div class="field"><label>Colour</label><div class="color-swatches">${raw(C.COLORS.map(c => html`<button class="${c === t.color ? 'active' : ''}" style="background:${c}" data-color="${c}" aria-label="${c}"></button>`).join(''))}</div></div>
          <div class="field"><label>Preview in the GM console</label>
            <div><span class="quick-preview" style="--qa:${t.color || C.COLORS[0]}"><i class="icon-${t.icon || 'zap'}"></i>${t.label || a.name || 'Button'}</span></div></div>`;
        f.querySelector('#tr-label').oninput = (e) => { t.label = e.target.value; f.querySelector('.quick-preview').lastChild.textContent = t.label || a.name || 'Button'; refreshTitle(); };
        f.querySelector('#tr-icon').onchange = (e) => { t.icon = e.target.value; drawTrigger(); markDirty(); };
        f.querySelectorAll('[data-color]').forEach(b => b.onclick = () => { t.color = b.dataset.color; drawTrigger(); markDirty(); });
        break;
      }
      case 'event': {
        f.innerHTML = html`<div class="sentence"><span>When</span><select class="select input-sm w-lg" id="tr-ev">${raw(C.ROOM_EVENTS.map(e => html`<option value="${e.v}" ${e.v === t.event ? 'selected' : ''}>${e.label.toLowerCase()}</option>`).join(''))}</select></div>
          <div class="hint small faint">${t.event === 'player_message' || t.event === 'hint_sent' ? raw('The message text is available as <code>{{payload.message}}</code>.') : ''}</div>`;
        f.querySelector('#tr-ev').onchange = (e) => { t.event = e.target.value; drawTrigger(); markDirty(); };
        break;
      }
    }
  }

  /* ------------------------------------------------------------ conditions */
  function drawConditions() {
    const c = S.current.conditions = S.current.conditions || { mode: 'all', rules: [] };
    const block = $('#cond-block');
    if (!c.rules.length) {
      block.innerHTML = '<div class="block-head"><span class="b-icon" style="background:var(--surface-3);color:var(--text-muted)"><i class="icon-filter"></i></span><div class="grow"><div class="b-title">Always</div><div class="b-sum">Runs every time the trigger fires.</div></div><button class="btn btn-sm" id="add-cond"><i class="icon-plus"></i>Add a check</button></div>';
      block.querySelector('#add-cond').onclick = () => { c.rules.push({ variable: '', operator: 'equals', value: '' }); drawConditions(); markDirty(); };
      return;
    }
    block.innerHTML = html`
      <div class="block-head">
        <span class="b-icon" style="background:var(--surface-3);color:var(--text-muted)"><i class="icon-filter"></i></span>
        <div class="grow sentence"><span>Only if</span>
          <select class="select input-sm" id="cond-mode" style="min-width:0"><option value="all" ${c.mode !== 'any' ? 'selected' : ''}>all</option><option value="any" ${c.mode === 'any' ? 'selected' : ''}>any</option></select>
          <span>of these are true:</span></div>
      </div>
      <div class="block-body">
        ${raw(c.rules.map((r, i) => {
          const op = C.CONDITION_OPERATORS.find(o => o.v === r.operator) || C.CONDITION_OPERATORS[0];
          return html`<div class="cond-row">
            <input class="input input-sm mono" list="var-names" data-i="${i}" data-k="variable" value="${r.variable}" placeholder="variable">
            <select class="select input-sm" data-i="${i}" data-k="operator">${raw(C.CONDITION_OPERATORS.map(o => html`<option value="${o.v}" ${o.v === op.v ? 'selected' : ''}>${o.label}</option>`).join(''))}</select>
            ${op.needsValue ? raw(html`<input class="input input-sm" data-i="${i}" data-k="value" value="${r.value ?? ''}" placeholder="value">`) : raw('<span></span>')}
            <button class="btn btn-ghost btn-icon btn-sm" data-del="${i}" aria-label="Remove"><i class="icon-x"></i></button>
          </div>`;
        }).join(''))}
        <div><button class="btn btn-sm btn-ghost" id="add-cond"><i class="icon-plus"></i>Add another check</button></div>
      </div>`;
    block.querySelector('#cond-mode').onchange = (e) => { c.mode = e.target.value; markDirty(); };
    block.querySelectorAll('[data-k]').forEach(el => {
      const handler = () => {
        c.rules[+el.dataset.i][el.dataset.k] = el.value;
        if (el.dataset.k === 'operator') drawConditions();
        markDirty();
      };
      if (el.tagName === 'SELECT') el.onchange = handler; else el.oninput = handler;
    });
    block.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { c.rules.splice(+b.dataset.del, 1); drawConditions(); markDirty(); });
    block.querySelector('#add-cond').onclick = () => { c.rules.push({ variable: '', operator: 'equals', value: '' }); drawConditions(); markDirty(); };
  }

  /* --------------------------------------------------------------- actions */
  const expanded = new Set();

  function drawActions() {
    const list = $('#action-list');
    const acts = S.current.actions;
    if (!acts.length) {
      list.innerHTML = '<div class="block"><div class="block-head"><span class="b-icon" style="background:var(--surface-3);color:var(--text-muted)"><i class="icon-list-plus"></i></span><div class="grow"><div class="b-title">No steps yet</div><div class="b-sum">Add what should happen – show a message, change a variable, call a prop…</div></div></div></div>';
      return;
    }
    list.innerHTML = acts.map((act, i) => {
      const def = C.ACTIONS[act.type] || { label: act.type, icon: 'icon-circle' };
      const open = expanded.has(i) || !actionComplete(act);
      return html`
        ${i > 0 ? raw(html`<div class="action-gap"><button class="btn btn-primary btn-icon insert" data-insert="${i}" aria-label="Insert step here"><i class="icon-plus"></i></button></div>`) : ''}
        <div class="block action-block ${open ? '' : 'collapsed'} ${act.disabled ? 'off' : ''}" data-id="${i}">
          <div class="block-head" data-toggle="${i}">
            <span class="drag-handle" title="Drag to reorder"><i class="icon-grip-vertical"></i></span>
            <span class="num">${i + 1}</span>
            <span class="b-icon tone-${act.type === 'delay' ? 'timer' : act.type === 'http_request' ? 'webhook' : 'manual'}"><i class="${def.icon}"></i></span>
            <div class="grow"><div class="b-title">${C.describeAction(act, ctx())}</div><div class="b-sum">${def.label}${act.disabled ? ' · skipped' : ''}</div></div>
            <button class="btn btn-ghost btn-icon btn-sm" data-act-menu="${i}" aria-label="Step options"><i class="icon-ellipsis"></i></button>
            <i class="icon-chevron-down faint"></i>
          </div>
          <div class="block-body" data-fields="${i}"></div>
        </div>`;
    }).join('');

    list.querySelectorAll('[data-fields]').forEach(f => renderActionFields(f, acts[+f.dataset.fields], +f.dataset.fields));
    list.querySelectorAll('[data-toggle]').forEach(h => h.onclick = (e) => {
      if (e.target.closest('button, .drag-handle')) return;
      const i = +h.dataset.toggle;
      const block = h.parentElement;
      block.classList.toggle('collapsed');
      if (block.classList.contains('collapsed')) expanded.delete(i); else expanded.add(i);
    });
    list.querySelectorAll('[data-insert]').forEach(b => b.onclick = () => addAction(+b.dataset.insert));
    list.querySelectorAll('[data-act-menu]').forEach(b => b.onclick = (e) => {
      const i = +b.dataset.actMenu;
      const act = acts[i];
      menu(e.currentTarget, [
        { label: act.disabled ? 'Enable step' : 'Skip this step', icon: act.disabled ? 'icon-circle-play' : 'icon-circle-pause', onClick: () => { act.disabled = !act.disabled; drawActions(); markDirty(); } },
        { label: 'Duplicate step', icon: 'icon-copy', onClick: () => { acts.splice(i + 1, 0, JSON.parse(JSON.stringify(act))); drawActions(); markDirty(); } },
        i > 0 ? { label: 'Move up', icon: 'icon-arrow-up', onClick: () => { [acts[i - 1], acts[i]] = [acts[i], acts[i - 1]]; drawActions(); markDirty(); } } : null,
        i < acts.length - 1 ? { label: 'Move down', icon: 'icon-arrow-down', onClick: () => { [acts[i + 1], acts[i]] = [acts[i], acts[i + 1]]; drawActions(); markDirty(); } } : null,
        'divider',
        { label: 'Delete step', icon: 'icon-trash-2', danger: true, onClick: () => { acts.splice(i, 1); expanded.clear(); drawActions(); markDirty(); } }
      ]);
    });
    QC.sortable(list, {
      items: '.action-block', handle: '.drag-handle',
      onEnd: (ids) => {
        const reordered = ids.map(id => acts[+id]);
        acts.splice(0, acts.length, ...reordered);
        expanded.clear();
        drawActions();
        markDirty();
      }
    });
  }

  function actionComplete(a) {
    switch (a.type) {
      case 'show_message': return !!a.text;
      case 'send_hint': return !!a.message;
      case 'show_media': return !!(a.url || a.mediaId || a.headline);
      case 'play_sound': return !!a.url;
      case 'set_variable': return !!a.variable;
      case 'http_request': return !!a.url;
      case 'run_automation': return !!a.automationId;
      default: return true;
    }
  }

  async function addAction(index) {
    const body = document.createElement('div');
    body.className = 'add-action-menu';
    body.innerHTML = Object.entries(C.ACTIONS).map(([k, d]) => html`<button class="add-action-opt" data-k="${k}"><i class="${d.icon}"></i><div><strong>${d.label}</strong><span>${d.help}</span></div></button>`).join('');
    const type = await modal({
      title: 'Add a step', size: 'lg', icon: 'icon-list-plus', body,
      onOpen: ({ close }) => body.querySelectorAll('[data-k]').forEach(b => b.onclick = () => close(b.dataset.k))
    });
    if (!type) return;
    const act = { type, ...JSON.parse(JSON.stringify(C.ACTIONS[type].defaults)) };
    S.current.actions.splice(index, 0, act);
    expanded.clear();
    expanded.add(index);
    drawActions();
    markDirty();
    const block = document.querySelector(`.action-block[data-id="${index}"]`);
    if (block) block.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function renderActionFields(f, act, i) {
    const update = (redraw) => {
      const block = f.closest('.action-block');
      block.querySelector('.b-title').textContent = C.describeAction(act, ctx());
      markDirty();
      if (redraw) { expanded.add(i); drawActions(); }
    };
    const bind = (sel, key, { num = false, time = false, redraw = false } = {}) => {
      const el = f.querySelector(sel);
      if (!el) return;
      const ev = el.tagName === 'SELECT' || el.type === 'checkbox' || el.type === 'range' ? 'onchange' : 'oninput';
      el[ev] = () => {
        let v = el.type === 'checkbox' ? el.checked : el.value;
        if (num) v = Number(v);
        if (time) { const t = parseTime(v); el.classList.toggle('invalid', !Number.isFinite(t)); if (!Number.isFinite(t)) return; v = t; }
        act[key] = v;
        update(redraw);
      };
      if (el.type === 'range') el.oninput = el.onchange;
    };

    switch (act.type) {
      case 'show_message':
        f.innerHTML = html`
          <div class="grid-2">
            <div class="field"><label>Title (optional)</label><input class="input input-sm" data-f="title" value="${act.title || ''}"></div>
            <div class="row"><div class="field grow"><label>Style</label><select class="select input-sm" data-f="style">${raw(['info', 'success', 'warning', 'danger'].map(s => `<option ${s === act.style ? 'selected' : ''}>${s}</option>`).join(''))}</select></div>
            <div class="field grow"><label>Show for</label><select class="select input-sm" data-f="duration">${raw([[5, '5 s'], [8, '8 s'], [15, '15 s'], [30, '30 s'], [60, '1 min'], [0, 'Until GM closes']].map(([v, l]) => `<option value="${v}" ${Number(act.duration) === v ? 'selected' : ''}>${l}</option>`).join(''))}</select></div></div>
          </div>
          <div class="field"><label>Message</label><textarea class="textarea" rows="2" data-f="text" id="msg-${i}">${act.text || ''}</textarea>${raw(templateChips(`#msg-${i}`))}</div>`;
        bind('[data-f="title"]', 'title'); bind('[data-f="style"]', 'style'); bind('[data-f="duration"]', 'duration', { num: true }); bind('[data-f="text"]', 'text');
        wireChips(f);
        break;

      case 'send_hint':
        f.innerHTML = html`<div class="field"><label>Hint text</label><textarea class="textarea" rows="2" data-f="message" id="hint-${i}">${act.message || ''}</textarea>${raw(templateChips(`#hint-${i}`))}</div>`;
        bind('[data-f="message"]', 'message');
        wireChips(f);
        break;

      case 'show_media': {
        const m = S.media.find(x => x.id === act.mediaId);
        const url = act.url || (m && m.url);
        const isVideo = url && /\.(mp4|webm|mov|m4v)$/i.test(url);
        f.innerHTML = html`
          <div class="row">
            ${url ? raw(isVideo ? html`<video src="${url}#t=0.5" muted style="width:120px;height:68px;object-fit:cover;border-radius:8px;background:#000"></video>` : html`<img src="${url}" style="width:120px;height:68px;object-fit:cover;border-radius:8px;background:#000" alt="">`) : raw('<div class="faint small">No media chosen – a headline on its own also works.</div>')}
            <div class="spacer"></div>
            <button class="btn btn-sm" data-pick><i class="icon-image"></i>${url ? 'Change' : 'Choose media'}</button>
            ${url ? raw('<button class="btn btn-ghost btn-sm" data-clear>Remove</button>') : ''}
          </div>
          <div class="grid-2">
            <div class="field"><label>Headline (optional)</label><input class="input input-sm" data-f="headline" value="${act.headline || ''}"></div>
            <div class="field"><label>Close after</label><select class="select input-sm" data-f="duration">${raw([[5, '5 s'], [10, '10 s'], [30, '30 s'], [60, '1 min'], [0, 'Until GM closes']].map(([v, l]) => `<option value="${v}" ${Number(act.duration) === v ? 'selected' : ''}>${l}</option>`).join(''))}</select></div>
          </div>`;
        f.querySelector('[data-pick]').onclick = async () => {
          const picked = await QC.pickMedia({ roomId, accept: 'image/*,video/*', title: 'Choose an image or video' });
          if (!picked) return;
          act.url = picked.url; act.mediaId = '';
          loadMedia();
          update(true);
        };
        const clear = f.querySelector('[data-clear]');
        if (clear) clear.onclick = () => { act.url = ''; act.mediaId = ''; update(true); };
        bind('[data-f="headline"]', 'headline'); bind('[data-f="duration"]', 'duration', { num: true });
        break;
      }

      case 'play_sound': {
        const sounds = [
          ...S.audio.map(a => ({ url: a.file_path.startsWith('/') ? a.file_path : `/${a.file_path}`, name: a.original_name })),
          ...S.media.filter(m => m.type === 'audio').map(m => ({ url: m.url, name: m.title || C.fileName(m.url) }))
        ];
        f.innerHTML = html`
          <div class="row">
            <select class="select input-sm grow" data-f="url"><option value="">Choose a sound…</option>${raw(sounds.map(s => html`<option value="${s.url}" ${s.url === act.url ? 'selected' : ''}>${s.name}</option>`).join(''))}
              ${act.url && !sounds.some(s => s.url === act.url) ? raw(html`<option value="${act.url}" selected>${C.fileName(act.url)}</option>`) : ''}</select>
            <button class="btn btn-sm" data-upload><i class="icon-upload"></i>Upload</button>
            <button class="btn btn-ghost btn-icon btn-sm" data-preview aria-label="Preview"><i class="icon-play"></i></button>
          </div>
          <div class="grid-2">
            <div class="field"><label>Volume <span class="faint" data-volv>${act.volume || 80}%</span></label><input type="range" min="0" max="100" data-f="volume" value="${act.volume || 80}"></div>
            <div class="field"><label>Play on</label><select class="select input-sm" data-f="target">
              <option value="players" ${act.target !== 'gm' && act.target !== 'all' ? 'selected' : ''}>Player screens</option>
              <option value="gm" ${act.target === 'gm' ? 'selected' : ''}>GM console only</option>
              <option value="all" ${act.target === 'all' ? 'selected' : ''}>Everywhere</option></select></div>
          </div>`;
        bind('[data-f="url"]', 'url', { redraw: false });
        bind('[data-f="target"]', 'target');
        const vol = f.querySelector('[data-f="volume"]');
        vol.oninput = () => { act.volume = Number(vol.value); f.querySelector('[data-volv]').textContent = `${vol.value}%`; markDirty(); };
        f.querySelector('[data-preview]').onclick = () => {
          if (!act.url) return toast('Choose a sound first', 'warning');
          const au = new Audio(act.url);
          au.volume = (act.volume || 80) / 100;
          au.play().catch(() => toast('Could not play that file', 'error'));
        };
        f.querySelector('[data-upload]').onclick = async () => {
          const files = await QC.pickFiles({ accept: 'audio/*' });
          if (!files) return;
          try {
            const [up] = await QC.upload(files, { roomId, category: 'sound' });
            act.url = up.url;
            await loadMedia();
            update(true);
            toast('Sound uploaded', 'success');
          } catch (err) { error(err); }
        };
        break;
      }

      case 'set_variable':
        f.innerHTML = html`
          <div class="sentence">
            <select class="select input-sm" data-f="mode">${raw([['set', 'Set'], ['increment', 'Add to'], ['decrement', 'Subtract from'], ['toggle', 'Toggle']].map(([v, l]) => `<option value="${v}" ${v === (act.mode || 'set') ? 'selected' : ''}>${l}</option>`).join(''))}</select>
            <input class="input input-sm mono" list="var-names" data-f="variable" value="${act.variable || ''}" placeholder="variable_name">
            ${act.mode === 'toggle' ? '' : raw(html`<span>${act.mode === 'set' || !act.mode ? 'to' : 'by'}</span><input class="input input-sm w-sm" data-f="value" id="sv-${i}" value="${act.value ?? ''}" placeholder="${act.mode === 'set' || !act.mode ? 'true / 3 / open' : '1'}">`)}
          </div>
          ${act.mode === 'set' || !act.mode ? raw('<div class="hint small faint">Numbers and true/false are detected automatically. Templates like <code>{{payload.code}}</code> work too.</div>') : ''}`;
        bind('[data-f="mode"]', 'mode', { redraw: true });
        bind('[data-f="variable"]', 'variable');
        bind('[data-f="value"]', 'value');
        break;

      case 'timer':
        f.innerHTML = html`
          <div class="sentence">
            <select class="select input-sm" data-f="command">${raw([['start', 'Start'], ['pause', 'Pause'], ['stop', 'Stop & reset'], ['reset', 'Reset'], ['add', 'Add time to'], ['subtract', 'Remove time from']].map(([v, l]) => `<option value="${v}" ${v === act.command ? 'selected' : ''}>${l}</option>`).join(''))}</select>
            <select class="select input-sm" data-f="timer"><option value="main" ${act.timer !== 'secondary' ? 'selected' : ''}>the game timer</option><option value="secondary" ${act.timer === 'secondary' ? 'selected' : ''}>${S.room ? S.room.timer.secondaryLabel : 'secondary timer'}</option></select>
            ${['add', 'subtract'].includes(act.command) ? raw(html`<span>by</span><input class="input input-sm w-sm" data-f="seconds" value="${formatTime(act.seconds || 60)}">`) : ''}
          </div>`;
        bind('[data-f="command"]', 'command', { redraw: true });
        bind('[data-f="timer"]', 'timer');
        bind('[data-f="seconds"]', 'seconds', { time: true });
        break;

      case 'http_request': {
        act.headers = Array.isArray(act.headers) ? act.headers : [];
        f.innerHTML = html`
          <div class="row">
            <select class="select input-sm" data-f="method" style="width:96px">${raw(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map(m => `<option ${m === (act.method || 'POST') ? 'selected' : ''}>${m}</option>`).join(''))}</select>
            <input class="input input-sm mono grow" data-f="url" value="${act.url || ''}" placeholder="http://192.168.1.50/relay/1/on">
          </div>
          <details ${act.headers.length || (act.body && act.method !== 'GET') ? 'open' : ''}><summary class="small muted" style="cursor:pointer">Headers & body</summary>
            <div class="stack-sm mt-8" data-headers>${raw(act.headers.map((h, hi) => html`<div class="row"><input class="input input-sm mono" data-hk="${hi}" value="${h.key}" placeholder="Header"><input class="input input-sm mono grow" data-hv="${hi}" value="${h.value}" placeholder="Value"><button class="btn btn-ghost btn-icon btn-xs" data-hdel="${hi}"><i class="icon-x"></i></button></div>`).join(''))}</div>
            <button class="btn btn-ghost btn-xs mt-8" data-hadd><i class="icon-plus"></i>Header</button>
            ${act.method !== 'GET' ? raw(html`<div class="field mt-8"><label>Body</label><textarea class="textarea mono" rows="4" data-f="body" id="body-${i}" placeholder='{"room": "{{room.name}}"}'>${act.body || ''}</textarea>${raw(templateChips(`#body-${i}`))}</div>`) : ''}
            <div class="field mt-8" style="max-width:280px"><label>Save the response into a variable (optional)</label><input class="input input-sm mono" list="var-names" data-f="saveResponseTo" value="${act.saveResponseTo || ''}" placeholder="last_response"></div>
          </details>`;
        bind('[data-f="method"]', 'method', { redraw: true });
        bind('[data-f="url"]', 'url');
        bind('[data-f="body"]', 'body');
        bind('[data-f="saveResponseTo"]', 'saveResponseTo');
        f.querySelectorAll('[data-hk]').forEach(el => el.oninput = () => { act.headers[+el.dataset.hk].key = el.value; markDirty(); });
        f.querySelectorAll('[data-hv]').forEach(el => el.oninput = () => { act.headers[+el.dataset.hv].value = el.value; markDirty(); });
        f.querySelectorAll('[data-hdel]').forEach(b => b.onclick = () => { act.headers.splice(+b.dataset.hdel, 1); update(true); });
        f.querySelector('[data-hadd]').onclick = () => { act.headers.push({ key: '', value: '' }); update(true); };
        wireChips(f);
        break;
      }

      case 'delay':
        f.innerHTML = html`<div class="sentence"><span>Wait</span><input class="input input-sm w-sm" data-f="seconds" value="${formatTime(act.seconds || 0)}"><span class="faint small">before the next step (MM:SS)</span></div>`;
        bind('[data-f="seconds"]', 'seconds', { time: true });
        break;

      case 'start_slideshow':
        f.innerHTML = html`<div class="field"><label>Slideshow</label><select class="select input-sm" data-f="slideshowId">
          <option value="">Let players choose (or play the only one)</option>
          ${raw(S.slideshows.map(s => html`<option value="${s.id}" ${s.id === act.slideshowId ? 'selected' : ''}>${s.name}</option>`).join(''))}</select>
          ${S.slideshows.length ? '' : raw(html`<div class="hint">This room has no slideshows yet – <a href="/room/${roomId}/slideshows">create one</a>.</div>`)}</div>`;
        bind('[data-f="slideshowId"]', 'slideshowId');
        break;

      case 'room_command':
        f.innerHTML = html`<div class="field"><label>Command</label><select class="select input-sm" data-f="command">${raw([['close_overlays', 'Close pop-ups on player screens'], ['clear_hints', 'Clear hints from player screens'], ['clear_chat', 'Clear the chat'], ['reload_players', 'Reload player screens']].map(([v, l]) => `<option value="${v}" ${v === act.command ? 'selected' : ''}>${l}</option>`).join(''))}</select></div>`;
        bind('[data-f="command"]', 'command');
        break;

      case 'run_automation': {
        const others = S.automations.filter(x => x.id !== S.current.id);
        f.innerHTML = html`
          <div class="field"><label>Automation</label><select class="select input-sm" data-f="automationId"><option value="">Choose…</option>${raw(others.map(o => html`<option value="${o.id}" ${o.id === act.automationId ? 'selected' : ''}>${o.name}</option>`).join(''))}</select></div>
          <label class="switch"><input type="checkbox" data-f="skipConditions" ${act.skipConditions ? 'checked' : ''}><span class="track"></span><span class="small">Ignore its “only if” checks</span></label>`;
        bind('[data-f="automationId"]', 'automationId');
        bind('[data-f="skipConditions"]', 'skipConditions');
        break;
      }
    }
  }

  /* -------------------------------------------------------------- persist */
  function validate(a) {
    if (!a.name.trim()) return 'Give the automation a name';
    const t = a.trigger;
    if (t.type === 'variable' && !t.variable) return 'Choose which variable to watch';
    if (t.type === 'manual' && !(t.label || a.name)) return 'Give the GM button a label';
    if (!a.actions.length) return 'Add at least one step';
    const bad = a.actions.find(x => !x.disabled && !actionComplete(x));
    if (bad) return `Finish setting up “${C.ACTIONS[bad.type].label}”`;
    return null;
  }

  function replaceInList(updated) {
    const i = S.automations.findIndex(x => x.id === updated.id);
    if (i >= 0) S.automations[i] = updated; else S.automations.push(updated);
  }

  async function save() {
    const a = S.current;
    const problem = validate(a);
    if (problem) return toast(problem, 'warning');
    const btn = $('#ed-save');
    btn.classList.add('loading');
    const payload = { name: a.name, enabled: a.enabled, trigger: a.trigger, conditions: a.conditions, actions: a.actions, cooldown_seconds: a.cooldown_seconds || 0 };
    try {
      const saved = a.id ? await put(`/api/v2/automations/${a.id}`, payload) : await post(`/api/v2/rooms/${roomId}/automations`, payload);
      const created = !a.id;
      replaceInList(saved);
      S.current = JSON.parse(JSON.stringify(saved));
      S.original = JSON.stringify(S.current);
      drawList();
      drawEditor();
      history.replaceState(null, '', `${location.pathname}#${saved.id}`);
      toast(created ? (saved.trigger.type === 'webhook' ? 'Created – your webhook URL is ready' : 'Automation created') : 'Saved', 'success');
    } catch (err) {
      error(err);
      btn.classList.remove('loading');
    }
  }

  async function testRun() {
    if (isDirty()) {
      const go = await confirm({ title: 'Save before testing?', message: 'Tests run the saved version of this automation.', confirmText: 'Save & test' });
      if (!go) return;
      await save();
      if (isDirty()) return;
    }
    const btn = $('#ed-test');
    btn.classList.add('loading');
    try {
      const res = await post(`/api/v2/automations/${S.current.id}/test`);
      if (res.pending) toast('Running… (has a wait step)', 'info');
      else {
        const failed = (res.results || []).filter(r => !r.ok);
        if (failed.length) toast(`${failed.length} step(s) failed: ${failed[0].error}`, 'error');
        else toast(`Ran ${res.results.length} step${res.results.length === 1 ? '' : 's'} – check a player screen`, 'success');
      }
    } catch (err) { error(err); }
    btn.classList.remove('loading');
  }

  async function duplicate() {
    try {
      const copyA = await post(`/api/v2/automations/${S.current.id}/duplicate`);
      S.automations.push(copyA);
      S.current = null;
      await select(copyA.id);
      toast('Duplicated', 'success');
    } catch (err) { error(err); }
  }

  async function remove() {
    if (!(await confirm({ title: `Delete “${esc(S.current.name)}”?`, message: S.current.trigger.type === 'webhook' ? 'Its webhook URL will stop working. This cannot be undone.' : 'This cannot be undone.', confirmText: 'Delete', danger: true }))) return;
    try {
      await del(`/api/v2/automations/${S.current.id}`);
      S.automations = S.automations.filter(x => x.id !== S.current.id);
      S.current = null;
      S.original = null;
      drawList();
      drawEditor();
      toast('Automation deleted', 'success');
    } catch (err) { error(err); }
  }

  window.addEventListener('beforeunload', (e) => { if (isDirty()) { e.preventDefault(); e.returnValue = ''; } });
  QC.hotkeys({ 'mod+s': () => { if (S.current) save(); } });

  /* ========================================================== integrations */
  function base() { return location.origin; }

  function snippetSet({ url, method = 'GET', body }) {
    const isGet = method === 'GET';
    const u = new URL(url);
    return {
      URL: url,
      curl: isGet ? `curl "${url}"` : `curl -X ${method} "${url}" \\\n  -H "Content-Type: application/json" \\\n  -d '${body || '{}'}'`,
      'ESP32 / Arduino': `#include <WiFi.h>
#include <HTTPClient.h>

// Call this when the puzzle is solved
void notifyQuandary() {
  HTTPClient http;
  http.begin("${url}");${isGet ? `
  int code = http.GET();` : `
  http.addHeader("Content-Type", "application/json");
  int code = http.${method === 'POST' ? 'POST' : 'sendRequest'}(${method === 'POST' ? '' : `"${method}", `}"${(body || '{}').replace(/"/g, '\\"')}");`}
  Serial.printf("Quandary responded: %d\\n", code);
  http.end();
}`,
      Python: `import requests

${isGet ? `requests.get("${url}", timeout=5)` : `requests.${method.toLowerCase()}("${url}", json=${body || '{}'}, timeout=5)`}`,
      'Home Assistant': `# configuration.yaml
rest_command:
  quandary_${u.pathname.split('/').filter(Boolean).slice(-2).join('_').replace(/[^\w]/g, '_')}:
    url: "${url}"
    method: ${method.toLowerCase()}${isGet ? '' : `
    content_type: "application/json"
    payload: '${body || '{}'}'`}`
    };
  }

  function codePanel(snips) {
    const keys = Object.keys(snips);
    const wrap = document.createElement('div');
    wrap.innerHTML = `<div class="code-tabs">${keys.map((k, i) => `<button class="${i === 0 ? 'active' : ''}" data-k="${esc(k)}">${esc(k)}</button>`).join('')}</div>
      <pre class="code-block"><button class="btn btn-sm copy-btn"><i class="icon-copy"></i>Copy</button><code></code></pre>`;
    const code = wrap.querySelector('code');
    let current = keys[0];
    const show = (k) => { current = k; code.textContent = snips[k]; wrap.querySelectorAll('[data-k]').forEach(b => b.classList.toggle('active', b.dataset.k === k)); };
    wrap.querySelectorAll('[data-k]').forEach(b => b.onclick = () => show(b.dataset.k));
    wrap.querySelector('.copy-btn').onclick = () => copy(snips[current], 'Copied');
    show(current);
    return wrap;
  }

  function showSnippets({ title, url, method, body }) {
    const panel = codePanel(snippetSet({ url, method, body }));
    panel.className = 'card';
    modal({ title, size: 'lg', icon: 'icon-code', body: panel });
  }

  function drawIntegrations() {
    const host = $('#view-integrations');
    const code = S.room.shortcode;
    const vars = Object.keys(S.room.variables || {});
    const hooks = S.automations.filter(a => a.trigger.type === 'webhook' && a.webhookUrl);
    const varName = vars[0] || 'door_open';
    host.innerHTML = html`
      <div class="page-head"><div class="titles"><h1>Connect props & devices</h1>
        <p>Everything below is a plain HTTP URL – it works from Arduino/ESP32, Raspberry Pi, Shelly relays, Home Assistant, Node-RED, Stream Deck, Bitfocus Companion or a browser. URLs use the room code <span class="badge badge-accent mono">${code}</span>.</p></div></div>
      <div class="int-grid">
        <section class="card">
          <div class="card-head"><i class="icon-variable" style="color:var(--accent)"></i><h3 class="grow">Set game variables</h3></div>
          <div class="card-body stack">
            <p class="small muted">Devices report state by setting variables. Automations react to the change.</p>
            <div class="row"><label class="label" for="int-var">Variable</label>
              <input class="input input-sm mono grow" id="int-var" list="int-var-list" value="${varName}">
              <datalist id="int-var-list">${raw(vars.map(v => `<option value="${esc(v)}">`).join(''))}</datalist>
              <input class="input input-sm" id="int-val" value="true" style="width:100px" aria-label="Value"></div>
            <div data-var-endpoints></div>
            <div data-var-code></div>
          </div>
        </section>
        <section class="card">
          <div class="card-head"><i class="icon-timer" style="color:var(--warning)"></i><h3 class="grow">Control the timer & send hints</h3></div>
          <div class="card-body">
            <p class="small muted mb-8">Great for Stream Deck / Companion buttons or a physical start button.</p>
            ${raw(['start', 'pause', 'toggle', 'reset'].map(c => endpointRow('GET', `${base()}/api/v2/rooms/${code}/timer/${c}`)).join(''))}
            ${raw(endpointRow('GET', `${base()}/api/v2/rooms/${code}/timer/add?seconds=60`))}
            ${raw(endpointRow('GET', `${base()}/api/v2/rooms/${code}/timer/start?timer=secondary`))}
            ${raw(endpointRow('POST', `${base()}/api/v2/rooms/${code}/hint`, '{"message": "Look under the rug"}'))}
          </div>
        </section>
        <section class="card" style="grid-column:1/-1">
          <div class="card-head"><i class="icon-webhook" style="color:var(--info)"></i><h3 class="grow">Webhook automations</h3>
            <button class="btn btn-sm" id="int-new-hook"><i class="icon-plus"></i>New webhook</button></div>
          <div class="card-body">
            ${hooks.length ? raw(hooks.map(h => html`<div class="endpoint"><span class="method post">ANY</span><strong style="min-width:180px">${h.name}</strong><code>${h.webhookUrl}</code>
              <button class="btn btn-ghost btn-icon btn-xs" data-copy="${h.webhookUrl}"><i class="icon-copy"></i></button>
              <button class="btn btn-ghost btn-xs" data-open="${h.id}">Edit</button></div>`).join(''))
              : raw('<p class="small muted">No webhook automations yet. A webhook automation gives you a secret URL that runs a whole list of steps when called – ideal for “puzzle solved” signals.</p>')}
          </div>
        </section>
        <section class="card" style="grid-column:1/-1">
          <div class="card-head"><i class="icon-send" style="color:var(--success)"></i><h3 class="grow">Sending commands out to devices</h3></div>
          <div class="card-body small muted">Add a <strong>Call a URL</strong> step to any automation to trigger relays, lights, sound systems or other software. Use <code>{{variable_name}}</code>, <code>{{timer.remaining_formatted}}</code> or <code>{{payload.field}}</code> in the URL or body.
            Tip: a <em>GM button</em> automation with a single “Call a URL” step gives the Game Master a one-click control for any networked device.</div>
        </section>
      </div>`;

    function endpointRow(method, url, body) {
      return html`<div class="endpoint"><span class="method ${method === 'POST' ? 'post' : ''}">${method}</span><code title="${url}">${url}</code>
        <button class="btn btn-ghost btn-icon btn-xs" data-copy="${url}" aria-label="Copy"><i class="icon-copy"></i></button>
        <button class="btn btn-ghost btn-xs" data-code="${url}" data-method="${method}" data-body="${body || ''}">Code</button>
        ${method === 'GET' ? raw(html`<button class="btn btn-ghost btn-xs" data-try="${url}">Try</button>`) : ''}</div>`;
    }

    function drawVarEndpoints() {
      const name = $('#int-var').value.trim() || 'my_variable';
      const val = encodeURIComponent($('#int-val').value);
      const setUrl = `${base()}/api/v2/rooms/${code}/variables/${encodeURIComponent(name)}/set?value=${val}`;
      host.querySelector('[data-var-endpoints]').innerHTML = [
        endpointRow('GET', setUrl),
        endpointRow('GET', `${base()}/api/v2/rooms/${code}/variables/${encodeURIComponent(name)}/increment?by=1`),
        endpointRow('GET', `${base()}/api/v2/rooms/${code}/variables/${encodeURIComponent(name)}/toggle`),
        endpointRow('GET', `${base()}/api/v2/rooms/${code}/variables`)
      ].join('');
      const panel = codePanel(snippetSet({ url: setUrl, method: 'GET' }));
      panel.className = 'card';
      const holder = host.querySelector('[data-var-code]');
      holder.innerHTML = '';
      holder.appendChild(panel);
      wire(host.querySelector('[data-var-endpoints]'));
    }

    function wire(root) {
      root.querySelectorAll('[data-copy]').forEach(b => b.onclick = () => copy(b.dataset.copy));
      root.querySelectorAll('[data-code]').forEach(b => b.onclick = () => showSnippets({ title: 'Code snippets', url: b.dataset.code, method: b.dataset.method, body: b.dataset.body }));
      root.querySelectorAll('[data-try]').forEach(b => b.onclick = async () => {
        try {
          const res = await fetch(b.dataset.try);
          const j = await res.json();
          toast(j.success ? `OK – ${JSON.stringify(j.data).slice(0, 90)}` : j.error, j.success ? 'success' : 'error', { timeout: 5000 });
          if (j.success) refreshRoom();
        } catch (err) { error(err); }
      });
      root.querySelectorAll('[data-open]').forEach(b => b.onclick = () => { setView('automations'); select(b.dataset.open); });
    }

    $('#int-var').oninput = QC.debounce(drawVarEndpoints, 200);
    $('#int-val').oninput = QC.debounce(drawVarEndpoints, 200);
    $('#int-new-hook').onclick = () => {
      setView('automations');
      S.current = { id: null, enabled: true, cooldown_seconds: 0, conditions: { mode: 'all', rules: [] }, ...C.RECIPES.find(r => r.id === 'prop-solved').build() };
      S.original = '';
      drawList();
      drawEditor();
    };
    drawVarEndpoints();
    wire(host);
  }

  /* ============================================================== activity */
  function drawActivity() {
    const host = $('#view-activity');
    const icons = { run: 'icon-zap', error: 'icon-circle-x', skip: 'icon-skip-forward', info: 'icon-info' };
    host.innerHTML = html`
      <div class="page-head"><div class="titles"><h1>Activity</h1><p>Live log of automation runs, skipped triggers and errors for this room (last 100, kept until the server restarts).</p></div>
        <button class="btn btn-sm" id="act-refresh"><i class="icon-refresh-cw"></i>Refresh</button></div>
      <div class="card">${S.logs.length ? raw(S.logs.map(l => html`
        <div class="log-item ${l.level}">
          <span class="when">${new Date(l.at).toLocaleTimeString()}</span>
          <i class="${icons[l.level] || 'icon-info'}"></i>
          <div class="grow">${l.automation ? raw(html`<strong>${l.automation}</strong> – `) : ''}${l.message}${l.response ? raw(html`<pre>${l.response}</pre>`) : ''}</div>
          ${l.automationId && S.automations.some(a => a.id === l.automationId) ? raw(html`<button class="btn btn-ghost btn-xs" data-open="${l.automationId}">Open</button>`) : ''}
        </div>`).join('')) : raw('<div class="empty"><div class="empty-icon"><i class="icon-activity"></i></div><h3>Nothing yet</h3><p>Runs appear here live. Use “Test now” on an automation, or start the game timer.</p></div>')}</div>`;
    host.querySelector('#act-refresh').onclick = async () => { S.logs = await get(`/api/v2/rooms/${roomId}/automations/logs`); drawActivity(); };
    host.querySelectorAll('[data-open]').forEach(b => b.onclick = () => { setView('automations'); select(b.dataset.open); });
  }

  /* ================================================================== boot */
  async function loadMedia() {
    try { S.media = await get(`/api/v2/rooms/${roomId}/media`); } catch (_) { S.media = []; }
    try { S.audio = await get(`/api/rooms/${roomId}/notifications/audio`); } catch (_) { S.audio = []; }
  }

  async function refreshRoom() {
    try { S.room = await get(`/api/v2/rooms/${roomId}`); } catch (_) { /* keep old */ }
  }

  (async function boot() {
    try {
      [S.room, S.automations, S.slideshows, S.logs] = await Promise.all([
        get(`/api/v2/rooms/${roomId}`),
        get(`/api/v2/rooms/${roomId}/automations`),
        get(`/api/v2/rooms/${roomId}/slideshows`).catch(() => []),
        get(`/api/v2/rooms/${roomId}/automations/logs`).catch(() => [])
      ]);
    } catch (err) {
      document.querySelector('#view-automations').innerHTML = html`<div class="empty" style="grid-column:1/-1"><div class="empty-icon"><i class="icon-door-closed"></i></div><h3>Could not load this room</h3><p>${err.message}</p><a class="btn" href="/">Back to dashboard</a></div>`;
      return;
    }
    QC.applyRoomAppearance(S.room, { background: false });
    document.title = `Automations · ${S.room.name}`;
    $('#room-name').textContent = S.room.name;
    $('#gm-link').href = `/room/${roomId}/gm`;
    loadMedia();
    drawList();

    const hash = location.hash.slice(1);
    if (['integrations', 'activity'].includes(hash)) {
      drawEditor();
      setView(hash);
    } else if (hash && S.automations.some(a => a.id === hash)) {
      await select(hash);
    } else if (S.automations.length) {
      await select(S.automations[0].id);
    } else {
      drawEditor();
    }
  })();
})();
