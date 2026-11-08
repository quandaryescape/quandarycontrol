/* Slideshow player: chooser (multiple slideshows) + playback.
   URLs:
     /room/:roomId/rules-slideshow            → 1 show: play it, 2+: chooser, 0: legacy rules
     /room/:roomId/slideshow/:slideshowId     → play that show
   Query: ?return=/path (where to go when finished), ?preview=1 (studio preview, no redirect) */
(function () {
  'use strict';
  const R = window.SlideRender;
  const $ = (id) => document.getElementById(id);

  const parts = location.pathname.split('/').filter(Boolean);
  const roomId = parts[0] === 'room' ? decodeURIComponent(parts[1] || '') : null;
  const directShowId = parts[2] === 'slideshow' ? decodeURIComponent(parts[3] || '') : null;
  const params = new URLSearchParams(location.search);
  const returnTo = params.get('return');
  const isPreview = params.get('preview') === '1';
  const startAt = Number(params.get('slide')) || 0;

  const state = { room: null, shows: [], show: null, index: 0, timer: null, paused: false, segTimer: null, idleTimer: null, focusIdx: 0 };

  /* ------------------------------------------------------------ TV mode */
  const ua = navigator.userAgent.toLowerCase();
  const isTV = (ua.includes('android') && (ua.includes('tv') || ua.includes('aft'))) || typeof window.fully !== 'undefined' || ua.includes('smart-tv') || ua.includes('webos') || ua.includes('tizen');
  if (isTV) document.body.classList.add('tv-mode');

  async function api(url) {
    const res = await fetch(url);
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.success === false) throw new Error(json.error || `HTTP ${res.status}`);
    return json.data;
  }

  function show(id) {
    ['loading', 'chooser', 'player', 'message'].forEach(x => { $(x).hidden = x !== id; });
  }

  function message(title, text) {
    $('message-title').textContent = title;
    $('message-text').textContent = text;
    show('message');
    $('message-back').focus();
  }

  function applyRoomColor(room) {
    if (!room || !room.appearance) return;
    const accent = room.appearance.accent;
    if (accent) {
      document.documentElement.style.setProperty('--room-accent', accent);
    }
  }

  function exitToGame() {
    clearTimers();
    if (isPreview) { window.close(); return; }
    if (returnTo && returnTo.startsWith('/')) location.href = returnTo;
    else if (roomId) location.href = `/room/${encodeURIComponent(roomId)}/player`;
    else location.href = '/';
  }

  function tryFullscreen() {
    if (isPreview) return;
    const el = document.documentElement;
    if (!document.fullscreenElement && el.requestFullscreen) el.requestFullscreen().catch(() => {});
  }

  /* -------------------------------------------------------------- chooser */
  function renderChooser() {
    show('chooser');
    const grid = $('chooser-grid');
    $('chooser-room').textContent = state.room ? state.room.name : '';
    grid.className = `chooser-grid count-${Math.min(state.shows.length, 3)}`;
    grid.innerHTML = '';
    state.shows.forEach((s, i) => {
      const btn = document.createElement('button');
      btn.className = 'choice';
      btn.setAttribute('role', 'option');
      btn.dataset.index = i;
      const mins = s.estimatedSeconds ? Math.max(1, Math.round(s.estimatedSeconds / 60)) : null;
      btn.innerHTML = `
        <div class="choice-thumb"><span class="choice-num">${i + 1}</span></div>
        <div class="choice-body">
          <h2></h2>
          <p></p>
          <div class="choice-meta"><span><i class="icon-layers"></i>${s.slideCount} slide${s.slideCount === 1 ? '' : 's'}</span>${mins ? `<span><i class="icon-clock"></i>~${mins} min</span>` : ''}</div>
        </div>`;
      btn.querySelector('h2').textContent = s.name;
      btn.querySelector('p').textContent = s.description || '';
      // thumbnail: cover image, or the first slide rendered
      const frame = document.createElement('div');
      frame.className = 'ss-frame';
      R.applyShow(frame, s.settings);
      if (s.settings.cover) {
        frame.appendChild(R.render({ type: 'image', media_url: s.settings.cover, settings: { fit: 'cover' } }, { mode: 'thumb' }));
      } else if (s.firstSlide) {
        frame.appendChild(R.render(s.firstSlide, { mode: 'thumb' }));
      }
      btn.querySelector('.choice-thumb').prepend(frame);
      btn.addEventListener('click', () => play(s.id));
      btn.addEventListener('focus', () => { state.focusIdx = i; document.querySelectorAll('.choice').forEach((el, n) => el.classList.toggle('focused', n === i)); });
      grid.appendChild(btn);
    });
    focusChoice(Math.min(state.focusIdx, state.shows.length - 1));
  }

  function focusChoice(i) {
    const items = Array.from(document.querySelectorAll('.choice'));
    if (!items.length) return;
    const idx = (i + items.length) % items.length;
    state.focusIdx = idx;
    items.forEach((el, n) => el.classList.toggle('focused', n === idx));
    items[idx].focus({ preventScroll: false });
  }

  function chooserColumns() {
    const items = Array.from(document.querySelectorAll('.choice'));
    if (items.length < 2) return 1;
    const top = items[0].getBoundingClientRect().top;
    return items.filter(el => Math.abs(el.getBoundingClientRect().top - top) < 5).length;
  }

  /* -------------------------------------------------------------- playback */
  async function play(showId) {
    show('loading');
    try {
      state.show = await api(`/api/v2/slideshows/${encodeURIComponent(showId)}`);
    } catch (err) {
      return message('Slideshow not found', err.message);
    }
    if (!state.show.slides.length) return message('This slideshow is empty', 'Add slides in the slideshow studio.');
    if (!state.room && state.show.room) state.room = state.show.room;
    document.title = state.show.name;
    buildStage();
    show('player');
    tryFullscreen();
    goTo(Math.min(startAt, state.show.slides.length - 1), true);
    bumpIdle();
  }

  function buildStage() {
    const st = state.show.settings;
    const stage = $('stage');
    stage.className = `ss-frame ss-stage t-${st.transition || 'fade'}`;
    R.applyShow(stage, st);
    stage.innerHTML = '';
    state.show.slides.forEach((slide, i) => {
      const el = R.render(slide, { mode: 'player' });
      el.dataset.index = i;
      stage.appendChild(el);
    });
    $('segments').innerHTML = state.show.slides.map(() => '<div class="seg"><div></div></div>').join('');
    $('segments').hidden = st.showProgress === false;
    $('controls').hidden = st.showControls === false;
    $('count-total').textContent = state.show.slides.length;
    $('the-end').hidden = true;
  }

  function slideEls() { return Array.from($('stage').children); }

  function clearTimers() {
    clearTimeout(state.timer);
    cancelAnimationFrame(state.segTimer);
    state.timer = null;
  }

  function goTo(index, instant) {
    const slides = state.show.slides;
    if (index < 0) index = 0;
    if (index >= slides.length) return finish();
    clearTimers();
    $('the-end').hidden = true;
    const prev = state.index;
    state.index = index;
    const els = slideEls();
    els.forEach((el, i) => {
      el.classList.toggle('leaving', i === prev && i !== index);
      el.classList.toggle('active', i === index);
      const v = el.querySelector('video');
      if (v && i !== index) { v.pause(); try { v.currentTime = 0; } catch (_) { /* ignore */ } }
    });
    setTimeout(() => els.forEach(el => el.classList.remove('leaving')), instant ? 0 : 650);

    $('count-current').textContent = index + 1;
    $('prev').disabled = index === 0;
    document.querySelectorAll('.progress-segments .seg').forEach((seg, i) => {
      seg.classList.toggle('done', i < index);
      seg.firstElementChild.style.width = i < index ? '100%' : '0%';
    });

    const slide = slides[index];
    const el = els[index];
    const video = el.querySelector('video');
    if (video) {
      playVideo(video, slide);
    } else {
      schedule(R.durationOf(slide, state.show));
    }
    preload(index + 1);
  }

  function schedule(seconds) {
    const seg = document.querySelectorAll('.progress-segments .seg')[state.index];
    $('pause').hidden = !(seconds > 0);
    if (!(seconds > 0) || state.paused) {
      if (seg && !(seconds > 0)) seg.firstElementChild.style.width = '100%';
      return;
    }
    const started = performance.now();
    const total = seconds * 1000;
    const tick = () => {
      const p = Math.min(1, (performance.now() - started) / total);
      if (seg) seg.firstElementChild.style.width = `${p * 100}%`;
      if (p < 1) state.segTimer = requestAnimationFrame(tick);
    };
    state.segTimer = requestAnimationFrame(tick);
    state.timer = setTimeout(next, total);
  }

  function playVideo(video, slide) {
    const s = slide.settings || {};
    video.preload = 'auto';
    video.muted = true;
    const seg = document.querySelectorAll('.progress-segments .seg')[state.index];
    const onTime = () => { if (seg && video.duration) seg.firstElementChild.style.width = `${(video.currentTime / video.duration) * 100}%`; };
    video.ontimeupdate = onTime;
    video.onended = () => { if (s.loopVideo) return; if (s.waitForEnd !== false) setTimeout(next, 300); };
    const p = video.play();
    if (p && p.then) {
      p.then(() => {
        if (s.muted) return;
        // Try to unmute; browsers may block without a prior user gesture
        video.muted = false;
        if (video.muted || video.paused) { video.muted = true; video.play().catch(() => {}); $('unmute').hidden = false; }
      }).catch(() => { $('unmute').hidden = false; });
    }
    if (s.waitForEnd === false) schedule(R.durationOf(slide, state.show));
    else $('pause').hidden = true;
  }

  function preload(i) {
    const el = slideEls()[i];
    if (!el) return;
    const v = el.querySelector('video');
    if (v && v.preload !== 'auto') { v.preload = 'auto'; v.load(); }
  }

  function next() {
    if (!state.show) return;
    if (state.index >= state.show.slides.length - 1) return finish();
    goTo(state.index + 1);
  }
  function prev() { if (state.show && state.index > 0) goTo(state.index - 1); }

  function finish() {
    clearTimers();
    const st = state.show.settings;
    if (st.loop || st.endAction === 'restart') return goTo(0);
    if (st.endAction === 'chooser' && state.shows.length > 1) { stopVideos(); return renderChooser(); }
    if (st.endAction === 'stay' || isPreview) {
      $('the-end').hidden = false;
      $('end-continue').focus();
      return;
    }
    stopVideos();
    exitToGame();
  }

  function stopVideos() { slideEls().forEach(el => { const v = el.querySelector('video'); if (v) v.pause(); }); }

  function togglePause() {
    state.paused = !state.paused;
    $('pause').innerHTML = state.paused ? '<i class="icon-play"></i>' : '<i class="icon-pause"></i>';
    if (state.paused) clearTimers();
    else schedule(R.durationOf(state.show.slides[state.index], state.show));
  }

  function bumpIdle() {
    const p = $('player');
    p.classList.remove('idle');
    clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(() => p.classList.add('idle'), 3500);
  }

  /* ------------------------------------------------------------ controls */
  $('next').onclick = () => { next(); bumpIdle(); };
  $('prev').onclick = () => { prev(); bumpIdle(); };
  $('close').onclick = () => (state.shows.length > 1 && !directShowId ? (stopVideos(), clearTimers(), renderChooser()) : exitToGame());
  $('pause').onclick = togglePause;
  $('unmute').onclick = () => {
    const v = slideEls()[state.index] && slideEls()[state.index].querySelector('video');
    if (v) { v.muted = false; v.play().catch(() => {}); }
    $('unmute').hidden = true;
  };
  $('end-replay').onclick = () => goTo(0);
  $('end-continue').onclick = exitToGame;
  $('message-back').onclick = exitToGame;
  $('chooser-back').onclick = exitToGame;

  let lastNav = 0;
  window.addEventListener('keydown', (e) => {
    if (e.repeat) { e.preventDefault(); return; }
    const k = e.key;
    const now = Date.now();
    const nav = (fn) => { e.preventDefault(); if (now - lastNav < 220) return; lastNav = now; fn(); };

    if (!$('chooser').hidden) {
      const cols = chooserColumns();
      if (k === 'ArrowRight') return nav(() => focusChoice(state.focusIdx + 1));
      if (k === 'ArrowLeft') return nav(() => focusChoice(state.focusIdx - 1));
      if (k === 'ArrowDown') return nav(() => focusChoice(state.focusIdx + cols));
      if (k === 'ArrowUp') return nav(() => focusChoice(state.focusIdx - cols));
      if (/^[1-9]$/.test(k) && state.shows[Number(k) - 1]) return nav(() => play(state.shows[Number(k) - 1].id));
      if (k === 'Escape' || k === 'Backspace' || k === 'GoBack' || k === 'BrowserBack') return nav(exitToGame);
      return;
    }
    if (!$('player').hidden) {
      bumpIdle();
      if (!$('the-end').hidden) return; // buttons handle Enter themselves
      if (['ArrowRight', 'PageDown', 'MediaTrackNext', ' ', 'Enter'].includes(k)) return nav(next);
      if (['ArrowLeft', 'PageUp', 'MediaTrackPrevious'].includes(k)) return nav(prev);
      if (k === 'MediaPlayPause' || k === 'p') return nav(togglePause);
      if (k === 'Escape' || k === 'Backspace' || k === 'GoBack' || k === 'BrowserBack') return nav(() => $('close').click());
    }
  }, true);

  // Touch: swipe; mouse: click left/right thirds
  let touchX = null;
  $('stage').addEventListener('touchstart', (e) => { touchX = e.changedTouches[0].clientX; }, { passive: true });
  $('stage').addEventListener('touchend', (e) => {
    if (touchX === null) return;
    const dx = e.changedTouches[0].clientX - touchX;
    touchX = null;
    if (Math.abs(dx) > 50) { if (dx < 0) next(); else prev(); }
    bumpIdle();
  });
  $('stage').addEventListener('click', (e) => {
    const x = e.clientX / window.innerWidth;
    if (x < 0.3) prev(); else if (x > 0.7) next();
    bumpIdle();
  });
  document.addEventListener('mousemove', () => { if (!$('player').hidden) bumpIdle(); });

  // GM can push a specific slideshow while this page is open
  if (typeof io === 'function' && roomId && !isPreview) {
    const socket = io();
    socket.on('connect', () => socket.emit('join_room', { roomId, clientType: 'player' }));
    socket.on('start_slideshow', (d) => { if (d && d.slideshowId) play(d.slideshowId); else if (state.shows.length > 1) renderChooser(); });
    socket.on('reload_player', () => location.reload());
  }

  /* -------------------------------------------------------------- legacy */
  async function legacyRules() {
    // Rooms that only have media in the old rules editor still work
    const rules = await api(`/api/rooms/${encodeURIComponent(roomId)}/rules`).catch(() => []);
    const usable = (rules || []).filter(r => r.type === 'image' || r.type === 'video');
    if (!usable.length) return false;
    state.show = {
      id: 'legacy', name: 'Rules',
      settings: { advance: 'manual', transition: 'fade', showProgress: true, showControls: true, endAction: 'player', background: '#000000', textColor: '#ffffff', accent: '#f5b942' },
      slides: usable.map(r => ({ type: r.type, media_url: r.url, title: '', body: '', settings: { fit: 'contain' } }))
    };
    buildStage();
    show('player');
    tryFullscreen();
    goTo(0, true);
    return true;
  }

  /* ----------------------------------------------------------------- boot */
  (async function boot() {
    if (!roomId) return message('No room', 'Open a slideshow from a room.');
    try {
      state.room = await api(`/api/v2/rooms/${encodeURIComponent(roomId)}/public`).catch(() => null);
      applyRoomColor(state.room);
      state.shows = await api(`/api/v2/rooms/${encodeURIComponent(roomId)}/slideshows`).then(list => list.filter(s => s.slideCount > 0));
    } catch (err) {
      return message('Could not load slideshows', err.message);
    }

    if (directShowId) return play(directShowId);
    if (state.shows.length === 1) return play(state.shows[0].id);
    if (state.shows.length > 1) return renderChooser();
    if (await legacyRules()) return;
    message('No slideshow yet', 'This room has no slideshow. Your Game Master can create one in the Slideshow Studio.');
  })();
})();
