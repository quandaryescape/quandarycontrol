/* Shared slide renderer (player + studio). Produces DOM for one slide. */
(function () {
  'use strict';

  const FONTS = {
    system: 'system-ui, "Segoe UI", sans-serif',
    inter: '"Inter Variable", system-ui, sans-serif',
    oswald: '"Oswald", "Arial Narrow", sans-serif',
    bebas: '"Bebas Neue", "Arial Narrow", sans-serif',
    rajdhani: '"Rajdhani", system-ui, sans-serif',
    orbitron: '"Orbitron", system-ui, sans-serif',
    serif: 'Georgia, "Times New Roman", serif'
  };

  function esc(v) {
    return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /** Plain text → safe HTML with **bold** and "- " bullet lists. */
  function richText(text) {
    const lines = String(text || '').split(/\r?\n/);
    let out = '';
    let inList = false;
    const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    lines.forEach((line, i) => {
      const m = /^\s*[-•*]\s+(.*)$/.exec(line);
      if (m) {
        if (!inList) { out += '<ul>'; inList = true; }
        out += `<li>${inline(m[1])}</li>`;
      } else {
        if (inList) { out += '</ul>'; inList = false; }
        out += inline(line) + (i < lines.length - 1 ? '\n' : '');
      }
    });
    if (inList) out += '</ul>';
    return out;
  }

  /** Apply show-level look (colours, font) to a frame element. */
  function applyShow(frame, settings = {}) {
    frame.style.setProperty('--ss-bg', settings.background || '#000000');
    frame.style.setProperty('--ss-text', settings.textColor || '#ffffff');
    frame.style.setProperty('--ss-accent', settings.accent || '#f5b942');
    frame.style.setProperty('--ss-font', FONTS[settings.font] || FONTS.inter);
  }

  function isVideoUrl(url) {
    return /\.(mp4|webm|mov|m4v|ogv)(\?|#|$)/i.test(url || '');
  }

  /**
   * @param {object} slide  { type, media_url, title, body, settings }
   * @param {object} opts   { mode: 'player'|'thumb'|'editor' }
   */
  function render(slide, opts = {}) {
    const mode = opts.mode || 'player';
    const s = slide.settings || {};
    const el = document.createElement('div');
    el.className = 'ss-slide';
    el.dataset.type = slide.type;
    if (s.bg) el.style.setProperty('--slide-bg', s.bg);
    if (s.textColor) el.style.setProperty('--slide-text', s.textColor);
    if (s.titleColor) el.style.setProperty('--slide-title', s.titleColor);

    if (slide.type === 'image' || slide.type === 'video') {
      const url = slide.media_url;
      if (!url) {
        el.innerHTML = `<div class="ss-empty">${slide.type === 'video' ? 'No video chosen' : 'No image chosen'}</div>`;
        return el;
      }
      let media;
      if (slide.type === 'video' || isVideoUrl(url)) {
        media = document.createElement('video');
        media.src = mode === 'thumb' ? `${url}#t=0.5` : url;
        media.muted = true;
        media.playsInline = true;
        media.setAttribute('playsinline', '');
        media.setAttribute('muted', '');
        media.preload = mode === 'player' ? 'none' : 'metadata';
        if (mode === 'player') media.loop = !!s.loopVideo;
      } else {
        media = document.createElement('img');
        media.src = url;
        media.alt = slide.title || '';
        media.decoding = 'async';
        if (mode !== 'player') media.loading = 'lazy';
      }
      media.className = `ss-media ${s.fit === 'cover' ? 'cover' : ''}`;
      el.appendChild(media);
      if ((slide.title || slide.body) && s.caption !== false) {
        const cap = document.createElement('div');
        cap.className = `ss-caption ${s.captionPos === 'top' ? 'top' : ''} size-m bsize-m`;
        cap.innerHTML = `${slide.title ? `<h2 class="ss-title">${esc(slide.title)}</h2>` : ''}${slide.body ? `<div class="ss-body">${richText(slide.body)}</div>` : ''}`;
        el.appendChild(cap);
      }
      return el;
    }

    // text slide
    if (s.bgImage) {
      const bg = document.createElement('div');
      bg.className = 'ss-bgimg';
      bg.style.backgroundImage = `url("${String(s.bgImage).replace(/"/g, '%22')}")`;
      el.appendChild(bg);
      const ov = document.createElement('div');
      ov.className = 'ss-overlay';
      ov.style.opacity = s.overlay !== undefined ? s.overlay : 0.45;
      el.appendChild(ov);
    }
    const text = document.createElement('div');
    text.className = [
      'ss-text',
      `layout-${s.layout || 'center'}`,
      `align-${s.align || 'center'}`,
      `size-${s.titleSize || 'l'}`,
      `bsize-${s.bodySize || 'm'}`
    ].join(' ');
    const hasContent = slide.title || slide.body || s.icon;
    text.innerHTML = hasContent ? `
      ${s.icon ? `<div class="ss-icon">${esc(s.icon)}</div>` : ''}
      ${slide.title ? `<h2 class="ss-title">${esc(slide.title)}</h2>` : ''}
      ${slide.title && slide.body && s.accentBar !== false ? '<div class="ss-accent-bar"></div>' : ''}
      ${slide.body ? `<div class="ss-body">${richText(slide.body)}</div>` : ''}` : '<div class="ss-empty">Empty slide</div>';
    el.appendChild(text);
    return el;
  }

  /** Slide duration in seconds for auto-advance (0 = manual). */
  function durationOf(slide, show) {
    const s = slide.settings || {};
    if (Number(s.duration) > 0) return Number(s.duration);
    if (show && show.settings && show.settings.advance === 'auto') return Number(show.settings.autoSeconds) || 8;
    return 0;
  }

  window.SlideRender = { render, applyShow, richText, durationOf, isVideoUrl, FONTS };
})();
