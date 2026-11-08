/* Shared player-screen behaviours injected into every theme:
   - styled full-screen GM/automation messages (show_message)
   - slideshow launch (start_slideshow)
   - remote reload when a theme is saved (reload_player)
   - close overlays on GM request
   - sound playback by URL for automations
   Themes can restyle the overlay via .qc-overlay, .qc-overlay-card,
   .qc-overlay-title and .qc-overlay-text. */
(function () {
  'use strict';
  if (window.__qcOverlays) return;
  window.__qcOverlays = true;

  const css = `
  .qc-overlay { position: fixed; inset: 0; z-index: 2147483000; display: flex; align-items: center; justify-content: center;
    background: rgba(5, 6, 10, .78); backdrop-filter: blur(6px); padding: 5vmin; animation: qcFade .25s ease-out; cursor: pointer; }
  .qc-overlay-card { max-width: min(1100px, 92vw); text-align: center; color: #fff; padding: 5vmin 6vmin; border-radius: 3vmin;
    background: rgba(20, 22, 30, .92); border: 2px solid var(--qc-accent, #8b7cf6); box-shadow: 0 30px 80px rgba(0,0,0,.6);
    font-family: inherit; animation: qcPop .35s cubic-bezier(.2,.9,.3,1.2); }
  .qc-overlay[data-style="success"] .qc-overlay-card { --qc-accent: #3ecf8e; }
  .qc-overlay[data-style="warning"] .qc-overlay-card { --qc-accent: #f5b942; }
  .qc-overlay[data-style="danger"] .qc-overlay-card { --qc-accent: #f2555a; }
  .qc-overlay-title { font-size: clamp(1.4rem, 4vmin, 3rem); font-weight: 700; margin: 0 0 2vmin; color: var(--qc-accent, #8b7cf6); letter-spacing: .02em; }
  .qc-overlay-text { font-size: clamp(1.6rem, 6vmin, 5rem); line-height: 1.2; font-weight: 600; white-space: pre-wrap; overflow-wrap: anywhere; }
  .qc-overlay-bar { height: 6px; background: var(--qc-accent, #8b7cf6); border-radius: 6px; margin-top: 4vmin; transform-origin: left; }
  @keyframes qcFade { from { opacity: 0; } }
  @keyframes qcPop { from { opacity: 0; transform: scale(.92) translateY(10px); } }
  @keyframes qcBar { from { transform: scaleX(1); } to { transform: scaleX(0); } }`;
  const style = document.createElement('style');
  style.id = 'qc-overlay-styles';
  style.textContent = css;
  document.head.appendChild(style);

  let current = null;
  let timer = null;

  function close() {
    clearTimeout(timer);
    if (current) { current.remove(); current = null; }
  }

  function showMessage(data) {
    data = data || {};
    close();
    const el = document.createElement('div');
    el.className = 'qc-overlay';
    el.dataset.style = ['success', 'warning', 'danger'].includes(data.style) ? data.style : 'info';
    const card = document.createElement('div');
    card.className = 'qc-overlay-card';
    if (data.title) {
      const t = document.createElement('div');
      t.className = 'qc-overlay-title';
      t.textContent = data.title;
      card.appendChild(t);
    }
    const text = document.createElement('div');
    text.className = 'qc-overlay-text';
    text.textContent = data.text || '';
    card.appendChild(text);
    const seconds = Number(data.duration) || 0;
    if (seconds > 0) {
      const bar = document.createElement('div');
      bar.className = 'qc-overlay-bar';
      bar.style.animation = `qcBar ${seconds}s linear forwards`;
      card.appendChild(bar);
      timer = setTimeout(close, seconds * 1000);
    }
    el.appendChild(card);
    el.addEventListener('click', close);
    document.body.appendChild(el);
    current = el;
  }

  function attach(socket) {
    if (!socket || socket.__qcOverlayBound) return;
    socket.__qcOverlayBound = true;

    // Replace the old unstyled handler from player.js with the styled overlay
    socket.off && socket.off('show_message');
    socket.on('show_message', showMessage);

    socket.on('close_overlays', () => {
      close();
      const hint = document.getElementById('hint-overlay');
      if (hint) hint.style.display = 'none';
      const lb = document.getElementById('fullscreen-media');
      if (lb) lb.style.display = 'none';
      document.querySelectorAll('#trigger-message-overlay').forEach(n => n.remove());
    });

    socket.on('reload_player', () => {
      // Small random delay so many screens don't hit the server at once
      setTimeout(() => location.reload(), 300 + Math.random() * 700);
    });

    socket.on('room_updated', (room) => {
      if (room && room.theme && document.body.dataset.qcTheme && document.body.dataset.qcTheme !== room.theme) {
        location.reload();
      }
    });

    socket.on('start_slideshow', (data) => {
      const roomId = window.roomId || (window.playerApp && window.playerApp.getCurrentRoomId && window.playerApp.getCurrentRoomId());
      if (!roomId || roomId === 'loading') return;
      const target = data && data.slideshowId
        ? `/room/${encodeURIComponent(roomId)}/slideshow/${encodeURIComponent(data.slideshowId)}`
        : `/room/${encodeURIComponent(roomId)}/rules-slideshow`;
      location.href = `${target}?return=${encodeURIComponent(location.pathname)}`;
    });
  }

  function waitForSocket(tries = 0) {
    if (window.socket) return attach(window.socket);
    if (tries < 50) setTimeout(() => waitForSocket(tries + 1), 100);
  }
  waitForSocket();

  window.QCOverlay = { showMessage, close };
})();
