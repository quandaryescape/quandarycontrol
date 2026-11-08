/* Automation building blocks: trigger/action definitions, plain-English
   summaries and starter recipes. Used by the automation builder. */
(function () {
  'use strict';
  const fmt = (s) => (window.QC ? QC.formatTime(s) : String(s));

  const TRIGGERS = {
    variable: { label: 'Variable changes', icon: 'icon-variable', tone: 'variable', help: 'A prop, webhook, GM or another automation changes a game variable.' },
    timer: { label: 'Timer', icon: 'icon-timer', tone: 'timer', help: 'At a moment in the game clock, or when a timer starts, pauses or runs out.' },
    webhook: { label: 'Webhook', icon: 'icon-webhook', tone: 'webhook', help: 'A device or service calls a unique URL (GET or POST).' },
    manual: { label: 'GM button', icon: 'icon-mouse-pointer-click', tone: 'manual', help: 'A button in the Game Master console.' },
    event: { label: 'Game event', icon: 'icon-radio', tone: 'event', help: 'Something happens in the room: a screen connects, a hint is sent, players message the GM.' }
  };

  const OPERATORS = [
    { v: 'equals', label: 'becomes', needsValue: true },
    { v: 'not_equals', label: 'is no longer', needsValue: true },
    { v: 'gt', label: 'goes above', needsValue: true },
    { v: 'gte', label: 'reaches at least', needsValue: true },
    { v: 'lt', label: 'drops below', needsValue: true },
    { v: 'lte', label: 'is at most', needsValue: true },
    { v: 'contains', label: 'contains', needsValue: true },
    { v: 'is_true', label: 'turns true', needsValue: false },
    { v: 'is_false', label: 'turns false', needsValue: false },
    { v: 'any_change', label: 'changes at all', needsValue: false },
    { v: 'changes_from', label: 'changes away from', needsValue: true }
  ];

  // Conditions are checked against current state ("is" wording)
  const CONDITION_OPERATORS = [
    { v: 'equals', label: 'is', needsValue: true },
    { v: 'not_equals', label: 'is not', needsValue: true },
    { v: 'gt', label: 'is greater than', needsValue: true },
    { v: 'gte', label: 'is at least', needsValue: true },
    { v: 'lt', label: 'is less than', needsValue: true },
    { v: 'lte', label: 'is at most', needsValue: true },
    { v: 'contains', label: 'contains', needsValue: true },
    { v: 'not_contains', label: 'does not contain', needsValue: true },
    { v: 'is_true', label: 'is true', needsValue: false },
    { v: 'is_false', label: 'is false', needsValue: false },
    { v: 'is_empty', label: 'is empty', needsValue: false },
    { v: 'is_not_empty', label: 'has a value', needsValue: false }
  ];

  const TIMER_EVENTS = [
    { v: 'remaining', label: 'has this much time left', needsSeconds: true },
    { v: 'elapsed', label: 'has been running for', needsSeconds: true },
    { v: 'start', label: 'starts (new game)' },
    { v: 'pause', label: 'is paused' },
    { v: 'resume', label: 'resumes after a pause' },
    { v: 'complete', label: 'runs out' },
    { v: 'reset', label: 'is reset' },
    { v: 'adjust', label: 'has time added or removed' }
  ];

  const ROOM_EVENTS = [
    { v: 'player_connected', label: 'A player screen connects' },
    { v: 'hint_sent', label: 'A hint is sent' },
    { v: 'player_message', label: 'Players send a chat message' },
    { v: 'gm_message', label: 'The GM sends a chat message' }
  ];

  const ACTIONS = {
    show_message: { label: 'Show a message', icon: 'icon-megaphone', help: 'Big pop-up on player screens', defaults: { title: '', text: '', style: 'info', duration: 8 } },
    send_hint: { label: 'Send a hint', icon: 'icon-lightbulb', help: 'Same as the GM sending a hint', defaults: { message: '' } },
    show_media: { label: 'Show image / video', icon: 'icon-image', help: 'Full-screen media on player screens', defaults: { url: '', mediaId: '', headline: '', duration: 10 } },
    play_sound: { label: 'Play a sound', icon: 'icon-volume-2', help: 'On player screens or the GM console', defaults: { url: '', volume: 80, target: 'players' } },
    set_variable: { label: 'Change a variable', icon: 'icon-variable', help: 'Set, add to, subtract or toggle', defaults: { variable: '', mode: 'set', value: '' } },
    timer: { label: 'Control a timer', icon: 'icon-timer', help: 'Start, pause, reset or add time', defaults: { timer: 'main', command: 'start', seconds: 60 } },
    http_request: { label: 'Call a URL (webhook)', icon: 'icon-send', help: 'Trigger a prop, Home Assistant, Node-RED…', defaults: { method: 'POST', url: '', headers: [], body: '' } },
    delay: { label: 'Wait', icon: 'icon-hourglass', help: 'Pause before the next step', defaults: { seconds: 5 } },
    start_slideshow: { label: 'Play a slideshow', icon: 'icon-presentation', help: 'Switch player screens to a slideshow', defaults: { slideshowId: '' } },
    room_command: { label: 'Room command', icon: 'icon-terminal', help: 'Clear hints/chat, close pop-ups, reload screens', defaults: { command: 'close_overlays' } },
    run_automation: { label: 'Run another automation', icon: 'icon-workflow', help: 'Chain automations together', defaults: { automationId: '', skipConditions: false } }
  };

  const COLORS = ['#8b7cf6', '#3ecf8e', '#f5b942', '#f2555a', '#4fb3f6', '#e96bb0', '#f59e42', '#94a3b8'];
  const BUTTON_ICONS = ['zap', 'lightbulb', 'lightbulb-off', 'door-open', 'lock-open', 'lock', 'volume-2', 'bell-ring', 'siren', 'sparkles', 'flame', 'skull', 'party-popper', 'trophy', 'power', 'clapperboard'];

  function opLabel(list, v) {
    const o = list.find(x => x.v === v);
    return o ? o.label : v;
  }

  function q(v) {
    if (v === undefined || v === null || v === '') return '…';
    return `“${v}”`;
  }

  function describeTrigger(t, ctx = {}) {
    if (!t || !t.type) return 'Choose a trigger';
    switch (t.type) {
      case 'variable': {
        const op = OPERATORS.find(o => o.v === (t.operator || 'equals'));
        return `When ${t.variable ? `“${t.variable}”` : 'a variable'} ${op ? op.label : t.operator}${op && op.needsValue ? ` ${q(t.value)}` : ''}`;
      }
      case 'timer': {
        const which = t.timer === 'secondary' ? (ctx.secondaryLabel || 'the secondary timer') : 'the game timer';
        const ev = TIMER_EVENTS.find(e => e.v === (t.event || 'remaining'));
        if (ev && ev.needsSeconds) return `When ${which} ${ev.label} ${fmt(t.seconds || 0)}`;
        return `When ${which} ${ev ? ev.label : t.event}`;
      }
      case 'webhook': return 'When the webhook URL is called';
      case 'manual': return `When the GM presses “${t.label || 'button'}”`;
      case 'event': return opLabel(ROOM_EVENTS, t.event);
      default: return t.type;
    }
  }

  function describeAction(a, ctx = {}) {
    switch (a.type) {
      case 'show_message': return a.text ? `Show “${trim(a.text)}”` : 'Show a message';
      case 'send_hint': return a.message ? `Hint: “${trim(a.message)}”` : 'Send a hint';
      case 'show_media': return a.headline ? `Show media – “${trim(a.headline)}”` : (a.url || a.mediaId ? `Show ${fileName(a.url) || 'media'}` : 'Show an image or video');
      case 'play_sound': return a.url ? `Play ${fileName(a.url)}${a.target === 'gm' ? ' in the GM console' : a.target === 'all' ? ' everywhere' : ''}` : 'Play a sound';
      case 'set_variable': {
        if (!a.variable) return 'Change a variable';
        if (a.mode === 'increment') return `Add ${a.value || 1} to “${a.variable}”`;
        if (a.mode === 'decrement') return `Subtract ${a.value || 1} from “${a.variable}”`;
        if (a.mode === 'toggle') return `Toggle “${a.variable}”`;
        return `Set “${a.variable}” to ${q(a.value)}`;
      }
      case 'timer': {
        const which = a.timer === 'secondary' ? (ctx.secondaryLabel || 'secondary timer') : 'game timer';
        const map = { start: 'Start', pause: 'Pause', stop: 'Stop', reset: 'Reset', add: `Add ${fmt(a.seconds)} to`, subtract: `Remove ${fmt(a.seconds)} from` };
        return `${map[a.command] || a.command} the ${which}`;
      }
      case 'http_request': return a.url ? `${a.method || 'POST'} ${trim(a.url.replace(/^https?:\/\//, ''), 42)}` : 'Call a URL';
      case 'delay': return `Wait ${fmt(a.seconds || 0)}`;
      case 'start_slideshow': {
        const s = (ctx.slideshows || []).find(x => x.id === a.slideshowId);
        return s ? `Play slideshow “${s.name}”` : 'Play a slideshow (players choose)';
      }
      case 'room_command': return ({ clear_hints: 'Clear hints on screens', clear_chat: 'Clear the chat', reload_players: 'Reload player screens', close_overlays: 'Close pop-ups on screens' })[a.command] || a.command;
      case 'run_automation': {
        const t = (ctx.automations || []).find(x => x.id === a.automationId);
        return t ? `Run “${t.name}”` : 'Run another automation';
      }
      default: return a.type;
    }
  }

  function trim(s, n = 48) {
    s = String(s || '').replace(/\s+/g, ' ').trim();
    return s.length > n ? `${s.slice(0, n - 1)}…` : s;
  }
  function fileName(url) {
    if (!url) return '';
    const f = String(url).split('/').pop().split('?')[0];
    return f.replace(/^\d{10,}_[\w-]{6,10}/, '').replace(/^[_-]/, '') || f;
  }

  const RECIPES = [
    {
      id: 'prop-solved', icon: 'icon-puzzle', tone: 'webhook',
      title: 'Prop solved → celebrate',
      text: 'A keypad or sensor calls a URL; mark the puzzle solved and show a message.',
      build: () => ({
        name: 'Puzzle solved',
        trigger: { type: 'webhook' },
        actions: [
          { type: 'set_variable', variable: 'puzzle_1_solved', mode: 'set', value: 'true' },
          { type: 'show_message', title: 'Puzzle solved!', text: 'The lock clicks open…', style: 'success', duration: 6 }
        ]
      })
    },
    {
      id: 'time-warning', icon: 'icon-alarm-clock', tone: 'timer',
      title: 'Time warning',
      text: 'Warn players when 10 minutes are left.',
      build: () => ({
        name: '10 minute warning',
        trigger: { type: 'timer', timer: 'main', event: 'remaining', seconds: 600 },
        actions: [{ type: 'show_message', title: 'Hurry!', text: '10 minutes remaining', style: 'warning', duration: 8 }]
      })
    },
    {
      id: 'times-up', icon: 'icon-siren', tone: 'timer',
      title: "Time's up",
      text: 'When the clock runs out, show a final message.',
      build: () => ({
        name: "Time's up",
        trigger: { type: 'timer', timer: 'main', event: 'complete' },
        actions: [{ type: 'show_message', title: "Time's up!", text: 'Please wait for your Game Master.', style: 'danger', duration: 0 }]
      })
    },
    {
      id: 'gm-button', icon: 'icon-mouse-pointer-click', tone: 'manual',
      title: 'GM button',
      text: 'One click in the GM console: blackout, open a door, play a sound…',
      build: () => ({
        name: 'Lights out',
        trigger: { type: 'manual', label: 'Lights out', color: '#f2555a', icon: 'lightbulb-off' },
        actions: [{ type: 'http_request', method: 'POST', url: 'http://192.168.1.50/lights/off', headers: [], body: '' }]
      })
    },
    {
      id: 'game-start', icon: 'icon-play', tone: 'timer',
      title: 'Game start',
      text: 'When the GM starts the clock, start the secondary timer and play intro media.',
      build: () => ({
        name: 'Game start',
        trigger: { type: 'timer', timer: 'main', event: 'start' },
        actions: [{ type: 'show_message', title: 'Welcome', text: 'Your time starts… now!', style: 'info', duration: 5 }]
      })
    },
    {
      id: 'score', icon: 'icon-trophy', tone: 'variable',
      title: 'Reward when a score is reached',
      text: 'When a counter reaches a value, unlock the next stage.',
      build: () => ({
        name: 'All keys found',
        trigger: { type: 'variable', variable: 'keys_found', operator: 'gte', value: '3' },
        actions: [
          { type: 'send_hint', message: 'You have all three keys – try the chest!' },
          { type: 'set_variable', variable: 'stage', mode: 'set', value: '2' }
        ]
      })
    },
    {
      id: 'notify', icon: 'icon-bell-ring', tone: 'event',
      title: 'Notify another system',
      text: 'Post to Discord, Slack, Home Assistant or Node-RED when players message the GM.',
      build: () => ({
        name: 'Forward player messages',
        trigger: { type: 'event', event: 'player_message' },
        actions: [{
          type: 'http_request', method: 'POST', url: 'https://example.com/webhook',
          headers: [{ key: 'Content-Type', value: 'application/json' }],
          body: '{\n  "room": "{{room.name}}",\n  "message": "{{payload.message}}",\n  "time_left": "{{timer.remaining_formatted}}"\n}'
        }]
      })
    },
    {
      id: 'blank', icon: 'icon-plus', tone: 'variable',
      title: 'Start from scratch',
      text: 'An empty automation.',
      build: () => ({ name: 'New automation', trigger: { type: 'variable', variable: '', operator: 'equals', value: '' }, actions: [] })
    }
  ];

  window.AutomationCatalog = {
    TRIGGERS, OPERATORS, CONDITION_OPERATORS, TIMER_EVENTS, ROOM_EVENTS, ACTIONS, COLORS, BUTTON_ICONS, RECIPES,
    describeTrigger, describeAction, fileName
  };
})();
