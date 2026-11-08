/**
 * Filesystem-backed themes: themes/<slug>/{index.html, style.css, script.js, theme-config.json, assets/}
 */
const fs = require('fs');
const path = require('path');
const { nanoid } = require('nanoid');

const THEMES_DIR = process.env.QUANDARY_THEMES_DIR
  ? path.resolve(process.env.QUANDARY_THEMES_DIR)
  : path.join(__dirname, '..', '..', 'themes');

const SLUG_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const PROTECTED_THEMES = new Set(['boilerplate']);
const MAX_FILE_BYTES = 2 * 1024 * 1024;

function isValidSlug(slug) {
  return typeof slug === 'string' && SLUG_PATTERN.test(slug);
}

function slugify(name) {
  const base = String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base || `theme-${nanoid(6).toLowerCase()}`;
}

function themeDir(slug) {
  if (!isValidSlug(slug)) {
    throw Object.assign(new Error('Invalid theme name'), { statusCode: 400 });
  }
  const dir = path.join(THEMES_DIR, slug);
  // Defence in depth against traversal
  if (path.relative(THEMES_DIR, dir).startsWith('..')) {
    throw Object.assign(new Error('Invalid theme path'), { statusCode: 400 });
  }
  return dir;
}

function readIf(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (_) { return null; }
}

function readConfig(slug) {
  const raw = readIf(path.join(themeDir(slug), 'theme-config.json'));
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (_) { return {}; }
}

function exists(slug) {
  if (!isValidSlug(slug)) return false;
  return fs.existsSync(path.join(themeDir(slug), 'index.html'));
}

