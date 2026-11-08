/**
 * OpenRouter-backed AI assistant for the Theme Builder.
 * The API key stays on the server; the browser only sends instructions.
 */
const settings = require('./settings-service');

// Override for OpenRouter-compatible gateways (and for testing against a mock)
const OPENROUTER_BASE = (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
const MODELS_TTL_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 180000;

let modelCache = { at: 0, models: [] };

function getApiKey() {
  return settings.get('openrouter_api_key') || process.env.OPENROUTER_API_KEY || '';
}

function getConfiguredModel() {
  return settings.get('openrouter_model') || process.env.OPENROUTER_MODEL || '';
}

function status() {
  const fromDb = !!settings.get('openrouter_api_key');
  const key = getApiKey();
  return {
    configured: !!key,
    source: fromDb ? 'settings' : (process.env.OPENROUTER_API_KEY ? 'environment' : null),
    keyPreview: settings.maskKey(key),
    model: getConfiguredModel()
  };
}

async function listModels({ force = false } = {}) {
  if (!force && modelCache.models.length && Date.now() - modelCache.at < MODELS_TTL_MS) {
    return modelCache.models;
  }
  const res = await fetch(`${OPENROUTER_BASE}/models`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`OpenRouter model list failed (HTTP ${res.status})`);
  const json = await res.json();
  const models = (json.data || [])
    .filter(m => {
      const out = m.architecture && m.architecture.output_modalities;
      return !out || out.includes('text');
    })
    .map(m => ({
      id: m.id,
      name: m.name || m.id,
      context: m.context_length || null,
      promptPrice: m.pricing ? Number(m.pricing.prompt) * 1e6 : null,
      completionPrice: m.pricing ? Number(m.pricing.completion) * 1e6 : null
    }));
  modelCache = { at: Date.now(), models };
  return models;
}

function versionScore(id) {
  const nums = (String(id).match(/\d+(?:\.\d+)?/g) || []).map(Number);
  return nums.reduce((acc, n, i) => acc + n / Math.pow(100, i), 0);
}

/**
 * Prefer the newest Claude Sonnet (good at HTML/CSS, fast), then any Claude, then OpenRouter's router.
 */
function pickDefaultModel(models) {
  const ids = models.map(m => m.id);
  const byFamily = (rx) => ids.filter(id => rx.test(id) && !/:free|beta|thinking/i.test(id)).sort((a, b) => versionScore(b) - versionScore(a));
  return byFamily(/^anthropic\/claude.*sonnet/i)[0]
    || byFamily(/^anthropic\/claude/i)[0]
    || 'openrouter/auto';
}

async function resolveModel() {
  const configured = getConfiguredModel();
  if (configured) return configured;
  try {
    return pickDefaultModel(await listModels());
  } catch (_) {
    return 'openrouter/auto';
  }
}

const SHORTCODE_REFERENCE = `
Available shortcodes (they are replaced server-side with live components; keep them as plain text inside elements):
- [timer format="mm:ss" showControls="false" connection_status="false" class=""] → .timer-component > #timer-display.timer-display (+ .timer-status)
- [secondary-timer] → #secondary-timer-component.secondary-timer-component > #secondary-timer-display.secondary-timer-display (hidden unless the room enables it)
- [hints maxHints="10" showNavigation="true" display="default|ticker" hints_header="true"] → #hints-section.hints-component, .hints-header h3, #hint-container.hint-container, .hint-item, .hint-placeholder, plus a fullscreen #hint-overlay.hint-overlay with .hint-overlay-content, .overlay-hint-text, .hint-overlay-close
- [chat maxMessages="50" showTimestamps="true" allowUserInput="true"] → #chat-section.chat-component, .chat-header, #chat-log.chat-log, .chat-message.player / .chat-message.gm, .chat-input-container, .chat-input, .chat-submit
- [media] → fullscreen lightbox: #fullscreen-media .lightbox, .lightbox-content, .lightbox-header, .lightbox-headline, .lightbox-close, .lightbox-media (put once near the end of <body>)
- [variables] → .variables-component, #variable-display.variable-display
- [room-info] → .room-info-component, #room-title.room-title, #room-info.room-info ; [room-info field="name|shortcode"] outputs plain text
- [game-state] → .game-state-component, #game-status.game-status
- [notifications showControls="true" showStatus="true"] → sound toggle controls
Scripts (/socket.io, /player.js) and the base stylesheet are injected automatically – never add them.
Full-screen overlays for GM messages use .qc-overlay, .qc-overlay-card, .qc-overlay-title, .qc-overlay-text (style them if the design calls for it).`;

const SYSTEM_PROMPT = `You are an expert front-end designer editing a PLAYER SCREEN theme for "Quandary Control", an escape-room control system. Players see this page on a TV or tablet inside the room while they play, so it must be legible from across a room, fit a 16:9 screen without scrolling, and look atmospheric and polished.

A theme is three files:
- index.html – full HTML document using shortcodes for live components
- style.css – all styling (prefer CSS custom properties in :root for colours/fonts)
- script.js – optional, usually empty; only for decorative effects

${SHORTCODE_REFERENCE}

Rules:
1. Keep every existing shortcode unless the user explicitly asks to remove that component. Never invent new shortcodes.
2. Keep <link rel="stylesheet" href="style.css"> in index.html.
3. Preserve any block between "/* === qb:visual-start === */" and "/* === qb:visual-end === */" in style.css (it is managed by the visual editor) unless the user asks to change those exact styles; you may edit rules inside it.
4. Keep class names prefixed "qb-" on elements; the visual editor relies on them.
5. Web fonts may be loaded with @import from fonts.googleapis.com at the top of style.css.
6. Do not use external images unless the user provides a URL; prefer CSS gradients, shapes and effects.
7. Make the minimal set of file changes that fully achieves the request, but always return COMPLETE file contents for each file you change.

Respond in exactly this format and nothing else:
<summary>One or two sentences describing what you changed.</summary>
<file name="style.css">
...complete new contents...
</file>
Include a <file> block only for files you changed (index.html, style.css or script.js).`;

function buildUserMessage({ instruction, html, css, js, selection, roomName }) {
  const parts = [];
  if (roomName) parts.push(`This theme is being previewed in the room "${roomName}".`);
  if (selection && selection.selector) {
    parts.push(`The user has selected this element in the visual editor: ${selection.selector}${selection.snippet ? `\nIts markup: ${String(selection.snippet).slice(0, 1500)}` : ''}\nFocus the change on that element unless the request clearly says otherwise.`);
  }
  parts.push(`<current_file name="index.html">\n${html}\n</current_file>`);
  parts.push(`<current_file name="style.css">\n${css}\n</current_file>`);
  parts.push(`<current_file name="script.js">\n${js || ''}\n</current_file>`);
  parts.push(`Request: ${instruction}`);
  return parts.join('\n\n');
}

function stripFences(content) {
  let c = String(content || '');
  c = c.replace(/^\s*```[a-zA-Z]*\s*\n/, '').replace(/\n\s*```\s*$/, '');
  return c.replace(/^\n+/, '');
}

function parseResponse(text) {
  const out = { summary: '', files: {} };
  const summary = /<summary>([\s\S]*?)<\/summary>/i.exec(text);
  out.summary = summary ? summary[1].trim() : '';
  const rx = /<file\s+name=["']?([\w.-]+)["']?\s*>([\s\S]*?)<\/file>/gi;
  let m;
  while ((m = rx.exec(text)) !== null) {
    const name = m[1].toLowerCase();
    const key = name === 'index.html' ? 'html' : name === 'style.css' ? 'css' : name === 'script.js' ? 'js' : null;
    if (key) out.files[key] = stripFences(m[2]);
  }
  if (!out.summary && Object.keys(out.files).length === 0) {
    out.summary = text.trim().slice(0, 600);
  }
  return out;
}

/**
 * @param {object} args { instruction, html, css, js, history?: [{role, content}], selection?, roomName? }
 */
async function editTheme(args) {
  const apiKey = getApiKey();
  if (!apiKey) throw Object.assign(new Error('Add your OpenRouter API key in Settings to use the AI assistant.'), { statusCode: 400 });
  const instruction = String(args.instruction || '').trim();
  if (!instruction) throw Object.assign(new Error('Describe the change you want.'), { statusCode: 400 });

  const model = args.model || await resolveModel();
  const history = Array.isArray(args.history) ? args.history.slice(-6).filter(h => h && ['user', 'assistant'].includes(h.role) && typeof h.content === 'string') : [];

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.map(h => ({ role: h.role, content: h.content.slice(0, 4000) })),
    { role: 'user', content: buildUserMessage({ ...args, instruction }) }
  ];

  const started = Date.now();
  const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/strykerx/quandarycontrol',
      'X-Title': 'Quandary Control Theme Builder'
    },
    body: JSON.stringify({ model, messages, temperature: 0.4, max_tokens: 32000 }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (json.error && (json.error.message || json.error)) || `HTTP ${res.status}`;
    const hint = res.status === 401 ? ' – check your OpenRouter API key in Settings.' : res.status === 402 ? ' – your OpenRouter account is out of credits.' : '';
    throw Object.assign(new Error(`OpenRouter: ${msg}${hint}`), { statusCode: 502 });
  }

  const choice = json.choices && json.choices[0];
  const text = choice && choice.message && typeof choice.message.content === 'string' ? choice.message.content : '';
  if (!text) throw Object.assign(new Error('The model returned an empty response. Try again or pick a different model.'), { statusCode: 502 });

  const parsed = parseResponse(text);
  return {
    ...parsed,
    model: json.model || model,
    truncated: choice.finish_reason === 'length',
    usage: json.usage || null,
    ms: Date.now() - started
  };
}

async function testKey(apiKey) {
  const res = await fetch(`${OPENROUTER_BASE}/key`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15000)
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error((json.error && json.error.message) || `Key check failed (HTTP ${res.status})`), { statusCode: 400 });
  return json.data || {};
}

module.exports = {
  status,
  listModels,
  pickDefaultModel,
  resolveModel,
  editTheme,
  testKey,
  parseResponse,
  getApiKey
};
