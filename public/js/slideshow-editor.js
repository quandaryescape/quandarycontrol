/* Slideshow Studio */
(function () {
  'use strict';
  const { html, raw, escape: esc, get, post, put, del, toast, error, confirm, prompt, modal, drawer, menu, formatTime, $, $$ } = QC;
  const R = window.SlideRender;

  const roomId = QC.roomIdFromPath();
  const S = {
    room: null,
    shows: [],
    show: null,       // full slideshow being edited (with slides)
    sel: 0,
    saving: false,
    dirty: false
  };

  /* --------------------------------------------------------------- saving */
  function setSaveState(kind) {
    const el = $('#save-state');
    const map = {
      saved: '<i class="icon-check"></i> All changes saved',
      saving: '<i class="icon-loader-circle"></i> Saving…',
      dirty: '<span class="unsaved-dot" style="display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--warning)"></span> Unsaved',
      error: '<i class="icon-triangle-alert" style="color:var(--danger)"></i> Not saved – retrying'
    };
    el.innerHTML = map[kind] || '';
  }

  const autosave = QC.debounce(async () => {
    if (!S.show) return;
    S.saving = true;
    setSaveState('saving');
    const snapshot = JSON.stringify(S.show);
    try {
      const saved = await put(`/api/v2/slideshows/${S.show.id}`, {
        name: S.show.name,
        description: S.show.description,
        settings: S.show.settings,
        slides: S.show.slides
      });
      // Keep server-assigned ids without clobbering edits made while saving
      if (JSON.stringify(S.show) === snapshot) {
        S.show.slides.forEach((s, i) => { if (saved.slides[i]) s.id = saved.slides[i].id; });
        S.dirty = false;
        setSaveState('saved');
      } else {
        autosave();
      }
      const listItem = S.shows.find(x => x.id === saved.id);
      if (listItem) Object.assign(listItem, { name: saved.name, description: saved.description, slideCount: saved.slideCount, thumbnail: saved.thumbnail, thumbnailType: saved.thumbnailType, firstSlide: saved.firstSlide, settings: saved.settings, estimatedSeconds: saved.estimatedSeconds });
      drawShows();
    } catch (err) {
      setSaveState('error');
      toast(`Save failed: ${err.message}`, 'error');
      setTimeout(autosave, 4000);
    }
    S.saving = false;
  }, 700);

  function changed({ stage = true, film = true, inspector = false } = {}) {
    S.dirty = true;
    setSaveState('dirty');
    if (stage) drawStage();
    if (film) drawFilmstrip();
    if (inspector) drawInspector();
    autosave();
  }

  window.addEventListener('beforeunload', (e) => {
    if (S.dirty) { autosave.flush(); e.preventDefault(); e.returnValue = ''; }
  });

  /* ---------------------------------------------------------- show list */
  function thumbFrame(show) {
    const frame = document.createElement('div');
    frame.className = 'ss-frame ratio';
    R.applyShow(frame, show.settings || {});
    if (show.settings && show.settings.cover) {
      frame.appendChild(R.render({ type: 'image', media_url: show.settings.cover, settings: { fit: 'cover' } }, { mode: 'thumb' }));
    } else if (show.firstSlide) {
      frame.appendChild(R.render(show.firstSlide, { mode: 'thumb' }));
    }
    return frame;
  }

  function drawShows() {
    const list = $('#shows-list');
    list.innerHTML = '';
    S.shows.forEach(s => {
      const b = document.createElement('button');
      b.className = `show-item ${S.show && S.show.id === s.id ? 'active' : ''}`;
      b.dataset.id = s.id;
      b.innerHTML = html`<div class="si-thumb"></div>
        <div class="grow"><div class="si-name truncate">${s.name}</div><div class="si-meta">${s.slideCount} slide${s.slideCount === 1 ? '' : 's'}${s.estimatedSeconds ? ` · ~${Math.max(1, Math.round(s.estimatedSeconds / 60))} min` : ''}</div></div>
        <span class="btn btn-ghost btn-icon btn-xs si-more" data-more role="button" aria-label="Slideshow options"><i class="icon-ellipsis"></i></span>`;
      b.querySelector('.si-thumb').appendChild(thumbFrame(s));
      b.onclick = (e) => {
        if (e.target.closest('[data-more]')) return showMenu(e.target.closest('[data-more]'), s);
        openShow(s.id);
      };
      list.appendChild(b);
    });
    $('#shows-foot').textContent = S.shows.length > 1
      ? `Players choose between ${S.shows.length} slideshows. Drag to change their order.`
      : S.shows.length === 1 ? 'With one slideshow, players go straight into it.' : '';
  }

  function showMenu(anchor, s) {
    menu(anchor, [
      { label: 'Preview', icon: 'icon-play', onClick: () => window.open(`/room/${roomId}/slideshow/${s.id}?preview=1`, '_blank') },
      { label: 'Copy link', icon: 'icon-link', onClick: () => QC.copy(`${location.origin}/room/${roomId}/slideshow/${s.id}`, 'Slideshow link copied') },
      { label: 'Duplicate', icon: 'icon-copy', onClick: () => duplicateShow(s) },
      'divider',
      { label: 'Delete slideshow', icon: 'icon-trash-2', danger: true, onClick: () => deleteShow(s) }
    ]);
  }

  async function loadShows() {
    S.shows = await get(`/api/v2/rooms/${roomId}/slideshows`);
    drawShows();
  }

  async function openShow(id) {
    if (S.show && S.show.id === id) return;
    if (S.dirty) await autosave.flush();
    try {
      S.show = await get(`/api/v2/slideshows/${id}`);
    } catch (err) { return error(err); }
    S.sel = 0;
    S.dirty = false;
    history.replaceState(null, '', `${location.pathname}#${id}`);
    $('#no-show').hidden = true;
    $('#editor').hidden = false;
    $('#inspector').hidden = false;
    $('#preview-btn').disabled = false;
    $('#show-name').value = S.show.name;
    $('#show-desc').value = S.show.description || '';
    setSaveState('saved');
    drawShows();
    drawStage();
    drawFilmstrip();
    drawInspector();
  }

  async function duplicateShow(s) {
    try {
      const copy = await post(`/api/v2/slideshows/${s.id}/duplicate`);
      await loadShows();
      openShow(copy.id);
      toast('Slideshow duplicated', 'success');
    } catch (err) { error(err); }
  }

  async function deleteShow(s) {
    if (!(await confirm({ title: `Delete “${esc(s.name)}”?`, message: `Its ${s.slideCount} slide(s) will be removed. Uploaded images and videos stay in the room's media library.`, confirmText: 'Delete', danger: true }))) return;
    try {
      await del(`/api/v2/slideshows/${s.id}`);
      if (S.show && S.show.id === s.id) {
        S.show = null;
        S.dirty = false;
        $('#editor').hidden = true;
        $('#inspector').hidden = true;
        $('#no-show').hidden = false;
        $('#preview-btn').disabled = true;
        setSaveState('');
      }
      await loadShows();
      if (!S.show && S.shows.length) openShow(S.shows[0].id);
      toast('Slideshow deleted', 'success');
    } catch (err) { error(err); }
  }

  QC.sortable($('#shows-list'), {
    items: '.show-item',
    onEnd: async (ids) => {
      try {
        S.shows = await post(`/api/v2/rooms/${roomId}/slideshows/reorder`, { ids });
        drawShows();
      } catch (err) { error(err); }
    }
  });

  /* ------------------------------------------------------- new slideshow */
  function briefingTemplate(roomName, minutes) {
    return [
      { type: 'text', title: `Welcome to ${roomName}`, body: `You have **${minutes} minutes** to escape.`, settings: { icon: '🔐', layout: 'center', titleSize: 'xl', bodySize: 'l' } },
      { type: 'text', title: 'Your mission', body: 'Describe the story here: who the players are, what happened, and what they must do to win.', settings: { layout: 'center', titleSize: 'l', bodySize: 'm' } },
      { type: 'text', title: 'House rules', body: '- No force is needed – nothing requires strength\n- Don\'t climb on furniture or touch light fittings\n- Items with a **red sticker** are not part of the game\n- Please keep phones and cameras away', settings: { layout: 'top', titleSize: 'l', bodySize: 'm', align: 'left' } },
      { type: 'text', title: 'Need a hint?', body: 'Your Game Master is watching. Ask for help any time – hints appear on this screen.', settings: { icon: '💡', layout: 'center', titleSize: 'l', bodySize: 'm' } },
      { type: 'text', title: 'Ready?', body: 'The clock starts when your Game Master closes the door.\nGood luck!', settings: { icon: '⏱️', layout: 'center', titleSize: 'xl', bodySize: 'l' } }
    ];
  }

  function kidsTemplate(roomName) {
    return [
      { type: 'text', title: `Welcome, adventurers!`, body: `Get ready for **${roomName}**!`, settings: { icon: '🗝️', titleSize: 'xl', bodySize: 'l' } },
      { type: 'text', title: 'Play nice', body: '- Be gentle – nothing needs pushing hard\n- Work as a team and share your ideas\n- Stuck? Just ask for a clue!', settings: { icon: '🤝', layout: 'top', titleSize: 'l', bodySize: 'l', align: 'left' } },
      { type: 'text', title: 'Let\'s go!', body: 'Find the clues and solve the puzzles before time runs out.', settings: { icon: '🚀', titleSize: 'xl', bodySize: 'l' } }
    ];
  }

  async function newShow() {
    if (S.dirty) await autosave.flush();
    const body = document.createElement('div');
    body.className = 'stack';
    let tpl = 'briefing';
    let files = null;
    body.innerHTML = html`
      <div class="field"><label for="ns-name">Name</label><input class="input" id="ns-name" value="${S.shows.length ? '' : 'Rules'}" placeholder="e.g. Rules, Kids briefing, Español"></div>
      <div class="field"><label for="ns-desc">Description <span class="faint">(shown when players choose)</span></label><input class="input" id="ns-desc" placeholder="e.g. Standard briefing – about 2 minutes"></div>
      <div class="field"><label>Start with</label>
        <div class="tpl-grid">
          <button class="tpl active" data-t="briefing"><i class="icon-clipboard-list"></i><strong>Escape room briefing</strong><span>Welcome, story, house rules, hints, ready – just edit the text.</span></button>
          <button class="tpl" data-t="kids"><i class="icon-baby"></i><strong>Kids & families</strong><span>Shorter and friendlier, with big text.</span></button>
          <button class="tpl" data-t="images"><i class="icon-images"></i><strong>From images / videos</strong><span>Pick files – one slide each, in order.</span></button>
          <button class="tpl" data-t="blank"><i class="icon-file"></i><strong>Blank</strong><span>A single empty slide.</span></button>
        </div>
        <div class="hint" id="ns-files"></div>
      </div>`;
    body.querySelectorAll('[data-t]').forEach(b => b.onclick = async () => {
      tpl = b.dataset.t;
      body.querySelectorAll('[data-t]').forEach(x => x.classList.toggle('active', x === b));
      if (tpl === 'images') {
        files = await QC.pickFiles({ accept: 'image/*,video/*', multiple: true });
        body.querySelector('#ns-files').textContent = files ? `${files.length} file(s) selected` : 'No files selected';
      }
    });

    const created = await modal({
      title: 'New slideshow', icon: 'icon-presentation', body, size: 'lg',
      actions: [{ label: 'Cancel', value: null }, {
        label: 'Create', variant: 'primary', icon: 'icon-plus',
        onClick: async () => {
          const name = body.querySelector('#ns-name').value.trim();
          if (!name) { body.querySelector('#ns-name').classList.add('invalid'); body.querySelector('#ns-name').focus(); return false; }
          const minutes = Math.round(((S.room && S.room.timer.duration) || 3600) / 60);
          let slides;
          if (tpl === 'briefing') slides = briefingTemplate(S.room.name, minutes);
          else if (tpl === 'kids') slides = kidsTemplate(S.room.name);
          else if (tpl === 'images') {
            if (!files || !files.length) { toast('Choose some files first', 'warning'); return false; }
            const ups = await QC.upload(files, { roomId, category: 'slides' });
            slides = ups.filter(u => u.type === 'image' || u.type === 'video').map(u => ({ type: u.type, media_url: u.url, settings: { fit: 'contain' } }));
          } else slides = [{ type: 'text', title: name, body: '', settings: {} }];
          return post(`/api/v2/rooms/${roomId}/slideshows`, {
            name,
            description: body.querySelector('#ns-desc').value.trim(),
            settings: { accent: QC.roomAccent(S.room) },
            slides
          });
        }
      }]
    });
    if (created) {
      await loadShows();
      openShow(created.id);
      toast('Slideshow created – click any slide to edit it', 'success');
    }
  }
  $('#new-show').onclick = newShow;
  $('#empty-new').onclick = newShow;

  /* --------------------------------------------------------------- stage */
  function current() { return S.show && S.show.slides[S.sel]; }

  function drawStage() {
    const stage = $('#stage');
    R.applyShow(stage, S.show.settings);
    stage.innerHTML = '';
    const slide = current();
    if (!slide) {
      stage.innerHTML = '<div class="ss-slide"><div class="ss-empty">No slides – add one below</div></div>';
      return;
    }
    const el = R.render(slide, { mode: 'editor' });
    stage.appendChild(el);
    const v = el.querySelector('video');
    if (v) { v.controls = true; v.preload = 'metadata'; v.style.zIndex = 1; }
  }

  // Bulk add by dropping files on the stage
  const wrap = $('#stage-wrap');
  wrap.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); wrap.classList.add('dragover'); } });
  wrap.addEventListener('dragleave', (e) => { if (!wrap.contains(e.relatedTarget)) wrap.classList.remove('dragover'); });
  wrap.addEventListener('drop', (e) => {
    e.preventDefault();
    wrap.classList.remove('dragover');
    if (e.dataTransfer.files.length) addMediaSlides(e.dataTransfer.files);
  });

  async function addMediaSlides(files) {
    const dismiss = toast(`Uploading ${files.length} file${files.length > 1 ? 's' : ''}…`, 'info', { timeout: 0 });
    try {
      const ups = await QC.upload(files, { roomId, category: 'slides' });
      dismiss();
      const slides = ups.filter(u => u.type === 'image' || u.type === 'video').map(u => ({ type: u.type, media_url: u.url, title: '', body: '', settings: { fit: 'contain' } }));
      if (!slides.length) return toast('Only images and videos can become slides', 'warning');
      S.show.slides.splice(S.sel + 1, 0, ...slides);
      S.sel = S.sel + 1;
      changed({ inspector: true });
      toast(`Added ${slides.length} slide${slides.length > 1 ? 's' : ''}`, 'success');
    } catch (err) { dismiss(); error(err); }
  }

  /* ----------------------------------------------------------- filmstrip */
  function drawFilmstrip() {
    const strip = $('#filmstrip');
    strip.innerHTML = '';
    S.show.slides.forEach((slide, i) => {
      const b = document.createElement('div');
      b.className = `film ${i === S.sel ? 'active' : ''}`;
      b.dataset.id = String(i);
      b.tabIndex = 0;
      const dur = R.durationOf(slide, S.show);
      b.innerHTML = `<span class="f-num">${i + 1}</span>
        ${slide.type !== 'text' ? `<span class="f-type"><i class="${slide.type === 'video' ? 'icon-video' : 'icon-image'}"></i></span>` : ''}
        ${dur ? `<span class="f-dur">${dur}s</span>` : ''}
        <span class="f-actions"><button class="dup" data-dup title="Duplicate"><i class="icon-copy"></i></button><button data-del title="Delete"><i class="icon-trash-2"></i></button></span>`;
      const frame = document.createElement('div');
      frame.className = 'ss-frame ratio';
      R.applyShow(frame, S.show.settings);
      frame.appendChild(R.render(slide, { mode: 'thumb' }));
      b.prepend(frame);
      b.addEventListener('click', (e) => {
        if (e.target.closest('[data-del]')) return removeSlide(i);
        if (e.target.closest('[data-dup]')) return duplicateSlide(i);
        select(i);
      });
      strip.appendChild(b);
    });
    const active = strip.querySelector('.film.active');
    if (active) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  QC.sortable($('#filmstrip'), {
    items: '.film', axis: 'x',
    onEnd: (ids) => {
      const selected = S.show.slides[S.sel];
      S.show.slides = ids.map(i => S.show.slides[+i]);
      S.sel = S.show.slides.indexOf(selected);
      changed({ inspector: false });
    }
  });

  function select(i) {
    if (!S.show.slides.length) return;
    S.sel = Math.max(0, Math.min(S.show.slides.length - 1, i));
    drawStage();
    drawFilmstrip();
    drawInspector();
  }

  function duplicateSlide(i) {
    const copy = JSON.parse(JSON.stringify(S.show.slides[i]));
    delete copy.id;
    S.show.slides.splice(i + 1, 0, copy);
    S.sel = i + 1;
    changed({ inspector: true });
  }

  async function removeSlide(i) {
    const slide = S.show.slides[i];
    const removed = S.show.slides.splice(i, 1)[0];
    if (S.sel >= S.show.slides.length) S.sel = Math.max(0, S.show.slides.length - 1);
    changed({ inspector: true });
    toast('Slide deleted', 'info', {
      timeout: 6000,
      action: { label: 'Undo', onClick: () => { S.show.slides.splice(i, 0, removed); S.sel = i; changed({ inspector: true }); } }
    });
    return slide;
  }

  $('#add-text').onclick = () => {
    const prev = current();
    const settings = prev && prev.type === 'text' ? { ...prev.settings, icon: '', duration: prev.settings.duration } : { layout: 'center', titleSize: 'l', bodySize: 'm' };
    S.show.slides.splice(S.sel + 1, 0, { type: 'text', title: 'New slide', body: '', settings });
    S.sel = S.show.slides.length === 1 ? 0 : S.sel + 1;
    changed({ inspector: true });
    setTimeout(() => { const t = $('#in-title'); if (t) { t.focus(); t.select(); } }, 30);
  };
  $('#add-media').onclick = async () => {
    const files = await QC.pickFiles({ accept: 'image/*,video/*', multiple: true });
    if (files) addMediaSlides(files);
  };

  /* ----------------------------------------------------------- inspector */
  const EMOJI = ['🔐', '🗝️', '⏱️', '💡', '⚠️', '🚫', '📵', '🤝', '🧩', '🔍', '🏆', '💀', '🧪', '🕯️', '🚀', '✅'];

  function seg(name, value, options) {
    return `<div class="segmented" data-seg="${esc(name)}">${options.map(([v, label, icon]) => `<button type="button" data-v="${esc(v)}" class="${String(value) === String(v) ? 'active' : ''}">${icon ? `<i class="${icon}"></i>` : ''}${esc(label)}</button>`).join('')}</div>`;
  }

  function colorField(key, value, fallback) {
    return `<span class="color-input"><input type="color" data-color="${esc(key)}" value="${esc(value || fallback)}">${value ? `<button class="btn btn-ghost btn-xs" data-color-reset="${esc(key)}">Reset</button>` : '<span class="faint tiny">default</span>'}</span>`;
  }

  function drawInspector() {
    const insp = $('#inspector');
    const slide = current();
    if (!slide) { insp.innerHTML = '<div class="insp-section"><p class="muted small">Add a slide to start editing.</p></div>'; return; }
    const s = slide.settings = slide.settings || {};
    const showDur = S.show.settings.advance === 'auto' ? `${S.show.settings.autoSeconds}s (slideshow default)` : 'Wait for next (manual)';

    let content = '';
    if (slide.type === 'text') {
      content = html`
        <div class="insp-section">
          <div class="insp-title"><i class="icon-type"></i>Text</div>
          <div class="field"><label for="in-title">Title</label><input class="input" id="in-title" value="${slide.title || ''}"></div>
          <div class="field"><label for="in-body">Body</label><textarea class="textarea" id="in-body" rows="6">${slide.body || ''}</textarea>
            <div class="text-help">Start lines with <code>- </code> for bullets. Wrap words in <code>**stars**</code> to highlight them.</div></div>
          <div class="field"><label>Icon / emoji</label>
            <div class="row"><input class="input input-sm" id="in-icon" value="${s.icon || ''}" style="width:70px;text-align:center;font-size:18px" maxlength="8"><div class="emoji-row">${raw(EMOJI.map(e => `<button type="button" data-emoji="${e}">${e}</button>`).join(''))}</div></div></div>
        </div>
        <div class="insp-section">
          <div class="insp-title"><i class="icon-layout-template"></i>Layout</div>
          <div class="insp-row"><span class="label">Position</span>${raw(seg('layout', s.layout || 'center', [['center', 'Center'], ['top', 'Top'], ['left', 'Left']]))}</div>
          <div class="insp-row"><span class="label">Align</span>${raw(seg('align', s.align || 'center', [['center', '', 'icon-align-center'], ['left', '', 'icon-align-left']]))}</div>
          <div class="insp-row"><span class="label">Title size</span>${raw(seg('titleSize', s.titleSize || 'l', [['s', 'S'], ['m', 'M'], ['l', 'L'], ['xl', 'XL']]))}</div>
          <div class="insp-row"><span class="label">Body size</span>${raw(seg('bodySize', s.bodySize || 'm', [['s', 'S'], ['m', 'M'], ['l', 'L'], ['xl', 'XL']]))}</div>
        </div>
        <div class="insp-section">
          <div class="insp-title"><i class="icon-paintbrush"></i>Colours & background</div>
          <div class="insp-row"><span class="label">Background</span>${raw(colorField('bg', s.bg, S.show.settings.background || '#000000'))}</div>
          <div class="insp-row"><span class="label">Text</span>${raw(colorField('textColor', s.textColor, S.show.settings.textColor || '#ffffff'))}</div>
          <div class="insp-row"><span class="label">Title</span>${raw(colorField('titleColor', s.titleColor, s.textColor || S.show.settings.textColor || '#ffffff'))}</div>
          <div class="insp-row"><span class="label">Image</span>
            ${s.bgImage ? raw(html`<img src="${s.bgImage}" style="width:64px;height:36px;object-fit:cover;border-radius:5px" alt="">`) : ''}
            <button class="btn btn-sm" id="in-bgimg"><i class="icon-image"></i>${s.bgImage ? 'Change' : 'Add'}</button>
            ${s.bgImage ? raw('<button class="btn btn-ghost btn-sm" id="in-bgimg-clear">Remove</button>') : ''}</div>
          ${s.bgImage ? raw(html`<div class="insp-row"><span class="label">Darken</span><input type="range" min="0" max="0.9" step="0.05" id="in-overlay" value="${s.overlay ?? 0.45}"></div>`) : ''}
        </div>`;
    } else {
      const isVideo = slide.type === 'video';
      content = html`
        <div class="insp-section">
          <div class="insp-title"><i class="${isVideo ? 'icon-video' : 'icon-image'}"></i>${isVideo ? 'Video' : 'Image'}</div>
          ${slide.media_url ? raw(html`<div class="media-thumb">${raw(isVideo ? html`<video src="${slide.media_url}#t=0.5" muted preload="metadata"></video>` : html`<img src="${slide.media_url}" alt="">`)}</div>`) : raw('<div class="callout warning"><i class="icon-image-off"></i><div class="small">No file chosen yet.</div></div>')}
          <button class="btn btn-sm" id="in-media"><i class="icon-replace"></i>${slide.media_url ? 'Replace' : 'Choose'} ${isVideo ? 'video' : 'image'}</button>
          <div class="insp-row"><span class="label">Fit</span>${raw(seg('fit', s.fit || 'contain', [['contain', 'Whole', 'icon-shrink'], ['cover', 'Fill screen', 'icon-expand']]))}</div>
          <div class="insp-row"><span class="label">Background</span>${raw(colorField('bg', s.bg, S.show.settings.background || '#000000'))}</div>
          ${isVideo ? raw(html`
            <label class="switch"><input type="checkbox" id="in-sound" ${s.muted ? '' : 'checked'}><span class="track"></span><span class="small">Play with sound</span></label>
            <label class="switch"><input type="checkbox" id="in-wait" ${s.waitForEnd === false ? '' : 'checked'}><span class="track"></span><span class="small">Go to the next slide when the video ends</span></label>
            <label class="switch"><input type="checkbox" id="in-loop" ${s.loopVideo ? 'checked' : ''}><span class="track"></span><span class="small">Loop video</span></label>`) : ''}
        </div>
        <div class="insp-section">
          <div class="insp-title"><i class="icon-captions"></i>Caption <span class="faint" style="text-transform:none;letter-spacing:0;font-weight:500">(optional)</span></div>
          <input class="input input-sm" id="in-title" value="${slide.title || ''}" placeholder="Caption title">
          <textarea class="textarea" id="in-body" rows="2" placeholder="Caption text">${slide.body || ''}</textarea>
          <div class="insp-row"><span class="label">Position</span>${raw(seg('captionPos', s.captionPos || 'bottom', [['bottom', 'Bottom'], ['top', 'Top']]))}</div>
        </div>`;
    }

    insp.innerHTML = html`
      <div class="insp-section">
        <div class="row"><div class="insp-title grow"><i class="icon-square-stack"></i>Slide ${S.sel + 1} of ${S.show.slides.length}</div>
          <button class="btn btn-ghost btn-icon btn-xs" id="in-dup" data-tip="Duplicate"><i class="icon-copy"></i></button>
          <button class="btn btn-ghost btn-icon btn-xs" id="in-del" data-tip="Delete"><i class="icon-trash-2"></i></button></div>
        ${raw(seg('type', slide.type, [['text', 'Text', 'icon-type'], ['image', 'Image', 'icon-image'], ['video', 'Video', 'icon-video']]))}
      </div>
      ${raw(content)}
      <div class="insp-section">
        <div class="insp-title"><i class="icon-timer"></i>Timing</div>
        <div class="insp-row"><span class="label">Show for</span>
          <select class="select input-sm" id="in-duration">
            <option value="0" ${!(Number(s.duration) > 0) ? 'selected' : ''}>${showDur}</option>
            ${raw([3, 5, 8, 10, 15, 20, 30, 45, 60].map(n => `<option value="${n}" ${Number(s.duration) === n ? 'selected' : ''}>${n} seconds</option>`).join(''))}
          </select></div>
      </div>`;

    // wiring
    const s2 = slide.settings;
    insp.querySelectorAll('[data-seg]').forEach(group => group.querySelectorAll('button').forEach(b => b.onclick = () => {
      const key = group.dataset.seg;
      if (key === 'type') {
        if (slide.type === b.dataset.v) return;
        slide.type = b.dataset.v;
        if (slide.type === 'text') slide.media_url = '';
        changed({ inspector: true });
        return;
      }
      s2[key] = b.dataset.v;
      group.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
      changed();
    }));
    const title = insp.querySelector('#in-title');
    if (title) title.oninput = () => { slide.title = title.value; changed(); };
    const body = insp.querySelector('#in-body');
    if (body) body.oninput = () => { slide.body = body.value; changed(); };
    const icon = insp.querySelector('#in-icon');
    if (icon) icon.oninput = () => { s2.icon = icon.value; changed(); };
    insp.querySelectorAll('[data-emoji]').forEach(b => b.onclick = () => { s2.icon = s2.icon === b.dataset.emoji ? '' : b.dataset.emoji; changed({ inspector: true }); });
    insp.querySelectorAll('[data-color]').forEach(inp => {
      inp.oninput = () => { s2[inp.dataset.color] = inp.value; changed({ film: false }); };
      inp.onchange = () => { changed({ inspector: true }); };
    });
    insp.querySelectorAll('[data-color-reset]').forEach(b => b.onclick = () => { delete s2[b.dataset.colorReset]; changed({ inspector: true }); });
    const bgimg = insp.querySelector('#in-bgimg');
    if (bgimg) bgimg.onclick = async () => {
      const picked = await QC.pickMedia({ roomId, accept: 'image/*', types: ['image'], title: 'Background image' });
      if (picked) { s2.bgImage = picked.url; changed({ inspector: true }); }
    };
    const bgclear = insp.querySelector('#in-bgimg-clear');
    if (bgclear) bgclear.onclick = () => { delete s2.bgImage; changed({ inspector: true }); };
    const overlay = insp.querySelector('#in-overlay');
    if (overlay) overlay.oninput = () => { s2.overlay = Number(overlay.value); changed({ film: false }); };
    const mediaBtn = insp.querySelector('#in-media');
    if (mediaBtn) mediaBtn.onclick = async () => {
      const picked = await QC.pickMedia({ roomId, accept: slide.type === 'video' ? 'video/*' : 'image/*', types: [slide.type], title: `Choose ${slide.type === 'video' ? 'a video' : 'an image'}` });
      if (picked) { slide.media_url = picked.url; changed({ inspector: true }); }
    };
    const sound = insp.querySelector('#in-sound');
    if (sound) sound.onchange = () => { s2.muted = !sound.checked; changed({ stage: false, film: false }); };
    const wait = insp.querySelector('#in-wait');
    if (wait) wait.onchange = () => { s2.waitForEnd = wait.checked; changed({ stage: false }); };
    const loop = insp.querySelector('#in-loop');
    if (loop) loop.onchange = () => { s2.loopVideo = loop.checked; changed({ stage: false, film: false }); };
    insp.querySelector('#in-duration').onchange = (e) => { s2.duration = Number(e.target.value); changed({ stage: false }); };
    insp.querySelector('#in-dup').onclick = () => duplicateSlide(S.sel);
    insp.querySelector('#in-del').onclick = () => removeSlide(S.sel);
  }

  /* ------------------------------------------------------ show settings */
  $('#show-name').oninput = (e) => { S.show.name = e.target.value || 'Untitled'; changed({ stage: false, film: false }); };
  $('#show-desc').oninput = (e) => { S.show.description = e.target.value; changed({ stage: false, film: false }); };

  $('#show-settings').onclick = () => {
    const st = S.show.settings;
    const body = document.createElement('div');
    body.className = 'stack-lg';
    function draw() {
      body.innerHTML = html`
        <div class="field"><label>Advancing</label>
          ${raw(seg('advance', st.advance, [['manual', 'Players click / remote', 'icon-mouse-pointer-click'], ['auto', 'Automatically', 'icon-timer']]))}
          ${st.advance === 'auto' ? raw(html`<div class="row mt-8"><span class="small muted">Every</span><input class="input input-sm" type="number" min="1" max="600" id="st-secs" value="${st.autoSeconds}" style="width:80px"><span class="small muted">seconds (slides can override)</span></div>`) : raw('<div class="hint">Videos still advance on their own when they finish (per-slide setting).</div>')}
        </div>
        <div class="field"><label>Transition</label>${raw(seg('transition', st.transition, [['fade', 'Fade'], ['slide', 'Slide'], ['zoom', 'Zoom'], ['none', 'None']]))}</div>
        <div class="field"><label>When it ends</label>
          <select class="select" id="st-end">
            <option value="player" ${st.endAction === 'player' ? 'selected' : ''}>Return to the game screen</option>
            <option value="chooser" ${st.endAction === 'chooser' ? 'selected' : ''}>Go back to the slideshow chooser</option>
            <option value="stay" ${st.endAction === 'stay' ? 'selected' : ''}>Show an end screen (watch again / start)</option>
            <option value="restart" ${st.endAction === 'restart' ? 'selected' : ''}>Loop forever (lobby display)</option>
          </select></div>
        <div class="stack-sm">
          <label class="switch"><input type="checkbox" id="st-progress" ${st.showProgress ? 'checked' : ''}><span class="track"></span>Show progress bar</label>
          <label class="switch"><input type="checkbox" id="st-controls" ${st.showControls ? 'checked' : ''}><span class="track"></span>Show on-screen controls</label>
        </div>
        <div class="grid-2">
          <div class="field"><label>Background</label><input type="color" class="input" id="st-bg" value="${st.background || '#000000'}"></div>
          <div class="field"><label>Text</label><input type="color" class="input" id="st-text" value="${st.textColor || '#ffffff'}"></div>
          <div class="field"><label>Highlight</label><input type="color" class="input" id="st-accent" value="${st.accent || '#f5b942'}"></div>
          <div class="field"><label>Font</label><select class="select" id="st-font">${raw(Object.keys(R.FONTS).map(f => `<option value="${f}" ${f === (st.font === 'system' && !R.FONTS.system ? 'inter' : st.font) ? 'selected' : ''}>${f[0].toUpperCase() + f.slice(1)}</option>`).join(''))}</select></div>
        </div>
        <div class="field"><label>Cover image <span class="faint">(chooser card – defaults to the first slide)</span></label>
          <div class="row">${st.cover ? raw(html`<img src="${st.cover}" style="width:96px;height:54px;object-fit:cover;border-radius:6px" alt="">`) : ''}
            <button class="btn btn-sm" id="st-cover">${st.cover ? 'Change' : 'Choose'}</button>${st.cover ? raw('<button class="btn btn-ghost btn-sm" id="st-cover-clear">Remove</button>') : ''}</div></div>`;

      body.querySelectorAll('[data-seg]').forEach(group => group.querySelectorAll('button').forEach(b => b.onclick = () => {
        st[group.dataset.seg] = b.dataset.v;
        changed({ film: true });
        draw();
      }));
      const secs = body.querySelector('#st-secs');
      if (secs) secs.oninput = () => { st.autoSeconds = Math.max(1, Number(secs.value) || 8); changed(); };
      body.querySelector('#st-end').onchange = (e) => { st.endAction = e.target.value; changed({ stage: false, film: false }); };
      body.querySelector('#st-progress').onchange = (e) => { st.showProgress = e.target.checked; changed({ stage: false, film: false }); };
      body.querySelector('#st-controls').onchange = (e) => { st.showControls = e.target.checked; changed({ stage: false, film: false }); };
      [['#st-bg', 'background'], ['#st-text', 'textColor'], ['#st-accent', 'accent']].forEach(([sel, key]) => {
        body.querySelector(sel).oninput = (e) => { st[key] = e.target.value; changed(); };
      });
      body.querySelector('#st-font').onchange = (e) => { st.font = e.target.value; changed(); };
      body.querySelector('#st-cover').onclick = async () => {
        const picked = await QC.pickMedia({ roomId, accept: 'image/*', types: ['image'], title: 'Cover image' });
        if (picked) { st.cover = picked.url; changed({ stage: false, film: false }); draw(); }
      };
      const cc = body.querySelector('#st-cover-clear');
      if (cc) cc.onclick = () => { st.cover = ''; changed({ stage: false, film: false }); draw(); };
    }
    draw();
    drawer({ title: 'Slideshow settings', body, width: 460, onClose: () => drawInspector() });
  };

  $('#preview-btn').onclick = () => {
    autosave.flush();
    window.open(`/room/${roomId}/slideshow/${S.show.id}?preview=1&slide=${S.sel}`, '_blank');
  };

  QC.hotkeys({
    arrowright: () => S.show && select(S.sel + 1),
    arrowleft: () => S.show && select(S.sel - 1),
    delete: () => S.show && S.show.slides.length && removeSlide(S.sel),
    'mod+d': () => S.show && S.show.slides.length && duplicateSlide(S.sel),
    'mod+s': () => autosave.flush()
  });

  /* ---------------------------------------------------------------- boot */
  (async function boot() {
    try {
      S.room = await get(`/api/v2/rooms/${roomId}`);
    } catch (err) {
      $('#canvas').innerHTML = html`<div class="empty"><div class="empty-icon"><i class="icon-door-closed"></i></div><h3>Room not found</h3><p>${err.message}</p><a class="btn" href="/">Back</a></div>`;
      return;
    }
    QC.applyRoomAppearance(S.room, { background: false });
    document.title = `Slideshows · ${S.room.name}`;
    $('#room-name').textContent = S.room.name;
    $('#gm-link').href = `/room/${roomId}/gm`;
    await loadShows();
    const hash = location.hash.slice(1);
    if (hash && S.shows.some(s => s.id === hash)) openShow(hash);
    else if (S.shows.length) openShow(S.shows[0].id);
  })();
})();