function listThemes() {
  if (!fs.existsSync(THEMES_DIR)) return [];
  const out = [];
  for (const entry of fs.readdirSync(THEMES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isValidSlug(entry.name)) continue;
    const dir = path.join(THEMES_DIR, entry.name);
    if (!fs.existsSync(path.join(dir, 'index.html'))) continue;
    const config = readConfig(entry.name);
    let updated = null;
    try {
      const stats = ['index.html', 'style.css', 'theme-config.json']
        .map(f => { try { return fs.statSync(path.join(dir, f)).mtimeMs; } catch (_) { return 0; } });
      updated = new Date(Math.max(...stats)).toISOString();
    } catch (_) { /* ignore */ }
    out.push({
      slug: entry.name,
      name: entry.name,
      displayName: config.name || entry.name,
      description: config.description || '',
      version: config.version || '1.0.0',
      author: config.author || '',
      colors: extractColors(config),
      protected: PROTECTED_THEMES.has(entry.name),
      builtWith: config.builtWith || null,
      updated_at: updated
    });
  }
  return out.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

function extractColors(config) {
  const vars = (config && config.variables) || {};
  return Object.entries(vars)
    .filter(([, v]) => typeof v === 'string' && /^(#|rgb|hsl)/i.test(v.trim()))
    .slice(0, 5)
    .map(([, v]) => v);
}

function getTheme(slug) {
  if (!exists(slug)) return null;
  const dir = themeDir(slug);
  const assetsDir = path.join(dir, 'assets');
  let assets = [];
  if (fs.existsSync(assetsDir)) {
    assets = fs.readdirSync(assetsDir, { withFileTypes: true })
      .filter(e => e.isFile())
      .map(e => ({ name: e.name, url: `/themes/${slug}/assets/${encodeURIComponent(e.name)}` }));
  }
  return {
    slug,
    config: readConfig(slug),
    html: readIf(path.join(dir, 'index.html')) || '',
    css: readIf(path.join(dir, 'style.css')) || '',
    js: readIf(path.join(dir, 'script.js')) || '',
    assets,
    protected: PROTECTED_THEMES.has(slug)
  };
}

function assertSize(label, content) {
  if (typeof content === 'string' && Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
    throw Object.assign(new Error(`${label} is larger than 2MB`), { statusCode: 413 });
  }
}

/**
 * Write theme files. Only provided keys are written.
 */
function saveTheme(slug, { html, css, js, config } = {}) {
  const dir = themeDir(slug);
  if (!fs.existsSync(dir)) throw Object.assign(new Error('Theme not found'), { statusCode: 404 });
  if (PROTECTED_THEMES.has(slug)) {
    throw Object.assign(new Error('The boilerplate theme is read-only. Duplicate it to make changes.'), { statusCode: 403 });
  }
  assertSize('HTML', html); assertSize('CSS', css); assertSize('JavaScript', js);

  if (typeof html === 'string') fs.writeFileSync(path.join(dir, 'index.html'), html, 'utf8');
  if (typeof css === 'string') fs.writeFileSync(path.join(dir, 'style.css'), css, 'utf8');
  if (typeof js === 'string') {
    const jsPath = path.join(dir, 'script.js');
    if (js.trim() === '') {
      if (fs.existsSync(jsPath)) fs.unlinkSync(jsPath);
    } else {
      fs.writeFileSync(jsPath, js, 'utf8');
    }
  }
  if (config && typeof config === 'object') {
    const merged = { ...readConfig(slug), ...config, updated_at: new Date().toISOString() };
    fs.writeFileSync(path.join(dir, 'theme-config.json'), JSON.stringify(merged, null, 2), 'utf8');
  }
  return getTheme(slug);
}

function uniqueSlug(base) {
  let slug = slugify(base);
  if (!isValidSlug(slug)) slug = `theme-${nanoid(6).toLowerCase()}`;
  let candidate = slug;
  let i = 2;
  while (fs.existsSync(path.join(THEMES_DIR, candidate))) {
    candidate = `${slug}-${i++}`;
  }
  return candidate;
}

/**
 * Create a theme from a starter (blank | boilerplate | <existing slug>).
 */
function createTheme({ name, description = '', from = 'starter' } = {}) {
  if (!name || !String(name).trim()) throw Object.assign(new Error('Theme name is required'), { statusCode: 400 });
  const slug = uniqueSlug(name);
  const dir = themeDir(slug);
  fs.mkdirSync(dir, { recursive: true });

  let source;
  if (from && from !== 'starter' && exists(from)) {
    source = getTheme(from);
    copyAssets(from, slug);
  } else {
    source = starterTheme();
  }

  const html = source.html.replace(new RegExp(`/themes/${escapeRegex(source.slug || '__none__')}/`, 'g'), `/themes/${slug}/`);
  fs.writeFileSync(path.join(dir, 'index.html'), html, 'utf8');
  fs.writeFileSync(path.join(dir, 'style.css'), source.css || '', 'utf8');
  if (source.js && source.js.trim()) fs.writeFileSync(path.join(dir, 'script.js'), source.js, 'utf8');

  const config = {
    ...(source.config || {}),
    name: String(name).trim(),
    description: description || (source.config && source.config.description) || '',
    version: '1.0.0',
    author: (source.config && source.config.author) || '',
    builtWith: 'theme-builder',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  fs.writeFileSync(path.join(dir, 'theme-config.json'), JSON.stringify(config, null, 2), 'utf8');
  return getTheme(slug);
}

function copyAssets(fromSlug, toSlug) {
  const src = path.join(themeDir(fromSlug), 'assets');
  if (!fs.existsSync(src)) return;
  const dest = path.join(themeDir(toSlug), 'assets');
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.isFile()) fs.copyFileSync(path.join(src, entry.name), path.join(dest, entry.name));
  }
}

function deleteTheme(slug) {
  if (PROTECTED_THEMES.has(slug)) throw Object.assign(new Error('The boilerplate theme cannot be deleted'), { statusCode: 403 });
  const dir = themeDir(slug);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

function assetsDir(slug) {
  const dir = path.join(themeDir(slug), 'assets');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A clean, modern starting point with every component, styled through CSS variables.
 */
function starterTheme() {
  return {
    slug: null,
    config: {
      description: 'Starter theme created in the Theme Builder',
      components: {
        timer: { enabled: true }, hints: { enabled: true }, chat: { enabled: true },
        media: { enabled: true }, 'room-info': { enabled: true }
      },
      variables: {
        'bg': '#0f1117', 'surface': '#1a1d27', 'accent': '#f5b942', 'text': '#f3f4f6', 'muted': '#9ca3af'
      }
    },
    html: `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>[room-info field="name"]</title>
    <link rel="stylesheet" href="style.css">
</head>
<body class="qt-body">
    <div class="qt-screen">
        <header class="qt-header">
            <h1 class="qt-title">[room-info field="name"]</h1>
        </header>

        <main class="qt-main">
            <section class="qt-timer-panel">
                [timer showControls="false"]
                [secondary-timer]
            </section>

            <section class="qt-side">
                <div class="qt-card qt-hints-card">
                    [hints maxHints="10"]
                </div>
                <div class="qt-card qt-chat-card">
                    [chat]
                </div>
            </section>
        </main>
    </div>

    [media]
</body>
</html>
`,
    css: `/* Starter theme – edit freely in Code mode, or use the Visual editor */
:root {
  --bg: #0f1117;
  --surface: #1a1d27;
  --accent: #f5b942;
  --text: #f3f4f6;
  --muted: #9ca3af;
  --radius: 18px;
  --font: 'Segoe UI', system-ui, sans-serif;
}

html, body { margin: 0; height: 100%; }

.qt-body {
  background: var(--bg);
  color: var(--text);
  font-family: var(--font);
}

.qt-screen {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  padding: 3vh 3vw;
  box-sizing: border-box;
  gap: 3vh;
}

.qt-header { text-align: center; }

.qt-title {
  margin: 0;
  font-size: clamp(1.5rem, 4vw, 3.5rem);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.qt-main {
  flex: 1;
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: 3vw;
  min-height: 0;
}

.qt-timer-panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: var(--surface);
  border-radius: var(--radius);
  padding: 2rem;
}

.qt-timer-panel .timer-display {
  font-size: clamp(4rem, 14vw, 16rem);
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--accent);
  line-height: 1;
}

.qt-side {
  display: flex;
  flex-direction: column;
  gap: 2vh;
  min-height: 0;
}

.qt-card {
  background: var(--surface);
  border-radius: var(--radius);
  padding: 1.25rem;
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.qt-card h3 {
  margin-top: 0;
  color: var(--muted);
  font-size: 0.9rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

@media (max-width: 900px) {
  .qt-main { grid-template-columns: 1fr; }
}
`,
    js: ''
  };
}

module.exports = {
  THEMES_DIR,
  isValidSlug,
  slugify,
  themeDir,
  exists,
  listThemes,
  getTheme,
  saveTheme,
  createTheme,
  deleteTheme,
  assetsDir,
  PROTECTED_THEMES
};
