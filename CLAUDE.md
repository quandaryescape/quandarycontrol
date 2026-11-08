# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Quandary Control** is a self-hostable, open-source control system for escape room operations: game timers, hints and chat, player screens, rules slideshows, automations and prop/hardware integration over plain HTTP. It runs on a local network or a web server.

### Technology Stack
- **Backend**: Node.js (18+) + Express 5 + SQLite (better-sqlite3)
- **Real-time**: Socket.IO
- **Frontend**: Vanilla HTML/CSS/JS, no build step. Vendored libraries are served from `node_modules` (CodeMirror 5, Lucide icon font, Fontsource fonts) so everything works offline.
- **Uploads**: Multer (`src/routes/upload.js` – size limit + file-type allowlist)
- **AI**: OpenRouter (server-side only; key never sent to the browser)

## Commands

```bash
npm run dev               # nodemon
node server.js            # production
npm test                  # all Jest tests
npx jest tests/v2         # the maintained suite (backend, automations, sockets)
```

Some older suites (`tests/integration/*`, `tests/secondary-timer.spec.js`) were already failing before v2 and test socket events that don't exist; `tests/v2` is the reliable signal.

### Environment variables
| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP port (default 3000) |
| `ADMIN_PASSWORD` / `ADMIN_USER` | Optional HTTP Basic auth for admin/GM/editor pages and `/api/v2` management APIs (user defaults to `admin`). Player screens, slideshows, webhooks and hardware endpoints stay open. |
| `QUANDARY_DB_PATH` | SQLite file (default `db/quandary.db`; tests use `:memory:`) |
| `QUANDARY_THEMES_DIR` | Themes folder (default `themes/`) |
| `OPENROUTER_API_KEY` / `OPENROUTER_MODEL` | Fallbacks if not set in Settings |
| `OPENROUTER_BASE_URL` | OpenRouter-compatible gateway (also used to test against a mock) |
| `MAX_UPLOAD_MB` | Upload size limit (default 750) |
| `LOG_LEVEL` | `error` / `warn` / `info` / `debug` |

## Architecture

- `server.js` – boots `createServer()` from `src/app.js` and listens.
- `src/app.js` – builds Express app, HTTP server, Socket.IO and the services; testable without listening.
- `src/services/`
  - `timer-service.js` – in-memory timers (wall-clock based). Exposes hooks (`onTick`, `onStateChange`). Timer variables are **not** written to the DB; they're computed live.
  - `variable-service.js` – the only place variables are set: type coercion (`"false"` → `false`), persistence in `rooms.api_variables`, socket broadcast (`variable_updated` + `variableUpdate`), and automation triggering.
  - `automation-engine.js` – WHEN trigger → IF conditions → THEN actions. Triggers: `variable` (edge-triggered), `timer` (remaining/elapsed crossings, start/pause/resume/complete/reset), `webhook` (`/api/hooks/:key`), `manual` (GM buttons), `event` (player_connected, hint_sent, player_message, gm_message). Actions: show_message, send_hint, show_media, play_sound, set_variable, timer, http_request, delay, start_slideshow, room_command, run_automation. `{{templates}}` render from variables, timer, room and webhook payload. Loop protection (depth 8) and cooldowns. Logs to `admin_<room>` / `gm_<room>` socket rooms.
  - `theme-service.js` – filesystem themes (`themes/<slug>/index.html|style.css|script.js|theme-config.json|assets/`). Slugs are validated; `boilerplate` is read-only.
  - `ai-service.js` – OpenRouter calls for the Theme Builder (`<summary>` + `<file name="…">` response format).
  - `settings-service.js`, `preview-store.js` (in-memory theme drafts for live preview), `registry.js` (service access for legacy modules).
- `db/database.js` + `db/schema-migrations.js` – run-once, additive migrations tracked in `schema_migrations`. Legacy columns are never dropped so older branches can open the same DB. Legacy `config.triggers` / `secondaryTimerTriggers` were imported into `automations`; legacy rules media into a "Rules" slideshow.
- `utils/shortcode-parser.js` – renders a theme's `index.html` (shortcodes like `[timer]`, `[hints]`, `[chat]`, `[media]`, `[room-info field="name"]`) and injects required scripts once. `renderDraft()` powers the builder preview.

