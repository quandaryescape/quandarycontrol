/* Fills a theme preview with sample content so empty components are visible
   while designing (timer value, a hint, chat messages). Loaded only for
   ?themePreview=…&demo=1 */
(function () {
  'use strict';

  function fill() {
    const timer = document.getElementById('timer-display');
    if (timer) {
      const inner = timer.querySelector('.timer-inner') || timer;
      if (/^0?0:00$/.test((inner.textContent || '').trim())) inner.textContent = '42:17';
    }

    const hintContainer = document.getElementById('hint-container');
    if (hintContainer && hintContainer.querySelector('.hint-placeholder')) {
      hintContainer.innerHTML = '<div class="hint-card"><p>The answer is hidden in the painting’s reflection.</p></div>';
    }

    const chatLog = document.getElementById('chat-log');
    if (chatLog && !chatLog.children.length) {
      const t = new Date().toLocaleTimeString();
      chatLog.innerHTML =
        `<div class="chat-row">[${t}] Player: We found three keys, what now?</div>` +
        `<div class="chat-row">[${t}] GM: Look closely at the clock on the wall.</div>`;
    }

    const varDisplay = document.getElementById('variable-display');
    if (varDisplay && varDisplay.querySelector('.variable-placeholder')) {
      varDisplay.innerHTML = '<span class="state-item"><strong>keys_found:</strong> 3</span>';
    }

    // Preview shows both hint and chat areas regardless of the room's hint mode
    ['chat-section', 'hints-section'].forEach(id => {
      const el = document.getElementById(id);
      if (el && el.style.display === 'none') el.style.display = '';
    });
  }

  // player.js fills real data on connect; fill gaps after it has had a chance
  window.addEventListener('load', () => setTimeout(fill, 400));
  setTimeout(fill, 1500);
})();