### Routes
- Pages (`src/routes/web-routes.js`): `/` admin dashboard (rooms · themes · settings), `/room/:id/gm`, `/room/:id/automations`, `/room/:id/slideshows` (studio), `/room/:id/rules-slideshow` (player: 1 show → plays, 2+ → chooser), `/room/:id/slideshow/:showId`, `/room/:id/player` (themed player; `?themePreview=token&editor=1&demo=1` for the builder), `/p/:code`, `/s/:code`, `/theme-builder/:slug`, `/tv`.
- `/api/v2/*` (`src/routes/api/v2/`): rooms (structured settings incl. `appearance`, hint presets, GM notes), variables (incl. hardware GET endpoints `.../variables/:name/set?value=`, `increment`, `toggle`), timer control (`/rooms/:idOrCode/timer/:command`), hints, slideshows, automations (+ test, duplicate, webhook key rotation, logs), uploads, themes (+ preview drafts, assets), settings, AI, system info. Room endpoints accept the room id **or** short code.
- `/api/hooks/:key` – inbound webhooks (responds within ~3 s even if actions include waits).
- `/api/*` (`routes/api.js`) and `/api/v1/*` – legacy endpoints kept for existing themes and hardware; variable routes delegate to `VariableService`.

### WebSocket events (main)
- Client → server: `join_room {roomId, clientType: gm|player|preview}`, `join_admin`, `join_dashboard`, `timer_control` / `secondary_timer_control`, `sendHint`, `chat_message`, `typing`, `show_lightbox`, `show_message`, `set_variable`, `run_automation` (ack), `start_slideshow`, `close_overlays`, `reload_players`, `play_sound`.
- Server → clients: `timer_update`, `secondary_timer_update`, `timer_complete`, `variableUpdate`, `variable_updated`, `hintReceived`, `chat_message`, `show_lightbox`, `show_message`, `play_sound`, `start_slideshow`, `reload_player`, `room_updated`, `presence`, `room_timer` / `room_presence` (dashboard), `automation_log`.
- `preview` clients receive updates but don't count as screens and don't fire `player_connected`.

### Frontend
- Shared design system: `public/css/ui.css` (tokens, dark/light, components) + `public/js/ui.js` (`window.QC`: api, toast, modal/confirm/prompt, drawer, menu, sortable, uploads, media picker, room appearance helpers).
- Pages: `admin.html` + `js/admin-app.js`; `gm.html` + `js/gm-app.js`; `automations.html` + `js/automation-catalog.js` + `js/automations-app.js`; `slideshow-editor.html` + `js/slideshow-editor.js`; `rules-slideshow.html` + `js/slideshow-player.js`; `theme-builder.html` + `js/theme-builder*.js`.
- Slides render through one shared renderer (`js/slideshow-render.js` + `css/slideshow.css`, container-query units with vw/vh fallbacks for old TV browsers).
- Theme Builder: Visual / Code / AI share one draft with undo/redo. The preview iframe runs `js/theme-preview-bridge.js` (selection, toolbar, drag/drop targeting, instant CSS). Visual-editor styles live in a managed block in `style.css` between `/* === qb:visual-start === */` and `/* === qb:visual-end === */`, keyed by `qb-xxxxxx` classes.
- Every themed player page also gets `js/player-overlays.js` (styled messages, slideshow launch, remote reload).
- Per-room appearance (`config.appearance = { accent, background, timerFont }`) colours the dashboard card and tints the GM console so GMs can tell rooms apart.
- The legacy grid layout system in `player.js` only runs if a theme opts in with `<body data-legacy-layout="true">`.

## Development notes
- Schema changes: add a new entry to `MIGRATIONS` in `db/schema-migrations.js` (never edit applied ones).
- Never interpolate user/room/webhook text into HTML without escaping (`QC.escape`, `QC.html`, `escapeHtml` in `player.js`).
- `db/quandary.db` is tracked in git for historical reasons but is ignored by `.gitignore`; don't commit changes to it.
- Remaining legacy/dead code worth removing later: `public/player.html`, `public/layout-*.js`, `public/theme-architecture.js`, `public/theme-registry.js`, `public/theme-inheritance.js`, `public/component-integration*.js`, `public/js/**` (old component framework), `routes/api.js` theme/layout sections, `src/routes/api/v1`.
